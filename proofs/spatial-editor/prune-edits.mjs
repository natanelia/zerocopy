import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { getWorkerData, resetMap } from '../../dist/shared.js';
import { applySpatialEdits, pruneSpatialEdits } from '../../dist/spatial.js';

// Measure just the owner's work installing a completed rebuild. Each trial
// starts with a fresh writer and the same captured overlay and later edits.
const count = 16_384, warmup = 2, trials = 7;
const capturedEdits = Array.from({ length: count }, (_, id) => ({ id, bounds: [id, 0, id + 1, 1] }));
function scanAndDelete(changes, cutoff) {
  const obsolete = [];
  for (const [id, change] of changes.entries()) if (change.revision <= cutoff) obsolete.push(id);
  return obsolete.length ? changes.deleteMany(obsolete) : changes;
}
const methods = { scanAndDelete, prune: (live, cutoff) => pruneSpatialEdits(live, cutoff), captured: pruneSpatialEdits };
const names = Object.keys(methods);
const used = map => getWorkerData({ map }, { copy: false }).arenas[0].used;
function run(newerCount) {
  const newer = Array.from({ length: newerCount }, (_, i) => ({
    id: i % 4 === 3 ? count + i : i,
    bounds: i % 4 === 1 ? null : [count - i, 0, count - i + 1, 1],
  }));
  const results = Object.fromEntries(names.map(name => [name, []]));
  for (let trial = 0; trial < warmup + trials; trial++) {
    for (let offset = 0; offset < names.length; offset++) {
      const name = names[(trial + offset) % names.length];
      resetMap();
      const captured = applySpatialEdits(undefined, 10, capturedEdits);
      const live = applySpatialEdits(captured, 11, newer);
      const before = used(live), start = performance.now();
      const result = methods[name](live, 10, captured);
      const ms = performance.now() - start, allocated = used(result) - before;
      assert.equal(result.size, newerCount);
      for (const { id, bounds } of newer) {
        assert.deepEqual(result.get(String(id)), { revision: 11, bounds });
      }
      assert.deepEqual(captured.get('0'), { revision: 10, bounds: [0, 0, 1, 1] });
      if (trial >= warmup) results[name].push({ ms, arenaBytes: allocated });
    }
  }
  return { newerCount, results };
}
console.log(JSON.stringify({ node: process.version, bun: process.versions.bun, cpu: cpus()[0].model,
  capturedCount: count, warmup, trials, cases: [0, 8, 8192].map(run) }, null, 2));
