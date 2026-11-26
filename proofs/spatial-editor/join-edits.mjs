import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { applySpatialEdits, buildSpatialIndex, diffSpatialJoin, prepareSpatialQuery, querySpatialJoin } from '../../dist/spatial.js';

const count = 4096;
const point = id => [id % 64, Math.floor(id / 64), id % 64, Math.floor(id / 64)];
const left = buildSpatialIndex(Array.from({ length: count }, (_, id) => ({ id, bounds: point(id) })));
const right = buildSpatialIndex(Array.from({ length: count / 2 }, (_, id) => ({
  id, bounds: [...point(id * 2).slice(0, 2), ...point(id * 2 + 1).slice(2)],
})));
const before = { left, right };
const initial = new Set(querySpatialJoin(left, right).map(String));
for (const changed of [1, 32, count]) {
  const edits = Array.from({ length: changed }, (_, i) => {
    const id = i * 67 % count;
    return { id, before: point(id), after: point((id + 2) % count) };
  });
  const overlay = applySpatialEdits(undefined, 1, edits.map(({ id, after }) => ({ id, bounds: after })));
  const after = { left: prepareSpatialQuery(left, overlay, 1), right };
  const full = () => querySpatialJoin(after.left, right);
  const incremental = () => diffSpatialJoin(before, after, { left: edits });
  const { added, removed } = incremental();
  const patched = new Set(initial);
  for (const pair of removed) assert.ok(patched.delete(String(pair)));
  for (const pair of added) patched.add(String(pair));
  assert.deepEqual(patched, new Set(full().map(String)));
  assert.equal(added.length, changed);
  assert.equal(removed.length, changed);
  const samples = { full: [], incremental: [] };
  for (let round = 0; round < 17; round++) {
    const modes = Object.entries({ full, incremental });
    for (const [name, query] of round % 2 ? modes.reverse() : modes) {
      const start = performance.now();
      for (let i = 0; i < 8; i++) query();
      if (round >= 4) samples[name].push((performance.now() - start) / 8);
    }
  }
  const median = times => times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)];
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, left: count, right: count / 2,
    changed, fullMs: median(samples.full), incrementalMs: median(samples.incremental), samples }));
}
