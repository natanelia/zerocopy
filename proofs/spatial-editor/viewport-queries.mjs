import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { applySpatialEdits, buildSpatialIndex, prepareSpatialQuery, querySpatialIndex, rebuildSpatialIndex } from '../../dist/spatial.js';

// One tile, a stationary edit snapshot, and repeatable panning paths.
const count = 16_384, side = 128;
function bounds(id) {
  const x = id % side, y = Math.floor(id / side);
  return [x, y, x + 0.25, y + 0.25];
}
const initial = Array.from({ length: count }, (_, id) => ({ id, bounds: bounds(id) }));
const base = buildSpatialIndex(initial);
const pans = Array.from({ length: 96 }, (_, i) => {
  const x = i * 37 % 120, y = i * 17 % 120;
  return [x, y, x + 7, y + 7];
});
const wide = [[0, 0, 128, 128], [0, 0, 90, 100], [30, 30, 128, 128], [10, 10, 120, 120]];
const shapes = { pans, wide };
const modes = ['scan', 'prepared', 'rebuilt'];
function median(values) { return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]; }
function bytes(index) { return index.ids.byteLength + (index.buffer?.byteLength ?? 0); }
function timeBuild(fn) {
  const started = performance.now(), index = fn();
  return { index, ms: performance.now() - started };
}

function compare(editCount) {
  const edits = Array.from({ length: editCount }, (_, i) => ({
    id: i % 5 === 0 ? count + i : i * 7 % count,
    bounds: i % 5 === 1 ? null : bounds((i * 11 + 3) % count),
  }));
  const changes = applySpatialEdits(undefined, 1, edits);
  const rows = new Map(initial.map(row => [row.id, row.bounds]));
  for (const { id, bounds } of edits) {
    if (bounds) rows.set(id, bounds);
    else rows.delete(id);
  }
  const expected = new Map();
  for (const box of [...pans, ...wide]) {
    expected.set(box, [...rows].filter(([, b]) =>
      b[0] <= box[2] && b[1] <= box[3] && b[2] >= box[0] && b[3] >= box[1])
      .map(([id]) => id).sort((a, b) => a - b));
  }
  const trials = [];
  let preparedBytes, rebuiltBytes;
  for (let round = 0; round < 9; round++) {
    const trial = {};
    for (let offset = 0; offset < modes.length; offset++) {
      const mode = modes[(round + offset) % modes.length];
      let index = base, overlay, buildMs = 0;
      if (mode === 'prepared') {
        ({ index, ms: buildMs } = timeBuild(() => prepareSpatialQuery(base, changes, 1)));
        preparedBytes = index.changedIds.byteLength + bytes(index.updates);
      } else if (mode === 'rebuilt') {
        ({ index, ms: buildMs } = timeBuild(() => rebuildSpatialIndex(base, changes, 1)));
        rebuiltBytes = bytes(index);
      } else overlay = changes;
      trial[mode] = { buildMs };
      for (const [name, windows] of Object.entries(shapes)) {
        if (round === 0) {
          for (const box of windows) assert.deepEqual(querySpatialIndex(index, box, overlay), expected.get(box));
        }
        let hits = 0;
        const start = performance.now();
        for (const box of windows) hits += querySpatialIndex(index, box, overlay).length;
        trial[mode][name + 'Ms'] = (performance.now() - start) / windows.length;
        assert.equal(hits, windows.reduce((sum, box) => sum + expected.get(box).length, 0));
      }
    }
    if (round >= 2) trials.push(trial);
  }
  const summary = Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(
    ['buildMs', 'pansMs', 'wideMs'].map(metric => [metric, median(trials.map(trial => trial[mode][metric]))])
  )]));
  return { editCount, preparedBytes, rebuiltBytes, trials, summary };
}

console.log(JSON.stringify({ cpu: cpus()[0].model, node: process.version, platform: process.platform,
  featureCount: count, panCount: pans.length, wideCount: wide.length, cases: [16, 256, 2048].map(compare) }, null, 2));
