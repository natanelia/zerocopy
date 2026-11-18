// Retained JSON array cursors in independent readers, before and after growth.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as lib from '../../dist/shared.js';

function image(payload) {
  return payload.arenas.map(arena => new Uint8Array(arena.memory.buffer).slice());
}
function unchanged(payload, before) {
  for (let index = 0; index < before.length; index++) {
    const actual = new Uint8Array(payload.arenas[index].memory.buffer);
    assert.deepEqual(actual, before[index], 'Reader changed shared bytes or capacity');
  }
}
const count = 4096;

if (!isMainThread) {
  try {
    const before = image(workerData.payload);
    const { data } = await lib.initWorker(workerData.payload);
    const first = data.getView('record').get('items');
    const second = data.getView('record').get('items');
    for (let index = 0; index < 1024; index++) assert.equal(first.at(index), index);
    assert.equal(second.at(3072), 3072);
    unchanged(workerData.payload, before);
    parentPort.postMessage({ ready: true });
    const [message] = await once(parentPort, 'message');
    const afterGrowth = image(message.payload);
    for (let index = 1024; index < count; index++) assert.equal(first.at(index), index);
    assert.equal(first.at(count), undefined, 'Array end must not enter the following sibling');
    for (const index of [count - 1, 0, 1, 3000, 2, 2, 4095]) {
      assert.equal(first.at(index), index);
      assert.equal(second.at(count - 1 - index), count - 1 - index);
    }
    const { data: changed } = await lib.initWorker(message.payload);
    assert.equal(changed.getView('record').get('items').at(0), -1);
    assert.equal(data.get('record').items.length, count);
    assert(Object.isFrozen(data.get('record').items));
    unchanged(message.payload, afterGrowth);
    parentPort.postMessage({ ok: true, retainedCount: count, sharedBytesUnchanged: true });
  } catch (error) {
    parentPort.postMessage({ error: error.stack });
    process.exitCode = 1;
  }
} else {
  lib.resetMap();
  const data = new lib.SharedMap('object').set('record', {
    items: Array.from({ length: count }, (_, index) => index), after: [99999],
  });
  const payload = lib.getWorkerData({ data }, { copy: false });
  const capacity = payload.arenas[0].memory.buffer.byteLength;
  const workers = Array.from({ length: 2 }, () => new Worker(new URL(import.meta.url), { workerData: { payload } }));
  const reply = async worker => {
    const [message] = await once(worker, 'message');
    if (message.error) throw new Error(message.error);
    return message;
  };
  const timeout = setTimeout(() => { throw new Error('JSON array worker proof timed out'); }, 15000);
  try {
    for (const result of await Promise.all(workers.map(reply))) assert.equal(result.ready, true);
    const changed = data.set('padding', { text: 'x'.repeat(capacity + 65536) })
      .set('record', { items: [-1], after: [-2] });
    const next = lib.getWorkerData({ data: changed }, { copy: false });
    assert(next.arenas[0].memory.buffer.byteLength > capacity);
    const done = workers.map(reply);
    for (const worker of workers) worker.postMessage({ payload: next });
    for (const result of await Promise.all(done)) assert.equal(result.ok, true);
    console.log(JSON.stringify({ ok: true, node: process.version, readers: workers.length,
      retainedArrayLength: count, initialCapacity: capacity,
      finalCapacity: next.arenas[0].memory.buffer.byteLength,
      sharedBytesUnchanged: true, cursorsSurviveGrowth: true }));
  } finally {
    clearTimeout(timeout);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}
