import assert from 'node:assert/strict';
import { once } from 'node:events';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import * as S from '../../dist/shared.js';
import { createZerocopyCodec } from '../../dist/redux.js';

const codec = createZerocopyCodec();
const envelope = (kind, type, values) => ({ $zerocopyRedux: 1, value: ['c', kind, type, null, values] });
function verify(snapshots, expected) {
  const before = S.getWorkerData(snapshots, { copy: true });
  for (const [name, sequence] of Object.entries(snapshots)) {
    const result = codec.encode(sequence);
    assert.deepEqual(result, expected[name]); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(sequence));
    assert.equal(codec.stringify(sequence), JSON.stringify(expected[name]));
  }
  const after = S.getWorkerData(snapshots, { copy: true });
  for (let i = 0; i < before.arenas.length; i++) {
    assert.equal(after.arenas[i].used, before.arenas[i].used);
    assert.deepEqual(after.arenas[i].copy, before.arenas[i].copy);
  }
}

if (!isMainThread) {
  let old;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'initial') {
        old = await S.initWorker(message.payload);
        verify(old, workerData.expected);
        assert.throws(() => old.stack.push(-1), /read-only/);
        assert.throws(() => old.queue.enqueue(-1), /read-only/);
        parentPort.postMessage({ type: 'ready' });
      } else if (message.type === 'updated') {
        const next = await S.initWorker(message.payload);
        verify(old, workerData.expected); verify(next, message.expected); verify(old, workerData.expected);
        parentPort.postMessage({ type: 'complete' });
      }
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  for (const copy of [false, true]) {
    S.resetStack(); S.resetQueue();
    let stack = new S.SharedStack('number'), queue = new S.SharedQueue('number');
    let boolStack = new S.SharedStack('boolean'), boolQueue = new S.SharedQueue('boolean');
    const values = Array.from({ length: 4097 }, (_, i) => i / 4);
    const queueValues = Array.from({ length: 5154 }, (_, i) => i / 4);
    const booleans = Array.from({ length: 65 }, (_, i) => i % 3 === 0);
    for (const value of values) stack = stack.push(value);
    for (const value of queueValues) queue = queue.enqueue(value);
    for (let i = 0; i < 1057; i++) queue = queue.dequeue();
    for (const value of booleans) { boolStack = boolStack.push(value); boolQueue = boolQueue.enqueue(value); }
    const snapshots = { stack, queue, boolStack, boolQueue };
    const expected = {
      stack: envelope('SharedStack', 'number', [...values].reverse()),
      queue: envelope('SharedQueue', 'number', queueValues.slice(1057)),
      boolStack: envelope('SharedStack', 'boolean', [...booleans].reverse()),
      boolQueue: envelope('SharedQueue', 'boolean', booleans),
    };
    const worker = new Worker(new URL(import.meta.url), { workerData: { expected } });
    const timer = setTimeout(() => { console.error('Redux sequence worker proof timed out'); process.exit(1); }, 30000);
    const receive = async type => {
      const [message] = await once(worker, 'message');
      if (message.error) throw new Error(message.error);
      assert.equal(message.type, type);
    };
    try {
      const ready = receive('ready');
      worker.postMessage({ type: 'initial', payload: S.getWorkerData(snapshots, { copy }) });
      await ready;
      for (const arena of S.getWorkerData(snapshots, { copy: false }).arenas) {
        const oldBuffer = arena.memory.buffer;
        arena.memory.grow(2); assert.notEqual(arena.memory.buffer, oldBuffer);
      }
      const next = { stack: stack.push(-1), queue: queue.dequeue().enqueue(-1),
        boolStack: boolStack.pop().push(true), boolQueue: boolQueue.dequeue().enqueue(false) };
      const nextExpected = {
        stack: envelope('SharedStack', 'number', [-1, ...values.slice().reverse()]),
        queue: envelope('SharedQueue', 'number', [...queueValues.slice(1058), -1]),
        boolStack: envelope('SharedStack', 'boolean', [true, ...booleans.slice(0, -1).reverse()]),
        boolQueue: envelope('SharedQueue', 'boolean', [...booleans.slice(1), false]),
      };
      const completed = receive('complete');
      worker.postMessage({ type: 'updated', payload: S.getWorkerData(next, { copy }), expected: nextExpected });
      await completed; verify(snapshots, expected); verify(next, nextExpected);
      console.log(`${copy ? 'copy' : 'shared'} Redux sequence worker: complete numeric/boolean outputs, old roots and bytes preserved across owner edits/growth`);
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
}
