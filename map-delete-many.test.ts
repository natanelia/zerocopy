import { describe, expect, test } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedMap, getWorkerData, initWorker } from './shared';

describe('batched persistent map deletion experiment', () => {
  test.each([1, 63, 64, 500, 13000, 19999, 20000])('removes %i keys with retained history', count => {
    const source = new SharedMap('number', 0, 0, new Arena());
    const entries = Array.from({ length: 20000 }, (_, i) => ['tile/' + i, i] as const);
    const base = source.setMany(entries);
    const keys = Array.from({ length: count }, (_, i) => 'tile/' + ((i * 8191 + 17) % entries.length));
    const removed = new Set(keys);
    const result = base.deleteMany(keys);
    expect(result.size).toBe(entries.length - removed.size);
    expect(base.size).toBe(entries.length);
    const actual = new Map(result.entries());
    expect(actual.size).toBe(result.size);
    for (const [key, value] of entries) {
      expect(base.get(key)).toBe(value);
      expect(actual.get(key)).toBe(removed.has(key) ? undefined : value);
      expect(result.has(key)).toBe(!removed.has(key));
    }
    const edited = result.set('added', -1).set('tile/17', 99);
    expect(edited.get('added')).toBe(-1);
    expect(edited.get('tile/17')).toBe(99);
    expect(base.get('tile/17')).toBe(17);
    expect(result.has('added')).toBe(false);
  });

  test.each([true, false])('preserves collisions, aliases, overlays and published snapshots (copy=%s)', async copy => {
    let base = new SharedMap('object', 0, 0, new Arena()).setMany(
      Array.from({ length: 512 }, (_, i) => ['k' + i, { i }] as const));
    base = base.set('costarring', { i: 1 }).set('liquid', { i: 2 })
      .set('\ufffd', { i: 3 }).set('道路/🙂', { i: 4 });
    for (let i = 0; i < 80; i++) base = base.set('k' + i, { i: -i });
    const keys = Array.from({ length: 80 }, (_, i) => 'k' + (i * 3));
    keys.push('costarring', '\ud800', '道路/🙂', 'costarring', 'absent', ...keys);
    const result = base.deleteMany(keys);
    const expected = new Map(base.entries());
    for (const key of keys) expected.delete(key === '\ud800' ? '\ufffd' : key);
    expect(new Map(result.entries())).toEqual(expected);
    expect(result.get('liquid')).toEqual({ i: 2 });
    expect(base.get('costarring')).toEqual({ i: 1 });
    expect(base.get('\ufffd')).toEqual({ i: 3 });
    const owner = arenaOf(base);
    const before = owner.buf.slice(65536, owner.used);
    const attached = await initWorker(getWorkerData({ base, result }, { copy }));
    expect(new Map(attached.result.entries())).toEqual(expected);
    expect(attached.base.get('道路/🙂')).toEqual({ i: 4 });
    expect(() => attached.result.deleteMany([])).toThrow(/read-only/);
    expect(owner.buf.slice(65536, owner.used)).toEqual(before);
  });

  test('staged and oversized keys use identical byte semantics', () => {
    const asciiLimit = 'a'.repeat(49152);
    const oversizedAscii = 'a'.repeat(49153);
    const oversizedUtf8 = '路'.repeat(17000);
    const entries = Array.from({ length: 80 }, (_, i) => ['feature/' + i, i] as const);
    const base = new SharedMap('number', 0, 0, new Arena()).setMany([
      ...entries, ['', 100], [asciiLimit, 101], [oversizedAscii, 102],
      [oversizedUtf8, 103], ['\ufffd', 104], ['\ufeffkey', 105],
    ]);
    const keys = [...entries.slice(0, 65).map(([key]) => key), '', asciiLimit,
      oversizedAscii, oversizedUtf8, '\ud800', asciiLimit, 'absent'];
    const result = base.deleteMany(keys);
    const scalar = keys.reduce((snapshot, key) => snapshot.delete(key), base);
    expect(new Map(result.entries())).toEqual(new Map(scalar.entries()));
    expect(result.size).toBe(16);
    expect(result.get('\ufeffkey')).toBe(105);
    expect(base.get(oversizedUtf8)).toBe(103);
    expect(base.size).toBe(86);
  });

  test('missing keys preserve identity, invalid input throws, empty roots stay empty', () => {
    const base = new SharedMap('number', 0, 0, new Arena()).set('key', 1);
    const missing = Array.from({ length: 100 }, (_, i) => 'missing/' + i);
    expect(base.deleteMany(missing)).toBe(base);
    expect(base.deleteMany([...missing, 'key', 'key']).size).toBe(0);
    const empty = base.delete('key');
    expect(empty.deleteMany(missing)).toBe(empty);
    expect(() => base.deleteMany([...missing, 1 as unknown as string])).toThrow(TypeError);
    expect(() => empty.deleteMany([...missing, 1 as unknown as string])).toThrow(TypeError);
    expect(base.get('key')).toBe(1);
  });
});
