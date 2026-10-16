import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, nativeReaderOf } from './arena';
import { structureRegistry } from './codec';
import {
  SharedMap, SharedList, SharedStack, SharedQueue, SharedLinkedList,
  SharedDoublyLinkedList, SharedOrderedMap, SharedSortedMap, SharedPriorityQueue,
  SharedSet, SharedOrderedSet, SharedSortedSet, getWorkerData, initWorker, compactMany,
} from './shared';

const readNames = [
  'mapSize', 'mapFind', 'radixSize', 'radixFind',
  'mapHashCandidate', 'mapHashCandidateFrom', 'mapHashPrefix',
  'journalFind', 'compareLeaves', 'vecLeaf', 'vecGet', 'blockGet',
  'textContains16', 'textContainsBlock16',
] as const;
// Full pre-repair order, including the vector cache declared after the constructor.
const legacyFields = [
  'memory', 'wasm', 'id', 'readOnly', 'dependencyLookup', 'writeHead', 'writeSize',
  'writeCount', 'buffer', 'bytes', 'view', 'reads', 'prefixRoot', 'prefixBits',
  'prefixChildren', 'prefixValid', 'lastReadAscii', 'valueRoot', 'valueCode',
  'valueMap', 'valueMapChars', 'valueMapBytes', 'objects', 'keys', 'keyBytes',
  'objectBytes', 'stringBytes', 'strings', 'internedStrings', 'internedStringBytes',
  'scalar', 'scalarView', 'vectorRoot', 'vectorLevel', 'vectorBlock',
  'vectorAddress', 'vectorView',
];

function borrowed(donor: Arena, used = donor.used): Arena {
  return new Arena({ memory: donor.memory, id: donor.id, used, readOnly: true }, nativeReaderOf(donor));
}
function assertBorrowedSlot(arena: Arena): void {
  const descriptor = Object.getOwnPropertyDescriptor(arena, 'wasm')!;
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(descriptor.set, undefined);
  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.configurable, true);
  assert.equal(Object.hasOwn(descriptor, 'value'), false);
}
// Test-scoped mechanism instrumentation. Recording imported Memories distinguishes
// a required destination instance from an accidental source-view promotion.
async function withNativeInstances(run: (memories: readonly WebAssembly.Memory[]) => void | Promise<void>): Promise<void> {
  const NativeInstance = WebAssembly.Instance, memories: WebAssembly.Memory[] = [];
  WebAssembly.Instance = class extends NativeInstance {
    constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      super(module, imports);
      memories.push(imports!.env.memory as WebAssembly.Memory);
    }
  };
  try { await run(memories); } finally { WebAssembly.Instance = NativeInstance; }
}

