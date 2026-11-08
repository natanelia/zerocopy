import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'map-miss-cache-20261108',
  baseline: 'a4265a0608ec25eec5719496225212db6b251989',
  changedSources: ['arena.ts'], changedWasm: [],
  cases: [
    { name: 'get-repeated-ascii-16', role: 'target', method: 'get', mode: 'miss', state: 'warm', count: 4096, pool: 16, queries: 1024, repetitions: 256 },
    { name: 'has-repeated-ascii-128', role: 'target', method: 'has', mode: 'miss', state: 'warm', count: 4096, pool: 128, queries: 1024, repetitions: 256 },
    { name: 'get-repeated-unicode-128', role: 'target', method: 'get', mode: 'unicode', state: 'warm', count: 32768, pool: 128, queries: 1024, repetitions: 256 },
    { name: 'get-short-repeated-misses', role: 'short-key', method: 'get', mode: 'short', state: 'warm', count: 4096, pool: 16, queries: 1024, repetitions: 256 },
    { name: 'get-cold-misses', role: 'admission-control', method: 'get', mode: 'miss', state: 'cold', count: 4096, pool: 1024, queries: 1024, repetitions: 64 },
    { name: 'get-short-cold-misses', role: 'admission-control', method: 'get', mode: 'short', state: 'cold', count: 4096, pool: 1024, queries: 1024, repetitions: 64 },
    { name: 'get-cold-hits', role: 'first-hit-control', method: 'get', mode: 'hit', state: 'cold', count: 4096, pool: 1024, queries: 1024, repetitions: 64 },
    { name: 'get-streaming-misses', role: 'streaming-control', method: 'get', mode: 'miss', state: 'streaming', count: 4096, pool: 1024, queries: 1024, repetitions: 64 },
    { name: 'get-over-budget-misses', role: 'capacity-control', method: 'get', mode: 'miss', state: 'full', count: 4096, pool: 1024, queries: 1024, repetitions: 128 },
    { name: 'get-mixed', role: 'mixed-control', method: 'get', mode: 'mixed', state: 'warm', count: 4096, pool: 128, queries: 1024, repetitions: 256 },
    { name: 'get-alternating-roots', role: 'root-control', method: 'get', mode: 'alternating', state: 'warm', count: 4096, pool: 16, queries: 1024, repetitions: 64 },
    { name: 'get-warm-hits', role: 'control', method: 'get', mode: 'hit', state: 'warm', count: 4096, pool: 1024, queries: 1024, repetitions: 512 },
    { name: 'get-warm-hits-after-miss', role: 'shape-control', method: 'get', mode: 'hit', state: 'warm-after-miss', count: 4096, pool: 1024, queries: 1024, repetitions: 512 },
    { name: 'has-warm-hits', role: 'control', method: 'has', mode: 'hit', state: 'warm', count: 4096, pool: 1024, queries: 1024, repetitions: 512 },
  ],
};
// Keep every declared countercase in both the pilot and same-build control.
study.pilotCases = study.cases.map(spec => spec.name);
study.aaCases = study.cases.map(spec => spec.name);

const HEAP_START = 65536;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === undefined ? ['undefined'] : value;

