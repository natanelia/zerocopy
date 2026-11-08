import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { structureRegistry } from './codec';
import { SharedList, SharedPriorityQueue, getWorkerData, initWorker } from './shared';
import { createZerocopyCodec } from './redux';

const codec = createZerocopyCodec();
type Node = { value: any; priority: number; left: Node | null; right: Node | null; rank: number };
function referenceInsert(root: Node | null, value: any, priority: number, max: boolean): Node {
  if (!root || (max ? priority > root.priority : priority < root.priority)) {
    return { value, priority, left: root, right: null, rank: 1 };
  }
  let left = root.left, right: Node | null = referenceInsert(root.right, value, priority, max);
  if ((left?.rank ?? 0) < right.rank) [left, right] = [right, left];
  return { value: root.value, priority: root.priority, left, right, rank: (right?.rank ?? 0) + 1 };
}
function tag(value: any): any {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['n', 'NaN'];
    if (value === Infinity || value === -Infinity) return ['n', String(value)];
    return Object.is(value, -0) ? ['n', '-0'] : value;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return ['a', value.map(tag)];
  return ['o', Object.keys(value).map(key => [key, tag(value[key])])];
}
function expectedHeap(type: string, entries: [any, number][], max = false, transform = tag): any {
  let root: Node | null = null;
  for (const [value, priority] of entries) root = referenceInsert(root, value, priority, max);
  const nodes = root ? [root] : [], rows: any[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const left = node.left ? nodes.push(node.left) - 1 : -1;
    const right = node.right ? nodes.push(node.right) - 1 : -1;
    rows.push([transform(node.value), tag(node.priority), left, right]);
  }
  return { $zerocopyRedux: 1, value: ['c', 'SharedPriorityQueue', type, max, rows] };
}
function make(type: string, entries: [any, number][], max = false, arena = new Arena()): any {
  let source: any = new SharedPriorityQueue(type, { maxHeap: max }, arena);
  for (const [value, priority] of entries) source = source.enqueue(value, priority);
  return source;
}
function entries(count: number, type = 'number'): [any, number][] {
  return Array.from({ length: count }, (_, i) => [type === 'boolean' ? i % 3 === 0 : i / 4 - 17, (i * 73) % 127 - 63]);
}
function patch(object: object, name: string, descriptor: PropertyDescriptor, run: () => void): void {
  const old = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, ...descriptor });
  try { run(); }
  finally { if (old) Object.defineProperty(object, name, old); else Reflect.deleteProperty(object, name); }
}
function unchanged(source: any, run: () => void): void {
  const arena = arenaOf(source), used = arena.used, bytes = arena.buf.slice(HEAP_START, used);
  const descriptor = source.toWorkerData();
  run();
  assert.equal(arena.used, used);
  assert.deepEqual(arena.buf.subarray(HEAP_START, used), bytes);
  assert.deepEqual(source.toWorkerData(), descriptor);
}

