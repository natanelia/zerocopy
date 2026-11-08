import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'map-bulk-reads-20261108',
  baseline: 'a4265a0608ec25eec5719496225212db6b251989',
  changedSources: ['shared-map.ts'], changedWasm: [],
  pilotCases: ['number-hit-128', 'number-hit-1024', 'number-mixed-1024', 'number-miss-128', 'string-hit-128', 'object-hit-128', 'scalar-number-control'],
  aaCases: ['number-hit-128', 'number-mixed-1024', 'scalar-number-control'],
  cases: [
    { name: 'number-hit-128', type: 'number', role: 'target', count: 128, mode: 'hit', repetitions: 2048 },
    { name: 'number-hit-1024', type: 'number', role: 'target', count: 1024, mode: 'hit', repetitions: 256 },
    { name: 'number-mixed-1024', type: 'number', role: 'control', count: 1024, mode: 'mixed', repetitions: 128 },
    { name: 'number-miss-128', type: 'number', role: 'control', count: 128, mode: 'miss', repetitions: 256 },
    { name: 'string-hit-128', type: 'string', role: 'target', count: 128, mode: 'hit', repetitions: 1024 },
    { name: 'object-hit-128', type: 'object', role: 'control', count: 128, mode: 'hit', repetitions: 256 },
    { name: 'scalar-number-control', type: 'number', role: 'control', count: 128, mode: 'scalar', repetitions: 2048 },
  ],
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => value === undefined ? ['undefined'] : value;

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const sourceCount = 4096;
  const value = i => spec.type === 'number' ? i + 0.25
    : spec.type === 'string' ? `label/é/界/🙂/${i}` : { id: i, coordinates: [i, i + 0.25] };
  const entries = Array.from({ length: sourceCount }, (_, i) => [`id${i}`, value(i)]);
  const oracle = new Map(entries);
  const keys = Array.from({ length: spec.count }, (_, i) =>
    spec.mode === 'miss' || spec.mode === 'mixed' && i % 2 ? `absent${i}` : `id${(i * 73 + 19) % sourceCount}`);
  const expected = keys.map(key => oracle.get(key));
  S.resetMap();
  const writer = new S.SharedMap(spec.type).setMany(entries);
  // Public shared attachment gives each process an independent empty read cache.
  // Warm only the requested keys; the proof measures repeated reads thereafter.
  const source = (await S.initWorker(S.getWorkerData({ source: writer }, { copy: false }))).source;
  const packet = S.getWorkerData({ source }, { copy: false });
  const wire = packet.arenas[0], used = wire.used;
  const bytesHash = hash(new Uint8Array(wire.memory.buffer, 65536, used - 65536));
  const descriptor = packet.structures.source.data;
  const scalar = () => { const output = new Array(keys.length); for (let i = 0; i < keys.length; i++) output[i] = source.get(keys[i]); return output; };
  const operation = spec.mode === 'scalar' ? scalar : () => source.getMany(keys);
  const verify = output => {
    assert.ok(Array.isArray(output)); assert.equal(output.length, expected.length);
    for (let i = 0; i < output.length; i++) {
      if (spec.type === 'object' && expected[i] !== undefined) {
        assert.deepEqual(output[i], expected[i]);
        assert.ok(Object.isFrozen(output[i])); assert.ok(Object.isFrozen(output[i].coordinates));
      } else assert.ok(Object.is(output[i], expected[i]), `Output ${i} differs`);
    }
  };
  verify(operation());
  return {
    operation, verify,
    checkInvariant() {
      const current = S.getWorkerData({ source }, { copy: false });
      assert.deepEqual(current.structures.source.data, descriptor);
      assert.equal(current.arenas[0].used, used);
      assert.equal(hash(new Uint8Array(wire.memory.buffer, 65536, used - 65536)), bytesHash);
    },
    expectedDigest: hash(JSON.stringify({ spec, keys, values: expected.map(canonical) })),
    fixture: {
      sourceCount, requestCount: spec.count, type: spec.type, mode: spec.mode,
      hitCount: expected.filter(value => value !== undefined).length,
      sourceBytes: used - 65536, sourceBytesHash: bytesHash,
      readState: 'one read-only shared attachment per fresh process; requested keys warmed before timing',
      timedOperation: spec.mode === 'scalar' ? 'all scalar get calls and result-array creation' : 'complete public getMany including result-array allocation',
      oracle: 'every requested output against a separate native Map, plus frozen JSON and unchanged source bytes; no whole-map traversal per output',
    },
  };
}
