// Long selected JSON strings in shared and copied readers across owner growth.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as lib from '../../dist/shared.js';

function image(snapshot) {
  return lib.getWorkerData({ data: snapshot }, { copy: false }).arenas.map(arena => ({
    memory: arena.memory, used: arena.used, bytes: Buffer.from(new Uint8Array(arena.memory.buffer)),
  }));
}
function unchanged(snapshot, before) {
  const after = lib.getWorkerData({ data: snapshot }, { copy: false }).arenas;
  assert.equal(after.length, before.length);
  for (let index = 0; index < after.length; index++) {
    assert.equal(after[index].used, before[index].used, 'Reader allocated shared bytes');
    assert.equal(after[index].memory.buffer.byteLength, before[index].bytes.length, 'Reader grew memory');
    assert.ok(Buffer.from(after[index].memory.buffer).equals(before[index].bytes), 'Reader changed shared bytes');
  }
}
function verify(view, expected) {
  for (let round = 0; round < 64; round++) {
    for (const key of ['ascii', 'unicode', 'escaped']) assert.equal(view.get(key), expected[key]);
    assert.equal(view.get('target'), expected.target);
  }
}

if (!isMainThread) {
  try {
    const { data } = await lib.initWorker(workerData.payload);
    const retained = data.getView('record'), before = image(data);
    verify(retained, workerData.expected);
    unchanged(data, before);
    parentPort.postMessage({ ready: true });
    const [message] = await once(parentPort, 'message');
    const grown = image(data);
    verify(retained, workerData.expected);
    const { data: updated } = await lib.initWorker(message.payload);
    const updatedBefore = image(updated);
    verify(updated.getView('record'), message.expected);
    assert.equal(data.get('record').ascii, workerData.expected.ascii);
    assert.ok(Object.isFrozen(data.get('record')));
    unchanged(data, grown);
    unchanged(updated, updatedBefore);
    parentPort.postMessage({ ok: true, copy: workerData.copy, sharedBytesUnchanged: true });
  } catch (error) {
    parentPort.postMessage({ error: error.stack });
    process.exitCode = 1;
  }
} else {
  lib.resetMap();
  const expected = {
    ascii: 'ordinary text '.repeat(1024), unicode: '道路🙂'.repeat(2048),
    escaped: 'x"\\\n'.repeat(2048), target: 37,
  };
  const data = new lib.SharedMap('object').set('record', expected);
  const capacity = lib.getWorkerData({ data }, { copy: false }).arenas[0].memory.buffer.byteLength;
  const modes = [false, true];
  const workers = modes.map(copy => new Worker(new URL(import.meta.url), {
    workerData: { copy, expected, payload: lib.getWorkerData({ data }, { copy }) },
  }));
  const reply = async worker => {
    const [message] = await once(worker, 'message');
    if (message.error) throw new Error(message.error);
    return message;
  };
  const timeout = setTimeout(() => { throw new Error('Selected JSON string worker proof timed out'); }, 20000);
  try {
    for (const result of await Promise.all(workers.map(reply))) assert.equal(result.ready, true);
    const updatedExpected = { ascii: 'changed', unicode: '変更🙂', escaped: 'changed\n', target: -1 };
    const changed = data.set('padding', { text: 'x'.repeat(capacity + 65536) }).set('record', updatedExpected);
    const finalCapacity = lib.getWorkerData({ data: changed }, { copy: false }).arenas[0].memory.buffer.byteLength;
    assert(finalCapacity > capacity);
    const before = image(changed), done = workers.map(reply);
    for (let index = 0; index < workers.length; index++) workers[index].postMessage({
      payload: lib.getWorkerData({ data: changed }, { copy: modes[index] }), expected: updatedExpected,
    });
    for (const result of await Promise.all(done)) assert.equal(result.ok, true);
    unchanged(changed, before);
    console.log(JSON.stringify({ ok: true, node: process.version, readers: workers.length,
      modes: ['shared', 'copied'], initialCapacity: capacity, finalCapacity,
      retainedSelectedStrings: ['ascii', 'unicode', 'escaped'], sharedBytesUnchanged: true }));
  } finally {
    clearTimeout(timeout);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}