export function makeFixture(spec) {
  const entries = Array.from({ length: spec.count }, (_, i) => [`id/${i}`, i + 0.25]);
  const missing = i => spec.mode === 'unicode' ? `absent/é/界/🙂/${i}`
    : spec.mode === 'short' ? `?${i.toString(36).padStart(2, '0')}` : `absent/record/${String(i).padStart(6, '0')}`;
  const keys = Array.from({ length: spec.queries }, (_, i) => {
    const hit = spec.mode === 'hit' || spec.mode === 'mixed' && i % 5 !== 0;
    return hit ? entries[(i * 73 + 19) % spec.count][0] : missing(i % spec.pool);
  });
  // Every key alternates roots between successive cycles; it cannot accidentally
  // stay assigned to one root because the key pool has an even length.
  const roots = keys.map((_, i) => spec.mode === 'alternating' ? Math.floor(i / spec.pool) % 2 : 0);
  return { entries, keys, roots };
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const fixture = makeFixture(spec), { entries, keys, roots } = fixture;
  const oracle = new Map(entries), expected = keys.map(key => spec.method === 'has' ? oracle.has(key) : oracle.get(key));
  const streaming = spec.state === 'streaming';
  const streamKeys = streaming ? Array.from({ length: spec.repetitions }, (_, batch) => keys.map(key => `${key}/request-${batch}`)) : null;
  if (streamKeys) for (const group of streamKeys) for (const key of group) assert.equal(oracle.has(key), false);
  S.resetMap();
  const writer = new S.SharedMap('number').setMany(entries), fork = writer.set('fork-only', -1);
  const packet = S.getWorkerData({ source: writer, fork }, { copy: false }), wire = packet.arenas[0];
  assert.equal(packet.arenas.length, 1);
  const memory = wire.memory, used = wire.used, descriptor = writer.toWorkerData(), forkDescriptor = fork.toWorkerData();
  const bytesHash = hash(new Uint8Array(memory.buffer, HEAP_START, used - HEAP_START));
  const initial = await S.initWorker(packet);
  // Setup needs synchronous fresh readers for each cold operation. Derive the
  // same Arena constructor used by the public attachment rather than mutating
  // its private read caches. This setup is outside every measured batch.
  const ReaderArena = initial.source.arena.constructor;
  function freshReader() {
    const arena = new ReaderArena({ memory, used, readOnly: true });
    return [new S.SharedMap('number', writer.root, writer.size, arena), new S.SharedMap('number', fork.root, fork.size, arena)];
  }
  let readers = [[initial.source, initial.fork]], position = 0;
  const alternating = spec.mode === 'alternating';
  const next = () => readers[spec.state === 'cold' ? position++ : 0];
  const operation = spec.method === 'has' ? () => {
    const maps = next(), source = maps[0], output = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) output[i] = source.has(keys[i]);
    return output;
  } : alternating ? () => {
    const maps = next(), output = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) output[i] = maps[roots[i]].get(keys[i]);
    return output;
  } : () => {
    const source = next()[0], requested = streaming ? streamKeys[position++] : keys, output = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) output[i] = source.get(requested[i]);
    return output;
  };

  function verify(output) {
    assert.ok(Array.isArray(output)); assert.equal(output.length, expected.length);
    for (let i = 0; i < output.length; i++) assert.ok(Object.is(output[i], expected[i]), `Output ${i} differs`);
  }
  if (spec.state === 'full') {
    for (let i = 0; i < 256; i++) assert.equal(initial.source.get(`budget-miss/${i}`), undefined);
  }
  if (spec.state === 'warm-after-miss') assert.equal(initial.source.get('prior-miss'), undefined);
  if (spec.state !== 'cold' && !streaming) verify(operation());

  return {
    prepareBatch(repetitions) {
      if (spec.state === 'cold') readers = Array.from({ length: repetitions }, freshReader);
      else if (streaming) readers = [freshReader()];
      position = 0;
    },
    operation, verify,
    strategy: `unchanged public SharedMap.${spec.method} calls`,
    checkInvariant() {
      assert.deepEqual(writer.toWorkerData(), descriptor); assert.deepEqual(fork.toWorkerData(), forkDescriptor);
      const current = S.getWorkerData({ source: writer, fork }, { copy: false });
      assert.equal(current.arenas[0].used, used);
      assert.equal(hash(new Uint8Array(memory.buffer, HEAP_START, used - HEAP_START)), bytesHash);
    },
    expectedDigest: hash(JSON.stringify({ fixture, streamKeys, expected: expected.map(canonical) })),
    fixture: {
      count: spec.count, requestCount: keys.length, distinctKeys: new Set(keys).size, method: spec.method,
      mode: spec.mode, state: spec.state, hitCount: keys.filter(key => oracle.has(key)).length,
      distinctRequestsPerBatch: streaming ? spec.repetitions * keys.length : new Set(keys).size,
      sourceBytes: used - HEAP_START, sourceBytesHash: bytesHash,
      unit: `${keys.length} complete scalar ${spec.method} calls plus result-array creation and retention`,
      readState: spec.state === 'cold' ? 'a fresh read-only Arena per operation; construction outside timing; no requested key was read before timing'
        : streaming ? 'one fresh read-only Arena per batch; every queried key in the batch is distinct; all query strings are created before timing'
        : spec.state === 'full' ? 'one warm read-only reader; 256 unrelated misses consume the candidate admission budget before timing'
        : spec.state === 'warm-after-miss' ? 'one warm read-only reader; an absent query is read before priming successful queries, exercising the lazy-field shape'
        : 'one read-only reader; all requested queries are primed before timing',
      alternatingRoots: alternating ? 'same absent query revisits alternating published roots every 16 requests' : null,
      oracle: 'every returned scalar against an independent native Map; both published descriptors, writer allocation frontier and all published bytes unchanged',
      excluded: 'imports, source construction, query creation, warm-cache priming or cold-reader construction, all output verification and source-byte hashing',
    },
  };
}
