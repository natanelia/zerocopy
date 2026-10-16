import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, nativeReaderOf } from './arena';
import { structureRegistry } from './codec';
import {
  SharedMap, SharedList, SharedStack, SharedQueue, SharedLinkedList,
  SharedDoublyLinkedList, SharedOrderedMap, SharedSortedMap, SharedPriorityQueue,
  SharedSet, SharedOrderedSet, SharedSortedSet, getWorkerData, initWorker,
} from './shared';

function borrowed(donor: Arena, used = donor.used): Arena {
  return new Arena({ memory: donor.memory, id: donor.id, used, readOnly: true }, nativeReaderOf(donor));
}
// Mechanism instrumentation only; replacing this built-in is not an API contract.
function countNativeInstances(run: (count: () => number) => void): void {
  const NativeInstance = WebAssembly.Instance;
  let count = 0;
  WebAssembly.Instance = class extends NativeInstance {
    constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      super(module, imports); count++;
    }
  };
  try { run(() => count); } finally { WebAssembly.Instance = NativeInstance; }
}

describe('native reader raw ownership', () => {
  it('promotes real raw exports once per view and keeps saved heap getters live', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
    const donor = new Arena({ memory, used: 65536, readOnly: true });
    countNativeInstances(count => {
      const first = borrowed(donor, 65552), second = borrowed(first, 65560);
      assert.equal(first.nativeReads.mapSize, donor.wasm.mapSize);
      assert.equal(second.nativeReads.mapSize, donor.wasm.mapSize);
      assert.equal(first.nativeReads.mapSize(0), 0);
      assert.equal(first.used, 65552);
      assert.equal(second.used, 65560);
      assert.equal(count(), 0);
      const firstRaw = first.wasm;
      assert.equal(count(), 1);
      assert.notEqual(firstRaw, donor.wasm);
      assert.notEqual(firstRaw.mapSize, donor.wasm.mapSize);
      assert.equal(firstRaw.mapSize(0), 0);
      assert.deepEqual(Object.keys(firstRaw), Object.keys(donor.wasm));
      assert.equal(Object.getPrototypeOf(firstRaw), null);
      assert.equal(Object.isExtensible(firstRaw), false);
      assert.equal(typeof Object.getOwnPropertyDescriptor(firstRaw, 'alloc')!.value, 'function');
      const firstHeap = firstRaw.getHeapEnd, set = firstRaw.setHeapEnd;
      assert.equal(firstHeap(), 65552);
      const secondRaw = second.wasm, secondHeap = secondRaw.getHeapEnd;
      assert.equal(count(), 2);
      assert.notEqual(secondRaw, firstRaw);
      assert.equal(secondHeap(), 65560);
      assert.notEqual(set, donor.wasm.setHeapEnd);
      assert.equal(set, first.wasm.setHeapEnd);
      set(65568);
      assert.equal(first.wasm.alloc(8) >>> 0, 65568);
      assert.equal(firstHeap(), 65576);
      assert.equal(first.used, 65576);
      assert.equal(first.state().heapEnd, 65576);
      assert.equal(first.copy().length, 65576);
      assert.equal(secondHeap(), 65560);
      assert.equal(donor.used, 65536);
      assert.throws(() => set(1), WebAssembly.RuntimeError);
      assert.equal(firstHeap(), 65576);
      second.wasm.setHeapEnd(65584);
      assert.equal(secondHeap(), 65584);
      assert.equal(firstHeap(), 65576);
      const component = nativeReaderOf(first);
      assert.deepEqual(Object.keys(component), ['memory', 'reads']);
      assert.equal(component.reads.mapSize, donor.wasm.mapSize);
      assert.equal(Object.hasOwn(component.reads, 'getHeapEnd'), false);
      assert.equal(Object.hasOwn(component.reads, 'getInfo'), false);
      assert.equal(Object.hasOwn(component.reads, 'alloc'), false);
      assert.equal(count(), 2);
    });
  });

  it('preserves the legacy scratch ABI through an own native instance', () => {
    const owner = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true }) });
    const map = new SharedMap('number', 0, 0, owner).set('key', 7);
    const donor = new Arena({ memory: owner.memory, used: owner.used, readOnly: true });
    const view = borrowed(donor);
    const used = view.used, key = new TextEncoder().encode('key');
    view.buf.set(key, view.wasm.keyBuf());
    const leaf = view.wasm.getInfo(map.root, key.length) >>> 0;
    assert(leaf >= 65536);
    assert.equal(view.dv.getUint32(1024, true), key.length);
    assert.equal(view.dv.getUint32(1028, true), 8);
    assert.equal(view.dv.getUint32(1032, true), leaf + 16);
    assert.equal(view.wasm.mapFind(map.root, 0, key.length, view.dv.getUint32(leaf + 4, true)) >>> 0, leaf);
    assert.equal(view.used, used);
    assert.equal(donor.used, used);
    assert.equal(map.get('key'), 7);
  });

  it('preserves view metadata and retries after lazy native construction fails', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
    const donor = new Arena({ memory, used: 65536, readOnly: true });
    const view = borrowed(donor, 65552), sibling = borrowed(donor, 65560);
    const failure = new Error('native construction failed');
    const NativeInstance = WebAssembly.Instance;
    let attempts = 0;
    WebAssembly.Instance = class extends NativeInstance {
      constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
        if (++attempts === 1) throw failure;
        super(module, imports);
      }
    };
    try {
      assert.throws(() => view.wasm, error => error === failure);
      assert.equal(attempts, 1);
      assert.equal(view.used, 65552);
      assert.equal(view.state().heapEnd, 65552);
      assert.equal(sibling.used, 65560);
      assert.equal(donor.used, 65536);
      // Retry the same view. Successful initialization uses its original
      // prefix, and repeated raw access returns its one owned export.
      const raw = view.wasm, alloc = raw.alloc, getHeapEnd = raw.getHeapEnd;
      assert.equal(attempts, 2);
      assert.equal(view.wasm, raw);
      assert.equal(getHeapEnd(), 65552);
      assert.equal(alloc(8) >>> 0, 65552);
      assert.equal(getHeapEnd(), 65560);
      assert.equal(view.used, 65560);
      assert.equal(view.wasm.alloc, alloc);
      assert.equal(attempts, 2);
      assert.equal(sibling.used, 65560);
      assert.equal(donor.used, 65536);
    } finally { WebAssembly.Instance = NativeInstance; }
  });

  it('supports every built-in reader and allocation-free attached removals', async () => {
    let list = new SharedList('string'), linked = new SharedLinkedList('number');
    let doubly = new SharedDoublyLinkedList('number'), queue = new SharedQueue('number');
    let stack = new SharedStack('number');
    for (let i = 0; i < 65; i++) {
      list = list.push(`entry-${i}`); linked = linked.append(i); doubly = doubly.append(i);
      queue = queue.enqueue(i); stack = stack.push(i);
    }
    const writers = {
      map: new SharedMap('number').set('b', 2).set('a', 1),
      ordered: new SharedOrderedMap('number').set('b', 2).set('a', 1),
      sorted: new SharedSortedMap('number').set('b', 2).set('a', 1),
      set: new SharedSet<string>().add('a'), orderedSet: new SharedOrderedSet<string>().add('a'),
      sortedSet: new SharedSortedSet<string>().add('a'),
      priority: new SharedPriorityQueue('number').enqueue(1, 10), list, linked, doubly, stack, queue,
    };
    const payload = getWorkerData(writers, { copy: false }), first = await initWorker(payload);
    const arenas = new Map<string, Arena>();
    for (const item of Object.values(first)) {
      const donor = arenaOf(item);
      if (!arenas.has(donor.id)) arenas.set(donor.id, borrowed(donor));
    }
    const views: any = Object.create(null);
    for (const [name, item] of Object.entries(payload.structures)) {
      views[name] = structureRegistry[item.type].fromWorkerData(item.data, arenas.get(item.arena));
    }
    const used = [...arenas.values()].map(arena => arena.used);
    countNativeInstances(count => {
      assert.equal(views.map.get('a'), 1);
      assert.deepEqual([...views.ordered.entries()], [['b', 2], ['a', 1]]);
      assert.deepEqual([...views.sorted.entries()], [['a', 1], ['b', 2]]);
      for (const name of ['set', 'orderedSet', 'sortedSet']) assert.equal(views[name].has('a'), true);
      assert.equal(views.priority.peek(), 1);
      assert.equal(views.list.get(32), 'entry-32');
      const predicate = views.list.compileTextSearch('ENTRY-6', { caseSensitive: false });
      assert.equal(predicate(6), true); assert.equal(predicate(60), true); assert.equal(predicate(32), false);
      const left = views.list.values(), right = views.list.values();
      assert.equal(left.next().value, 'entry-0'); assert.equal(right.next().value, 'entry-0');
      assert.equal(left.next().value, 'entry-1'); assert.equal(right.next().value, 'entry-1');
      assert.deepEqual(views.linked.toArray(), Array.from({ length: 65 }, (_, i) => i));
      assert.deepEqual(views.doubly.toArray(), Array.from({ length: 65 }, (_, i) => i));
      assert.equal(views.linked.get(32), 32);
      assert.equal(views.doubly.get(32), 32);
      assert.equal(views.list.pop().get(63), 'entry-63');
      assert.equal(views.stack.pop().peek(), 63);
      assert.equal(views.queue.dequeue().peek(), 1);
      assert.throws(() => views.list.push('next'), /read-only/);
      assert.throws(() => views.map.set('c', 3), /read-only/);
      assert.throws(() => views.priority.dequeue(), /read-only/);
      assert.deepEqual([...arenas.values()].map(arena => arena.used), used);
      assert.equal(count(), 0);
    });
  });
});
