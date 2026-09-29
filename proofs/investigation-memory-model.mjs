import assert from 'node:assert/strict';

export const MEMORY_SCHEMA = 'zerocopy-investigation-memory/v1';
export const KINDS = ['shared', 'immutable', 'native', 'centralized'];
export const FIXTURES = ['repeated', 'unique', 'unicode'];
export const STAGES = ['loaded', 'queried', 'append-retained', 'released', 'streamed'];
export const METHOD = 'Sum of post-GC JavaScript heap and tracked ArrayBuffer deltas across the controller, owner, and every reader, plus current unique shared WASM buffer capacity counted once. Empty, imported workers are the baseline. Includes caches, spare WASM capacity and unreclaimed arena history. External memory is retained as a diagnostic, not added twice. Not browser memory, RSS, virtual reservation, or peak temporary allocation.';
export function validateCase(value) {
  assert.ok(KINDS.includes(value.kind), 'Unknown architecture');
  assert.ok(FIXTURES.includes(value.fixture), 'Unknown fixture');
  assert.ok([0, 1, 2, 4].includes(value.readers), 'Readers must be 0, 1, 2, or 4');
  assert.ok(value.kind !== 'centralized' || value.readers === 0, 'Centralized has no replicas');
  assert.ok(Number.isSafeInteger(value.entries) && value.entries >= 1000 && value.entries <= 100000, 'Invalid initial count');
  return value;
}
/** Same fixtures as the text-search proof, applied to every architecture. */
export function decorateColumns(columns, start, fixture) {
  assert.ok(FIXTURES.includes(fixture));
  if (fixture !== 'repeated') columns.message = columns.message.map((text, offset) =>
    (fixture === 'unicode' && (start + offset) % 5 === 0 ? '追跡 ' : '') + text + ' [event ' + (start + offset) + ']');
  return columns;
}
export function totals(threads) {
  assert.ok(threads.length >= 1);
  assert.equal(new Set(threads.map(t => t.role)).size, threads.length, 'Duplicate thread');
  const arenas = new Map();
  let heapUsed = 0, arrayBuffers = 0, external = 0;
  for (const thread of threads) {
    for (const field of ['heapUsed', 'arrayBuffers', 'external']) assert.ok(Number.isFinite(thread.usage[field]) && thread.usage[field] >= 0, `Missing ${field}`);
    heapUsed += thread.usage.heapUsed; arrayBuffers += thread.usage.arrayBuffers; external += thread.usage.external;
    for (const arena of thread.arenas) {
      assert.ok(typeof arena.id === 'string' && arena.id);
      assert.ok(Number.isSafeInteger(arena.capacityBytes) && arena.capacityBytes >= 131072);
      assert.ok(Number.isSafeInteger(arena.usedBytes) && arena.usedBytes >= 65536 && arena.usedBytes <= arena.capacityBytes);
      const prior = arenas.get(arena.id);
      if (prior) {
        assert.equal(prior.capacityBytes, arena.capacityBytes, 'All readers must see the current memory size');
        prior.usedBytes = Math.max(prior.usedBytes, arena.usedBytes);
      } else arenas.set(arena.id, { ...arena });
    }
  }
  const unique = [...arenas.values()];
  return { heapUsed, arrayBuffers, external, wasmCapacityBytes: unique.reduce((sum, a) => sum + a.capacityBytes, 0),
    arenaUsedBytes: unique.reduce((sum, a) => sum + a.usedBytes, 0), arenaCount: unique.length, arenas: unique };
}
export function compareMemory(before, after) {
  const b = totals(before), a = totals(after);
  // Keep signed changes. A negative component is measurement noise, not zero.
  const heapDelta = a.heapUsed - b.heapUsed, arrayBufferDelta = a.arrayBuffers - b.arrayBuffers;
  const retainedBytes = heapDelta + arrayBufferDelta + a.wasmCapacityBytes;
  return { ...a, heapDelta, arrayBufferDelta, retainedBytes, resolved: retainedBytes > 0 };
}
export function median(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite));
  const sorted = [...values].sort((a,b) => a-b), mid = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid])/2;
}
