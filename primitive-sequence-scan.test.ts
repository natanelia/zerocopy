import { describe, expect, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, SharedLinkedList, SharedDoublyLinkedList } from './shared';

describe('primitive sequence scan fast paths', () => {
  it('preserves all f64 values and indexes at leaf boundaries on writer and reader', () => {
    const expected = Array.from({ length: 1059 }, (_, i) => i + 0.25);
    expected[0] = -0;
    expected[31] = NaN;
    expected[32] = Infinity;
    expected[33] = -Infinity;
    expected[1024] = Number.MIN_VALUE;
    const list = new SharedList('number').pushMany(expected);
    const a = arenaOf(list);
    const readOnly = SharedList.fromWorkerData(list.toWorkerData(),
      new Arena({ memory: a.memory, used: a.used, readOnly: true }));
    for (const item of [list, readOnly]) {
      expect(item.toArray()).toEqual(expected);
      expect([...item.values()]).toEqual(expected);
      const indices: number[] = [], found: number[] = [];
      item.forEach((value, index) => { indices.push(index); found.push(value); });
      expect(found).toEqual(expected);
      expect(indices).toEqual(expected.map((_, i) => i));
      expect(Object.is(item.toArray()[0], -0)).toBe(true);
      expect(Number.isNaN(item.toArray()[31])).toBe(true);
    }
    expect(() => readOnly.push(5)).toThrow(/read-only/);
  });

  it('does not read a growing writer or a fork in the middle of a scan', () => {
    const expected = Array.from({ length: 2051 }, (_, i) => i);
    const list = new SharedList('number').pushMany(expected);
    const fork = list.set(31, -31).set(1024, -1024);
    const owner = arenaOf(list), oldEnd = owner.used;
    const before = owner.buf.slice(HEAP_START, oldEnd);
    const visited: number[] = [];
    list.forEach((value, index) => {
      if (index === 20) {
        const grown = list.pushMany(Array.from({ length: 50000 }, (_, i) => i));
        expect(grown.size).toBe(52051);
      }
      visited.push(value);
    });
    expect(visited).toEqual(expected);
    expect([...list.values()]).toEqual(expected);
    expect(fork.get(31)).toBe(-31);
    expect(fork.get(1024)).toBe(-1024);
    expect(list.get(31)).toBe(31);
    expect(owner.buf.slice(HEAP_START, oldEnd)).toEqual(before);
  });

  it('preserves boolean decoding, UTF-8 strings and immutable JSON objects', () => {
    const booleans = Array.from({ length: 1057 }, (_, i) => i % 3 === 0);
    const flags = new SharedList('boolean').pushMany(booleans);
    expect(flags.toArray()).toEqual(booleans);
    expect([...flags.values()]).toEqual(booleans);
    const seen: boolean[] = [];
    flags.forEach(value => { seen.push(value); });
    expect(seen).toEqual(booleans);

    const text = new SharedList('string').pushMany(['', 'ASCII', '中文', '🙂', '\ud800', 'end']);
    const strings = ['', 'ASCII', '中文', '🙂', '\ufffd', 'end'];
    expect(text.toArray()).toEqual(strings);
    expect([...text.values()]).toEqual(strings);
    const words: string[] = [];
    text.forEach(value => { words.push(value); });
    expect(words).toEqual(strings);

    const objects = new SharedList('object').pushMany([{ x: 1 }, { x: 2 }]);
    expect([...objects.values()]).toEqual([{ x: 1 }, { x: 2 }]);
    expect(objects.toArray()).toEqual([{ x: 1 }, { x: 2 }]);
    expect(Object.isFrozen(objects.get(0))).toBe(true);
  });

  for (const Collection of [SharedLinkedList, SharedDoublyLinkedList] as const) {
    it(`${Collection.name}: retains numeric scans, boolean scans and source versions`, () => {
      let list: any = new Collection('number');
      const expected: number[] = [];
      for (let i = 0; i < 289; i++) { list = list.append(i); expected.push(i); }
      const retained = list;
      const newer = list.append(1000).prepend(-1000);
      expect(retained.toArray()).toEqual(expected);
      expect(newer.toArray()).toEqual([-1000, ...expected, 1000]);
      const got: number[] = [], indices: number[] = [];
      retained.forEach((v: number, i: number) => { got.push(v); indices.push(i); });
      expect(got).toEqual(expected);
      expect(indices).toEqual(expected.map((_, i) => i));

      let booleans: any = new Collection('boolean');
      const flags: boolean[] = [];
      for (let i = 0; i < 81; i++) { const flag = i % 3 === 0; flags.push(flag); booleans = booleans.append(flag); }
      expect(booleans.toArray()).toEqual(flags);
      const seen: boolean[] = [];
      booleans.forEach((v: boolean) => seen.push(v));
      expect(seen).toEqual(flags);

      const owner = arenaOf(retained);
      const reader = Collection.fromWorkerData(retained.toWorkerData(),
        new Arena({ memory: owner.memory, used: owner.used, readOnly: true }));
      expect(reader.toArray()).toEqual(expected);
    });
  }

  it('preserves reverse traversal and source indexes for a doubly linked list', () => {
    let list = new SharedDoublyLinkedList('number');
    for (let i = 0; i < 289; i++) list = list.append(i);
    const values: number[] = [], indexes: number[] = [];
    list.forEachReverse((value, index) => { values.push(value); indexes.push(index); });
    const expected = Array.from({ length: 289 }, (_, i) => 288 - i);
    expect(values).toEqual(expected);
    expect(indexes).toEqual(expected);
    expect(list.toArrayReverse()).toEqual(expected);
    let flags = new SharedDoublyLinkedList('boolean');
    for (let i = 0; i < 65; i++) flags = flags.append((i % 2) !== 0);
    expect(flags.toArrayReverse()).toEqual(flags.toArray().reverse());
    const words = new SharedDoublyLinkedList('string').append('界').append('🙂');
    expect(words.toArrayReverse()).toEqual(['🙂', '界']);
  });
});
