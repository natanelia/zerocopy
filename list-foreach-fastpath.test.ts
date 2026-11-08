import { describe, expect, test, beforeEach } from 'vitest';
import { SharedList, resetSharedList } from './shared-list';
import { arenaOf } from './arena';

describe('SharedList primitive forEach fast path', () => {
  beforeEach(() => resetSharedList());

  test('preserves numeric values, indexes, NaN and negative zero across blocks', () => {
    const values = Array.from({ length: 1031 }, (_, i) => i % 41 - 20);
    values[0] = -0;
    values[31] = Number.NaN;
    values[32] = Number.POSITIVE_INFINITY;
    values[1024] = Number.NEGATIVE_INFINITY;
    const snapshot = new SharedList('number').pushMany(values);
    const found: number[] = [];
    const indices: number[] = [];
    snapshot.forEach((value, index) => { found.push(value); indices.push(index); });
    expect(indices).toEqual(values.map((_, i) => i));
    for (let i = 0; i < values.length; i++) expect(Object.is(found[i], values[i])).toBe(true);
  });

  test('preserves boolean values, indexes and retained snapshots', () => {
    const input = Array.from({ length: 1067 }, (_, i) => i % 3 === 0);
    const before = new SharedList('boolean').pushMany(input);
    const after = before.set(32, false).push(true);
    const found: boolean[] = [];
    before.forEach((value, i) => { expect(i).toBe(found.length); found.push(value); });
    expect(found).toEqual(input);
    expect(after.get(32)).toBe(false);
    expect(before.get(32)).toBe(input[32]);
  });

  for (const type of ['number', 'boolean'] as const) {
    test(`honors decoder replaced before and during ${type} iteration`, () => {
      const input = Array.from({ length: 69 }, (_, i) => type === 'number' ? i : i % 2 === 0);
      const list = new SharedList(type).pushMany(input as any);
      const a = arenaOf(list);
      const original = a.decode;
      let calls = 0;
      const custom = function (this: typeof a, kind: string, raw: number) {
        calls++;
        const value = original.call(this, kind, raw);
        return kind === 'number' ? value + 1000 : !value;
      };
      const actual: unknown[] = [];
      try {
        a.decode = custom;
        list.forEach((value, i) => {
          actual.push(value);
          if (i === 4) a.decode = original;
          if (i === 31) a.decode = custom;
          if (i === 39) a.decode = original;
        });
      } finally {
        a.decode = original;
      }
      expect(calls).toBe(5 + 8);
      for (let i = 0; i < input.length; i++) {
        const hooked = i <= 4 || (i >= 32 && i <= 39);
        const expected = hooked ? type === 'number' ? (input[i] as number) + 1000 : !input[i] : input[i];
        expect(Object.is(actual[i], expected)).toBe(true);
      }
    });
  }

  test('still visits custom object decoders and propagates exceptions', () => {
    const list = new SharedList('string').pushMany(['a', 'b', 'c']);
    const a = arenaOf(list), original = a.decode;
    let calls = 0;
    try {
      a.decode = function (type: string, raw: number) {
        calls++;
        return original.call(this, type, raw);
      };
      expect(() => list.forEach((_value, i) => { if (i === 2) throw new Error('stop'); }))
        .toThrow('stop');
      expect(calls).toBe(3);
    } finally {
      a.decode = original;
    }
  });

  test('survives growth and reentrant writes without changing an older snapshot', () => {
    const list = new SharedList('number').pushMany(Array.from({ length: 65 }, (_, i) => i));
    let grown: SharedList<'number'> | undefined;
    const found: number[] = [];
    list.forEach((value, index) => {
      found.push(value);
      if (index === 6) grown = list.pushMany(Array.from({ length: 131072 }, (_, i) => i));
    });
    expect(found).toEqual(Array.from({ length: 65 }, (_, i) => i));
    expect(grown?.size).toBe(131137);
    expect(list.size).toBe(65);
  });
});
