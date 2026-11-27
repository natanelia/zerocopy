import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import * as H from './worker-fixtures.mjs';

const directory = isMainThread ? resolve(process.argv[2] ?? '.') : workerData.directory;
const S = { ...await import(pathToFileURL(join(directory, 'dist/shared.js'))),
  ...await import(pathToFileURL(join(directory, 'dist/numeric.js'))) };
if (!isMainThread) {
  const handle = H.createWorkerHandler(S, result => parentPort.postMessage(result), new Int32Array(workerData.control));
  parentPort.on('message', async message => {
    try { parentPort.postMessage(await handle(message)); }
    catch (error) { parentPort.postMessage({ ok: false, error: error.stack ?? String(error) }); }
  });
  parentPort.postMessage({ type: 'ready' });
} else {
  const checks = [], writer = H.reentrantWriter(S);
  function receive(worker, type, send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Worker proof timed out: ${type}`)), 25000);
      const message = result => { if (result.ok === false || result.type === type) finish(result.ok === false ? new Error(result.error) : null, result); };
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
  for (const copy of [false, true]) {
    const original = H.fixture(S), bytes = H.capture(S, original.structures);
    const controlBuffer = new SharedArrayBuffer(4), control = new Int32Array(controlBuffer);
    const worker = new Worker(new URL(import.meta.url), { workerData: { directory, control: controlBuffer } });
    try {
      await receive(worker, 'ready');
      const payload = S.getWorkerData(original.structures, { copy });
      await receive(worker, 'paused', () => worker.postMessage({ type: 'initial', payload, expected: original.expected }));
      const updated = H.editAndGrow(S, original.structures, original.expected);
      const resumed = receive(worker, 'scanned');
      Atomics.store(control, 0, 1); Atomics.notify(control, 0);
      const first = await resumed;
      const second = await receive(worker, 'complete', () => worker.postMessage({ type: 'updated',
        payload: S.getWorkerData(updated.structures, { copy }), expected: updated.expected }));
      H.verify(S, original.structures, original.expected); H.unchanged(bytes);
      checks.push({ transport: copy ? 'copy' : 'shared', first, second });
    } finally { Atomics.store(control, 0, 1); Atomics.notify(control, 0); await worker.terminate(); }
  }
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const bundles = Object.fromEntries(readdirSync(join(directory, 'dist')).filter(name => name.endsWith('.js')).sort()
    .map(name => [name, sha(readFileSync(join(directory, 'dist', name)))]));
  console.log(JSON.stringify({ runtime: process.versions, date: new Date().toISOString(),
    source: sha(readFileSync(join(directory, 'numeric.ts'))),
    wasm: sha(readFileSync(join(directory, 'persistent-core.wasm'))), bundles,
    driver: sha(readFileSync(new URL(import.meta.url))),
    fixtures: sha(readFileSync(new URL('./worker-fixtures.mjs', import.meta.url))),
    writer, checks, timingMeasurements: false }, null, 2));
}
