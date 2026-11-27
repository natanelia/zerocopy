import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { SharedList, resetSharedList } from '../../dist/shared.js';
import { bboxXY, lineStringViewXY, pathIntersectsBoxXY } from '../../dist/geometry.js';
import { buildLineStringIndex, buildSpatialIndex, querySpatialIndex } from '../../dist/spatial.js';

// Input is already imported. All three builds see the same shared Float64 bytes.
const rows = 4096, points = 64;
const ids = Uint32Array.from({ length: rows }, (_, i) => i + 100);
const offsets = new Int32Array(new SharedArrayBuffer((rows + 1) * 4));
const coordinates = new Float64Array(new SharedArrayBuffer(rows * points * 16));
for (let row = 0; row < rows; row++) {
  offsets[row + 1] = (row + 1) * points;
  for (let j = 0; j < points; j++) {
    const i = (row * points + j) * 2;
    coordinates[i] = row % 64 * 16 + j * 0.25;
    coordinates[i + 1] = Math.floor(row / 64) * 16 + Math.sin(j * 0.1) * 4;
  }
}
const paths = { coordinates, offsets, validity: null };
const batches = [{ paths, ids }];
const view = row => lineStringViewXY(paths, row);
function fromRows(editable) {
  return buildSpatialIndex(Array.from(ids, (id, row) => {
    const xy = view(row);
    const path = editable ? new SharedList('number').pushMany(xy) : xy;
    return { id, bounds: bboxXY(path) };
  }));
}
const builders = {
  packed: () => buildLineStringIndex(batches),
  boxedViews: () => fromRows(false),
  copiedLists: () => fromRows(true),
};
const boxes = [[400, 241, 550, 267], [0, 0, 0, 0], [-50, -50, -20, -20], [0, 125, 1024, 185]];
const expected = boxes.map(box => Array.from(ids).filter((_, row) => pathIntersectsBoxXY(view(row), box)));
const reference = fromRows(false);
const candidates = boxes.map(box => querySpatialIndex(reference, box));
const samplesMs = { packed: [], boxedViews: [], copiedLists: [] };
const names = Object.keys(builders);
for (let round = 0; round < 21; round++) {
  for (let m = 0; m < names.length; m++) {
    const name = names[(round + m) % names.length];
    if (name === 'copiedLists') resetSharedList();
    const start = performance.now();
    const index = builders[name]();
    const elapsed = performance.now() - start;
    if (round >= 6) samplesMs[name].push(elapsed);
    for (const [i, box] of boxes.entries()) {
      const hits = querySpatialIndex(index, box);
      assert.deepEqual(hits, candidates[i]);
      assert.deepEqual(hits.filter(id => pathIntersectsBoxXY(view(id - 100), box)), expected[i]);
    }
  }
}
const median = times => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
console.log(JSON.stringify({ runtime: process.versions.bun ? 'Bun ' + process.versions.bun : 'Node ' + process.version,
  cpu: cpus()[0].model, rows, pointsPerRow: points, coordinateBytes: coordinates.byteLength, warmupRounds: 6,
  medianMs: Object.fromEntries(names.map(name => [name, median(samplesMs[name])])), samplesMs }));
