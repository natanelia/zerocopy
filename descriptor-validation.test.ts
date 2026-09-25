import { describe, expect, test } from 'vitest';
import { isNestedType, json, list, map, parseNestedType } from './types';
import { getCodec } from './codec';

const structures = [
  'SharedMap', 'SharedList', 'SharedStack', 'SharedQueue', 'SharedLinkedList',
  'SharedDoublyLinkedList', 'SharedOrderedMap', 'SharedSortedMap', 'SharedPriorityQueue',
  'SharedSet', 'SharedOrderedSet', 'SharedSortedSet',
] as const;
const sets = new Set(['SharedSet', 'SharedOrderedSet', 'SharedSortedSet']);
const primitives = ['string', 'number', 'boolean', 'object'] as const;

describe('complete descriptor validation', () => {
  test.each(structures)('%s agrees with its leaf grammar', structure => {
    for (const inner of primitives) {
      const type = `${structure}<${inner}>`;
      const valid = !sets.has(structure) || inner === 'string' || inner === 'number';
      expect(isNestedType(type)).toBe(valid);
      expect(parseNestedType(type)).toEqual(valid ? { structureType: structure, innerType: inner } : null);
      if (valid) expect(list(type as never)).toBe(`SharedList<${type}>`);
      else expect(() => list(type as never)).toThrow(TypeError);
    }
  });

  test.each([
    'SharedMap<invalid>', 'SharedList<SharedSet<object>>', 'SharedList<SharedSortedSet<boolean>>',
    'SharedSet<SharedMap<number>>', 'SharedMap<number>>', 'SharedMap<<number>>',
    'SharedMap<number><string>', 'SharedMap<>', 'SharedMap< number>', 'SharedMap<number> ',
    'SharedMap<number>\n', 'SharedMap<number>\r', 'SharedMap<number>\0', 'SharedBogus<number>',
    'SharedMap<SharedList<number>', 'SharedMap<constructor>', 'SharedMap<__proto__>',
  ])('rejects %s consistently', type => {
    expect(parseNestedType(type)).toBeNull();
    expect(isNestedType(type)).toBe(false);
    expect(() => list(type as never)).toThrow(TypeError);
    expect(() => getCodec(type)).toThrow(/Unknown type/);
  });

  test('handles primitives and unchecked non-string input without throwing', () => {
    for (const type of [...primitives, '', 'constructor', '__proto__', null, undefined, 12, {}]) {
      expect(parseNestedType(type as never)).toBeNull();
      expect(isNestedType(type as never)).toBe(false);
    }
    expect(json()).toBe('object');
    expect(map(list(json()))).toBe('SharedMap<SharedList<object>>');
  });

  test('validates generated compositions and damaged delimiters', () => {
    // Fixed seed keeps failures reproducible without adding a testing dependency.
    let seed = 0x12345678;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let sample = 0; sample < 400; sample++) {
      let type: string = primitives[random() % primitives.length];
      const depth = 1 + random() % 12;
      for (let level = 0; level < depth; level++) {
        const structure = structures[random() % 9]; // Value-bearing structures accept every valid inner type.
        const expected = { structureType: structure, innerType: type };
        type = `${structure}<${type}>`;
        expect(parseNestedType(type)).toEqual(expected);
      }
      expect(parseNestedType(type.slice(0, -1))).toBeNull();
      expect(parseNestedType(type + '>')).toBeNull();
    }
  });

  test('reuses immutable metadata without allowing cache poisoning', () => {
    const type = 'SharedMap<SharedList<object>>', first = parseNestedType(type)!;
    expect(parseNestedType(type)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => { (first as { innerType: string }).innerType = 'invalid'; }).toThrow(TypeError);
    expect(parseNestedType(type)?.innerType).toBe('SharedList<object>');
  });

  test('bounds cached descriptors and does not retain oversized keys', () => {
    const type = 'SharedQueue<SharedList<string>>', first = parseNestedType(type);
    for (let n = 0; n < 512; n++) {
      let unique = 'number';
      for (let bit = 0; bit < 9; bit++) unique = `${n & (1 << bit) ? 'SharedList' : 'SharedMap'}<${unique}>`;
      expect(parseNestedType(unique)).not.toBeNull();
    }
    expect(parseNestedType(type)).not.toBe(first);
    const deep = 'SharedList<'.repeat(10000) + 'object' + '>'.repeat(10000);
    const parsed = parseNestedType(deep)!;
    expect(parsed.innerType).toBe(deep.slice('SharedList<'.length, -1));
    expect(parseNestedType(deep)).not.toBe(parsed);
    expect(parseNestedType(deep.slice(0, -1))).toBeNull();
  });
});
