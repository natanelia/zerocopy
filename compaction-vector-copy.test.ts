import { describe, expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, SharedQueue, SharedMap, compact, compactMany, getWorkerData, initWorker } from './shared';

const special = [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE];
const numbers = (size: number) => Array.from({ length: size }, (_, i) => i % 17 === 0 ? special[(i / 17) % special.length | 0] : i / 8 - 4096);
function values(queue: SharedQueue<any>): unknown[] {
  const result = [];
  while (queue.size) { result.push(queue.peek()); queue = queue.dequeue(); }
  return result;
}
function bytes(source: object): Uint8Array {
  const a = arenaOf(source); return a.buf.slice(HEAP_START, a.used);
}
function unchanged(source: object, before: Uint8Array): void {
  assert.deepEqual(arenaOf(source).buf.slice(HEAP_START, HEAP_START + before.length), before);
}
function queue<T extends 'number' | 'boolean'>(type: T, items: any[]): SharedQueue<T> {
  let result = new SharedQueue(type, 0, 0, 0, undefined, new Arena());
  for (const value of items) result = result.enqueue(value);
  return result;
}

describe('primitive vector compaction', () => {
  for (const type of ['number', 'boolean'] as const) {
    test(`${type}: preserves boundaries, every value and writable results`, () => {
      for (const size of [0, 1, 8, 31, 32, 33, 64, 65, 1024, 1025, 32769, 32770, 32801]) {
        const expected: any[] = type === 'number' ? numbers(size) : Array.from({ length: size }, (_, i) => (i & 3) === 1);
        const source = new SharedList(type, 0, 0, 0, new Arena()).pushMany(expected), before = bytes(source), used = arenaOf(source).used;
        if (size === 32801) expect(source.depth).toBe(3);
        const copy = compact(source);
        assert.deepEqual(copy.toArray(), expected);
        expect(copy.toWorkerData().size).toBe(size);
        assert.notStrictEqual(arenaOf(copy), arenaOf(source));
        expect(arenaOf(copy).readOnly).toBe(false);
        expect(Object.isFrozen(copy)).toBe(true);
        expect(copy.push(type === 'number' ? -0 : true).get(size)).toBe(type === 'number' ? -0 : true);
        expect(arenaOf(source).used).toBe(used);
        unchanged(source, before);
      }
    });

    test(`${type}: drops consumed queue prefixes across partial blocks`, () => {
      const expected: any[] = type === 'number' ? numbers(1153) : Array.from({ length: 1153 }, (_, i) => i % 7 === 2);
      const original = queue(type, expected), before = bytes(original), retained = [];
      let source = original, offset = 0;
      for (const consumed of [0, 1, 31, 32, 33, 37, 1023, 1024, 1025, 1121, 1122, 1152, 1153]) {
        while (offset < consumed) { source = source.dequeue(); offset++; }
        const copy = compact(source);
        expect(values(copy)).toEqual(expected.slice(consumed));
        expect(copy.tail).toBe(0);
        expect(copy.size).toBe(expected.length - consumed);
        const next = copy.enqueue(type === 'number' ? -0 : true);
        expect(values(next)).toEqual([...expected.slice(consumed), type === 'number' ? -0 : true]);
        retained.push({ copy, expected: expected.slice(consumed) });
      }
      for (const item of retained) expect(values(item.copy)).toEqual(item.expected);
      expect(values(original)).toEqual(expected);
      unchanged(original, before);
    });
  }

  test('retains forks and nested aliases while target and source memory grow', () => {
    const expected = numbers(32769), source = new SharedList('number', 0, 0, 0, new Arena()).pushMany(expected);
    const changed = source.set(31, -0).set(32768, 999).pop(), changedExpected = expected.slice(0, -1);
    changedExpected[31] = -0;
    const outer = new SharedMap('SharedList<number>').set('left', source).set('again', source).set('changed', changed);
    const before = bytes(source);
    arenaOf(source).alloc(3 * 65536);
    const copies = compactMany({ source, changed, outer, duplicate: source });
    expect(copies.source).toBe(copies.duplicate);
    assert.deepEqual(copies.source.toArray(), expected);
    assert.deepEqual(copies.changed.toArray(), changedExpected);
    expect(copies.outer.get('left')!.toWorkerData()).toEqual(copies.source.toWorkerData());
    expect(copies.outer.get('again')!.toWorkerData()).toEqual(copies.source.toWorkerData());
    assert.deepEqual(copies.outer.get('changed')!.toArray(), changedExpected);
    expect(arenaOf(copies.outer.get('left')!)).toBe(arenaOf(copies.source));
    expect(getWorkerData(copies, { copy: false }).arenas).toHaveLength(1);
    arenaOf(copies.source).alloc(8 * 65536);
    expect(copies.source.set(1024, -1).get(1024)).toBe(-1);
    assert.deepEqual(copies.source.toArray(), expected);
    assert.deepEqual(source.toArray(), expected);
    unchanged(source, before);
  });

  test('compacts both read-only transport modes into independent writable arenas', async () => {
    const source = new SharedList('number', 0, 0, 0, new Arena()).pushMany(numbers(4097));
    let sourceQueue = queue('number', numbers(4134));
    for (let i = 0; i < 37; i++) sourceQueue = sourceQueue.dequeue();
    for (const copy of [false, true]) {
      const attached = await initWorker(getWorkerData({ source, sourceQueue }, { copy }));
      const oldList = bytes(attached.source), oldQueue = bytes(attached.sourceQueue);
      expect(() => attached.source.push(1)).toThrow(/read-only/);
      expect(() => attached.sourceQueue.enqueue(1)).toThrow(/read-only/);
      arenaOf(source).alloc(2 * 65536);
      const rebuilt = compactMany(attached);
      expect(rebuilt.source.toArray()).toEqual(numbers(4097));
      expect(values(rebuilt.sourceQueue)).toEqual(numbers(4134).slice(37));
      expect(rebuilt.source.push(-0).get(4097)).toBe(-0);
      expect(values(rebuilt.sourceQueue.enqueue(-0)).at(-1)).toBe(-0);
      expect(arenaOf(rebuilt.source)).toBe(arenaOf(rebuilt.sourceQueue));
      assert.notStrictEqual(arenaOf(rebuilt.source), arenaOf(attached.source));
      unchanged(attached.source, oldList); unchanged(attached.sourceQueue, oldQueue);
    }
  });

  test('keeps custom Arena views and replacement vecGet kernels on their existing path', () => {
    class CustomArena extends Arena {
      reads = 0;
      override get dv(): DataView { this.reads++; return super.dv; }
    }
    const a = new CustomArena(), source = new SharedList('number', 0, 0, 0, a).pushMany(numbers(64));
    a.reads = 0;
    expect(compact(source).toArray()).toEqual(numbers(64));
    expect(a.reads).toBe(32);

    const b = new Arena(), original = new SharedList('number', 0, 0, 0, b).pushMany(Array.from({ length: 64 }, (_, i) => i));
    const wasm = b.wasm; let reads = 0;
    (b as any).wasm = { ...wasm, vecGet(root: number, depth: number, index: number) {
      reads++; return wasm.vecGet(root, depth, index) + 1000;
    } };
    expect(compact(original).toArray()).toEqual(Array.from({ length: 64 }, (_, i) => i < 32 ? i + 1000 : i));
    expect(reads).toBe(32);
  });

  test('does not invoke replaced Arena.wasm getters while checking the native path', () => {
    const a = new Arena(), source = new SharedList('number', 0, 0, 0, a).pushMany(numbers(65));
    const wasm = a.wasm; let reads = 0;
    Object.defineProperty(a, 'wasm', { get() { reads++; return wasm; } });
    expect(compact(source).toArray()).toEqual(numbers(65));
    expect(reads).toBe(64);
  });

  test('keeps proxy-owned arenas on the original read path', () => {
    const arena = new Proxy(new Arena(), {});
    const source = new SharedList('number', 0, 0, 0, arena).pushMany(numbers(65));
    const copy = compact(source);
    assert.deepEqual(copy.toArray(), numbers(65));
    assert.deepEqual(source.toArray(), numbers(65));
  });

  test('does not invoke reflection traps on proxy-owned arenas', () => {
    for (const trap of ['getPrototypeOf', 'getOwnPropertyDescriptor'] as const) {
      const arena = new Proxy(new Arena(), { [trap]() { throw new Error(`Unexpected ${trap}`); } });
      const source = new SharedList('number', 0, 0, 0, arena).pushMany(numbers(65));
      assert.deepEqual(compact(source).toArray(), numbers(65));
      assert.deepEqual(source.toArray(), numbers(65));
    }
  });

  test('preserves overridden descriptor getters, their receiver and field read counts', () => {
    const source = new SharedList('number', 0, 0, 0, new Arena()).pushMany(numbers(33));
    const descriptor = source.toWorkerData(), method = Object.getOwnPropertyDescriptor(SharedList.prototype, 'toWorkerData')!;
    const reads: Record<string, number> = {}; let methodReads = 0, calls = 0;
    Object.defineProperty(SharedList.prototype, 'toWorkerData', { configurable: true, get() {
      methodReads++;
      return function (this: SharedList<'number'>) {
        expect(this).toBe(source); calls++;
        return Object.defineProperties({}, Object.fromEntries(Object.entries(descriptor).map(([key, value]) => [key, {
          enumerable: true, get() { reads[key] = (reads[key] ?? 0) + 1; return value; },
        }])));
      };
    } });
    try {
      expect(compact(source).toArray()).toEqual(numbers(33));
      expect(methodReads).toBe(1); expect(calls).toBe(1);
      expect(reads).toEqual({ root: 3, depth: 34, size: 3, type: 3, tail: 3 });
    } finally { Object.defineProperty(SharedList.prototype, 'toWorkerData', method); }
  });

  test('retains descriptor coercions and errors instead of silently clipping bytes', () => {
    const a = new Arena(), source = new SharedList('number', 0, 0, 0, a).pushMany(numbers(33));
    const fractional = new SharedList('number', source.root, source.depth, source.size, a, source.tail + 0.75);
    expect(compact(fractional).toArray()).toEqual(numbers(33));
    const badRoot = new SharedList('number', a.memory.buffer.byteLength - 4, 0, 33, a, source.tail);
    expect(() => compact(badRoot)).toThrow(WebAssembly.RuntimeError);
    const badTail = new SharedList('number', 0, 0, 32, a, a.memory.buffer.byteLength - 8);
    expect(() => compact(badTail)).toThrow(RangeError);
    const huge = new SharedList('number', a.memory.buffer.byteLength, 1, 0x10000000, a, 0);
    expect(() => compact(huge)).toThrow(WebAssembly.RuntimeError);
  });

  test('retains the original coercion order for a numeric-coercible queue offset', () => {
    const original = queue('number', numbers(102)), descriptor = original.toWorkerData(), hints: string[] = [];
    const offset = { [Symbol.toPrimitive](hint: string) { hints.push(hint); return 37; } };
    const source = new SharedQueue('number', descriptor.head, offset as any, 65, undefined,
      arenaOf(original), descriptor.block, descriptor.depth);
    hints.length = 0;
    assert.deepEqual(values(compact(source)), numbers(102).slice(37));
    assert.deepEqual(hints, ['default', 'number', 'number', 'number', 'number']);
  });

  test('continues to copy string, JSON and nested vector values without changing their source', () => {
    const strings = new SharedList('string').pushMany(Array.from({ length: 65 }, (_, i) => `界🙂/${i}`));
    const objects = new SharedList('object').pushMany(Array.from({ length: 65 }, (_, i) => ({ i, nested: { valid: true } })));
    const nested = new SharedList('SharedList<string>').pushMany([strings, strings]);
    const copied = compactMany({ strings, objects, nested });
    expect(copied.strings.toArray()).toEqual(strings.toArray());
    expect(copied.objects.toArray()).toEqual(objects.toArray());
    expect(Object.isFrozen(copied.objects.get(0))).toBe(true);
    expect(copied.nested.get(0)!.toWorkerData()).toEqual(copied.strings.toWorkerData());
    expect(copied.nested.get(1)!.toWorkerData()).toEqual(copied.strings.toWorkerData());
  });
});
