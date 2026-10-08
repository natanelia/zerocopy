import { beforeEach, describe, expect, test, vi } from 'vitest';
import { arenaOf } from './arena';
import { SharedOrderedMap, SharedSortedMap, SharedList, SharedOrderedSet, SharedSortedSet, resetOrderedMap, resetSortedMap, getWorkerData, initWorker } from './shared';

beforeEach(() => { resetOrderedMap(); resetSortedMap(); });

for (const [name, make] of [
  ['ordered', () => new SharedOrderedMap('object')],
  ['sorted', () => new SharedSortedMap('object')],
  ['custom sorted', () => new SharedSortedMap('object', (a, b) => b.localeCompare(a))],
] as const) describe(`${name} map projection`, () => {
  test('keys skip value decoding, including cold JSON larger than the cache', () => {
    let map = make();
    for (let i = 0; i < 2100; i++) map = map.set(`key-${i}`, { index: i, text: '🙂'.repeat(8) }) as typeof map;
    const a = arenaOf(map), read = vi.spyOn(a, 'leafValue');
    const keys = [...map.keys()];
    expect(keys).toHaveLength(2100);
    expect(new Set(keys).size).toBe(2100);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(keys).toEqual([...map.entries()].map(([key]) => key));
  });

  test('retains replacement, deletion, reinsertion, Unicode and old-fork order', () => {
    const original = make().set('🙂', { x: 1 }).set('a', { x: 2 }).set('\u0000', { x: 3 }).set('é', { x: 4 });
    const next = original.set('a', { x: 20 }).delete('🙂').set('🙂', { x: 10 });
    const fork = original.delete('é').set('z', { x: 5 });
    for (const map of [original, next, fork, make()]) {
      const entries = [...map.entries()];
      expect([...map.keys()]).toEqual(entries.map(([key]) => key));
      expect([...map.values()]).toEqual(entries.map(([, value]) => value));
      expect([...map.values()].every(value => Object.isFrozen(value))).toBe(true);
    }
    expect(original.get('a')).toEqual({ x: 2 });
    expect(next.get('a')).toEqual({ x: 20 });
  });
});

for (const [name, make] of [
  ['ordered', () => new SharedOrderedMap('number')],
  ['sorted', () => new SharedSortedMap('number')],
] as const) describe(`${name} read-only projections`, () => {
  test('values skip key decoding and preserve every f64 value', () => {
    let map = make().set('d', NaN).set('b', -0).set('a', Infinity).set('c', -Infinity);
    map = map.set('d', NaN) as typeof map;
    const expected = [...map.entries()].map(([, value]) => value);
    const keyRead = vi.spyOn(arenaOf(map), 'leafKey');
    const actual = [...map.values()];
    expect(keyRead).not.toHaveBeenCalled();
    keyRead.mockRestore();
    expect(actual).toHaveLength(expected.length);
    expect(actual.every((value, i) => Object.is(value, expected[i]))).toBe(true);
  });

  test.each([false, true])('attached iterator remains valid across memory growth (copy=%s)', async copy => {
    let map = make().set('a', 1).set('b', 2).set('c', 3);
    map = map.set('b', 20) as typeof map;
    const expected = [...map.entries()];
    const reader = (await initWorker(getWorkerData({ map }, { copy }))).map;
    const keys = reader.keys(), values = reader.values(), entries = reader.entries();
    const k = [keys.next().value], v = [values.next().value], e = [entries.next().value];
    arenaOf(map).alloc(1024 * 1024);
    map = map.delete('a').set('d', 4) as typeof map;
    k.push(...keys); v.push(...values); e.push(...entries);
    expect(k).toEqual(expected.map(([key]) => key));
    expect(v).toEqual(expected.map(([, value]) => value));
    expect(e).toEqual(expected);
    expect([...reader.keys()]).toEqual(k);
  });
});

test('custom comparator ties keep stable natural order and comparator receiver', () => {
  let receiver: unknown;
  const compare = function (this: unknown, a: string, b: string) { receiver = this; return a.length - b.length; };
  const map = new SharedSortedMap('number', compare).set('z', 1).set('aa', 2).set('a', 3).set('bb', 4);
  expect([...map.keys()]).toEqual(['a', 'z', 'aa', 'bb']);
  expect(receiver).toBe(map);
  expect([...map.keys()]).toEqual([...map.entries()].map(([key]) => key));
});

test('sets retain ordered, natural and custom traversal', () => {
  const ordered = new SharedOrderedSet().add('b').add(1).add('a').delete('b').add('b');
  expect([...ordered.values()]).toEqual([1, 'a', 'b']);
  const sorted = new SharedSortedSet().add('b').add(1).add('a');
  expect(new Set(sorted.values())).toEqual(new Set([1, 'a', 'b']));
  const custom = new SharedSortedSet((a, b) => b.localeCompare(a)).add('b').add('a').add('c');
  expect([...custom.values()]).toEqual(['c', 'b', 'a']);
});


test.each([false, true])('cold nested projections keep read-only child snapshots (copy=%s)', async copy => {
  const child = new SharedList('number').pushMany([1, 2, 3]);
  const other = child.set(0, 9);
  const ordered = new SharedOrderedMap('SharedList<number>').set('old', child).set('new', other);
  const sorted = new SharedSortedMap('SharedList<number>').set('old', child).set('new', other);
  const readers = await initWorker(getWorkerData({ ordered, sorted }, { copy }));
  for (const map of [readers.ordered, readers.sorted]) {
    const a = arenaOf(map), decode = vi.spyOn(a, 'leafValue');
    const keys = [...map.keys()];
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
    const values = [...map.values()];
    expect(values).toHaveLength(2);
    for (let i = 0; i < keys.length; i++) {
      expect(values[i].toArray()).toEqual(keys[i] === 'old' ? [1, 2, 3] : [9, 2, 3]);
      expect(() => values[i].push(4)).toThrow(/read-only/);
    }
  }
});


test('ordered projection helper stays off the prototype and starts lazily', () => {
  const map = new SharedOrderedMap('number').set('a', 1).set('b', 2);
  expect(Object.hasOwn(SharedOrderedMap.prototype, 'iterate')).toBe(false);
  const view = vi.spyOn(arenaOf(map), 'dv', 'get');
  const keys = map.keys(), values = map.values();
  expect(view).not.toHaveBeenCalled();
  expect([...keys]).toEqual(['a', 'b']);
  expect([...values]).toEqual([1, 2]);
  view.mockRestore();
});
