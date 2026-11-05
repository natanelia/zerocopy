import { describe, expect, it } from 'vitest';
import { Arena, HEAP_START } from './arena';
import {
  SharedMap, SharedList, SharedSet, SharedStack, SharedQueue,
  SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap,
  SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue,
  getWorkerData, initWorker,
} from './shared';

// Real, fixed-capacity WASM memory makes failure independent of host load or GC.
// Padding is a valid allocation. Do not rewind heapEnd or replace WASM exports:
// a failed operation may consume unpublished append-only storage.
const CAPACITY = 2 * 65536;
const HEADROOM = [...Array.from({ length: 25 }, (_, i) => i * 8), 256, 384, 512, 544, 576, 640, 672, 768, 1024, 4096];
const values = Array.from({ length: 65 }, (_, i) => i);
const entries = values.map(i => [`k${i}`, i] as const);

interface Fixture {
  snapshot: any;
  read(snapshot: any): unknown;
  expected: unknown;
  update(snapshot: any): any;
  updated: unknown;
  size: number;
  updatedSize: number;
}
interface Scenario {
  name: string;
  make(arena: Arena): Fixture;
  partialFailure?: boolean;
}

function drain(snapshot: any, method: 'pop' | 'dequeue'): unknown[] {
  const result: unknown[] = [];
  while (snapshot.size) {
    result.push(snapshot.peek());
    snapshot = snapshot[method]();
  }
  return result;
}

