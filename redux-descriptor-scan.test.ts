import { describe, expect, it } from 'vitest';
import { createZerocopyCodec } from './redux';

describe('Redux descriptor validation', () => {
  const codec = createZerocopyCodec();

  it.each([false, true])('keeps dense arrays, records, and retained input intact, frozen=%s', frozen => {
    const rows = Array.from({ length: 1024 }, (_, i) => ({ value: i, name: `item-${i}` }));
    const source = { rows, count: rows.length };
    if (frozen) {
      rows.forEach(Object.freeze);
      Object.freeze(rows);
      Object.freeze(source);
    }
    const previous = JSON.stringify(source), encoded = codec.encode(source);
    expect(codec.decode(encoded)).toEqual(source);
    expect(codec.parse(codec.stringify(source))).toEqual(source);
    expect(JSON.stringify(source)).toBe(previous);
    expect(Object.isFrozen(source)).toBe(frozen);
    expect(Object.isFrozen(rows)).toBe(frozen);
  });

  it.each([{}, []])('rejects enumerable accessors without running their getters: %s', source => {
    let calls = 0;
    Object.defineProperty(source, Array.isArray(source) ? '0' : 'field', {
      enumerable: true, get() { calls++; throw new Error('Getter should not run'); },
    });
    expect(() => codec.encode(source)).toThrow(/accessors/);
    expect(calls).toBe(0);
  });

  it.each([{}, []])('rejects enumerable symbols: %s', source => {
    Object.defineProperty(source, Symbol('field'), { value: 1, enumerable: true });
    expect(() => codec.encode(source)).toThrow(/symbols/);
  });

  it.each([{}, []])('ignores nonenumerable properties and symbols: %s', source => {
    let calls = 0;
    Object.defineProperty(source, 'hidden', { get() { calls++; throw new Error('Getter should not run'); } });
    Object.defineProperty(source, Symbol('hidden'), { value: 1 });
    expect(codec.decode(codec.encode(source))).toEqual(Array.isArray(source) ? [] : {});
    expect(calls).toBe(0);
  });

  it('preserves null prototypes and special own names', () => {
    const source = Object.create(null);
    source.__proto__ = { nested: 1 };
    source.constructor = 7;
    source.hasOwnProperty = 8;
    const result = codec.decode(codec.encode(source)) as typeof source;
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result).toEqual(source);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
  });

  it('ignores inherited enumerable keys and getters on a plain-record prototype', () => {
    let calls = 0;
    const prototype = Object.create(null);
    Object.defineProperty(prototype, 'inherited', { enumerable: true, value: 3 });
    Object.defineProperty(prototype, 'getter', { enumerable: true, get() { calls++; throw new Error('Getter should not run'); } });
    const source = Object.assign(Object.create(prototype), { own: 1 });
    expect(codec.decode(codec.encode(source))).toEqual({ own: 1 });
    expect(calls).toBe(0);
  });

  it('skips a key that disappears before its descriptor is read', () => {
    const target: Record<string, number> = { first: 1, removed: 2 };
    const source = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        if (key === 'first') delete object.removed;
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
    expect(codec.decode(codec.encode(source))).toEqual({ first: 1 });
  });

  it('propagates thrown descriptor traps without reading property values', () => {
    const failure = new Error('Descriptor rejected'), target = { field: 1 };
    let reads = 0;
    const source = new Proxy(target, {
      getOwnPropertyDescriptor() { throw failure; },
      get(object, key, receiver) { reads++; return Reflect.get(object, key, receiver); },
    });
    expect(() => codec.encode(source)).toThrow(failure);
    expect(reads).toBe(0);
  });

  it('continues to distinguish holes, undefined, and extra array properties', () => {
    const sparse = new Array(3);
    sparse[1] = undefined;
    const result = codec.decode(codec.encode(sparse)) as typeof sparse;
    expect(result.length).toBe(3);
    expect(Object.hasOwn(result, 0)).toBe(false);
    expect(Object.hasOwn(result, 1)).toBe(true);
    expect(Object.hasOwn(result, 2)).toBe(false);
    Object.defineProperty(sparse, 'extra', { value: 7, enumerable: true });
    expect(() => codec.encode(sparse)).toThrow(/array properties/);
  });
});
