import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpus } from 'node:os';
import { MessageChannel, Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCollection, createTransaction } from '@tanstack/db';
import peer from '@tanstack/db/package.json' with { type: 'json' };
import { getWorkerData, initWorker } from '../../dist/shared.js';
import { sharedCollectionConfig } from '../../dist/tanstack-db-collection.js';
import { connectSharedSession, createSharedSession } from '../../dist/worker.js';

const count = 16384, edits = 8;
const key = i => String(i * 67);
const row = (id, revision) => ({ id, revision, bounds: [Number(id), revision, Number(id) + 1, revision + 1] });
const envelope = rows => getWorkerData({ rows }, { copy: false });

if (!isMainThread) {
  const reader = await connectSharedSession({ endpoint: workerData.port });
  let priorSession = reader.current;
  let priorMessage = (await initWorker(workerData.initial)).rows;
  parentPort.on('message', async ({ version, payload, round }) => {
    try {
      const message = (await initWorker(payload, { previous: { rows: priorMessage } })).rows;
      if (reader.version < version) {
        await new Promise(resolve => {
          const stop = reader.subscribe((_, sequence) => {
            if (sequence >= version) { stop(); resolve(); }
          });
        });
      }
      assert.equal(reader.version, version);
      const current = reader.current;
      const pairs = { session: [priorSession, current], message: [priorMessage, message] };
      const timings = {}, sharedMemoryHandle = {};
      const expected = Array.from({ length: edits }, (_, i) => ({
        type: 'update', key: key(i), before: row(key(i), version - 2), after: row(key(i), version),
      }));
      for (const name of round % 2 ? ['message', 'session'] : ['session', 'message']) {
        const [before, after] = pairs[name];
        const start = performance.now();
        const changes = [...after.changesSince(before)];
        timings[name] = performance.now() - start;
        assert.deepEqual(changes.sort((a, b) => Number(a.key) - Number(b.key)), expected);
        sharedMemoryHandle[name] = envelope(before).arenas[0].memory === envelope(after).arenas[0].memory;
      }
      priorSession = current;
      priorMessage = message;
      parentPort.postMessage({ timings, sharedMemoryHandle });
    } catch (error) { parentPort.postMessage({ error: String(error.stack ?? error) }); }
  });
  parentPort.postMessage('ready');
} else {
  const options = sharedCollectionConfig({ id: 'lanes', initialData: Array.from({ length: count }, (_, i) => row(String(i), 0)) });
  const lanes = createCollection(options);
  await lanes.preload();
  const session = createSharedSession({ source: options }, { copy: false });
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { port: port2, initial: envelope(options.getSnapshot()) }, transferList: [port2],
  });
  try {
    const ready = once(worker, 'message');
    await session.connect(port1);
    assert.deepEqual(await ready, ['ready']);
    const samplesMs = [], handles = [];
    for (let round = 0; round < 16; round++) {
      for (let step = 1; step <= 2; step++) {
        const revision = 2 * round + step;
        const tx = createTransaction({ autoCommit: false, mutationFn: ({ transaction }) => options.utils.acceptMutations(transaction) });
        tx.mutate(() => {
          for (let i = 0; i < edits; i++) lanes.update(key(i), draft => {
            draft.revision = revision;
            draft.bounds = row(key(i), revision).bounds;
          });
        });
        await tx.commit();
      }
      assert.equal(session.version, 2 * (round + 1));
      const reply = once(worker, 'message');
      worker.postMessage({ version: session.version, payload: envelope(options.getSnapshot()), round });
      const [result] = await reply;
      if (result.error) throw new Error(result.error);
      assert.equal(result.sharedMemoryHandle.session, true);
      if (round >= 4) { samplesMs.push(result.timings); handles.push(result.sharedMemoryHandle); }
    }
    console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, tanstack: peer.version,
      rows: count, netEdits: edits, commitsPerComparison: 2, samplesMs, handles }));
  } finally { session.dispose(); port1.close(); await worker.terminate(); await lanes.cleanup(); }
}
