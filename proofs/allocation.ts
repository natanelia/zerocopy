import assert from 'node:assert/strict';
import { SharedMap, resetMap } from '../shared-map';
import { arenaOf, HEAP_START } from '../arena';
const seed = Array.from({ length: 32768 }, (_, i) => [`lane:${i}`, i] as [string, number]);
const updates = Array.from({ length: 4096 }, (_, i) => [`lane:${i * 7}`, -i - 1] as [string, number]);
function measure(bulk: boolean) {
  resetMap(); const original = new SharedMap('number').setMany(seed), a = arenaOf(original);
  const before = a.used, prefix = a.buf.slice(HEAP_START, before);
  let next = original;
  if (bulk) next = next.setMany(updates); else for (const [key, value] of updates) next = next.set(key, value);
  const allocated = a.used - before;
  assert.deepEqual(a.buf.slice(HEAP_START, before), prefix);
  for (const [key, value] of seed) assert.equal(original.get(key), value);
  const reference = new Map(seed); for (const [key, value] of updates) reference.set(key, value);
  assert.deepEqual(new Map(next.entries()), reference);
  return allocated;
}
const scalarBytes = measure(false), fusedBatchBytes = measure(true);
assert(fusedBatchBytes < scalarBytes);
console.log(JSON.stringify({ seedSize: seed.length, updateCount: updates.length, scalarBytes, fusedBatchBytes, reduction: 1 - fusedBatchBytes / scalarBytes, snapshotBytesPreserved: true }));
