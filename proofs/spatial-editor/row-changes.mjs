import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedMap, getWorkerData, initWorker } from '../../dist/shared.js';

const count = 16384;
const row = (id, revision) => ({ id, revision, bounds: [id, revision, id + 1, revision + 1] });

// The fixture increments revision on every persisted row edit. This gives the
// scan a cheap equality test without serializing or deeply comparing metadata.
function* scan(previous, current) {
  for (const [key, after] of current.entries()) {
    const before = previous.get(key);
    if (!before || after.revision !== before.revision) {
      yield { type: before ? 'update' : 'insert', key, before, after };
    }
  }
  for (const key of previous.keys()) {
    if (!current.has(key)) yield { type: 'delete', key, before: previous.get(key), after: undefined };
  }
}

if (!isMainThread) {
  const { previous, current } = await initWorker(workerData.shared);
  const oldCopy = (await initWorker(workerData.oldCopy)).previous;
  const newCopy = (await initWorker(workerData.newCopy)).current;
  const methods = {
    sharedDiff: () => current.changesSince(previous),
    copiedDiff: () => newCopy.changesSince(oldCopy),
    fullScan: () => scan(previous, current),
  };
  const names = Object.keys(methods);
  const samplesMs = { sharedDiff: [], copiedDiff: [], fullScan: [] };
  for (let round = 0; round < 12; round++) {
    for (let index = 0; index < names.length; index++) {
      const name = names[(round + index) % names.length];
      const start = performance.now();
      const changes = Array.from(methods[name]());
      const ms = performance.now() - start;
      if (round >= 3) samplesMs[name].push(ms);
      changes.sort((a, b) => Number(a.key) - Number(b.key));
      assert.deepEqual(changes, workerData.expected);
    }
  }
  parentPort.postMessage(samplesMs);
} else {
  const previous = new SharedMap('object').setMany(Array.from({ length: count }, (_, id) => [String(id), row(id, 0)]));
  const cases = [];
  for (const changed of [0, 8, 4096]) {
    let current = previous;
    const expected = [];
    for (let i = 0; i < changed; i++) {
      const id = (i * 67) % count, key = String(id);
      if (i % 4 === 0) {
        current = current.delete(key);
        expected.push({ type: 'delete', key, before: row(id, 0), after: undefined });
      } else if (i % 4 === 1) {
        const newId = count + id, after = row(newId, 2);
        current = current.set(String(newId), after);
        expected.push({ type: 'insert', key: String(newId), before: undefined, after });
      } else {
        current = current.set(key, row(id, 1)).set(key, row(id, 2));
        expected.push({ type: 'update', key, before: row(id, 0), after: row(id, 2) });
      }
    }
    expected.sort((a, b) => Number(a.key) - Number(b.key));
    const reader = new Worker(new URL(import.meta.url), { workerData: {
      shared: getWorkerData({ previous, current }, { copy: false }),
      oldCopy: getWorkerData({ previous }, { copy: true }),
      newCopy: getWorkerData({ current }, { copy: true }), expected,
    } });
    try {
      const [samplesMs] = await once(reader, 'message');
      cases.push({ changed, samplesMs });
    } finally { await reader.terminate(); }
  }
  const sourceHashes = {};
  for (const file of ['shared-map.ts', 'arena.ts', 'proofs/spatial-editor/row-changes.mjs']) {
    sourceHashes[file] = createHash('sha256').update(readFileSync(new URL('../../' + file, import.meta.url))).digest('hex');
  }
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, count, sourceHashes, cases }));
}
