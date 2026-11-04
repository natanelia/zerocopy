import assert from 'node:assert/strict';
import { workerData, parentPort } from 'node:worker_threads';
import { initWorker } from '../dist/shared.js';

const { text } = await initWorker(workerData.payload);
const contains = text.compileTextSearch(workerData.term);
assert.throws(() => text.push('reader write'), /read-only/);
parentPort.once('message', () => {
  let count = 0;
  for (let index = 0; index < text.size; index++) {
    const found = contains(index);
    assert.equal(found, text.get(index).includes(workerData.term));
    count += Number(found);
  }
  assert.equal(contains(-1), false);
  assert.equal(contains(text.size), false);
  parentPort.postMessage({ count });
});
parentPort.postMessage({ ready: true });
