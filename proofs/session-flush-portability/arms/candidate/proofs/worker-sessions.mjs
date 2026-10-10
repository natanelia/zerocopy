import assert from 'node:assert/strict';
import { Worker, MessageChannel, isMainThread, parentPort } from 'node:worker_threads';
import * as z from 'zerocopy';
import { createSharedState, connectSharedSession } from 'zerocopy/worker';
import { bindRedux, zerocopyMiddlewareOptions } from 'zerocopy/redux';
import { configureStore } from '@reduxjs/toolkit';

function waitFor(worker, sequence) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Missing worker version ${sequence}`)), 10000);
    const onError = error => finish(error);
    const onMessage = value => { if (value.proof === 'snapshot' && value.sequence === sequence) finish(undefined, value); };
    const finish = (error, value) => {
      clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError);
      error ? reject(error) : resolve(value);
    };
    worker.on('message', onMessage); worker.on('error', onError);
  });
}
if (!isMainThread) {
  let memoryHandles = 0;
  parentPort.on('message', data => {
    if (data.protocol === 'zerocopy/session' && data.kind === 'snapshot') {
      memoryHandles = data.data.arenas.filter(arena => arena.memory).length;
      for (const arena of data.data.arenas) {
        assert.equal(arena.copy, undefined);
        if (arena.memory) assert.ok(arena.memory.buffer instanceof SharedArrayBuffer);
      }
    }
  });
  const reader = await connectSharedSession({ endpoint: parentPort, channel: 'proof' });
  const original = reader.current;
  const report = (state, sequence) => {
    assert.ok(state.map instanceof z.SharedMap);
    assert.equal(state.set.has('a'), true);
    assert.equal(state.list.get(0), 2);
    assert.equal(state.stack.peek(), 3);
    assert.equal(state.queue.peek(), 4);
    assert.equal(state.linked.get(0), 5);
    assert.equal(state.doubly.get(0), 6);
    assert.equal(state.ordered.get('a'), 7);
    assert.equal(state.orderedSet.has('b'), true);
    assert.equal(state.sorted.get('a'), 8);
    assert.equal(state.sortedSet.has('c'), true);
    assert.equal(state.priority.peek(), 9);
    assert.equal(state.nested.get('n').get(0), 10);
    assert.throws(() => state.map.set('forbidden', 1), /read-only/);
    for (let i = 0; i < 10000; i++) assert.equal(original.map.get('seed'), 1);
    parentPort.postMessage({ proof: 'snapshot', sequence, memoryHandles, seed: state.map.get('seed'), last: state.map.get('n19999'), size: state.map.size });
  };
  report(reader.current, reader.version);
  reader.subscribe(report);
} else {
  const initial = {
    map: new z.SharedMap('number').set('seed', 1),
    set: new z.SharedSet().add('a'), list: new z.SharedList('number').push(2),
    stack: new z.SharedStack('number').push(3), queue: new z.SharedQueue('number').enqueue(4),
    linked: new z.SharedLinkedList('number').append(5), doubly: new z.SharedDoublyLinkedList('number').append(6),
    ordered: new z.SharedOrderedMap('number').set('a', 7), orderedSet: new z.SharedOrderedSet().add('b'),
    sorted: new z.SharedSortedMap('number').set('a', 8), sortedSet: new z.SharedSortedSet().add('c'),
    priority: new z.SharedPriorityQueue('number').enqueue(9, 1),
    nested: new z.SharedMap('SharedList<number>').set('n', new z.SharedList('number').push(10)),
  };
  const session = createSharedState(initial, { copy: false, channel: 'proof' });
  const workers = [new Worker(new URL(import.meta.url)), new Worker(new URL(import.meta.url))];
  try {
    const first = workers.map(worker => waitFor(worker, 0));
    await session.connect(workers);
    for (const result of await Promise.all(first)) assert.ok(result.memoryHandles > 0);
    const initialMemory = z.getWorkerData({ map: session.current.map }, { copy: false }).arenas[0].memory;
    const bytesBefore = initialMemory.buffer.byteLength;
    const next = workers.map(worker => waitFor(worker, 1));
    session.update('map', map => map.setMany(Array.from({ length: 20000 }, (_, i) => [`n${i}`, i])));
    session.update('map', map => map.set('seed', 2));
    assert.ok(initialMemory.buffer.byteLength > bytesBefore);
    for (const result of await Promise.all(next)) {
      assert.equal(result.memoryHandles, 0); assert.equal(result.last, 19999); assert.equal(result.seed, 2);
    }
    const compacted = workers.map(worker => waitFor(worker, 2));
    session.update(state => z.compactMany(state));
    for (const result of await Promise.all(compacted)) { assert.ok(result.memoryHandles > 0); assert.equal(result.last, 19999); }
    session.update(state => ({ ...state })); await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.version, 2);
  } finally { session.dispose(); await Promise.all(workers.map(worker => worker.terminate())); }

  // Verify the actual Toolkit store and public Redux barrel, not a store mock.
  const store = configureStore({
    reducer: (state = { map: new z.SharedMap('number'), panel: false }, action) => {
      if (action.type === 'value') return { ...state, map: state.map.set('x', action.payload) };
      if (action.type === 'panel') return { ...state, panel: !state.panel };
      return state;
    },
    middleware: getDefault => getDefault(zerocopyMiddlewareOptions), devTools: false,
  });
  const { port1, port2 } = new MessageChannel();
  const receiving = connectSharedSession({ endpoint: port2 });
  const bound = bindRedux(store, { workers: port1, copy: false, select: state => ({ map: state.map }) });
  const reader = await receiving;
  try {
    await bound.ready;
    store.dispatch({ type: 'panel' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(bound.version, 0);
    const next = new Promise(resolve => { const unsubscribe = reader.subscribe(() => { unsubscribe(); resolve(); }); });
    store.dispatch({ type: 'value', payload: 1 }); store.dispatch({ type: 'value', payload: 2 });
    await next; assert.equal(reader.current.map.get('x'), 2); assert.equal(reader.version, 1);
  } finally { bound.dispose(); reader.dispose(); port1.close(); port2.close(); }
  console.log('Worker sessions proof passed: 2 real workers, all 12 types, nested data, memory growth, descriptor-only updates, retained snapshots, compaction, and real Toolkit auto-publication.');
}
