import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import * as S from '../dist/shared.js';

function readAll(s, readOnly = true) {
  assert.equal(s.map.get('old'), 7);
  assert.equal(s.largeList.get(2048), 2048);
  assert.equal(s.largeLinked.get(2048), 2048);
  assert.equal(s.largeDoubly.get(2048), 2048);
  assert.equal(s.largeQueue.size, 2049);
  assert.equal(s.largeQueue.peek(), 0);
  assert.deepEqual(s.list.toArray(), [1, 2, 3]);
  assert.deepEqual(new Set(s.set.values()), new Set([1, '1']));
  assert.equal(s.stack.peek(), 2);
  assert.equal(s.queue.peek(), 1);
  assert.deepEqual(s.linked.toArray(), [1, 2]);
  assert.deepEqual(s.doubly.toArrayReverse(), [2, 1]);
  assert.deepEqual([...s.ordered.entries()], [['b', 2], ['a', 1]]);
  assert.deepEqual([...s.orderedSet.values()], ['b', 'a']);
  assert.deepEqual([...s.sorted.entries()], [['a', 1], ['b', 2]]);
  assert.deepEqual([...s.sortedSet.values()], ['a', 'b']);
  assert.equal(s.heap.peek(), 20);
  assert.deepEqual(s.nested.get('list').toArray(), [1, 2, 3]);
  if (readOnly) {
    assert.throws(() => s.list.push(8), /read-only/);
    assert.throws(() => s.map.set('new', 8), /read-only/);
    assert.throws(() => s.nested.get('list').push(8), /read-only/);
  }
}

if (!isMainThread) {
  let old;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'initial') {
        old = await S.initWorker(message.data);
        readAll(old);
        // This test-only scratch word is outside all collection payloads. A write
        // seen by the parent proves shared backing, not merely equal data copies.
        const source = message.data.arenas.find(a => a.id === message.data.structures.map.arena);
        Atomics.store(new Int32Array(source.memory.buffer), 15000, 37);
        parentPort.postMessage({ type: 'ready' });
      } else if (message.type === 'concurrent') {
        const control = new Int32Array(workerData.control);
        Atomics.store(control, 0, 1); Atomics.notify(control, 0);
        for (let i = 0; i < 10000 || Atomics.load(control, 1) === 0; i++) {
          assert.equal(old.largeList.get(i % 2049), i % 2049);
          assert.equal(old.largeLinked.get(i % 2049), i % 2049);
          assert.equal(old.largeDoubly.get(i % 2049), i % 2049);
          assert.equal(old.map.get('old'), 7);
          assert.deepEqual(old.list.toArray(), [1, 2, 3]);
        }
        parentPort.postMessage({ type: 'concurrent-ok' });
      } else if (message.type === 'new') {
        const next = await S.initWorker(message.data);
        assert.equal(next.map.get('old'), 8);
        assert.equal(next.map.get('long'), '🙂'.repeat(18000));
        assert.equal(next.map.size, 5002);
        assert.equal(next.largeList.size, 6145); assert.equal(next.largeList.get(6144), 6144);
        assert.equal(next.largeLinked.get(6144), 6144); assert.equal(next.largeDoubly.get(6144), 6144);
        assert.equal(next.largeQueue.size, 6145);
        readAll(old);
        parentPort.postMessage({ type: 'ok', oldValue: old.map.get('old'), nextValue: next.map.get('old') });
      }
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  const list = new S.SharedList('number').pushMany([1, 2, 3]);
  const large = Array.from({ length: 2049 }, (_, i) => i);
  let largeLinked = new S.SharedLinkedList('number'), largeDoubly = new S.SharedDoublyLinkedList('number'), largeQueue = new S.SharedQueue('number');
  for (const value of large) { largeLinked = largeLinked.append(value); largeDoubly = largeDoubly.append(value); largeQueue = largeQueue.enqueue(value); }
  let largeList = new S.SharedList('number').pushMany(large);
  const items = { largeList, largeLinked, largeDoubly, largeQueue,
    map: new S.SharedMap('object').set('old', 7), list,
    set: new S.SharedSet().add(1).add('1'),
    stack: new S.SharedStack('number').push(1).push(2),
    queue: new S.SharedQueue('number').enqueue(1).enqueue(2),
    linked: new S.SharedLinkedList('number').append(1).append(2),
    doubly: new S.SharedDoublyLinkedList('number').append(1).append(2),
    ordered: new S.SharedOrderedMap('number').set('b', 2).set('a', 1),
    orderedSet: new S.SharedOrderedSet().add('b').add('a'),
    sorted: new S.SharedSortedMap('number').set('b', 2).set('a', 1),
    sortedSet: new S.SharedSortedSet().add('b').add('a'),
    heap: new S.SharedPriorityQueue('number').enqueue(10, 2).enqueue(20, 1),
    nested: new S.SharedMap('SharedList<number>').set('list', list),
  };
  const control = new SharedArrayBuffer(8);
  const worker = new Worker(new URL(import.meta.url), { workerData: { control } });
  const timer = setTimeout(() => { console.error('Worker proof timed out'); process.exit(1); }, 30000);
  async function exchange(message) {
    const response = once(worker, 'message'); worker.postMessage(message);
    const [result] = await response; if (result.error) throw new Error(result.error); return result;
  }
  try {
    const initial = S.getWorkerData(items, { copy: false });
    assert(initial.arenas.every(a => a.memory && !a.copy));
    assert.equal((await exchange({ type: 'initial', data: initial })).type, 'ready');
    const arena = initial.arenas.find(a => a.id === initial.structures.map.arena);
    assert.equal(Atomics.load(new Int32Array(arena.memory.buffer), 15000), 37);
    const response = once(worker, 'message'); worker.postMessage({ type: 'concurrent' });
    assert.notEqual(Atomics.wait(new Int32Array(control), 0, 0, 10000), 'timed-out');
    const next = items.map.setMany(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])).set('old', 8).set('long', '🙂'.repeat(18000));
    for (let i = 2049; i < 6145; i++) { largeList = largeList.push(i); largeLinked = largeLinked.append(i); largeDoubly = largeDoubly.append(i); largeQueue = largeQueue.enqueue(i); }
    Atomics.store(new Int32Array(control), 1, 1);
    const [concurrent] = await response; if (concurrent.error) throw new Error(concurrent.error);
    assert.equal(concurrent.type, 'concurrent-ok');
    S.resetMap(); S.resetSharedList();
    const result = await exchange({ type: 'new', data: S.getWorkerData({ map: next, largeList, largeLinked, largeDoubly, largeQueue }, { copy: false }) });
    assert.equal(result.type, 'ok'); readAll(items, false);
    console.log(JSON.stringify({ passed: true, runtime: process.version, structures: 12, nested: true, concurrentReadsAtLeast: 10000, largeRetainedSequences: 4, workerSharesBackingMemory: true, repeatedAttachment: true, resetKeepsOldSnapshots: true }));
  } finally { clearTimeout(timer); await worker.terminate(); }
}
