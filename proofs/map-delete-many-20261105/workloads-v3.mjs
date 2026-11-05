import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'map-delete-many-20261105-v3',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['arena.ts', 'persistent-core.as.ts', 'shared-map.ts'],
  changedWasm: ['persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm', 'linked-list.wasm',
    'singly-linked-list.wasm', 'doubly-linked-list.wasm', 'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm'],
  primaryCases: ['delete-1024-of-4096', 'delete-4096-of-16384'],
  secondaryCases: ['unicode-256-of-2048'],
  aaCases: ['delete-1024-of-4096', 'small-four-control', 'small-eight-control', 'missing-control', 'scalar-delete-control'],
  pilotCases: ['delete-1024-of-4096', 'delete-4096-of-16384', 'small-four-control', 'missing-control', 'scalar-delete-control'],
  cases: [
    { name: 'delete-1024-of-4096', role: 'target', size: 4096, count: 1024, construction: 'bulk', operation: 'deleteMany', repetitions: 8 },
    { name: 'delete-4096-of-16384', role: 'target', size: 16384, count: 4096, construction: 'scalar', operation: 'deleteMany', repetitions: 4 },
    { name: 'unicode-256-of-2048', role: 'target', size: 2048, count: 256, construction: 'bulk', unicode: true, operation: 'deleteMany', repetitions: 16 },
    { name: 'small-four-control', role: 'boundary', size: 128, count: 4, construction: 'bulk', operation: 'deleteMany', repetitions: 256, minimumWarmupMs: 150 },
    { name: 'small-eight-control', role: 'boundary', size: 128, count: 8, construction: 'bulk', operation: 'deleteMany', repetitions: 256, minimumWarmupMs: 150 },
    { name: 'small-sixteen-control', role: 'boundary', size: 128, count: 16, construction: 'bulk', operation: 'deleteMany', repetitions: 256, minimumWarmupMs: 150 },
    { name: 'missing-control', role: 'control', size: 1024, count: 128, construction: 'bulk', missing: true, operation: 'deleteMany', repetitions: 128 },
    { name: 'hit-then-misses-control', role: 'control', size: 1024, count: 1024, construction: 'bulk', hitsThenMisses: 4, operation: 'deleteMany', repetitions: 32 },
    { name: 'empty-control', role: 'boundary', size: 128, count: 0, construction: 'bulk', operation: 'deleteMany', repetitions: 262144 },
    { name: 'long-key-control', role: 'fallback', size: 64, count: 7, construction: 'bulk', long: true, operation: 'deleteMany', repetitions: 4 },
    { name: 'scalar-delete-control', role: 'unchanged control', size: 128, count: 1, construction: 'bulk', operation: 'delete', repetitions: 1024, minimumWarmupMs: 150 },
    { name: 'bulk-set-control', role: 'unchanged control', size: 1024, count: 256, construction: 'bulk', operation: 'setMany', repetitions: 16 },
  ],
};

function hashKey(key) {
  let result = 2166136261;
  for (const byte of new TextEncoder().encode(key)) result = Math.imul(result ^ byte, 16777619);
  return result >>> 0;
}
// HAMT iteration follows low-to-high four-bit hash digits. Exact collisions
// retain input insertion order, as Array.sort does for equal comparisons.
function hashOrder(entries) {
  return entries.map(([key, value]) => ({ key, value, hash: hashKey(key) })).sort((a, b) => {
    for (let shift = 0; shift < 32; shift += 4) {
      const difference = ((a.hash >>> shift) & 15) - ((b.hash >>> shift) & 15);
      if (difference) return difference;
    }
    return 0;
  }).map(({ key, value }) => [key, value]);
}
function checkEntries(map, expected) {
  assert.ok(Object.isFrozen(map)); assert.equal(map.valueType, 'number'); assert.equal(map.size, expected.length);
  let index = 0;
  map.forEach((value, key) => {
    assert.ok(index < expected.length); assert.equal(key, expected[index][0]); assert.equal(value, expected[index][1]); index++;
  });
  assert.equal(index, expected.length);
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const keyAt = i => spec.unicode ? `route/界/🙂/${i}` : `key-${i}`;
  const input = Array.from({ length: spec.size }, (_, i) => [keyAt(i), i + 0.25]);
  let keys = Array.from({ length: spec.count }, (_, i) => spec.missing || spec.hitsThenMisses !== undefined && i >= spec.hitsThenMisses
    ? `absent-${i}` : keyAt((i * 73) % spec.size));
  if (spec.long) {
    const longA = 'a'.repeat(49153), longB = '界'.repeat(17000);
    input.push([longA, -1], [longB, -2]);
    keys = ['key-0', longA, 'key-1', longA, 'key-2', longB, 'key-3'];
  }
  const updates = keys.map((key, index) => [key, -index - 0.5]);
  const original = new Map(input), model = new Map(original);
  if (spec.operation === 'setMany') for (const [key, value] of updates) model.set(key, value);
  else for (const key of keys) model.delete(key);
  const expected = hashOrder([...model]), initialExpected = hashOrder(input);
  const identity = spec.missing || keys.length === 0;
  const samples = [];
  let source, memory, sourceUsed, sourceBytes, verified = 0;
  function prepare() {
    S.resetMap(); source = new S.SharedMap('number');
    if (spec.construction === 'scalar') for (const [key, value] of input) source = source.set(key, value);
    else source = source.setMany(input);
    checkEntries(source, initialExpected);
    const arena = S.getWorkerData({ source }, { copy: false }).arenas[0];
    memory = arena.memory; sourceUsed = arena.used;
    sourceBytes = new Uint8Array(memory.buffer, 65536, sourceUsed - 65536).slice();
  }
  prepare();
  return {
    operation: spec.operation === 'delete' ? () => source.delete(keys[0])
      : spec.operation === 'setMany' ? () => source.setMany(updates) : () => source.deleteMany(keys),
    verify(result) {
      assert.ok(result instanceof S.SharedMap);
      if (identity) assert.strictEqual(result, source);
      else checkEntries(result, expected);
      verified++;
    },
    checkInvariant() {
      assert.deepEqual(new Uint8Array(memory.buffer, 65536, sourceBytes.length), sourceBytes);
      if (!verified) return;
      const current = S.getWorkerData({ source }, { copy: false }).arenas[0];
      assert.strictEqual(current.memory, memory); assert.ok(current.used >= sourceUsed);
      const allocatedBytes = current.used - sourceUsed;
      if (identity) assert.equal(allocatedBytes, 0);
      samples.push({ operations: verified, allocatedBytes, allocatedBytesPerOperation: allocatedBytes / verified,
        sourceBytes: sourceBytes.length, capacityBytes: memory.buffer.byteLength });
      verified = 0; prepare();
    },
    expectedDigest: createHash('sha256').update(JSON.stringify({ input, expected, keys, updates })).digest('hex'),
    fixture: { size: input.length, operation: spec.operation, keys: keys.length, uniqueKeys: new Set(keys).size,
      construction: spec.construction, resultSize: expected.length, unicode: !!spec.unicode, long: !!spec.long,
      hitsThenMisses: spec.hitsThenMisses ?? null,
      reset: 'fresh source before each timed batch; setup and oracle verification excluded',
      retained: 'every returned snapshot retained until full verification after the timed batch' },
    observations: () => samples,
  };
}
