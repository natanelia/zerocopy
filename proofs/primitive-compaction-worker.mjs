import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import * as S from '../dist/shared.js';

function valuesOf(value) {
  if (!(value instanceof S.SharedQueue)) return value.toArray();
  const result = [];
  while (value.size) { result.push(value.peek()); value = value.dequeue(); }
  return result;
}

if (!isMainThread) {
  const attached = await S.initWorker(workerData);
  const expected = Object.fromEntries(Object.entries(attached).filter(([key]) => key !== 'nested').map(([key, value]) => [key, valuesOf(value)]));
  parentPort.postMessage('attached');
  await once(parentPort, 'message');
  const result = S.compactMany(attached);
  for (const [key, values] of Object.entries(expected)) {
    assert.deepEqual(valuesOf(attached[key]), values);
    assert.deepEqual(valuesOf(result[key]), values);
  }
  assert.deepEqual(result.nested.get('numbers').toArray(), expected.listNumber);
  assert.throws(() => attached.listNumber.push(1), /read-only/);
  assert.equal(result.listNumber.push(999).get(result.listNumber.size), 999);
  parentPort.postMessage(S.getWorkerData(result, { copy: true }));
} else {
  for (const copy of [false, true]) {
    const snapshots = {};
    for (const [type, suffix] of [['number', 'Number'], ['boolean', 'Boolean']]) {
      const values = Array.from({ length: 1091 }, (_, i) => type === 'number' ? i % 7 ? i : -0 : i % 3 === 0);
      snapshots[`list${suffix}`] = new S.SharedList(type).pushMany(values);
      let queue = new S.SharedQueue(type), linked = new S.SharedLinkedList(type), doubly = new S.SharedDoublyLinkedList(type);
      for (const value of values) { queue = queue.enqueue(value); linked = linked.append(value); doubly = doubly.append(value); }
      for (let i = 0; i < 37; i++) { queue = queue.dequeue(); linked = linked.removeFirst(); doubly = doubly.removeFirst(); }
      snapshots[`queue${suffix}`] = queue;
      snapshots[`linked${suffix}`] = linked;
      snapshots[`doubly${suffix}`] = doubly;
    }
    snapshots.nested = new S.SharedMap('SharedList<number>').set('numbers', snapshots.listNumber);
    const data = S.getWorkerData(snapshots, { copy });
    const before = new Map(data.arenas.map(source => [source.id, new Uint8Array(source.memory?.buffer ?? source.copy.buffer, 65536, source.used - 65536).slice()]));
    const worker = new Worker(new URL(import.meta.url), { workerData: data });
    try {
      assert.deepEqual(await once(worker, 'message'), ['attached']);
      // Growth occurs after the child attaches; old published bytes stay valid.
      snapshots.listNumber.pushMany(Array.from({ length: 65537 }, (_, i) => i));
      const reply = once(worker, 'message'); worker.postMessage('compact');
      const [payload] = await reply, restored = await S.initWorker(payload);
      for (const [key, value] of Object.entries(snapshots)) {
        if (key === 'nested') assert.deepEqual(restored.nested.get('numbers').toArray(), value.get('numbers').toArray());
        else assert.deepEqual(valuesOf(restored[key]), valuesOf(value));
      }
      for (const source of data.arenas) assert.equal(Buffer.compare(new Uint8Array(source.memory?.buffer ?? source.copy.buffer, 65536, source.used - 65536), before.get(source.id)), 0);
    } finally { await worker.terminate(); }
    console.log(`Primitive compaction worker passed, copy=${copy}`);
  }
}
