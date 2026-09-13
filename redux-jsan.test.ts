import { describe, expect, it } from 'vitest';
import jsan from 'jsan';
import { SharedMap } from './shared';
import { createZerocopyDevToolsOptions } from './redux';

describe('portable DevTools transport boundary', () => {
  function roundTrip(value: unknown, jsonOnly = false): any {
    const config = createZerocopyDevToolsOptions({ mode: 'portable' }).serialize!;
    const text = jsonOnly ? JSON.stringify(value, config.replacer) : jsan.stringify(value, config.replacer, null, config.options);
    return jsonOnly ? JSON.parse(text, config.reviver) : jsan.parse(text, config.reviver);
  }
  it.each([false, true])('preserves marker objects and strings, JSON-only=%s', jsonOnly => {
    const value = { $jsan: 'user value', nested: { $zerocopyReduxText: 'not a packet', $zerocopyRedux: 1 }, text: '$jsan' };
    expect(roundTrip(value, jsonOnly)).toEqual(value);
    expect(roundTrip({ ordinary: value, text: '$jsan' }, jsonOnly)).toEqual({ ordinary: value, text: '$jsan' });
  });
  it('preserves ordinary undefined properties, holes, special numbers, and repeated values', () => {
    const repeated = { $jsan: 'literal' };
    const sparse = new Array(3); sparse[1] = undefined; sparse[2] = -0;
    const value = { first: repeated, second: repeated, missing: undefined, sparse, numbers: [NaN, Infinity, -Infinity, -0] };
    const result = roundTrip(value);
    expect(result).toEqual(value);
    expect(Object.hasOwn(result, 'missing')).toBe(true);
    expect(Object.hasOwn(result.sparse, 0)).toBe(false);
    expect(Object.hasOwn(result.sparse, 1)).toBe(true);
    expect(Object.is(result.numbers[3], -0)).toBe(true);
  });
  it('does not interpret empty user keys as a second wire envelope', () => {
    const value = { '': { $zerocopyReduxText: 'literal', nested: { $jsan: 'data' } }, sibling: { '': undefined } };
    expect(roundTrip(value)).toEqual(value);
    expect(Object.hasOwn(roundTrip(value).sibling, '')).toBe(true);
  });
  it('preserves null prototypes and own __proto__ fields without changing prototypes', () => {
    const record = Object.create(null); record.value = 1;
    const special = JSON.parse('{"__proto__":{"polluted":true},"normal":1}');
    const result = roundTrip({ record, special });
    expect(Object.getPrototypeOf(result.record)).toBeNull();
    expect(Object.getPrototypeOf(result.special)).toBe(Object.prototype);
    expect(Object.hasOwn(result.special, '__proto__')).toBe(true);
    expect(result.special).toEqual(special);
    expect(({} as any).polluted).toBeUndefined();
  });
  it('restores real collection classes without changing source snapshots', () => {
    const map = new SharedMap('object').set('x', { $jsan: 'payload', inner: { value: 1 } });
    const result = roundTrip({ map, other: map, ordinary: { $jsan: 'plain' } });
    expect(result.map).toBeInstanceOf(SharedMap);
    expect(result.map.get('x')).toEqual(map.get('x'));
    expect(Object.isFrozen(result.map.get('x').inner)).toBe(true);
    expect(result.map.set('y', {}).size).toBe(2);
    expect(map.size).toBe(1);
    expect(result.ordinary).toEqual({ $jsan: 'plain' });
  });
  it('rejects cycles rather than replacing them with a false value', () => {
    const value: any = {}; value.self = value;
    expect(() => roundTrip(value)).toThrow(/cyclic/);
  });
});
