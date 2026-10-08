import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const S = await import(process.env.POINTER_MODULE ? pathToFileURL(resolve(process.env.POINTER_MODULE)).href : new URL('../dist/shared.js', import.meta.url).href);

function values(snapshot) {
  if (snapshot instanceof S.SharedStack || snapshot instanceof S.SharedQueue) {
    const result = [];
    while (snapshot.size) { result.push(snapshot.peek()); snapshot = snapshot instanceof S.SharedStack ? snapshot.pop() : snapshot.dequeue(); }
    return result;
  }
  if (snapshot instanceof S.SharedPriorityQueue || snapshot instanceof S.SharedMap || snapshot instanceof S.SharedOrderedMap || snapshot instanceof S.SharedSortedMap) return [...snapshot.entries()];
  return snapshot.toArray();
}

if (!isMainThread) {
  const first = await S.initWorker(workerData), second = await S.initWorker(workerData);
  const expected = Object.fromEntries(Object.entries(first).filter(([name]) => name !== 'nested').map(([name, snapshot]) => [name, values(snapshot)]));
  parentPort.postMessage('attached');
  await once(parentPort, 'message');
  const mixed = { ...first, more: second.more, pushed: second.pushed, changed: second.changed };
  const result = S.compactMany(mixed);
  for (const [name, expectedValues] of Object.entries(expected)) {
    assert.deepEqual(values(first[name]), expectedValues);
    assert.deepEqual(values(result[name]), expectedValues);
  }
  assert.deepEqual(result.nested.get('list').toArray(), expected.list);
  assert.deepEqual(result.nested.get('list').toWorkerData(), result.list.toWorkerData());
  assert.equal(result.pushed.pop().head, result.stack.head);
  assert.throws(() => first.list.push('no'), /read-only/);
  assert.equal(result.list.push('yes').get(result.list.size), 'yes');
  const payload = S.getWorkerData(result, { copy: true });
  assert.equal(payload.arenas.length, 1);
  const view = new DataView(payload.arenas[0].copy.buffer);
  assert.equal(view.getFloat64(result.list.toWorkerData().tail, true), view.getFloat64(result.more.toWorkerData().tail, true));
  parentPort.postMessage(payload);
} else {
  for (const copy of [false, true]) {
    const list = new S.SharedList('string').pushMany(['same', 'other']), more = list.push('third');
    const stack = new S.SharedStack('string').push('bottom').push('top'), pushed = stack.push('new');
    const map = new S.SharedMap('object').setMany([['a', { i: 1 }], ['b', { i: 2 }]]), changed = map.set('c', { i: 3 });
    let heap = new S.SharedPriorityQueue('string'), ordered = new S.SharedOrderedMap('string'), sorted = new S.SharedSortedMap('string');
    let queue = new S.SharedQueue('string'), linked = new S.SharedLinkedList('string'), doubly = new S.SharedDoublyLinkedList('object');
    for (let i = 0; i < 65; i++) {
      heap = heap.enqueue(`v${i}`, i % 11); ordered = ordered.set(`k${i}`, `v${i}`); sorted = sorted.set(`k${i}`, `v${i}`);
      queue = queue.enqueue(`v${i}`); linked = linked.append(`v${i}`); doubly = doubly.append({ i });
    }
    queue = queue.dequeue(); linked = linked.removeFirst(); doubly = doubly.removeFirst(); ordered = ordered.delete('k0');
    const nested = new S.SharedMap('SharedList<string>').set('list', list);
    const snapshots = { list, more, stack, pushed, map, changed, heap, ordered, sorted, queue, linked, doubly, nested };
    const payload = S.getWorkerData(snapshots, { copy });
    const before = payload.arenas.map(a => new Uint8Array(a.memory?.buffer ?? a.copy.buffer, 65536, a.used - 65536).slice());
    const worker = new Worker(new URL(import.meta.url), { workerData: payload });
    try {
      assert.deepEqual(await once(worker, 'message'), ['attached']);
      list.push('🙂'.repeat(40000)); map.set('growth', { text: 'x'.repeat(160000) });
      const reply = once(worker, 'message'); worker.postMessage('compact');
      const [data] = await reply, restored = await S.initWorker(data);
      for (const [name, snapshot] of Object.entries(snapshots)) {
        if (name === 'nested') assert.deepEqual(restored.nested.get('list').toArray(), list.toArray());
        else assert.deepEqual(values(restored[name]), values(snapshot));
      }
      payload.arenas.forEach((a, i) => assert.deepEqual(new Uint8Array(a.memory?.buffer ?? a.copy.buffer, 65536, a.used - 65536), before[i]));
    } finally { await worker.terminate(); }
    console.log(`Compaction pointer-cache worker passed, copy=${copy}`);
  }
}
