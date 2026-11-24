import { SharedList, resetSharedList } from './shared-list';
import { Arena, HEAP_START } from './arena';
import { getWorkerData, initWorker } from './shared';
import { expect, test, describe, beforeEach } from 'vitest';

describe('SharedList', () => {
  beforeEach(() => resetSharedList());

  test('empty list has size 0', () => {
    expect(new SharedList('number').size).toBe(0);
  });

  test('push increases size', () => {
    const v = new SharedList('number').push(1).push(2);
    expect(v.size).toBe(2);
  });

  test('get returns correct index', () => {
    const v = new SharedList('number').push(10).push(20).push(30);
    expect(v.get(0)).toBe(10);
    expect(v.get(1)).toBe(20);
    expect(v.get(2)).toBe(30);
  });

  test('get out of bounds returns undefined', () => {
    const v = new SharedList('number').push(1);
    expect(v.get(-1)).toBeUndefined();
    expect(v.get(1)).toBeUndefined();
  });

  test('set updates value', () => {
    const v = new SharedList('number').push(1).push(2).set(1, 99);
    expect(v.get(0)).toBe(1);
    expect(v.get(1)).toBe(99);
  });

  test('set out of bounds returns same list', () => {
    const v1 = new SharedList('number').push(1);
    const v2 = v1.set(5, 99);
    expect(v1).toBe(v2);
  });

  test('pop removes last', () => {
    const v = new SharedList('number').push(1).push(2).push(3).pop();
    expect(v.size).toBe(2);
    expect(v.get(2)).toBeUndefined();
  });

  test('pop on empty returns same', () => {
    const v1 = new SharedList('number');
    const v2 = v1.pop();
    expect(v1).toBe(v2);
  });

  test('immutability - original unchanged', () => {
    const v1 = new SharedList('number').push(1);
    const v2 = v1.push(2);
    expect(v1.size).toBe(1);
    expect(v2.size).toBe(2);
  });

  test('values iteration', () => {
    const v = new SharedList('number').push(1).push(2).push(3);
    expect([...v.values()]).toEqual([1, 2, 3]);
  });

  test('forEach with index', () => {
    const v = new SharedList('number').push(10).push(20);
    const pairs: [number, number][] = [];
    v.forEach((val, i) => pairs.push([val, i]));
    expect(pairs).toEqual([[10, 0], [20, 1]]);
  });

  test('toArray', () => {
    const v = new SharedList('number').push(1).push(2).push(3);
    expect(v.toArray()).toEqual([1, 2, 3]);
  });

  test('pushMany', () => {
    const v = new SharedList('number').pushMany([1, 2, 3]);
    expect(v.toArray()).toEqual([1, 2, 3]);
  });

  test.each([Float32Array, Float64Array])('pushMany copies %s subviews across growth and a partial tail', TypedArray => {
    const arena = new Arena();
    const prefix = Array.from({ length: 35 }, (_, i) => i * 0.25);
    const base = new SharedList('number', 0, 0, 0, arena).pushMany(prefix);
    const backing = new SharedArrayBuffer(8200 * TypedArray.BYTES_PER_ELEMENT);
    const input = new TypedArray(backing).subarray(1, 8199);
    for (let i = 0; i < input.length; i++) input[i] = i / 7;
    input.set([-0, NaN, Infinity, -Infinity, 103.851959000013], 30);
    const expected = Array.from(input);
    const published = arena.buf.slice(HEAP_START, arena.used);
    const result = base.pushMany(input);
    input.fill(0);
    expect(result.toArray()).toEqual([...prefix, ...expected]);
    expect(base.toArray()).toEqual(prefix);
    expect(arena.buf.subarray(HEAP_START, HEAP_START + published.length)).toEqual(published);
    expect(result.pushMany(new TypedArray(0))).toBe(result);
  });

  test('toFloat64Array copies packed and fragmented snapshots with exact values and independent storage', () => {
    const values = [-0, NaN, Infinity, -Infinity, Number.MIN_VALUE, 103.851959000013];
    for (const size of [0, 1, 31, 32, 33, 1024, 1057]) {
      const source = Array.from({ length: size }, (_, i) => values[i % values.length]);
      const base = new SharedList('number').pushMany(source);
      const edits = [[31, Math.PI], [32, -Math.PI], [size - 1, -0]] as const;
      const edited = base.setMany(edits), expected = source.slice();
      for (const [index, value] of edits) if (index >= 0 && index < size) expected[index] = value;
      expect(Array.from(base.toFloat64Array())).toEqual(source);
      const packed = edited.toFloat64Array();
      expect(packed.buffer).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(packed)).toEqual(expected);
      packed.fill(999);
      expect(Array.from(edited.toFloat64Array())).toEqual(expected);
    }
    expect(() => SharedList.prototype.toFloat64Array.call(new SharedList('object') as never))
      .toThrow('Float64Array output requires a numeric list');
  });

  test.each([false, true])('copies coordinate snapshots from read-only attachments (copy=%s)', async copy => {
    const arena = new Arena();
    const points = new SharedList('number', 0, 0, 0, arena).pushMany(Float64Array.from({ length: 65 }, (_, i) => i / 3));
    const { points: reader } = await initWorker(getWorkerData({ points }, { copy }));
    const expected = points.toArray(), before = arena.used;
    expect(reader.pushMany(new Float64Array(0))).toBe(reader);
    expect(() => reader.pushMany(new Float64Array([1, 2]))).toThrow(/read-only/);
    const packed = reader.toFloat64Array();
    expect(arena.used).toBe(before);
    points.pushMany(new Float64Array(16384)).set(31, -33);
    packed[0] = 999;
    expect(Array.from(reader.toFloat64Array())).toEqual(expected);
  });

  test('crosses 32-element boundary', () => {
    let v = new SharedList('number');
    for (let i = 0; i < 50; i++) v = v.push(i);
    expect(v.size).toBe(50);
    expect(v.get(31)).toBe(31);
    expect(v.get(32)).toBe(32);
    expect(v.get(49)).toBe(49);
  });

  test('crosses 1024-element boundary', () => {
    let v = new SharedList('number');
    for (let i = 0; i < 1100; i++) v = v.push(i);
    expect(v.size).toBe(1100);
    expect(v.get(1023)).toBe(1023);
    expect(v.get(1024)).toBe(1024);
    expect(v.get(1099)).toBe(1099);
  });

  test('many elements', () => {
    let v = new SharedList('number');
    for (let i = 0; i < 10000; i++) v = v.push(i);
    expect(v.size).toBe(10000);
    expect(v.get(0)).toBe(0);
    expect(v.get(5000)).toBe(5000);
    expect(v.get(9999)).toBe(9999);
  });

  test('version isolation', () => {
    const v1 = new SharedList('number').push(1).push(2);
    const v2 = v1.push(3);
    const v3 = v1.set(1, 99);
    expect(v2.toArray()).toEqual([1, 2, 3]);
    expect(v3.toArray()).toEqual([1, 99]);
    expect(v1.toArray()).toEqual([1, 2]);
  });

  test('string type', () => {
    const v = new SharedList('string').push('a').push('b').push('c');
    expect(v.size).toBe(3);
    expect(v.get(0)).toBe('a');
    expect(v.get(1)).toBe('b');
    expect(v.get(2)).toBe('c');
    expect(v.toArray()).toEqual(['a', 'b', 'c']);
  });

  test('string set', () => {
    const v = new SharedList('string').push('a').push('b').set(1, 'x');
    expect(v.toArray()).toEqual(['a', 'x']);
  });

  test('boolean type', () => {
    const v = new SharedList('boolean').push(true).push(false).push(true);
    expect(v.toArray()).toEqual([true, false, true]);
  });

  test('object type', () => {
    const o1 = { x: 1 };
    const o2 = { y: 2 };
    const v = new SharedList('object').push(o1).push(o2);
    expect(v.get(0)).toEqual(o1);
    expect(v.get(1)).toEqual(o2);
  });

  test('string interning', () => {
    const v = new SharedList('string').push('hello').push('world').push('hello');
    expect(v.get(0)).toBe('hello');
    expect(v.get(2)).toBe('hello');
  });

  test('many strings', () => {
    let v = new SharedList('string');
    for (let i = 0; i < 1000; i++) v = v.push(`item${i}`);
    expect(v.size).toBe(1000);
    expect(v.get(0)).toBe('item0');
    expect(v.get(999)).toBe('item999');
  });
});
