import { beforeEach, describe, expect, test } from 'vitest';
import { SharedMap, resetMap } from './shared-map';
import { Arena, arenaOf } from './arena';

describe('SharedMap.toEntriesArray', () => {
  beforeEach(() => resetMap());

  for (const size of [0, 1, 31, 32, 33, 256, 4096]) {
    test('materializes ordered numeric entries, size ' + size, () => {
      const pairs = Array.from({ length: size }, (_, i) => ['feature-' + i, i * 1.25] as const);
      const map = new SharedMap('number').setMany(pairs);
      const expected = [...map.entries()];
      const result = map.toEntriesArray();
      expect(result).toEqual(expected);
      expect(result.length).toBe(map.size);
      if (result.length) {
        result[0] = ['detached', -1];
        expect(map.has('detached')).toBe(false);
        expect(map.get(pairs[0][0])).toBe(pairs[0][1]);
      }
    });
  }

  test('retains unicode keys, NaN, signed zero and original snapshot', () => {
    const pairs = [['😀', -0], ['mañana', NaN], ['中文', Infinity], ['a', 17]] as const;
    const old = new SharedMap('number').setMany(pairs);
    const next = old.set('a', 100).set('new', 1);
    const actual = old.toEntriesArray(), fromEntries = [...old.entries()];
    expect(actual.map(x => x[0])).toEqual(fromEntries.map(x => x[0]));
    expect(actual.length).toBe(pairs.length);
    for (let i = 0; i < actual.length; i++) expect(Object.is(actual[i][1], fromEntries[i][1])).toBe(true);
    expect(old.get('a')).toBe(17);
    expect(next.get('a')).toBe(100);
    expect(next.size).toBe(5);
  });

  test('matches string entries and avoids altering stored data', () => {
    const map = new SharedMap('string').setMany(Array.from({ length: 1027 }, (_, i) =>
      ['p-' + i, 'text-' + (i % 31)] as const));
    const actual = map.toEntriesArray(), expected = [...map.entries()];
    expect(actual).toEqual(expected);
    actual[0][1] = 'mutated-local-pair';
    expect([...map.entries()]).toEqual(expected);
  });

  test('reads the same entries from a copied read-only worker arena', () => {
    const map = new SharedMap('number').setMany(Array.from({ length: 1057 }, (_, i) =>
      ['id:' + i, i * 2] as const));
    const owner = arenaOf(map), reader = new Arena({copy:owner.copy(),used:owner.used,readOnly:true});
    const mounted = SharedMap.fromWorkerData(map.root, map.valueType, map.size, reader);
    expect(mounted.toEntriesArray()).toEqual([...map.entries()]);
    expect(() => mounted.set('x', 1)).toThrow();
  });

  test('respects a custom leaves iterator and propagates its failure', () => {
    const map = new SharedMap('number').setMany([['a', 1], ['b', 2]]);
    const owner = arenaOf(map);
    const leaves = owner.leaves;
    let visited = 0;
    try {
      (owner as any).leaves = function* (root: number) {
        for (const leaf of leaves.call(this, root)) {
          visited++;
          yield leaf;
        }
      };
      expect(map.toEntriesArray()).toEqual([...map.entries()]);
      expect(visited).toBe(4);
      (owner as any).leaves = function* () { throw new Error('custom leaf failure'); };
      expect(() => map.toEntriesArray()).toThrow('custom leaf failure');
    } finally {
      delete (owner as any).leaves;
    }
  });
});
