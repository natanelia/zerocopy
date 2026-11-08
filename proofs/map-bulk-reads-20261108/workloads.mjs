import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'map-bulk-reads-20261108',
  baseline: 'a4265a0608ec25eec5719496225212db6b251989',
  changedSources: ['arena.ts', 'shared-map.ts'], changedWasm: [],
  pilotCases: ['number-hit-128', 'number-hit-1024', 'number-mixed-1024', 'number-miss-128', 'string-hit-128', 'object-hit-128', 'scalar-number-control', 'cold-number-1024', 'changing-root-1024'],
  aaCases: ['number-hit-128', 'number-mixed-1024', 'cold-number-1024', 'scalar-number-control'],
  cases: [
    { name: 'number-hit-128', type: 'number', role: 'target', count: 128, mode: 'hit', repetitions: 4096 },
    { name: 'number-hit-1024', type: 'number', role: 'target', count: 1024, mode: 'hit', repetitions: 256 },
    { name: 'number-mixed-1024', type: 'number', role: 'control', count: 1024, mode: 'mixed', repetitions: 128 },
    { name: 'number-miss-128', type: 'number', role: 'control', count: 128, mode: 'miss', repetitions: 512 },
    { name: 'string-hit-128', type: 'string', role: 'target', count: 128, mode: 'hit', repetitions: 4096 },
    { name: 'object-hit-128', type: 'object', role: 'control', count: 128, mode: 'hit', repetitions: 1024 },
    { name: 'scalar-number-control', type: 'number', role: 'control', count: 128, mode: 'scalar', repetitions: 4096 },
    { name: 'cold-number-1024', type: 'number', role: 'control', count: 1024, mode: 'cold', repetitions: 64 },
    { name: 'changing-root-1024', type: 'number', role: 'control', count: 1024, mode: 'root-change', repetitions: 256 },
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
  const alternateExpected = spec.mode === 'root-change' ? expected.map((value, i) => i === 0 ? -999.25 : value) : null;
  S.resetMap();
  const writer = new S.SharedMap(spec.type).setMany(entries);
  const alternateWriter = spec.mode === 'root-change' ? writer.set(keys[0], alternateExpected[0]) : undefined;
  // Public shared attachment gives each process an independent empty read cache.
  // Warm only the requested keys; the proof measures repeated reads thereafter.
  const transport = S.getWorkerData(alternateWriter ? { source: writer, alternate: alternateWriter } : { source: writer }, { copy: false });
  const attached = await S.initWorker(transport), source = attached.source;
  const packet = S.getWorkerData(attached, { copy: false });
  const wire = packet.arenas[0], used = wire.used;
  const bytesHash = hash(new Uint8Array(wire.memory.buffer, 65536, used - 65536));
  const descriptors = Object.fromEntries(Object.entries(packet.structures).map(([name, item]) => [name, item.data]));
  // JSON values are deeply frozen. Validate each distinct value completely
  // once, then verify every retained output by exact identity without repeatedly
  // traversing the same object during every untimed batch check.
  const objectReferences = spec.type === 'object' ? source.getMany(keys) : null;
  if (objectReferences) for (let i = 0; i < objectReferences.length; i++) {
    assert.deepEqual(objectReferences[i], expected[i]);
    assert.ok(Object.isFrozen(objectReferences[i]));
    assert.ok(Object.isFrozen(objectReferences[i].coordinates));
  }
  let coldReaders = [], cursor = 0, verifyCursor = 0;
  async function prepareBatch(count) {
    cursor = 0; verifyCursor = 0;
    if (spec.mode === 'cold') {
      coldReaders = await Promise.all(Array.from({ length: count }, async () => (await S.initWorker(transport)).source));
    }
  }
  const operation = () => {
    const selected = spec.mode === 'cold' ? coldReaders[cursor++]
      : spec.mode === 'root-change' && (cursor++ & 1) ? attached.alternate : source;
    if (spec.mode !== 'scalar') return selected.getMany(keys);
    const output = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) output[i] = selected.get(keys[i]);
    return output;
  };
  const verify = output => {
    assert.ok(Array.isArray(output)); assert.equal(output.length, expected.length);
    const wanted = alternateExpected && (verifyCursor++ & 1) ? alternateExpected : expected;
    for (let i = 0; i < output.length; i++) {
      if (!Object.is(output[i], objectReferences ? objectReferences[i] : wanted[i])) throw new Error(`Output ${i} differs`);
    }
  };
  await prepareBatch(1);
  verify(operation());
  return {
    operation, verify, prepareBatch,
    checkInvariant() {
      const current = S.getWorkerData(attached, { copy: false });
      assert.deepEqual(Object.fromEntries(Object.entries(current.structures).map(([name, item]) => [name, item.data])), descriptors);
      assert.equal(current.arenas[0].used, used);
      assert.equal(hash(new Uint8Array(wire.memory.buffer, 65536, used - 65536)), bytesHash);
      if (alternateExpected) {
        assert.equal(source.get(keys[0]), expected[0]);
        assert.equal(attached.alternate.get(keys[0]), alternateExpected[0]);
      }
      for (const reader of coldReaders) assert.deepEqual(reader.toWorkerData(), descriptors.source);
    },
    expectedDigest: hash(JSON.stringify({ spec, keys, values: expected.map(canonical), alternateValues: alternateExpected?.map(canonical) ?? null })),
    fixture: {
      sourceCount, requestCount: spec.count, type: spec.type, mode: spec.mode,
      hitCount: expected.filter(value => value !== undefined).length,
      sourceBytes: used - 65536, sourceBytesHash: bytesHash,
      readState: spec.mode === 'cold' ? 'new public shared read-only attachment for each operation, prepared outside timing; first getMany fills that reader cache'
        : spec.mode === 'root-change' ? 'alternate two retained roots sharing one read-only arena; second root changes the first requested value'
        : 'one read-only shared attachment per fresh process; requested keys warmed before timing',
      timedOperation: spec.mode === 'scalar' ? 'all scalar get calls and result-array creation' : 'complete public getMany including result-array allocation',
      oracle: 'every output position checked against independent native-Map values or fully verified frozen JSON identities; root alternation checked by operation ordinal; source bytes checked once per batch',
    },
  };
}
