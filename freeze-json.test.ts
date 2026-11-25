import { describe, expect, test } from 'vitest';
import { freezeJSON } from './freeze-json';
import { Arena } from './arena';
import { getCodec } from './codec';

// Inspect descriptors rather than using the production traversal algorithm.
function expectDeeplyFrozen(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object') continue;
    expect(Object.isFrozen(item)).toBe(true);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if ('value' in descriptor) pending.push(descriptor.value);
    }
  }
}

describe('JSON freezing', () => {
  test.each([null, true, false, 0, -0, 12.5, '', 'text', undefined])('preserves scalar %s', value => {
    expect(Object.is(freezeJSON(value), value)).toBe(true);
  });

  test('freezes mixed arrays, empty containers, and every nested coordinate', () => {
    const source = [null, false, 0, '', [], {}, [[103.85, 1.29, 0], [103.86, 1.30, 0]],
      { geometry: { coordinates: [[[0, 0], [1, 2]]] }, properties: { lanes: [{ id: 'a' }] } }];
    const decoded = JSON.parse(JSON.stringify(source));
    expect(freezeJSON(decoded)).toBe(decoded);
    expect(decoded).toEqual(source);
    expectDeeplyFrozen(decoded);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source[6])).toBe(false);
    expect(() => decoded.push(1)).toThrow(TypeError);
    expect(() => { decoded[7].geometry.coordinates[0][0][0] = 99; }).toThrow(TypeError);
  });

  test('preserves own special names and null-prototype records', () => {
    const special = JSON.parse('{"__proto__":{"items":[1]},"constructor":{"items":[2]},"hasOwnProperty":{"items":[3]},"0":{"items":[4]}}');
    const record = Object.assign(Object.create(null), { special });
    freezeJSON(record);
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.getPrototypeOf(special)).toBe(Object.prototype);
    expect(Object.hasOwn(special, '__proto__')).toBe(true);
    expect(special.__proto__.items).toEqual([1]);
    expectDeeplyFrozen(record);
  });

  test('ignores inherited enumerable properties and accessors', () => {
    const inherited = { items: [1] };
    const prototype = Object.create(null);
    Object.defineProperty(prototype, 'inherited', { value: inherited, enumerable: true });
    Object.defineProperty(prototype, 'accessor', { get() { throw new Error('Inherited getter ran'); }, enumerable: true });
    const record = Object.assign(Object.create(prototype), { own: [{ items: [2] }] });
    freezeJSON(record);
    expectDeeplyFrozen(record);
    expect(Object.isFrozen(inherited)).toBe(false);
    inherited.items.push(3);
    expect(inherited.items).toEqual([1, 3]);
  });

  test('continues through a shallow-frozen parent', () => {
    const child = { items: [{ value: 1 }] };
    const parent = Object.freeze({ child });
    expect(Object.isFrozen(child)).toBe(false);
    expect(freezeJSON(parent)).toBe(parent);
    expectDeeplyFrozen(parent);
  });

  test('handles 20,000 nested arrays without recursive calls', () => {
    const depth = 20000;
    const decoded = JSON.parse('['.repeat(depth) + '{"value":1}' + ']'.repeat(depth));
    freezeJSON(decoded);
    let node = decoded;
    for (let i = 0; i < depth; i++) {
      expect(Object.isFrozen(node)).toBe(true);
      expect(node.length).toBe(1);
      node = node[0];
    }
    expect(node).toEqual({ value: 1 });
    expect(Object.isFrozen(node)).toBe(true);
  });

  test('handles a wide array without a function-argument limit', () => {
    const decoded = JSON.parse(JSON.stringify(Array.from({ length: 100000 }, (_, i) => i % 997 ? i : { coordinates: [[i, -i]] })));
    freezeJSON(decoded);
    expect(decoded.length).toBe(100000);
    expect(Object.isFrozen(decoded)).toBe(true);
    for (let i = 0; i < decoded.length; i += 997) expectDeeplyFrozen(decoded[i]);
  });

  test('uses the same semantics for direct object-codec reads', () => {
    const codec = getCodec('object');
    const input = { geometry: { coordinates: [[103.85, 1.29], [103.86, 1.30]] }, text: '界🙂' };
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    const decoded = codec.decode(bytes, 0, bytes.length);
    expect(decoded).toEqual(input);
    expectDeeplyFrozen(decoded);
    input.geometry.coordinates[0][0] = 99;
    expect(decoded.geometry.coordinates[0][0]).toBe(103.85);
    expect(Object.isFrozen(input.geometry.coordinates[0])).toBe(false);
  });
});

test('arena freezes every container in parsed text with whitespace, nesting and quoted delimiters', () => {
  for (const text of [
    '{"x":1,"text":"plain","flag":false,"n":null}', '[-0,null,false,"a"]',
    '[{"nested":[{}]}]', '  {"a":[1]}  ', '{"x":"{","[":[{"y":true}]}',
    '{"__proto__":{"deep":[{"end":1}]}}', '[1,2,3]', '"["', '-0', 'null',
    JSON.stringify({ text: 'x'.repeat(128), flat: 1 }),
    JSON.stringify({ text: '['.repeat(128), nested: { values: [1, 2] } }),
    JSON.stringify([{ text: 'x'.repeat(128) }]),
    JSON.stringify({ nested: [1, { x: 2 }], text: 'x'.repeat(128) }),
    JSON.stringify({ text: 'x'.repeat(128), nested: [1, 2] }),
    JSON.stringify({ text: '界🙂'.repeat(64), flat: true }),
    JSON.stringify(['x'.repeat(128), 'y', null]),
    ' '.repeat(100) + '{"__proto__":{"deep":[]}}',
  ]) {
    const arena = new Arena(), bytes = new TextEncoder().encode(text);
    const ptr = arena.alloc(bytes.length);
    arena.buf.set(bytes, ptr);
    const decoded = arena.decodeAt('object', ptr, bytes.length);
    expectDeeplyFrozen(decoded);
    expect(decoded).toEqual(JSON.parse(text));
  }
});