const sortedEntries = (snapshot: any) => [...snapshot.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const sortedValues = (snapshot: any) => [...snapshot.values()].sort((a, b) => a - b);
const lookupKeys = ['k0', 'k32', 'k64', 'new', 'costarring', 'liquid', 'missing'];
const lookups = (map: { has(key: string): boolean; get(key: string): unknown }) => lookupKeys.map(key => [key, map.has(key), map.get(key)]);
const scenarios: Scenario[] = [];

for (const [name, fresh, ordered] of [
  ['map', (a: Arena) => new SharedMap('number', 0, 0, a), false],
  ['ordered map', (a: Arena) => new SharedOrderedMap('number', 0, 0, 0, 0, a), true],
  ['sorted map', (a: Arena) => new SharedSortedMap('number', undefined, 0, 0, a), false],
] as const) {
  for (const operation of ['insert', 'replace', 'delete'] as const) {
    scenarios.push({
      name: `${name}: ${operation}`,
      make(a) {
        let snapshot = fresh(a);
        for (const [key, value] of entries) snapshot = snapshot.set(key, value) as typeof snapshot;
        const model = new Map<string, number>(entries);
        if (operation === 'delete') model.delete('k32');
        else model.set(operation === 'insert' ? 'new' : 'k32', -1);
        const normalize = (data: [string, number][]) => ordered ? data : data.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        return {
          snapshot,
          read: s => ({ entries: name === 'map' ? sortedEntries(s) : [...s.entries()], lookups: lookups(s) }),
          expected: { entries: normalize(entries.map(([k, v]) => [k, v])), lookups: lookups(new Map(entries)) },
          update: s => operation === 'delete' ? s.delete('k32') : s.set(operation === 'insert' ? 'new' : 'k32', -1),
          updated: { entries: normalize([...model]), lookups: lookups(model) },
          size: entries.length, updatedSize: model.size,
        };
      },
    });
  }
}

scenarios.push({
  name: 'map: bulk insert, overwrite, duplicate and exact hash collision',
  partialFailure: true,
  make(a) {
    const snapshot = new SharedMap('number', 0, 0, a).setMany(entries);
    const batch = [['costarring', 1], ['liquid', 2], ['k32', -1], ['costarring', 3]] as const;
    const model = new Map<string, number>(entries);
    for (const [key, value] of batch) model.set(key, value);
    const sort = (data: readonly (readonly [string, number])[]) => [...data].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return {
      snapshot, read: s => ({ entries: sortedEntries(s), lookups: lookups(s) }),
      expected: { entries: sort(entries), lookups: lookups(new Map(entries)) },
      update: s => s.setMany(batch), updated: { entries: sort([...model]), lookups: lookups(model) },
      size: entries.length, updatedSize: model.size,
    };
  },
});

for (const [name, fresh] of [
  ['set', (a: Arena) => new SharedSet(new SharedMap('number', 0, 0, a))],
  ['ordered set', (a: Arena) => new SharedOrderedSet(new SharedOrderedMap('number', 0, 0, 0, 0, a))],
  ['sorted set', (a: Arena) => SharedSortedSet.fromWorkerData({ root: 0, size: 0 }, a)],
] as const) {
  scenarios.push({
    name: `${name}: insert`,
    make(a) {
      let snapshot = fresh(a);
      for (const value of values) snapshot = snapshot.add(value) as typeof snapshot;
      return { snapshot, read: name === 'ordered set' ? s => [...s.values()] : sortedValues, expected: values, update: s => s.add(99), updated: [...values, 99], size: values.length, updatedSize: values.length + 1 };
    },
  });
}

for (const [name, size, update, model] of [
  ['append across a full leaf', 64, (s: any) => s.push(99), (v: number[]) => [...v, 99]],
  ['replace a tree value', 65, (s: any) => s.set(0, -1), (v: number[]) => [-1, ...v.slice(1)]],
  ['replace a tail value', 65, (s: any) => s.set(64, -1), (v: number[]) => [...v.slice(0, -1), -1]],
  ['bulk append across leaves', 65, (s: any) => s.pushMany(values), (v: number[]) => [...v, ...values]],
] as const) {
  scenarios.push({
    name: `list: ${name}`,
    partialFailure: name === 'bulk append across leaves',
    make(a) {
      const input = values.slice(0, size);
      return { snapshot: new SharedList('number', 0, 0, 0, a).pushMany(input), read: s => s.toArray(), expected: input, update, updated: model(input), size: input.length, updatedSize: model(input).length };
    },
  });
}

for (const [name, fresh] of [
  ['linked list', (a: Arena) => new SharedLinkedList('number', 0, 0, 0, a)],
  ['doubly linked list', (a: Arena) => new SharedDoublyLinkedList('number', 0, 0, 0, a)],
] as const) {
  for (const operation of ['append', 'insert', 'remove'] as const) {
    scenarios.push({
      name: `${name}: ${operation}`,
      make(a) {
        let snapshot = fresh(a);
        for (const value of values.slice(0, 64)) snapshot = snapshot.append(value) as typeof snapshot;
        const model = values.slice(0, 64);
        if (operation === 'append') model.push(99);
        else if (operation === 'insert') model.splice(17, 0, 99);
        else model.splice(17, 1);
        return {
          snapshot, read: s => s.toArray(), expected: values.slice(0, 64),
          update: s => operation === 'append' ? s.append(99) : operation === 'insert' ? s.insertAfter(16, 99) : name === 'linked list' ? s.removeAfter(16) : s.remove(17),
          updated: model,
          size: 64, updatedSize: model.length,
        };
      },
    });
  }
}

scenarios.push({
  name: 'queue: enqueue after a partial drain at a leaf boundary',
  make(a) {
    let snapshot = new SharedQueue('number', 0, 0, 0, undefined, a);
    for (const value of values.slice(0, 64)) snapshot = snapshot.enqueue(value);
    for (let i = 0; i < 17; i++) snapshot = snapshot.dequeue();
    return { snapshot, read: s => drain(s, 'dequeue'), expected: values.slice(17, 64), update: s => s.enqueue(99), updated: [...values.slice(17, 64), 99], size: 47, updatedSize: 48 };
  },
});

for (const [name, type, value, addition] of [
  ['number', 'number', 1, 99],
  ['string payload then node', 'string', 'old', 'new'.repeat(37)],
  ['JSON payload then node', 'object', { saved: [1, 2] }, { next: ['x'.repeat(100)] }],
] as const) {
  scenarios.push({
    name: `stack: ${name}`,
    partialFailure: type !== 'number',
    make(a) {
      const snapshot = new SharedStack(type, 0, 0, undefined, a).push(value as never);
      return { snapshot, read: s => drain(s, 'pop'), expected: [value], update: s => s.push(addition), updated: [addition, value], size: 1, updatedSize: 2 };
    },
  });
}

for (const maxHeap of [false, true]) {
  for (const operation of ['enqueue', 'dequeue'] as const) {
    scenarios.push({
      name: `priority queue: ${maxHeap ? 'max' : 'min'} ${operation}`,
      make(a) {
        let snapshot = new SharedPriorityQueue('number', { maxHeap }, a);
        // Avoid a monotonic insertion chain: both min and max roots must have
        // children to merge when removing the root.
        for (const i of values) {
          const value = (i * 17) % values.length;
          snapshot = snapshot.enqueue(value + 1000, value);
        }
        const original = values.map(v => [v + 1000, v]);
        const model = original.map(entry => [...entry]);
        if (operation === 'enqueue') model.push([1099, 99]);
        else model.splice(maxHeap ? model.length - 1 : 0, 1);
        const expected = (entries: number[][]) => {
          const [peek, priority] = entries[maxHeap ? entries.length - 1 : 0];
          return { entries, peek, priority };
        };
        // entries() reads without allocating dequeue paths in exhausted memory.
        return {
          snapshot, read: s => ({ entries: [...s.entries()].sort(([a], [b]) => a - b), peek: s.peek(), priority: s.peekPriority() }), expected: expected(original),
          update: s => operation === 'enqueue' ? s.enqueue(1099, 99) : s.dequeue(), updated: expected(model), size: values.length, updatedSize: model.length,
        };
      },
    });
  }
}

describe('bounded-memory writes preserve every published snapshot', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      let failures = 0, successes = 0, partialFailures = 0;
      for (const headroom of HEADROOM) {
        const a = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }) });
        const fixture = scenario.make(a), { snapshot, read, expected } = fixture;
        expect(read(snapshot), `before write; headroom=${headroom}`).toEqual(expected);
        expect(snapshot.size).toBe(fixture.size);
        const end = a.used, published = a.buf.slice(HEAP_START, end);
        const descriptor = snapshot.toWorkerData();
        const before = await initWorker(getWorkerData({ snapshot }, { copy: false }));
        expect(read(before.snapshot)).toEqual(expected);
        expect(before.snapshot.size).toBe(fixture.size);
        a.alloc(0); // Map records can leave a 4-byte-aligned frontier.
        a.alloc(CAPACITY - a.used - headroom);
        expect(CAPACITY - a.used).toBe(headroom);
        const mark = a.used;
        let next: any, failed = false;
        try { next = fixture.update(snapshot); }
        catch (error) {
          expect(error, `headroom=${headroom}`).toBeInstanceOf(WebAssembly.RuntimeError);
          failed = true;
          failures++;
          if (a.used > mark) partialFailures++;
        }
        const usedAfterUpdate = a.used;
        if (!failed) {
          expect(next, `returned snapshot; headroom=${headroom}`).toBeDefined();
          successes++;
          expect(read(next), `successful write; headroom=${headroom}`).toEqual(fixture.updated);
          expect(next.size).toBe(fixture.updatedSize);
        }
        expect(snapshot.toWorkerData(), `descriptor; headroom=${headroom}`).toEqual(descriptor);
        expect(read(snapshot), `writer; headroom=${headroom}`).toEqual(expected);
        expect(snapshot.size).toBe(fixture.size);
        expect(read(before.snapshot), `retained reader; headroom=${headroom}`).toEqual(expected);
        expect(before.snapshot.size).toBe(fixture.size);
        expect(a.buf.slice(HEAP_START, end), `published bytes; headroom=${headroom}`).toEqual(published);
        expect(a.used).toBeGreaterThanOrEqual(mark);
        expect(a.used).toBeLessThanOrEqual(CAPACITY);
        expect(a.memory.buffer.byteLength).toBe(CAPACITY);
        // A fresh WASM instance and empty read caches must agree after failure.
        const after = await initWorker(getWorkerData({ snapshot }, { copy: true }));
        expect(read(after.snapshot), `fresh copy reader; headroom=${headroom}`).toEqual(expected);
        expect(after.snapshot.size).toBe(fixture.size);
        expect(a.used, 'Checking old and new snapshots must not allocate in the writer').toBe(usedAfterUpdate);
      }
      expect(failures, 'The fixture must reach real memory exhaustion').toBeGreaterThan(0);
      expect(successes, 'The same operation must succeed when it has space').toBeGreaterThan(0);
      // Single-allocation operations need not have a partial allocation failure.
      if (scenario.partialFailure) expect(partialFailures).toBeGreaterThan(0);
    });
  }

  it('can make a smaller write after a partial failure without rewinding the arena', async () => {
    const a = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }) });
    const snapshot = new SharedList('number', 0, 0, 0, a).pushMany(values);
    const end = a.used, published = a.buf.slice(HEAP_START, end);
    a.alloc(CAPACITY - a.used - 192);
    const mark = a.used;
    expect(() => snapshot.set(0, -1)).toThrow(WebAssembly.RuntimeError);
    expect(a.used).toBeGreaterThan(mark);
    // A tail replacement is smaller than a replacement down the tree path.
    const recovered = snapshot.set(64, -2);
    const expected = [...values.slice(0, -1), -2];
    expect(recovered.toArray()).toEqual(expected);
    expect(snapshot.toArray()).toEqual(values);
    expect(a.buf.slice(HEAP_START, end)).toEqual(published);
    expect(a.memory.buffer.byteLength).toBe(CAPACITY);
    const reader = await initWorker(getWorkerData({ snapshot, recovered }, { copy: true }));
    expect(reader.snapshot.toArray()).toEqual(values);
    expect(reader.recovered.toArray()).toEqual(expected);
  });
});