describe('direct native reader boundaries', () => {
  it('keeps ordinary construction eager and appends fields after the complete legacy order', async () => {
    await withNativeInstances(memories => {
      const owner = new Arena();
      const attached = new Arena({ memory: owner.memory, used: owner.used, readOnly: true });
      const copied = new Arena({ copy: owner.copy(), used: owner.used, readOnly: true });
      assert.equal(memories.length, 3);
      assert.equal(memories[0], owner.memory);
      assert.equal(memories[1], owner.memory);
      assert.equal(memories[2], copied.memory);
      assert.notEqual(copied.memory, owner.memory);
      for (const arena of [owner, attached, copied]) {
        const descriptor = Object.getOwnPropertyDescriptor(arena, 'wasm')!;
        assert.equal(descriptor.value, arena.nativeReads);
        assert.equal(descriptor.get, undefined);
        assert.equal(descriptor.writable, true);
        assert.equal(descriptor.enumerable, true);
        assert.equal(descriptor.configurable, true);
        assert.equal(arena.nativeReads, arena.wasm);
      }
      const reused = borrowed(attached);
      assertBorrowedSlot(reused);
      for (const arena of [owner, attached, copied, reused]) {
        const fields = Object.getOwnPropertyNames(arena);
        assert.deepEqual(fields.slice(0, legacyFields.length), legacyFields);
        assert.deepEqual(fields.slice(legacyFields.length), ['nativeReads', 'nativeState']);
      }
      assert.equal(memories.length, 3);
    });
  });

  it('memoizes exact frozen projections by native exports, including reborrowing after promotion', async () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
    const donor = new Arena({ memory, used: 65536, readOnly: true });
    const independent = new Arena({ memory, used: 65536, readOnly: true });
    const otherMemory = new Arena();
    await withNativeInstances(memories => {
      const component = nativeReaderOf(donor);
      assert.equal(nativeReaderOf(donor), component);
      assert.equal(Object.isFrozen(component), true);
      assert.deepEqual(Reflect.ownKeys(component), ['memory', 'reads']);
      assert.equal(component.memory, memory);
      assert.equal(Object.isFrozen(component.reads), true);
      assert.deepEqual(Reflect.ownKeys(component.reads), [...readNames]);
      assert.equal(Object.getPrototypeOf(component.reads), null);
      for (const name of readNames) {
        const descriptor = Object.getOwnPropertyDescriptor(component.reads, name)!;
        assert.equal(typeof descriptor.value, 'function');
        assert.equal(descriptor.value, donor.nativeReads[name]);
        assert.equal(descriptor.get, undefined);
        assert.equal(descriptor.set, undefined);
        assert.equal(descriptor.writable, false);
        assert.equal(descriptor.configurable, false);
        assert.equal(descriptor.enumerable, true);
      }
      const separate = nativeReaderOf(independent);
      assert.notEqual(separate, component);
      assert.notEqual(separate.reads, component.reads);
      assert.notEqual(separate.reads.mapSize, component.reads.mapSize);
      assert.notEqual(nativeReaderOf(otherMemory), component);
      const first = borrowed(donor, 65552), second = borrowed(first, 65560);
      assert.equal(first.nativeReads, component.reads);
      assert.equal(second.nativeReads, component.reads);
      assert.equal(nativeReaderOf(first), component);
      assert.equal(nativeReaderOf(second), component);
      assert.equal(memories.length, 0);

      // Even a pure raw read promotes; metadata/extraction above did not.
      const raw = first.wasm;
      assert.equal(raw.mapSize(0), 0);
      assert.equal(memories.length, 1);
      assert.equal(memories[0], memory);
      assert.equal(first.wasm, raw);
      assert.notEqual(raw, donor.wasm);
      assert.notEqual(raw.mapSize, component.reads.mapSize);
      assert.equal(nativeReaderOf(first), component);
      const third = borrowed(first, 65568);
      assert.equal(nativeReaderOf(third), component);
      assert.equal(third.nativeReads, component.reads);
      assert.equal(first.used, 65552);
      assert.equal(second.used, 65560);
      assert.equal(third.used, 65568);
      assert.equal(memories.length, 1);
    });
  });

  it('preserves nested captured prefixes through growth, metadata, copies and transport round trips', async () => {
    const memory = () => new WebAssembly.Memory({ initial: 4, maximum: 16, shared: true });
    const childOwner = new Arena({ memory: memory() }), parentOwner = new Arena({ memory: memory() });
    const oldChild = new SharedMap('number', 0, 0, childOwner).set('value', 1);
    const oldParent = new SharedMap('SharedMap<number>', 0, 0, parentOwner).set('child', oldChild);
    const oldUsed = [parentOwner.used, childOwner.used];
    const nextChild = oldChild.set('value', 2);
    const nextParent = oldParent.set('child', nextChild);
    const nextUsed = [parentOwner.used, childOwner.used];
    assert(nextUsed.every((used, index) => used > oldUsed[index]));
    await withNativeInstances(async memories => {
      const oldArenas = [borrowed(parentOwner, oldUsed[0]), borrowed(childOwner, oldUsed[1])];
      const nextArenas = [borrowed(parentOwner, nextUsed[0]), borrowed(childOwner, nextUsed[1])];
      for (const [parent, child] of [oldArenas, nextArenas]) parent.dependencies.set(child.id, child);
      const old = SharedMap.fromWorkerData(oldParent.root, oldParent.valueType, oldParent.size, oldArenas[0]);
      const next = SharedMap.fromWorkerData(nextParent.root, nextParent.valueType, nextParent.size, nextArenas[0]);
      parentOwner.memory.grow(1); childOwner.memory.grow(1);
      const bytes = [parentOwner.buf.slice(), childOwner.buf.slice()];
      let expectedInstances = 0;
      for (const [root, arenas, prefixes, value] of [
        [old, oldArenas, oldUsed, 1], [next, nextArenas, nextUsed, 2],
      ] as const) {
        arenas.forEach((arena, index) => {
          assert.equal(arena.used, prefixes[index]);
          assert.equal(arena.state().heapEnd, prefixes[index]);
          assert.equal(arena.copy().length, prefixes[index]);
          assertBorrowedSlot(arena);
        });
        assert.equal(root.get('child')!.get('value'), value);
        assert.equal(arenaOf(root.get('child')!), arenas[1]);
        for (const copy of [false, true]) {
          const exported = getWorkerData({ root }, { copy });
          assert.deepEqual(exported.arenas.map(arena => arena.used), prefixes);
          exported.arenas.forEach((arena, index) => {
            if (copy) assert.equal(arena.copy!.length, prefixes[index]);
            else assert.equal(arena.memory, arenas[index].memory);
          });
          assert.equal(memories.length, expectedInstances);
          const roundTrip = await initWorker(exported);
          expectedInstances += 2; // Ordinary reattachment owns two eager instances.
          assert.equal(memories.length, expectedInstances);
          assert.equal(roundTrip.root.get('child')!.get('value'), value);
          assert.equal(arenaOf(roundTrip.root).used, prefixes[0]);
          assert.equal(arenaOf(roundTrip.root.get('child')!).used, prefixes[1]);
        }
      }
      assert.notEqual(old.get('child'), next.get('child'));
      assert.equal(old.get('child')!.get('value'), 1);
      assert.equal(next.get('child')!.get('value'), 2);
      const raw = nextArenas[0].wasm, savedHeap = raw.getHeapEnd;
      assert.equal(memories.length, ++expectedInstances);
      const rawStart = Math.ceil(nextUsed[0] / 8) * 8 + 8, promotedUsed = rawStart + 8;
      raw.setHeapEnd(rawStart);
      assert.equal(raw.alloc(8) >>> 0, rawStart);
      assert.equal(savedHeap(), promotedUsed);
      assert.equal(nextArenas[0].state().heapEnd, promotedUsed);
      assert.equal(nextArenas[0].copy().length, promotedUsed);
      for (const copy of [false, true]) {
        const exported = getWorkerData({ root: next }, { copy });
        assert.deepEqual(exported.arenas.map(arena => arena.used), [promotedUsed, nextUsed[1]]);
        if (copy) assert.deepEqual(exported.arenas.map(arena => arena.copy!.length), [promotedUsed, nextUsed[1]]);
      }
      assert.deepEqual(oldArenas.map(arena => arena.used), oldUsed);
      assert.equal(nextArenas[1].used, nextUsed[1]);
      assert.equal(parentOwner.used, nextUsed[0]);
      assert.equal(childOwner.used, nextUsed[1]);
      assert.equal(memories.length, expectedInstances);
      assert.deepEqual(parentOwner.buf, bytes[0]);
      assert.deepEqual(childOwner.buf, bytes[1]);
    });
  });

  it('discards failed raw heap initialization and retries without losing metadata or reads', () => {
    const owner = new Arena(), map = new SharedMap('number', 0, 0, owner).set('key', 7);
    owner.alloc(0); // Align the fixture's frontier before testing raw alloc(8).
    const view = borrowed(owner), sibling = borrowed(owner), used = view.used;
    const attached = SharedMap.fromWorkerData(map.root, 'number', map.size, view);
    const before = owner.buf.slice(), failure = new Error('heap initialization failed');
    const NativeInstance = WebAssembly.Instance;
    let attempts = 0, failedPrefix: number | undefined, successfulExports: WebAssembly.Exports | undefined;
    WebAssembly.Instance = class extends NativeInstance {
      constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
        super(module, imports);
        const raw = this.exports as any;
        if (++attempts === 1) {
          // Fail after changing the discarded instance's native heap global.
          Object.defineProperty(this, 'exports', { value: {
            ...raw,
            setHeapEnd(prefix: number) { failedPrefix = prefix; raw.setHeapEnd(prefix); throw failure; },
          } });
        } else successfulExports = raw;
      }
    };
    try {
      assert.throws(() => view.wasm, error => error === failure);
      assert.equal(attempts, 1);
      assert.equal(failedPrefix, used);
      assert.equal(view.used, used);
      assert.equal(view.state().heapEnd, used);
      assert.equal(view.copy().length, used);
      assert.equal(attached.get('key'), 7);
      assert.equal(nativeReaderOf(view), nativeReaderOf(owner));
      assert.equal(sibling.used, used);
      assert.equal(owner.used, used);
      assert.equal(attempts, 1);
      const raw = view.wasm, savedHeap = raw.getHeapEnd;
      assert.equal(attempts, 2);
      assert.equal(raw, successfulExports);
      assert.equal(savedHeap(), used);
      assert.equal(raw.alloc(8) >>> 0, used);
      assert.equal(savedHeap(), used + 8);
      assert.equal(view.used, used + 8);
      assert.equal(view.wasm, raw);
      assert.equal(attempts, 2);
      assert.equal(sibling.used, used);
      assert.equal(owner.used, used);
      assert.deepEqual(owner.buf, before);
    } finally { WebAssembly.Instance = NativeInstance; }
  });

  it('reads omitted-size constructors, cold hash directories, collisions and journals without promotion', async () => {
    const owner = new Arena();
    let map = new SharedMap('number', 0, 0, owner);
    for (let i = 0; i < 300; i++) map = map.set(`key${i}`, i);
    map = map.set('costarring', 701).set('liquid', 702);
    const changed = map.set('costarring', 703);
    const ordered = new SharedOrderedMap('number', 0, 0, 0, 0, owner)
      .set('b', 2).set('a', 1).set('b', 3);
    const sorted = new SharedSortedMap('number', undefined, 0, 0, owner)
      .set('b', 2).set('a', 1).set('c', 3).set('b', 4);
    assert.equal(owner.dv.getUint32(sorted.root, true), 0xffffffff);
    // Current map writers no longer emit journals. Preserve a valid legacy
    // descriptor fixture, as in bulk-input-storage.test.ts, to cover journalFind.
    const pending = owner.leaf('number', 'key0', 900), journalRoot = owner.alloc(24);
    owner.dv.setUint32(journalRoot, 0xffffffff, true);
    owner.dv.setUint32(journalRoot + 4, map.root, true);
    owner.dv.setUint32(journalRoot + 8, map.size, true);
    owner.dv.setUint32(journalRoot + 12, 1, true);
    owner.dv.setUint32(journalRoot + 16, pending, true);
    owner.dv.setUint32(journalRoot + 20, 0, true);
    const before = owner.buf.slice(), used = owner.used;
    await withNativeInstances(memories => {
      const view = borrowed(owner);
      const attached = new SharedMap('number', map.root, undefined, view);
      const fork = new SharedMap('number', changed.root, undefined, view);
      const insertion = new SharedOrderedMap('number', ordered.root, ordered.head, ordered.tail, undefined, view, false);
      const lexicographic = new SharedSortedMap('number', undefined, sorted.root, undefined, view);
      const journal = new SharedMap('number', journalRoot, undefined, view);
      assert.equal(attached.size, 302);
      assert.equal(fork.size, 302);
      assert.equal(insertion.size, 2);
      assert.equal(lexicographic.size, 3);
      assert.equal(journal.size, 302);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 299; i >= 0; i--) assert.equal(attached.get(`key${i}`), i);
        assert.equal(attached.has('absent'), false);
        assert.equal(attached.get('costarring'), 701);
        assert.equal(attached.get('liquid'), 702);
        assert.equal(fork.get('costarring'), 703);
        assert.equal(attached.get('costarring'), 701);
        assert.equal(journal.get('key0'), 900);
        assert.equal(journal.get('key1'), 1);
        assert.equal(journal.get('absent'), undefined);
        assert.equal([...journal.entries()].filter(([key]) => key === 'key0').length, 1);
        assert.deepEqual([...insertion.entries()], [['b', 3], ['a', 1]]);
        assert.deepEqual([...lexicographic.entries()], [['a', 1], ['b', 4], ['c', 3]]);
        assert.equal(lexicographic.get('b'), 4);
        assert.equal(lexicographic.has('absent'), false);
      }
      const left = journal.entries(), right = journal.entries();
      assert.deepEqual(left.next(), right.next());
      assert.deepEqual(left.next(), right.next());
      assert.deepEqual([...left], [...right]);
      assert.equal(memories.length, 0);
      assert.equal(view.used, used);
      assert.deepEqual(owner.buf, before);
    });
  });

  it('keeps complete backing bytes unchanged through all twelve built-in readers', async () => {
    const owner = new Arena();
    let list = new SharedList('string', 0, 0, 0, owner);
    let linked = new SharedLinkedList('number', 0, 0, 0, owner);
    let doubly = new SharedDoublyLinkedList('number', 0, 0, 0, owner);
    let queue = new SharedQueue('number', 0, 0, 0, undefined, owner);
    let stack = new SharedStack('number', 0, 0, undefined, owner);
    for (let i = 0; i < 65; i++) {
      list = list.push(`row-${i}`); linked = linked.append(i); doubly = doubly.append(i);
      queue = queue.enqueue(i); stack = stack.push(i);
    }
    const writers = {
      map: new SharedMap('number', 0, 0, owner).set('b', 2).set('a', 1),
      ordered: new SharedOrderedMap('number', 0, 0, 0, 0, owner).set('b', 2).set('a', 1),
      sorted: new SharedSortedMap('number', undefined, 0, 0, owner).set('b', 2).set('a', 1),
      set: new SharedSet<string>(new SharedMap('number', 0, 0, owner)).add('a'),
      orderedSet: new SharedOrderedSet<string>(new SharedOrderedMap('number', 0, 0, 0, 0, owner)).add('a'),
      sortedSet: new SharedSortedSet<string>(undefined, new SharedSortedMap('number', undefined, 0, 0, owner)).add('a'),
      priority: new SharedPriorityQueue('number', undefined, owner).enqueue(7, 1),
      list, linked, doubly, queue, stack,
    };
    const payload = getWorkerData(writers, { copy: false });
    const before = owner.buf.slice(), used = owner.used;
    await withNativeInstances(memories => {
      const arena = borrowed(owner);
      const views = Object.fromEntries(Object.entries(payload.structures).map(([name, item]) => [
        name, structureRegistry[item.type].fromWorkerData(item.data, arena),
      ])) as typeof writers;
      assert.equal(views.map.get('a'), 1);
      assert.deepEqual([...views.ordered.entries()], [['b', 2], ['a', 1]]);
      assert.deepEqual([...views.sorted.entries()], [['a', 1], ['b', 2]]);
      for (const set of [views.set, views.orderedSet, views.sortedSet]) {
        assert.equal(set.has('a'), true);
        assert.deepEqual([...set.values()], ['a']);
        assert.equal(set.add('a'), set); // Existing nonallocating no-op exception.
        assert.throws(() => set.add('b'), /read-only/);
      }
      assert.equal(views.priority.peek(), 7);
      assert.equal(views.priority.peekPriority(), 1);
      assert.deepEqual([...views.priority.entries()], [[7, 1]]);
      assert.deepEqual(views.list.toArray(), Array.from({ length: 65 }, (_, i) => `row-${i}`));
      const visited: string[] = [];
      views.list.forEach((value, index) => { assert.equal(value, `row-${index}`); visited.push(value); });
      assert.deepEqual(visited, [...views.list.values()]);
      const first = views.list.values(), second = views.list.values();
      for (let i = 0; i < 33; i++) { assert.equal(first.next().value, `row-${i}`); assert.equal(second.next().value, `row-${i}`); }
      for (const sequence of [views.linked, views.doubly]) {
        assert.equal(sequence.get(31), 31);
        assert.equal(sequence.get(32), 32);
        assert.equal(sequence.get(64), 64);
        assert.deepEqual(sequence.toArray(), Array.from({ length: 65 }, (_, i) => i));
      }
      assert.equal(views.queue.dequeue().peek(), 1);
      assert.equal(views.stack.pop().peek(), 63);
      assert.equal(views.list.pop().get(63), 'row-63');
      assert.equal(views.list.pushMany([]), views.list);
      assert.equal(views.list.set(-1, 'ignored'), views.list);
      assert.equal(views.map.setMany([]), views.map);
      assert.throws(() => views.list.push('next'), /read-only/);
      assert.throws(() => views.map.set('c', 3), /read-only/);
      assert.throws(() => views.ordered.set('c', 3), /read-only/);
      assert.throws(() => views.sorted.set('c', 3), /read-only/);
      assert.throws(() => views.linked.append(65), /read-only/);
      assert.throws(() => views.doubly.append(65), /read-only/);
      assert.throws(() => views.queue.enqueue(65), /read-only/);
      assert.throws(() => views.stack.push(65), /read-only/);
      assert.throws(() => views.priority.dequeue(), /read-only/);
      assert.throws(() => views.priority.enqueue(8, NaN), /Priority must be a number/);
      assert.equal(arena.used, used);
      assert.equal(owner.used, used);
      assert.equal(memories.length, 0);
      assert.deepEqual(owner.buf, before); // Includes scratch, slack and unused pages.
    });
  });

  it('handles vector contraction and queue, stack and linked boundaries without promotion', async () => {
    const owner = new Arena();
    const lists = [0, 1, 33, 65, 1057].map(size => new SharedList('number', 0, 0, 0, owner)
      .pushMany(Array.from({ length: size }, (_, i) => i)));
    let queue = new SharedQueue('number', 0, 0, 0, undefined, owner);
    let stack = new SharedStack('number', 0, 0, undefined, owner);
    let linked = new SharedLinkedList('number', 0, 0, 0, owner);
    let doubly = new SharedDoublyLinkedList('number', 0, 0, 0, owner);
    for (let i = 0; i < 1057; i++) {
      queue = queue.enqueue(i); stack = stack.push(i);
      linked = linked.append(i); doubly = doubly.append(i);
    }
    const before = owner.buf.slice(), used = owner.used;
    await withNativeInstances(memories => {
      const view = borrowed(owner);
      for (const source of lists) {
        const list = SharedList.fromWorkerData(source.toWorkerData(), view), result = list.pop();
        assert.equal(result.size, Math.max(0, list.size - 1));
        assert.deepEqual(result.toArray(), Array.from({ length: result.size }, (_, i) => i));
        assert.deepEqual([...list.values()], Array.from({ length: list.size }, (_, i) => i));
        if (!list.size) assert.equal(result, list);
        if (list.size === 33) assert.equal(result.root, 0);
        if (list.size === 1057) { assert.equal(list.depth, 2); assert.equal(result.depth, 1); }
      }
      let q = SharedQueue.fromWorkerData(queue.toWorkerData(), view);
      let s = SharedStack.fromWorkerData(stack.toWorkerData(), view);
      for (let i = 0; i < 1057; i++) {
        assert.equal(q.peek(), i);
        assert.equal(s.peek(), 1056 - i);
        q = q.dequeue(); s = s.pop();
      }
      assert.equal(q.peek(), undefined); assert.equal(q.dequeue(), q);
      assert.equal(s.peek(), undefined); assert.equal(s.pop(), s);
      const retainedQueue = SharedQueue.fromWorkerData(queue.toWorkerData(), view);
      assert.equal(retainedQueue.peek(), 0); // Removals did not edit the original queue.
      const sequences = [
        SharedLinkedList.fromWorkerData(linked.toWorkerData(), view),
        SharedDoublyLinkedList.fromWorkerData(doubly.toWorkerData(), view),
      ];
      for (const sequence of sequences) {
        for (const index of [0, 31, 32, 63, 64, 1023, 1024, 1055, 1056]) assert.equal(sequence.get(index), index);
        assert.deepEqual(sequence.toArray(), Array.from({ length: 1057 }, (_, i) => i));
      }
      assert.equal(view.used, used);
      assert.equal(memories.length, 0);
      assert.deepEqual(owner.buf, before);
    });
  });

  it('retains short, Unicode, medium and long saved scanners across growth and old snapshots', async () => {
    const owner = new Arena();
    const medium = 'abcdefghijklmnopqrstuvwx', long = 'AbCd'.repeat(12);
    const samples = ['plain', 'Needle', 'CAFÉ', 'İstanbul', '🙂 smile', `xx${medium}yy`, `xx${long}yy`, 'Kelvin'];
    const values = Array.from({ length: 1057 }, (_, i) => `${i}/${samples[i % samples.length]}`);
    const source = new SharedList('string', 0, 0, 0, owner).pushMany(values);
    const used = owner.used;
    const cases = [
      { term: 'Needle', sensitive: true }, { term: 'NEEDLE', sensitive: false },
      { term: 'k', sensitive: false }, { term: 'CAFÉ', sensitive: false },
      { term: '\ud83d', sensitive: true }, { term: medium, sensitive: true },
      { term: medium.toUpperCase(), sensitive: false }, { term: long, sensitive: true },
      { term: long.toLowerCase(), sensitive: false }, { term: '', sensitive: true },
    ];
    await withNativeInstances(memories => {
      const view = borrowed(owner, used), old = SharedList.fromWorkerData(source.toWorkerData(), view);
      const saved = cases.map(({ term, sensitive }) => old.compileTextSearch(term, { caseSensitive: sensitive }));
      const verify = () => {
        saved.forEach((predicate, queryIndex) => {
          const { term, sensitive } = cases[queryIndex], needle = sensitive ? term : term.toLowerCase();
          // Alternating forward/backward walks replace cached half-leaves and
          // cross both the 16/32-value boundaries and the deeper vector branch.
          for (let pass = 0; pass < 2; pass++) for (let i = 0; i < values.length; i++) {
            const index = pass ? values.length - i - 1 : i;
            const haystack = sensitive ? values[index] : values[index].toLowerCase();
            assert.equal(predicate(index), haystack.includes(needle), `${queryIndex}/${index}`);
          }
          for (const invalid of [-1, 0.5, NaN, Infinity, values.length]) assert.equal(predicate(invalid), false);
        });
      };
      const before = owner.buf.slice();
      verify(); assert.deepEqual(owner.buf, before);
      const next = source.set(15, 'changed').set(32, 'changed').push('new Needle');
      owner.memory.grow(1);
      const afterOwnerWrite = owner.buf.slice();
      verify();
      assert.equal(old.get(15), values[15]);
      assert.equal(old.get(32), values[32]);
      assert.equal(next.get(15), 'changed');
      assert.equal(next.get(32), 'changed');
      assert.equal(view.used, used);
      assert.equal(old.size, values.length);
      assert.equal(memories.length, 0);
      assert.deepEqual(owner.buf, afterOwnerWrite);
    });
  });

  it('compacts borrowed vectors and unstable ordered maps with only a writable destination instance', async () => {
    const owner = new Arena();
    const list = new SharedList('number', 0, 0, 0, owner).pushMany(Array.from({ length: 1057 }, (_, i) => i));
    const ordered = new SharedOrderedMap('number', 0, 0, 0, 0, owner)
      .set('b', 1).set('a', 2).set('b', 3).delete('a').set('a', 4);
    assert.equal(ordered.orderStable, false);
    const before = owner.buf.slice(), used = owner.used;
    await withNativeInstances(memories => {
      const view = borrowed(owner);
      const sourceList = SharedList.fromWorkerData(list.toWorkerData(), view);
      const sourceOrdered = SharedOrderedMap.fromWorkerData(ordered.toWorkerData(), view);
      const result = compactMany({ list: sourceList, ordered: sourceOrdered });
      const target = arenaOf(result.list);
      assert.equal(memories.length, 1);
      assert.equal(memories[0], target.memory);
      assert.notEqual(target.memory, owner.memory);
      assert.equal(arenaOf(result.ordered), target);
      assert.equal(target.readOnly, false);
      assert.deepEqual(result.list.toArray(), Array.from({ length: 1057 }, (_, i) => i));
      assert.deepEqual([...result.ordered.entries()], [['b', 3], ['a', 4]]);
      assert.equal(result.ordered.orderStable, true);
      const updatedList = result.list.set(1024, -1).push(1057);
      const updatedOrdered = result.ordered.set('b', 9).set('c', 5);
      assert.equal(updatedList.get(1024), -1);
      assert.equal(updatedList.get(1057), 1057);
      assert.equal(result.list.get(1024), 1024);
      assert.equal(updatedOrdered.get('b'), 9);
      assert.equal(updatedOrdered.get('c'), 5);
      assert.equal(result.ordered.get('b'), 3);
      assert.equal(sourceList.get(1024), 1024);
      assert.deepEqual([...sourceOrdered.entries()], [['b', 3], ['a', 4]]);
      assert.equal(view.used, used);
      assert.equal(owner.used, used);
      assert.equal(memories.length, 1);
      assert.deepEqual(owner.buf, before);
    });
  });
});
