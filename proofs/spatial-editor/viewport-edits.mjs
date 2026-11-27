import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpus } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { createCollection } from '@tanstack/db';
import peer from '@tanstack/db/package.json' with { type: 'json' };
import { buildSpatialIndex, diffSpatialViewport, querySpatialIndex } from '../../dist/spatial.js';
import { viewportCollectionConfig } from '../../dist/tanstack-db-collection.js';

const count = 4096, viewport = [0, 0, 31, 63];
function bounds(id, moved = false) {
  const x = moved ? 63 - id % 64 : id % 64, y = Math.floor(id / 64);
  return [x, y, x, y];
}

if (!isMainThread) {
  const { before, after, edits } = workerData;
  const undo = edits.map(edit => ({ id: edit.id, before: edit.after, after: edit.before }));
  parentPort.on('message', ({ method, reverse }) => {
    const result = method === 'full' ? querySpatialIndex(reverse ? before : after, viewport)
      : diffSpatialViewport(viewport, reverse ? undo : edits);
    parentPort.postMessage(result);
  });
  parentPort.postMessage('ready');
} else {
  const cases = [];
  for (const changed of [1, 32, count]) cases.push(await compare(changed));
  console.log(JSON.stringify({ node: process.version, tanstack: peer.version, cpu: cpus()[0].model, count, viewport, cases }));
}

async function compare(changed) {
  const edits = Array.from({ length: changed }, (_, i) => {
    const id = i * 67 % count;
    return { id, before: bounds(id), after: bounds(id, true) };
  });
  const changedIds = new Set(edits.map(edit => edit.id));
  const rows = Array.from({ length: count }, (_, id) => ({ id, bounds: bounds(id) }));
  const updated = rows.map(row => changedIds.has(row.id) ? { id: row.id, bounds: bounds(row.id, true) } : row);
  const visibleIds = rows => rows.filter(row => row.bounds[0] <= viewport[2]).map(row => row.id);
  const initial = visibleIds(rows), next = visibleIds(updated);
  const reader = new Worker(new URL(import.meta.url), { workerData: {
    before: buildSpatialIndex(rows), after: buildSpatialIndex(updated, 1), edits,
  } });
  const visible = createCollection(viewportCollectionConfig({ id: 'visible-' + changed }));
  const samplesMs = { full: [], incremental: [] };
  try {
    assert.deepEqual(await once(reader, 'message'), ['ready']);
    await visible.preload();
    await visible.utils.setVisibleIds(initial);
    for (let round = 0; round < 12; round++) {
      const methods = Object.keys(samplesMs);
      for (const method of round % 2 ? methods.reverse() : methods) {
        let elapsed = 0;
        for (const reverse of [false, true]) {
          const expected = reverse ? initial : next, version = visible.utils.getVersion();
          const start = performance.now();
          const reply = once(reader, 'message').then(([value]) => value);
          reader.postMessage({ method, reverse });
          const applied = method === 'full' ? await visible.utils.setVisibleIds(reply)
            : await visible.utils.applyVisibleChanges(reply, version);
          elapsed += performance.now() - start;
          assert.equal(applied, true);
          assert.deepEqual([...visible.keys()].sort((a, b) => a - b), expected);
          const result = await reply;
          assert.equal(method === 'full' ? result.length : result.added.length + result.removed.length,
            method === 'full' ? expected.length : changed);
        }
        if (round >= 3) samplesMs[method].push(elapsed / 2);
      }
    }
    return { changed, fullReplyIds: [next.length, initial.length], deltaReplyIds: changed, samplesMs };
  } finally { await reader.terminate(); await visible.cleanup(); }
}
