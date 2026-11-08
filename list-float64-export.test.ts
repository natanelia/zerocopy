import { describe, expect, test, beforeEach } from 'vitest';
import { SharedList, resetSharedList } from './shared-list';
import { Arena, arenaOf } from './arena';

describe('SharedList.toFloat64Array', () => {
  beforeEach(() => resetSharedList());

  test('exports empty values and rejects other types', () => {
    expect(new SharedList('number').toFloat64Array()).toEqual(new Float64Array(0));
    expect(() => (new SharedList('boolean') as any).toFloat64Array()).toThrow(TypeError);
  });

  for (const size of [1, 31, 32, 33, 63, 64, 65, 1024, 1025, 32768, 32769]) {
    test('copies all numeric values across leaf boundaries, length ' + size, () => {
      const values = Array.from({ length: size }, (_, i) => (i % 97) - 48.5);
      values[0] = -0;
      values[size - 1] = Number.NaN;
      if (size > 31) values[31] = Number.POSITIVE_INFINITY;
      if (size > 32) values[32] = Number.NEGATIVE_INFINITY;
      const list = new SharedList('number').pushMany(values);
      const result = list.toFloat64Array();
      expect(result).toBeInstanceOf(Float64Array);
      expect(result.length).toBe(values.length);
      for (let i = 0; i < size; i++) expect(Object.is(result[i], values[i])).toBe(true);
      result[0] = 123456;
      expect(Object.is(list.get(0), -0)).toBe(true);
    });
  }

  test('preserves the full IEEE-754 NaN payload, not only its numeric value', () => {
    const list = new SharedList('number').pushMany([NaN, 3]);
    const origin = arenaOf(list);
    const copy = origin.copy();
    const payload = 0x7ff8000000000123n;
    new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setBigUint64(list.tail, payload, true);
    const reader = new Arena({ copy, used: origin.used, readOnly: true });
    const attached = SharedList.fromWorkerData(list.toWorkerData(), reader);
    const result = attached.toFloat64Array();
    expect(Number.isNaN(result[0])).toBe(true);
    expect(new BigUint64Array(result.buffer)[0]).toBe(payload);
    expect(result[1]).toBe(3);
  });

  test('handles changed trees and unchanged historical snapshots', () => {
    const original = new SharedList('number').pushMany(Array.from({ length: 1031 }, (_, i) => i));
    const changed = original.set(32, -123).pushMany([9, 10, 11]);
    const initial = original.toFloat64Array();
    const updated = changed.toFloat64Array();
    expect(initial[32]).toBe(32);
    expect(updated[32]).toBe(-123);
    expect(updated.length).toBe(1034);
    updated[5] = -99999;
    expect(changed.get(5)).toBe(5);
    expect(original.get(32)).toBe(32);
  });
});
