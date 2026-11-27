import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { applySpatialEdits, buildSpatialIndex, createSpatialQueryCursor, prepareSpatialQuery, querySpatialIndex } from '../../dist/spatial.js';

const size = 16_384, side = 128, steps = 64, editsPerStep = 4, pansPerStep = 3;
function box(slot, width = 0.25) {
  const x = slot % side, y = Math.floor(slot / side);
  return [x, y, x + width, y + width];
}
const features = Array.from({ length: size }, (_, id) => ({ id, bounds: box(id) }));
const base = buildSpatialIndex(features);
const modes = ['direct', 'prepared', 'cursor'];
const median = samples => samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];

function workload(editedIds) {
  const rows = new Map(features.map(f => [f.id, f.bounds]));
  // Each eighth handle is an insertion outside the original tile ID range.
  const handle = i => i % 8 === 0 ? size + i : (i * 7) % size;
  function edit(i, slot, remove) {
    const id = handle(i), bounds = remove ? null : box(slot % size);
    if (bounds) rows.set(id, bounds); else rows.delete(id);
    return { id, bounds };
  }
  const seed = applySpatialEdits(undefined, 1, Array.from({ length: editedIds }, (_, i) =>
    edit(i, i * 11 + 3, i % 5 === 1)));
  let changes = seed;
  const frames = [];
  for (let step = 0; step < steps; step++) {
    const revision = 2 + step;
    const edits = Array.from({ length: editsPerStep }, (_, j) =>
      edit((step * 37 + j * 3) % editedIds, (step * 397 + j * 71), (step + j) % 7 === 0));
    changes = applySpatialEdits(changes, revision, edits);
    const pans = Array.from({ length: pansPerStep }, (_, j) => box((step * 397 + j * 971) % size, 7));
    const expected = pans.map(([x0, y0, x1, y1]) => {
      const ids = [];
      for (const [id, b] of rows) if (b[0] <= x1 && b[1] <= y1 && b[2] >= x0 && b[3] >= y0) ids.push(id);
      return ids.sort((a, b) => a - b);
    });
    frames.push({ changes, revision, pans, expected });
  }
  return { seed, frames };
}

function trial(mode, { seed, frames }) {
  const start = performance.now();
  let cursor, prepared;
  if (mode === 'cursor') {
    cursor = createSpatialQueryCursor(base);
    cursor.advance(seed, 1);
  } else if (mode === 'prepared') prepared = prepareSpatialQuery(base, seed, 1);
  const setupMs = performance.now() - start;
  let advanceMs = 0, searchMs = 0;
  for (const { changes, revision, pans, expected } of frames) {
    const before = performance.now();
    if (cursor) cursor.advance(changes, revision);
    else if (prepared) prepared = prepareSpatialQuery(base, changes, revision);
    const ready = performance.now();
    const hits = pans.map(pan => cursor ? cursor.search(pan) : prepared
      ? querySpatialIndex(prepared, pan) : querySpatialIndex(base, pan, changes));
    const end = performance.now();
    advanceMs += ready - before;
    searchMs += end - ready;
    assert.deepEqual(hits, expected);
  }
  return { setupMs, advanceMs: advanceMs / steps, searchMs: searchMs / steps, revisionMs: (advanceMs + searchMs) / steps };
}

function compare(editedIds) {
  const fixture = workload(editedIds), trials = [];
  for (let round = 0; round < 9; round++) {
    const times = {};
    for (let j = 0; j < modes.length; j++) {
      const mode = modes[(j + round) % modes.length];
      times[mode] = trial(mode, fixture);
    }
    if (round >= 2) trials.push(times);
  }
  const summary = Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(
    Object.keys(trials[0][mode]).map(key => [key, median(trials.map(t => t[mode][key]))]),
  )]));
  return { editedIds, summary, trials };
}

const sha256 = url => createHash('sha256').update(readFileSync(url)).digest('hex');
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, platform: process.platform,
  driverSHA256: sha256(new URL(import.meta.url)), spatialSourceSHA256: sha256(new URL('../../spatial.ts', import.meta.url)),
  features: size, steps, editsPerStep, pansPerStep, cases: [16, 256, 2048].map(compare) }, null, 2));