describe('portable Redux heap view reuse', () => {
  for (const max of [false, true]) {
    it(`preserves independent breadth-first topology at the fast-path boundary (max=${max})`, () => {
      for (const count of [0, 1, 8, 31, 32, 33, 127, 4096]) {
        const input = entries(count), source = make('number', input, max), expected = expectedHeap('number', input, max);
        unchanged(source, () => {
          assert.deepEqual(codec.encode(source), expected);
          assert.equal(codec.stringify(source), JSON.stringify(expected));
        });
      }
    });

    it(`keeps boolean values, tied priorities and exact special-number tags (max=${max})`, () => {
      const numbers = [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE, -3.25];
      const priorities = [-0, 0, -Infinity, Infinity, -1, 1, -0, 0];
      for (const type of ['number', 'boolean']) {
        const input: [any, number][] = Array.from({ length: 96 }, (_, i) => [type === 'boolean' ? i % 3 === 0 : numbers[i % numbers.length], priorities[i % priorities.length]]);
        const source = make(type, input, max), expected = expectedHeap(type, input, max);
        unchanged(source, () => {
          assert.deepEqual(codec.encode(source), expected);
          assert.deepEqual(codec.encode(codec.parse(codec.stringify(source))), expected);
        });
      }
    });

    it(`preserves old roots and forks after external growth (max=${max})`, () => {
      const input = entries(1025), source = make('number', input, max), arena = arenaOf(source);
      const added = source.enqueue(-999, max ? 999 : -999), removed = source.dequeue();
      const expected = expectedHeap('number', input, max), removedBefore = codec.encode(removed);
      const bytes = arena.buf.slice(HEAP_START, arena.used), used = arena.used, old = arena.memory.buffer;
      arena.memory.grow(2);
      assert.notEqual(arena.memory.buffer, old);
      assert.deepEqual(codec.encode(source), expected);
      assert.deepEqual(codec.encode(added), expectedHeap('number', [...input, [-999, max ? 999 : -999]], max));
      assert.deepEqual(codec.encode(removed), removedBefore);
      assert.equal(arena.used, used); assert.deepEqual(arena.buf.subarray(HEAP_START, used), bytes);
    });
  }

  it('preserves collection, node, depth and text budgets', () => {
    const input = entries(65), source = make('number', input), expected = expectedHeap('number', input);
    for (const options of [{ maxCollectionSize: 64 }, { maxNodes: 130 }, { maxTextLength: 2 }]) {
      unchanged(source, () => assert.throws(() => createZerocopyCodec(options).stringify(source), RangeError));
    }
    assert.deepEqual(createZerocopyCodec({ maxNodes: 131, maxDepth: 1 }).encode(source), expected);
    assert.throws(() => createZerocopyCodec({ maxDepth: 1 }).encode({ source }), /codec limit/);
  });

  it('keeps invalid-size errors and does not touch an absent root', () => {
    const source = make('number', entries(33)), arena = arenaOf(source);
    for (const size of [-1, 0, 1, 31, 32, 34]) {
      const malformed = SharedPriorityQueue.fromWorkerData({ ...source.toWorkerData(), size }, arena);
      assert.throws(() => codec.encode(malformed), error => error instanceof TypeError && error.message === 'Invalid heap size');
    }
    const error = new Error('must not access an empty heap view');
    patch(arena, 'dv', { get() { throw error; } }, () => {
      const empty = SharedPriorityQueue.fromWorkerData({ ...source.toWorkerData(), root: 0, size: 0 }, arena);
      assert.deepEqual(codec.encode(empty), expectedHeap('number', []));
      const absent = SharedPriorityQueue.fromWorkerData({ ...source.toWorkerData(), root: 0, size: 33 }, arena);
      assert.throws(() => codec.encode(absent), failure => failure instanceof TypeError && failure.message === 'Invalid heap size');
    });
  });

  it('preserves coercible roots and sizes from manually constructed descriptors', () => {
    const source = make('number', entries(65)), arena = arenaOf(source);
    const error = new Error('view replaced during root coercion');
    const root = { valueOf() {
      Object.defineProperty(arena, 'dv', { configurable: true, get() { throw error; } });
      return source.root;
    } };
    const coercible = SharedPriorityQueue.fromWorkerData({ ...source.toWorkerData(), root: root as any }, arena);
    try { assert.throws(() => codec.encode(coercible), thrown => thrown === error); }
    finally { Reflect.deleteProperty(arena, 'dv'); }

    let sizeReads = 0;
    const size = { valueOf() { sizeReads++; return source.size; } };
    const sized = SharedPriorityQueue.fromWorkerData({ ...source.toWorkerData(), size: size as any }, arena);
    assert.throws(() => codec.encode(sized), failure => failure instanceof TypeError && failure.message === 'Invalid heap size');
    assert.equal(sizeReads, source.size + 1);
  });

  it('honors own decoder getters without extra reads and preserves the Arena receiver', () => {
    const input = entries(65), source = make('number', input), arena = arenaOf(source), native = Arena.prototype.decode;
    let reads = 0;
    const decode = function (this: Arena, type: string, raw: number) {
      assert.equal(this, arena); return Reflect.apply(native, this, [type, raw]) + 100;
    };
    Object.defineProperty(decode, 'call', { value() { throw new Error('unexpected .call'); } });
    patch(arena, 'decode', { get() { reads++; assert.equal(this, arena); return decode; } }, () => {
      assert.deepEqual(codec.encode(source), expectedHeap('number', input, false, value => tag(value + 100)));
    });
    assert.equal(reads, input.length);
    patch(Arena.prototype, 'decode', { value: decode }, () => {
      assert.deepEqual(codec.encode(source), expectedHeap('number', input, false, value => tag(value + 100)));
    });
  });

  it('honors custom view and refresh accessors without changing read order', () => {
    const source = make('number', entries(65)), arena = arenaOf(source);
    const view = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!, refresh = Arena.prototype.refresh;
    let reads = 0, refreshes = 0;
    const expected = codec.encode(source);
    patch(arena, 'dv', { get() { reads++; assert.equal(this, arena); return Reflect.apply(view, this, []); } }, () => {
      assert.deepEqual(codec.encode(source), expected);
    });
    assert.equal(reads, source.size * 4);
    patch(Arena.prototype, 'dv', { get() { reads++; return Reflect.apply(view, this, []); } }, () => {
      assert.deepEqual(codec.encode(source), expected);
    });
    assert.equal(reads, source.size * 8);
    patch(arena, 'refresh', { get() {
      refreshes++; assert.equal(this, arena); return refresh;
    } }, () => assert.deepEqual(codec.encode(source), expected));
    assert.equal(refreshes, source.size * 4);
  });

  it('retains custom Arena subclasses and exact reader exceptions', () => {
    class CustomArena extends Arena {
      decode(type: string, raw: number): any { return type === 'number' ? raw - 1 : super.decode(type, raw); }
    }
    const input = entries(65), custom = make('number', input, false, new CustomArena());
    assert.deepEqual(codec.encode(custom), expectedHeap('number', input, false, value => tag(value - 1)));
    const source = make('number', input), arena = arenaOf(source), error = new Error('reader stopped');
    for (const name of ['dv', 'decode', 'refresh']) {
      patch(arena, name, { get() { throw error; } }, () => {
        assert.throws(() => codec.encode(source), thrown => thrown === error);
      });
    }
  });

  it('preserves Proxy reader interception without new reflection traps', () => {
    const input = entries(65), source = make('number', input), target = arenaOf(source);
    let views = 0, decodes = 0;
    const intercepted = new Proxy(target, { get(object, key, receiver) {
      if (key === 'dv') views++;
      if (key === 'decode') {
        decodes++;
        return function (this: Arena, type: string, raw: number) {
          assert.equal(this, intercepted); return object.decode(type, raw) + 100;
        };
      }
      return Reflect.get(object, key, receiver);
    } });
    const custom = SharedPriorityQueue.fromWorkerData(source.toWorkerData(), intercepted);
    assert.deepEqual(codec.encode(custom), expectedHeap('number', input, false, value => tag(value + 100)));
    assert.equal(views, source.size * 4); assert.equal(decodes, source.size);

    const reflectionError = new Error('new prototype reflection is forbidden');
    const trapped = new Proxy(target, { getPrototypeOf() { throw reflectionError; } });
    const opaque = SharedPriorityQueue.fromWorkerData(source.toWorkerData(), trapped);
    assert.deepEqual(codec.encode(opaque), expectedHeap('number', input));
  });

  it('allows decoder reentry and view replacement during the same row', () => {
    for (const valueType of ['number', 'string']) {
      const input: [any, number][] = entries(40).map(([value, priority]) => [valueType === 'number' ? value : `value-${value}`, priority]);
      const source = make(valueType, input), arena = arenaOf(source), decode = arena.decode;
      const originalView = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!;
      const bytes = arena.buf.slice(HEAP_START, arena.used), used = arena.used;
      let reads = 0, first = true;
      patch(arena, 'decode', { value: function (this: Arena, type: string, raw: number) {
        if (first) {
          first = false; arena.memory.grow(2);
          assert.deepEqual(codec.encode(new SharedList('number').push(7)).value, ['c', 'SharedList', 'number', null, [7]]);
          Object.defineProperty(arena, 'dv', { configurable: true, get() { reads++; return Reflect.apply(originalView, arena, []); } });
        }
        return Reflect.apply(decode, this, [type, raw]);
      } }, () => {
        try { assert.deepEqual(codec.encode(source), expectedHeap(valueType, input)); }
        finally { Reflect.deleteProperty(arena, 'dv'); }
      });
      // Uncached string decoding obtains one additional length view. The
      // numeric override must also preserve lookups after its first callback.
      assert.equal(reads, 1 + (source.size - 1) * 4 + (valueType === 'string' ? source.size : 0));
      assert.equal(arena.used, used); assert.deepEqual(arena.buf.subarray(HEAP_START, used), bytes);
    }
  });

  it('keeps JSON and nested reconstruction on the callback-safe path through growth', () => {
    const json: [any, number][] = entries(40).map(([value, priority]) => [{ id: value, child: [false, '🙂'] }, priority]);
    const objectSource = make('object', json);
    assert.deepEqual(codec.encode(objectSource), expectedHeap('object', json));
    assert.ok(Object.isFrozen(objectSource.peek().child));

    const input: [any, number][] = entries(40).map(([value, priority]) => [new SharedList('number').push(value), priority]);
    const source = make('SharedList<number>', input), arena = arenaOf(source);
    const expected = expectedHeap('SharedList<number>', input, false, value => ['c', 'SharedList', 'number', null, value.toArray().map(tag)]);
    const restore = structureRegistry.SharedList.fromWorkerData;
    const used = arena.used, bytes = arena.buf.slice(HEAP_START, used);
    let reconstructed = 0;
    patch(structureRegistry.SharedList, 'fromWorkerData', { value: function (data: any, target: Arena) {
      if (++reconstructed === 17) arena.memory.grow(2);
      return restore(data, target);
    } }, () => assert.deepEqual(codec.encode(source), expected));
    assert.equal(reconstructed, source.size);
    assert.equal(arena.used, used); assert.deepEqual(arena.buf.subarray(HEAP_START, used), bytes);
  });

  for (const copy of [false, true]) {
    it(`encodes ${copy ? 'copied' : 'shared'} read-only worker attachments`, async () => {
      const input = entries(1025), source = make('number', input, true);
      const { heap } = await initWorker(getWorkerData({ heap: source }, { copy }));
      const arena = arenaOf(heap), used = arena.used, bytes = arena.buf.slice(HEAP_START, used);
      assert.ok(arena.readOnly);
      assert.deepEqual(codec.encode(heap), expectedHeap('number', input, true));
      assert.throws(() => heap.enqueue(-1, 0), /read-only/);
      assert.equal(arena.used, used); assert.deepEqual(arena.buf.subarray(HEAP_START, used), bytes);
    });
  }
});
