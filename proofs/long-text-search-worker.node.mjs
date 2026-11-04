import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { SharedList, getWorkerData, resetSharedList } from '../dist/shared.js';

test('long searches keep compiled shared and copied snapshots in real Node workers after growth', { timeout: 15000 }, async () => {
  resetSharedList();
  const term = 'request-processing-completed-for-map-validation';
  const values = Array.from({ length: 1025 }, (_, i) => `event ${i} ` + 'ordinary data '.repeat(20) + (i % 3 ? 'unchanged' : term));
  const text = new SharedList('string').pushMany(values);
  const memory = getWorkerData({ text }, { copy: false }).arenas[0].memory;
  const oldBytes = memory.buffer.byteLength;
  const workers = [false, true].map(copy => new Worker(new URL('./long-text-search-worker.mjs', import.meta.url), {
    workerData: { payload: getWorkerData({ text }, { copy }), term },
  }));
  const receive = worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  try {
    assert.deepEqual(await Promise.all(workers.map(receive)), [{ ready: true }, { ready: true }]);
    text.set(0, 'replacement snapshot').pushMany(Array.from({ length: 60000 }, (_, i) => `growing ${i} `.repeat(8)));
    assert.ok(memory.buffer.byteLength > oldBytes);
    resetSharedList(); new SharedList('string').push('replacement arena');
    const pending = workers.map(receive);
    for (const worker of workers) worker.postMessage('scan');
    assert.deepEqual(await Promise.all(pending), [false, true].map(() => ({ count: values.filter(value => value.includes(term)).length })));
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
});
