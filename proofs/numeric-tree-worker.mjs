import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedList, getWorkerData, initWorker } from '../dist/shared.js';
import { countInRange } from '../dist/numeric.js';

const bounds = [[-Infinity, Infinity], [-0, 0], [-1000, 1000], [Infinity, Infinity]];
if (!isMainThread) {
  const { original } = await initWorker(workerData.data);
  assert.throws(() => original.push(1));
  parentPort.on('message', () => {
    for (let round = 0; round < 512; round++) {
      for (let i = 0; i < bounds.length; i++) {
        assert.equal(countInRange(original, ...bounds[i]), workerData.expected[i]);
      }
    }
    parentPort.postMessage('checked');
  });
  parentPort.postMessage('ready');
} else {
  const edge = [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE];
  const values = Array.from({ length: 32801 }, (_, i) => i % 31 === 0 ? edge[Math.floor(i / 31) % edge.length] : i % 2001 - 1000);
  const original = new SharedList('number').pushMany(values);
  const expected = bounds.map(([lo, hi]) => values.reduce((n, value) => n + Number(value >= lo && value <= hi), 0));
  const data = getWorkerData({ original }, { copy: false });
  const memory = data.arenas[0].memory;
  const initialBytes = memory.buffer.byteLength;
  const worker = new Worker(new URL(import.meta.url), { workerData: { data, expected } });
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
    const duringGrowth = response(); worker.postMessage('read');
    const fork = original.set(32768, Infinity).pop();
    const changed = original.pushMany(Array.from({ length: 524288 }, () => 777)).set(0, 123456);
    assert.ok(memory.buffer.byteLength > initialBytes, 'The owner must grow shared memory');
    assert.equal(await duringGrowth, 'checked');
    const afterGrowth = response(); worker.postMessage('read');
    assert.equal(await afterGrowth, 'checked');
    for (let i = 0; i < bounds.length; i++) assert.equal(countInRange(original, ...bounds[i]), expected[i]);
    assert.equal(countInRange(changed, 123456, 123456), 1);
    assert.equal(countInRange(fork, Infinity, Infinity), expected[3] + 1 - Number(values[32768] === Infinity) - Number(values.at(-1) === Infinity));
    console.log('Numeric tree worker proof passed: partial depth-three tree, IEEE values, retained snapshots, fork, and memory growth.');
  } finally { await worker.terminate(); }
}
