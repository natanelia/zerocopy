import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedList, getWorkerData, initWorker } from '../dist/shared.js';
import { countPointsInBox } from '../dist/numeric.js';
const bounds = { minX: 0, minY: 0, maxX: 2, maxY: 2 };
if (!isMainThread) {
  const { points } = await initWorker(workerData);
  parentPort.on('message', () => {
    let count = 0;
    for (let i = 0; i < 10000; i++) count = countPointsInBox(points, bounds);
    parentPort.postMessage(count);
  });
  parentPort.postMessage('ready');
} else {
  let points = new SharedList('number').pushMany(Array.from({ length: 34 }, () => 1));
  const old = points;
  const worker = new Worker(new URL(import.meta.url), { workerData: getWorkerData({ points }, { copy: false }) });
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
    const reading = response(); worker.postMessage('read');
    points = points.pushMany(Array.from({ length: 32768 }, () => 1)).set(0, 99).set(1, 99);
    assert.equal(await reading, 17);
    const next = response(); worker.postMessage('read-after-growth');
    assert.equal(await next, 17);
    assert.equal(countPointsInBox(old, bounds), 17);
    assert.equal(countPointsInBox(points, { minX: 99, minY: 99, maxX: 99, maxY: 99 }), 1);
    console.log('Spatial worker proof passed: immutable snapshots, append, edit, and growth.');
  } finally { await worker.terminate(); }
}
