import assert from 'node:assert/strict';
import { describe, expect, test, vi } from 'vitest';
import { Arena, arenaOf, MAX_SIZE } from './arena';
import { structureRegistry } from './codec';
import { SharedOrderedMap, SharedOrderedSet, SharedList, resetOrderedMap, getWorkerData, initWorker } from './shared';

function numbers(count: number) {
  let map = new SharedOrderedMap('number', 0, 0, 0, 0, new Arena());
  const model = new Map<string, number>();
  for (let i = 0; i < count; i++) { map = map.set(`key-${i}`, i); model.set(`key-${i}`, i); }
  return { map, model };
}

function logNodes(map: SharedOrderedMap<any>): number[] {
  const nodes: number[] = [], view = arenaOf(map).dv;
  for (let p = map.head; p; p = view.getUint32(p, true)) nodes.push(p);
  return nodes;
}

describe('ordered iteration across log blocks', () => {
  test.each([0, 1, 255, 256, 257, 511, 512, 513, 769])('keeps all projections in insertion order for %i entries', count => {
    const { map, model } = numbers(count), expected = [...model];
    expect(map.orderStable).toBe(true);
    expect([...map.entries()]).toEqual(expected);
    expect([...map.keys()]).toEqual([...model.keys()]);
    expect([...map.values()]).toEqual([...model.values()]);
    const seen: Array<[string, number]> = [];
    map.forEach((value, key) => seen.push([key, value]));
    expect(seen).toEqual(expected);
  });

  test('filters overwrites, deletions and reinsertions while retaining both forks', () => {
    const { map: old, model: original } = numbers(769);
    let changed = old, model = new Map(original);
    for (const i of [0, 1, 255, 256, 511, 512, 768]) {
      changed = changed.set(`key-${i}`, -i - 1); model.set(`key-${i}`, -i - 1);
    }
    for (const i of [1, 254, 255, 256, 510, 511, 512, 767]) {
      changed = changed.delete(`key-${i}`); model.delete(`key-${i}`);
    }
    for (const i of [767, 512, 255, 1]) {
      changed = changed.set(`key-${i}`, i + 1000); model.set(`key-${i}`, i + 1000);
    }
    const fork = old.delete('key-0').set('🙂\u0000', 900);
    const forkModel = new Map(original); forkModel.delete('key-0'); forkModel.set('🙂\u0000', 900);
    expect(changed.orderStable).toBe(false);
    expect([...changed.entries()]).toEqual([...model]);
    expect([...old.entries()]).toEqual([...original]);
    expect([...fork.entries()]).toEqual([...forkModel]);
    // A long historical log may have only one remaining live entry.
    for (const key of model.keys()) if (key !== 'key-0') changed = changed.delete(key);
    expect([...changed.entries()]).toEqual([['key-0', -1]]);
    const empty = changed.delete('key-0');
    expect([...empty.entries()]).toEqual([]);
    expect([...empty.set('again', 4).entries()]).toEqual([['again', 4]]);
  });

  test('preserves generator identity and remains lazy before next, return or throw', () => {
    const { map, model } = numbers(769), a = arenaOf(map), view = vi.spyOn(a, 'dv', 'get');
    try {
      assert.equal(Object.getPrototypeOf(map.entries), Object.getPrototypeOf(function* () {}));
      assert.equal(map.entries.name, 'entries'); assert.equal(map.entries.length, 0);
      const iterator = map.entries(), closed = map.entries();
      assert.equal(Object.getPrototypeOf(iterator), map.entries.prototype);
      assert.deepEqual(closed.return('closed'), { done: true, value: 'closed' });
      const error = new Error('before start');
      assert.throws(() => map.entries().throw(error), caught => caught === error);
      assert.equal(view.mock.calls.length, 0);
      a.alloc(1024 * 1024); resetOrderedMap();
      assert.deepEqual([...iterator], [...model]);
      assert.deepEqual(closed.next(), { done: true, value: undefined });
    } finally { view.mockRestore(); }
  });

  test.each(['return', 'throw', 'break'] as const)('stops decoding after an early %s', completion => {
    const { map } = numbers(769), a = arenaOf(map);
    const keyRead = vi.spyOn(a, 'leafKey'), valueRead = vi.spyOn(a, 'leafValue');
    try {
      const iterator = map.entries();
      if (completion === 'break') { for (const _ of iterator) break; }
      else {
        expect(iterator.next()).toEqual({ done: false, value: ['key-0', 0] });
        if (completion === 'return') expect(iterator.return('closed')).toEqual({ done: true, value: 'closed' });
        else {
          const error = new Error('after start');
          assert.throws(() => iterator.throw(error), caught => caught === error);
        }
      }
      expect(keyRead).toHaveBeenCalledTimes(1); expect(valueRead).toHaveBeenCalledTimes(1);
      expect(iterator.next()).toEqual({ done: true, value: undefined });
      expect(valueRead).toHaveBeenCalledTimes(1);
    } finally { keyRead.mockRestore(); valueRead.mockRestore(); }
  });

  test('keeps iterator state local during recursive and interleaved forEach callbacks', () => {
    const { map, model } = numbers(769), expected = [...model], second = map.entries();
    const interleaved: Array<[string, number]> = [], outer: Array<[string, number]> = [];
    map.forEach((value, key) => {
      outer.push([key, value]); interleaved.push(second.next().value!);
      if (value === 1 || value === 256 || value === 512) {
        const recursive: Array<[string, number]> = [];
        map.forEach((v, k) => recursive.push([k, v]));
        expect(recursive).toEqual(expected);
      }
    });
    expect(outer).toEqual(expected); expect(interleaved).toEqual(expected);
    expect(second.next().done).toBe(true);
  });

  test('nested factories can reenter iteration and ordered keys still decode values after keys', () => {
    const child = new SharedList('number').pushMany([3, 4]);
    let map = new SharedOrderedMap('SharedList<number>', 0, 0, 0, 0, new Arena());
    for (let i = 0; i < 769; i++) map = map.set(`key-${i}`, child);
    const a = arenaOf(map), factory = structureRegistry.SharedList, original = factory.fromWorkerData;
    const keyRead = vi.spyOn(a, 'leafKey'), valueRead = vi.spyOn(a, 'leafValue');
    let entered = false, recursiveKey: unknown, factoryCalls = 0;
    factory.fromWorkerData = (data, source) => {
      factoryCalls++;
      if (!entered) {
        entered = true;
        const recursive = map.entries(); recursiveKey = recursive.next().value![0]; recursive.return();
      }
      return original(data, source);
    };
    try {
      expect([...map.keys()]).toEqual(Array.from({ length: 769 }, (_, i) => `key-${i}`));
      expect(recursiveKey).toBe('key-0'); expect(factoryCalls).toBeGreaterThanOrEqual(769);
      expect(valueRead).toHaveBeenCalledTimes(770);
      expect(keyRead.mock.invocationCallOrder[0]).toBeLessThan(valueRead.mock.invocationCallOrder[0]);
      const values = [...map.values()];
      expect(values.every(value => value.toArray().join(',') === '3,4')).toBe(true);
    } finally { factory.fromWorkerData = original; keyRead.mockRestore(); valueRead.mockRestore(); }
  });

  test('resume tolerates decoder-installed array setters and replacement array/DataView methods', () => {
    const child = new SharedList('number').push(1);
    let map = new SharedOrderedMap('SharedList<number>', 0, 0, 0, 0, new Arena());
    for (let i = 0; i < 769; i++) map = map.set(`key-${i}`, child);
    const view = arenaOf(map).dv, fields = new Set<number>();
    for (const node of logNodes(map)) { fields.add(node); fields.add(node + 4); }
    const originalRead = view.getUint32, ownRead = Object.getOwnPropertyDescriptor(view, 'getUint32');
    const push = Array.prototype.push, pop = Array.prototype.pop, splice = Array.prototype.splice;
    const iterate = Array.prototype[Symbol.iterator], index = Object.getOwnPropertyDescriptor(Array.prototype, '200');
    const factory = structureRegistry.SharedList, originalFactory = factory.fromWorkerData;
    const unexpected = new Error('new observable operation after decoding');
    let installed = false, count = 0;
    function fail(): never { throw unexpected; }
    factory.fromWorkerData = (data, source) => {
      if (!installed) {
        installed = true;
        const replacement = function (this: DataView, offset: number, littleEndian?: boolean) {
          if (fields.has(offset)) throw unexpected;
          return originalRead.call(this, offset, littleEndian);
        };
        Object.defineProperty(replacement, 'bind', { value: fail });
        Object.defineProperty(view, 'getUint32', { configurable: true, value: replacement });
        Object.defineProperty(Array.prototype, '200', { configurable: true, set: fail });
        Array.prototype.push = fail; Array.prototype.pop = fail; Array.prototype.splice = fail;
        Array.prototype[Symbol.iterator] = fail;
      }
      return originalFactory(data, source);
    };
    try {
      const iterator = map.entries();
      for (;;) {
        const item = iterator.next();
        if (item.done) break;
        if (item.value[0] !== `key-${count}`) throw new Error('wrong order');
        count++;
      }
    } finally {
      factory.fromWorkerData = originalFactory;
      Array.prototype.push = push; Array.prototype.pop = pop; Array.prototype.splice = splice;
      Array.prototype[Symbol.iterator] = iterate;
      if (index) Object.defineProperty(Array.prototype, '200', index); else delete Array.prototype[200];
      if (ownRead) Object.defineProperty(view, 'getUint32', ownRead); else delete (view as any).getUint32;
    }
    expect(installed).toBe(true); expect(count).toBe(769);
  });

  test.each([false, true])('retains shared/copied readers across growth, reset and new attachments (copy=%s)', async copy => {
    const { map: stable, model } = numbers(769), a = arenaOf(stable);
    const changed = stable.set('key-256', -1).delete('key-0').set('key-0', 900);
    const expectedChanged = new Map(model); expectedChanged.set('key-256', -1); expectedChanged.delete('key-0'); expectedChanged.set('key-0', 900);
    const readers = await initWorker(getWorkerData({ stable, changed }, { copy }));
    const first = readers.stable.entries(), second = readers.changed.entries();
    const actual = [first.next().value!], actualChanged = [second.next().value!];
    const before = a.memory.buffer.byteLength;
    a.alloc(before + 65536);
    expect(a.memory.buffer.byteLength).toBeGreaterThan(before);
    const newer = changed.set('later', 1000);
    resetOrderedMap();
    const attached = await initWorker(getWorkerData({ newer }, { copy }));
    actual.push(...first); actualChanged.push(...second);
    expect(actual).toEqual([...model]); expect(actualChanged).toEqual([...expectedChanged]);
    expect([...readers.stable.entries()]).toEqual([...model]);
    expect(attached.newer.get('later')).toBe(1000);
    expect(() => readers.stable.set('forbidden', 1)).toThrow(/read-only/);
    expect(new SharedOrderedMap('number').size).toBe(0);
  });

  test('ordered sets preserve insertion order and old snapshots across several blocks', async () => {
    let set = new SharedOrderedSet(new SharedOrderedMap('number', 0, 0, 0, 0, new Arena()));
    const model = new Set<string | number>();
    for (let i = 0; i < 769; i++) { const value = i % 2 ? `${i}` : i; set = set.add(value); model.add(value); }
    const old = set, original = [...model];
    for (const value of [0, '255', 256, '511', 512]) { set = set.delete(value).add(value); model.delete(value); model.add(value); }
    expect([...old.values()]).toEqual(original); expect([...set.values()]).toEqual([...model]);
    const seen: Array<string | number> = []; set.forEach(value => seen.push(value));
    expect(seen).toEqual([...model]);
    for (const copy of [false, true]) {
      const restored = await initWorker(getWorkerData({ old, set }, { copy }));
      expect([...restored.old.values()]).toEqual(original); expect([...restored.set.values()]).toEqual([...model]);
    }
  });

  test('uses actual log length with misleading tail and size metadata without coercing tail', () => {
    const { map, model } = numbers(769), source = arenaOf(map), data = map.toWorkerData();
    let coercions = 0;
    const hostile = { valueOf() { coercions++; throw new Error('tail coercion'); } };
    for (const tail of [0, 1, 255, 256, 257, MAX_SIZE, MAX_SIZE + 1, -1, 257.5, NaN, Infinity, '769', 769n, Symbol('tail'), hostile]) {
      const restored = SharedOrderedMap.fromWorkerData({ ...data, tail: tail as number, size: 0 }, source);
      expect([...restored.entries()]).toEqual([...model]);
    }
    expect(coercions).toBe(0);
    for (const count of [0, 1, 255, 256]) {
      const small = numbers(count);
      const restored = SharedOrderedMap.fromWorkerData({ ...small.map.toWorkerData(), tail: MAX_SIZE }, arenaOf(small.map));
      expect([...restored.entries()]).toEqual([...small.model]);
    }
  });

  test('preserves the old nonnumeric-head coercion and error path', () => {
    const { map, model } = numbers(257), source = arenaOf(map), data = map.toWorkerData();
    const hints: string[] = [];
    const head = { [Symbol.toPrimitive](hint: string) { hints.push(hint); return map.head; } };
    const restored = SharedOrderedMap.fromWorkerData({ ...data, head: head as unknown as number }, source);
    expect([...restored.entries()]).toEqual([...model]);
    expect(hints).toEqual(['default', 'number']);
    for (const head of [Symbol('head'), 1n]) {
      const malformed = SharedOrderedMap.fromWorkerData({ ...data, head: head as unknown as number }, source);
      expect(() => malformed.entries().next()).toThrow(TypeError);
    }
    const empty = SharedOrderedMap.fromWorkerData({ ...data, head: '' as unknown as number }, source);
    expect([...empty.entries()]).toEqual([]);
  });

  test('rejects a static malformed log before any output or leaf decoding', () => {
    const { map } = numbers(769), a = arenaOf(map), nodes = logNodes(map), view = a.dv;
    const oldest = nodes[nodes.length - 1], previous = view.getUint32(oldest, true);
    // At this address the next-link word fits, but the earlier leaf-pointer
    // read does not. The entire scan must still happen before the first yield.
    view.setUint32(oldest, view.byteLength - 4, true);
    const keyRead = vi.spyOn(a, 'leafKey'), valueRead = vi.spyOn(a, 'leafValue');
    try {
      expect(() => map.entries().next()).toThrow(RangeError);
      expect(keyRead).not.toHaveBeenCalled(); expect(valueRead).not.toHaveBeenCalled();
    } finally { view.setUint32(oldest, previous, true); keyRead.mockRestore(); valueRead.mockRestore(); }
  });

  test.each([true, false])('defers a static malformed leaf to its old output position (stable=%s)', stable => {
    const { map } = numbers(769), a = arenaOf(map), nodes = logNodes(map), view = a.dv;
    const node = nodes[nodes.length - 1 - 300], original = view.getUint32(node + 4, true);
    view.setUint32(node + 4, view.byteLength, true);
    const reader = SharedOrderedMap.fromWorkerData({ ...map.toWorkerData(), orderStable: stable }, a);
    try {
      const iterator = reader.entries();
      for (let i = 0; i < 300; i++) expect(iterator.next()).toEqual({ done: false, value: [`key-${i}`, i] });
      expect(() => iterator.next()).toThrow(RangeError);
    } finally { view.setUint32(node + 4, original, true); }
  });
});
