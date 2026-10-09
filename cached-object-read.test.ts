import { describe, expect, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedMap, SharedOrderedMap, SharedSortedMap, SharedList, compact, getWorkerData, initWorker } from './shared';

const expectedSlotReads = Number(process.env.CACHED_OBJECT_EXPECTED_SLOT_READS ?? '1');
const factories: [string, (type: string, arena: Arena) => any][] = [
  ['map', (type, a) => new SharedMap(type, 0, 0, a)],
  ['ordered', (type, a) => new SharedOrderedMap(type, 0, 0, 0, 0, a)],
  ['sorted', (type, a) => new SharedSortedMap(type, undefined, 0, 0, a)],
];
const snapshotBytes = (a: Arena) => Buffer.from(a.buf.slice(HEAP_START, a.used));
function countSlots(a: Arena, fn: () => void): number {
  const reads = (a as any).reads;
  expect(reads).toBeDefined();
  const original = reads.slot;
  let count = 0;
  reads.slot = function (key: string) { count++; return original.call(this, key); };
  try { fn(); } finally { reads.slot = original; }
  return count;
}

describe('exact-root cached object addresses', () => {
  for (const [name, create] of factories) {
    it(name + ': warm slot zero still decodes and preserves object identity', () => {
      const a = new Arena({ id: 'cached-object-' + name });
      const map = create('object', a).set('first', { nested: { value: 1 } }).set('other', null);
      const before = snapshotBytes(a), used = a.used, first = map.get('first');
      expect((a as any).reads.slot('first')).toBe(0);
      expect(countSlots(a, () => {
        const next = map.get('first');
        expect(next).toBe(first);
        expect(Object.isFrozen(next)).toBe(true);
        expect(Object.isFrozen(next.nested)).toBe(true);
      })).toBe(expectedSlotReads);
      expect(map.get('other')).toBeNull();
      expect(map.get('other')).toBeNull();
      expect(a.used).toBe(used);
      expect(snapshotBytes(a)).toEqual(before);
    });

    it(name + ': forks, changes, deletion, reinsertion and absent keys', () => {
      const a = new Arena({ id: 'cached-forks-' + name });
      const empty = create('object', a);
      const old = empty.set('key', { n: 1 }).set('anchor', { keep: true });
      const unchanged = old.set('elsewhere', { n: 2 });
      const changed = old.set('key', { n: 3 });
      const deleted = changed.delete('key');
      const restored = deleted.set('key', { n: 4 });
      for (let pass = 0; pass < 8; pass++) {
        for (const [map, n] of [[old, 1], [unchanged, 1], [changed, 3], [restored, 4]] as const) {
          expect(map.get('key')).toEqual({ n });
          expect(map.get('key')).toEqual({ n });
        }
        expect(deleted.get('key')).toBeUndefined();
        expect(countSlots(a, () => expect(deleted.get('key')).toBeUndefined())).toBe(expectedSlotReads);
        expect(deleted.get('missing')).toBeUndefined();
        expect(empty.get('key')).toBeUndefined();
      }
      expect(() => old.get(123 as any)).toThrow(TypeError);
    });

    it(name + ': JSON scalar roots, Unicode aliases, long keys and hash collisions', () => {
      const a = new Arena({ id: 'cached-keys-' + name });
      let map = create('object', a);
      const keys = ['', '\0', '\uFEFF', '中文🙂', '\ud800', 'x'.repeat(49153), 'costarring', 'liquid'];
      const values = [null, false, 0, '', { unicode: true }, { long: true }, { collision: 'A' }, { collision: 'B' }];
      for (let i = 0; i < keys.length; i++) map = map.set(keys[i], values[i]);
      for (let pass = 0; pass < 2; pass++) for (let i = 0; i < keys.length; i++) {
        expect(map.get(keys[i])).toEqual(values[i]);
        expect(map.get(keys[i])).toEqual(values[i]);
      }
      expect(map.get('\uFFFD')).toEqual({ unicode: true });
      expect(map.get('\ud800')).toEqual({ unicode: true });
      const next = map.set('costarring', { collision: 'changed' }).delete('liquid');
      expect(next.get('costarring')).toEqual({ collision: 'changed' });
      expect(next.get('liquid')).toBeUndefined();
      expect(map.get('liquid')).toEqual({ collision: 'B' });
    });

    it(name + ': nested references survive owner growth and compacted copies', () => {
      const childArena = new Arena({ id: 'cached-child-' + name });
      const child = new SharedList('number', 0, 0, 0, childArena).pushMany([3, 5, 8]);
      const a = new Arena({ id: 'cached-parent-' + name });
      const map = create('SharedList<number>', a).set('child', child).set('other', child);
      const first = map.get('child'), oldBytes = snapshotBytes(a);
      expect(countSlots(a, () => expect(map.get('child')).toBe(first))).toBe(expectedSlotReads);
      a.memory.grow(1); childArena.memory.grow(1);
      expect(map.get('child')).toBe(first);
      expect(map.get('child').toArray()).toEqual([3, 5, 8]);
      expect(snapshotBytes(a)).toEqual(oldBytes);
      const copy = compact(map) as any;
      const compactedChild = copy.get('child');
      expect(compactedChild.toArray()).toEqual([3, 5, 8]);
      expect(copy.get('child')).toBe(compactedChild);
      expect(map.get('child')).toBe(first);
    });
  }

  it('keeps codecs and ordered prefixes separate within one arena', () => {
    const a = new Arena({ id: 'cached-mixed-codecs' });
    const maps = factories.map(([, create], i) => create('object', a).set('same', { kind: i }));
    const primitive = new SharedMap('number', 0, 0, a).set('same', -0);
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 0; i < maps.length; i++) {
        expect(maps[i].get('same')).toEqual({ kind: i });
        expect(maps[i].get('same')).toEqual({ kind: i });
      }
      expect(Object.is(primitive.get('same'), -0)).toBe(true);
    }
  });

  it('decodes values outside the object cache even when their address is warm', () => {
    const a = new Arena({ id: 'cached-object-budget' });
    const entries = Array.from({ length: 2050 }, (_, i) => ['k' + i, { n: i, nested: { value: i } }] as const);
    const map = new SharedMap('object', 0, 0, a).setMany(entries);
    for (let i = 0; i < 2048; i++) map.get('k' + i);
    const first = map.get('k2049');
    expect(countSlots(a, () => {
      const next = map.get('k2049');
      expect(next).toEqual(first);
      expect(next).not.toBe(first);
      expect(Object.isFrozen((next as any).nested)).toBe(true);
    })).toBe(expectedSlotReads);
    expect((a as any).objects.size).toBeLessThanOrEqual(2048);
  });

  it('does not add oversized JSON values to the decoded-object cache', () => {
    const a = new Arena({ id: 'cached-object-byte-budget' });
    const map = new SharedMap('object', 0, 0, a).set('large', { nested: { text: 'x'.repeat(2097153) } });
    const first = map.get('large');
    expect(countSlots(a, () => {
      const next = map.get('large');
      expect(next).toEqual(first);
      expect(next).not.toBe(first);
      expect(Object.isFrozen((next as any).nested)).toBe(true);
    })).toBe(expectedSlotReads);
    expect((a as any).objects.size).toBe(0);
    expect((a as any).objectBytes).toBe(0);
  });

  it('respects address-cache entry and character budgets', () => {
    const a = new Arena({ id: 'cached-address-budget' });
    const entries = Array.from({ length: 16385 }, (_, i) => ['k' + i, { n: i }] as const);
    const map = new SharedMap('object', 0, 0, a).setMany(entries);
    for (let i = 0; i < entries.length; i++) expect((map.get('k' + i) as any).n).toBe(i);
    expect((a as any).reads.slots.size).toBe(16384);
    expect((a as any).reads.slot('k16384')).toBeUndefined();
    expect(map.get('k16384')).toEqual({ n: 16384 });
    expect(map.get('k0')).toEqual({ n: 0 });
    const b = new Arena({ id: 'cached-character-budget' });
    const key = 'x'.repeat(65537);
    const big = new SharedMap('object', 0, 0, b).set(key, { n: 1 }).set(key + 'y', { n: 2 });
    expect(big.get(key)).toEqual({ n: 1 });
    expect(big.get(key + 'y')).toEqual({ n: 2 });
    expect((b as any).reads.slot(key + 'y')).toBeUndefined();
    expect(big.get(key + 'y')).toEqual({ n: 2 });
    expect((b as any).reads.chars).toBeLessThanOrEqual(131072);
  });

  for (const copy of [false, true]) it('attached objects preserve identity and shared bytes; copy=' + copy, async () => {
    const child = new SharedList('number', 0, 0, 0, new Arena({ id: 'cached-attached-child-' + copy })).pushMany([1, 2, 3]);
    const source = new SharedMap('object', 0, 0, new Arena({ id: 'cached-attached-json-' + copy })).set('key', { nested: { n: 7 } });
    const nested = new SharedMap('SharedList<number>', 0, 0, new Arena({ id: 'cached-attached-parent-' + copy })).set('key', child);
    const original = snapshotBytes(arenaOf(source));
    const received = await initWorker<any>(getWorkerData({ source, nested }, { copy }));
    const first = received.source.get('key');
    arenaOf(source).memory.grow(1); arenaOf(child).memory.grow(1); arenaOf(nested).memory.grow(1);
    expect(received.source.get('key')).toBe(first);
    expect(Object.isFrozen(first.nested)).toBe(true);
    const list = received.nested.get('key');
    expect(received.nested.get('key')).toBe(list);
    expect(list.toArray()).toEqual([1, 2, 3]);
    expect(() => received.source.set('key', {})).toThrow(/read-only/);
    expect(snapshotBytes(arenaOf(source))).toEqual(original);
  });
});
