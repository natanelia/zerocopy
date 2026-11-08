import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, fixture, edited, grow, verifySnapshots, createWorkerHandler } from './worker-fixtures.mjs';

const directory = isMainThread ? resolve(process.argv[2] ?? '.') : workerData.directory;
const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
if (!isMainThread) {
  const handle = createWorkerHandler(S);
  parentPort.on('message', async message => {
    try { parentPort.postMessage({ id: message.id, ...await handle(message.payload, message.expected) }); }
    catch (error) { parentPort.postMessage({ id: message.id, ok: false, error: error.stack ?? String(error) }); }
  });
  parentPort.postMessage({ ready: true });
} else {
  const checks = [];
  let id = 0;
  function receive(worker, predicate, send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Worker proof timed out')), 20000);
      const message = result => { if (predicate(result)) finish(result.ok === false ? new Error(result.error) : null, result); };
      const error = caught => finish(caught);
      function finish(error, value) {
        clearTimeout(timer); worker.off('message', message); worker.off('error', errorHandler);
        if (error) reject(error); else resolve(value);
      }
      const errorHandler = error;
      worker.on('message', message); worker.on('error', errorHandler);
      send?.();
    });
  }
  async function send(worker, structures, expected, copy) {
    const payload = S.getWorkerData(structures, { copy }), requestId = ++id;
    return receive(worker, value => value.id === requestId,
      () => worker.postMessage({ id: requestId, payload, expected }, payload.arenas.flatMap(arena => arena.copy ? [arena.copy.buffer] : [])));
  }
  for (const copy of [false, true]) {
    const original = fixture(S), worker = new Worker(new URL(import.meta.url), { workerData: { directory } });
    try {
      await receive(worker, result => result.ready === true);
      const first = await send(worker, original.structures, original.expected, copy);
      grow(S, original.structures);
      const updated = edited(S, original.structures, original.expected);
      verifySnapshots(S, original.structures, original.expected);
      verifySnapshots(S, updated.structures, updated.expected);
      const second = await send(worker, updated.structures, updated.expected, copy);
      assert(first.ok && second.ok, 'Both worker versions verified');
      checks.push({ transport: copy ? 'copy' : 'shared', first, second });
    } finally { await worker.terminate(); }
  }
  console.log(JSON.stringify({ runtime: process.version, checks, timingMeasurements: false }, null, 2));
}
