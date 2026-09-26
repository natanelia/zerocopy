import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedList, getWorkerData, initWorker } from '../dist/shared.js';
import { countInRange } from '../dist/numeric.js';
if (!isMainThread) {
  const { list } = await initWorker(workerData);
  parentPort.on('message', () => {
    let result = 0;
    for (let i = 0; i < 10000; i++) result = countInRange(list, 0, 2);
    parentPort.postMessage(result);
  });
  parentPort.postMessage('ready');
} else {
  let list = new SharedList('number').pushMany(Array.from({ length: 33 }, () => 1));
  const old = list, data = getWorkerData({ list }, { copy: false });
  const worker = new Worker(new URL(import.meta.url), { workerData: data });
  function response() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Worker response timed out')); }, 15000);
      const message = value => { cleanup(); resolve(value); };
      const error = reason => { cleanup(); reject(reason); };
      const exit = code => { cleanup(); reject(new Error(`Worker exited before response: ${code}`)); };
      function cleanup() { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); }
      worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
    });
  }
  try {
    assert.equal(await response(), 'ready');
    const first = response(); worker.postMessage('read');
    list = list.pushMany(Array.from({ length: 32768 }, () => 1)).set(0, 99);
    assert.equal(await first, 33);
    const second = response(); worker.postMessage('read-after-growth');
    assert.equal(await second, 33);
    assert.equal(countInRange(old, 0, 2), 33);
    assert.equal(countInRange(list, 99, 99), 1);
    console.log('Numeric worker proof passed: read-only snapshot, append, fork, and growth.');
  } finally { await worker.terminate(); }
}
