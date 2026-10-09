import { describe, it, expect } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedMap } from './shared-map';
import { SharedOrderedMap } from './shared-ordered-map';

describe('Unicode lookups after ASCII prefixes', () => {
  it('retains full-key equality across NUL, BOM, astral and replacement aliases', () => {
    const keys = ['a\0\x7fé', 'path/\ufeff', 'path/🙂', 'path/\ud800', 'path/e\u0301', 'path/é', 'a'.repeat(256) + '界'];
    const original = new SharedMap('number', 0, 0, new Arena()).setMany(keys.map((key, i) => [key, i] as const));
    const a = arenaOf(original), reader = new SharedMap('number', original.root, original.size, new Arena({ copy: a.copy(), used: a.used, readOnly: true }));
    for (const [i, key] of keys.entries()) { expect(reader.get(key)).toBe(i); expect(reader.has(key + 'missing')).toBe(false); }
    expect(reader.get('path/\ufffd')).toBe(3);
    expect(reader.get('path/\ud800')).toBe(3);
    expect(() => reader.set('x', 0)).toThrow(/read-only/);
  });
  it('distinguishes equal-length Unicode hash collisions and accepts a zero hash', () => {
    const left = 'equal/ykKPfB-w/界', right = 'equal/2oCCzp1O/界', zero = 'zero/é/PEhINA';
    for (const C of [SharedMap, SharedOrderedMap]) {
      const old = new C('number').set(left, 1).set(right, 2).set(zero, 3);
      const next = old.set(left, 4).delete(right);
      expect(next.get(left)).toBe(4); expect(next.has(right)).toBe(false); expect(next.get(zero)).toBe(3);
      expect(old.get(left)).toBe(1); expect(old.get(right)).toBe(2); expect(old.get(zero)).toBe(3);
    }
  });
  it('preserves long-key deletion on each side of the encoded scratch boundary', () => {
    for (const bytes of [49151, 49152, 49153]) {
      const key = 'a'.repeat(bytes - 3) + '界', old = new SharedMap('number', 0, 0, new Arena()).set(key, bytes);
      expect(old.delete(key).size).toBe(0); expect(old.get(key)).toBe(bytes);
      expect(old.delete(key + 'missing')).toBe(old);
    }
  });
});
