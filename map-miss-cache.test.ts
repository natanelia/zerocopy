import { describe, expect, it } from 'vitest';
import { Arena, arenaOf, hashBytes, HEAP_START } from './arena';
import { SharedMap, SharedOrderedMap, SharedSortedMap, compact, getWorkerData, initWorker } from './shared';

type MissingReads = { roots: Map<string, number>; chars: number } | null | undefined;
const cacheOf = (arena: Arena): MissingReads => (arena as any).missingReads;
const numeric = (arena = new Arena()) => new SharedMap('number', 0, 0, arena)
  .setMany([['anchor', 1], ['zero', 0], ['negative-zero', -0], ['nan', NaN]]);

function journal(arena: Arena, base: SharedMap<'number'>, key: string, value: number) {
  const leaf = arena.leaf('number', key, value), root = arena.alloc(20), view = arena.dv;
  view.setUint32(root, 0xffffffff, true);
  view.setUint32(root + 4, base.root, true);
  view.setUint32(root + 8, base.size + (base.has(key) ? 0 : 1), true);
  view.setUint32(root + 12, 1, true);
  view.setUint32(root + 16, leaf, true);
  return new SharedMap('number', root, undefined, arena);
}

describe('bounded negative Map reads', () => {
  it('stays lazy for empty roots and successful reads without shifting existing fields', () => {
    const arena = new Arena(), empty = new SharedMap('number', 0, 0, arena);
    const fields = Object.keys(arena);
    expect(empty.get('missing')).toBeUndefined(); expect(empty.has('missing')).toBe(false);
    const map = numeric(arena);
    for (let i = 0; i < 5; i++) {
      expect(map.get('anchor')).toBe(1); expect(map.has('anchor')).toBe(true);
    }
    expect(Object.hasOwn(arena, 'missingReads')).toBe(false);
    expect(Object.keys(arena)).toEqual(fields);
    map.get('missing');
    expect(Object.keys(arena).slice(0, fields.length)).toEqual(fields);
    expect(cacheOf(arena)?.roots.get('missing')).toBe(map.root);
  });

  for (const [type, value] of [['number', 0], ['boolean', false], ['string', ''], ['object', { value: 1 }]] as const) {
    it(`distinguishes absent ${type} values from existing values`, () => {
      const arena = new Arena(), map = new SharedMap(type, 0, 0, arena).set('present', value);
      const used = arena.used, bytes = arena.copy();
      for (let i = 0; i < 20; i++) {
        expect(map.get('absent')).toBeUndefined(); expect(map.has('absent')).toBe(false);
        expect(map.get('present')).toEqual(value); expect(map.has('present')).toBe(true);
      }
      expect(cacheOf(arena)?.roots.get('absent')).toBe(map.root);
      expect(cacheOf(arena)?.roots.has('present')).toBe(false);
      expect(arena.used).toBe(used); expect(arena.copy()).toEqual(bytes);
    });
  }

  it('keeps old roots, insertions, deletions and forks independent', () => {
    const old = numeric(), arena = arenaOf(old);
    expect(old.get('new')).toBeUndefined(); expect(old.has('new')).toBe(false);
    const next = old.set('new', 2), fork = old.set('new', 3), deleted = next.delete('new');
    const bulk = old.setMany([['new', 4], ['another', 5]]);
    for (let i = 0; i < 20; i++) {
      for (const [map, expected] of [[old, undefined], [next, 2], [fork, 3], [deleted, undefined], [bulk, 4]] as const) {
        expect(map.get('new')).toBe(expected); expect(map.has('new')).toBe(expected !== undefined);
        expect(map.get('zero')).toBe(0); expect(Object.is(map.get('negative-zero'), -0)).toBe(true);
        expect(Number.isNaN(map.get('nan'))).toBe(true);
      }
    }
    expect(cacheOf(arena)?.roots.size).toBeLessThanOrEqual(1);
  });

  it('does not confuse UTF-8 aliases, empty keys, NUL, BOM or long keys', () => {
    const keys = ['', '\0', '\uFEFFname', 'é/界/🙂', '\ud800', '\ufffd', 'x'.repeat(16385), 'y'.repeat(49153)];
    const old = numeric();
    for (const key of keys) { expect(old.get(key)).toBeUndefined(); expect(old.has(key)).toBe(false); }
    const next = old.setMany(keys.map((key, i) => [key, i] as const));
    const encode = new TextEncoder(), decode = new TextDecoder('utf-8', { ignoreBOM: true });
    const oracle = new Map(keys.map((key, i) => [decode.decode(encode.encode(key)), i]));
    for (let i = 0; i < 3; i++) for (const key of keys) {
      expect(old.get(key)).toBeUndefined(); expect(old.has(key)).toBe(false);
      expect(next.get(key)).toBe(oracle.get(decode.decode(encode.encode(key)))); expect(next.has(key)).toBe(true);
    }
    const deleted = next.delete('\ud800');
    expect(deleted.get('\ufffd')).toBeUndefined(); expect(deleted.has('\ud800')).toBe(false);
    expect(next.get('\ud800')).toBe(5); expect(next.get('\ufffd')).toBe(5);
  });

  it('checks complete keys in full-hash collisions before caching a miss', () => {
    const encode = new TextEncoder();
    expect(hashBytes(encode.encode('costarring'))).toBe(hashBytes(encode.encode('liquid')));
    const old = new SharedMap('string', 0, 0, new Arena()).set('costarring', 'A');
    expect(old.get('liquid')).toBeUndefined(); expect(old.has('liquid')).toBe(false);
    const both = old.set('liquid', 'B'), removed = both.delete('costarring');
    for (let i = 0; i < 10; i++) {
      expect(old.get('costarring')).toBe('A'); expect(old.get('liquid')).toBeUndefined();
      expect(both.get('costarring')).toBe('A'); expect(both.get('liquid')).toBe('B');
      expect(removed.has('costarring')).toBe(false); expect(removed.get('liquid')).toBe('B');
    }
  });

  it('records the published journal root and respects its pending entries', () => {
    const base = numeric(), arena = arenaOf(base);
    const first = journal(arena, base, 'pending', 10), second = journal(arena, base, 'absent', 20);
    expect(first.get('absent')).toBeUndefined();
    expect(cacheOf(arena)?.roots.get('absent')).toBe(first.root);
    for (let i = 0; i < 10; i++) {
      expect(first.has('absent')).toBe(false); expect(first.get('pending')).toBe(10);
      expect(base.has('pending')).toBe(false); expect(base.get('absent')).toBeUndefined();
      expect(second.get('absent')).toBe(20); expect(second.has('pending')).toBe(false);
    }
  });

  it('bounds missing keys separately from successful-read caches', () => {
    const map = numeric(), arena = arenaOf(map);
    map.get('anchor'); map.has('zero');
    const positive = (arena as any).valueMap, positiveSize = positive.size;
    for (let i = 0; i < 400; i++) expect(map.get(`missing-${i}`)).toBeUndefined();
    const cache = cacheOf(arena)!;
    expect(cache.roots.size).toBe(256); expect(cache.chars).toBeLessThanOrEqual(16384);
    expect(cache.chars).toBe([...cache.roots.keys()].reduce((sum, key) => sum + key.length, 0));
    expect(cache.roots.has('missing-399')).toBe(false);
    expect((arena as any).valueMap).toBe(positive); expect(positive.size).toBe(positiveSize);
    expect(map.get('anchor')).toBe(1); expect(map.get('zero')).toBe(0);
    const fork = map.set('unrelated', 9);
    expect(fork.get('missing-0')).toBeUndefined(); expect(cache.roots.get('missing-0')).toBe(fork.root);
    expect(cache.roots.size).toBe(256);
  });

  it('bounds retained key characters even before the entry budget fills', () => {
    const map = numeric(), arena = arenaOf(map);
    expect(map.get('x'.repeat(16385))).toBeUndefined(); expect(cacheOf(arena)).toBeUndefined();
    const key = 'z'.repeat(16384);
    expect(map.has(key)).toBe(false); expect(map.has('extra')).toBe(false);
    expect(map.has('')).toBe(false);
    const cache = cacheOf(arena)!;
    expect(cache.roots.size).toBe(2); expect(cache.chars).toBe(16384);
    expect(cache.roots.has('extra')).toBe(false); expect(cache.roots.has('')).toBe(true);
    expect(map.set('extra', 8).get('extra')).toBe(8); expect(map.get('extra')).toBeUndefined();
  });

  for (const copy of [false, true]) it(`keeps ${copy ? 'copied' : 'shared'} attachments read-only without writing bytes`, async () => {
    const writer = numeric(), owner = arenaOf(writer), used = owner.used, bytes = owner.copy();
    const { map } = await initWorker<{ map: SharedMap<'number'> }>(getWorkerData({ map: writer }, { copy }));
    const reader = arenaOf(map), readerBytes = reader.copy();
    expect(reader).not.toBe(owner);
    for (let i = 0; i < 20; i++) {
      expect(map.get('absent')).toBeUndefined(); expect(map.has('absent')).toBe(false);
      expect(map.get('anchor')).toBe(1);
    }
    expect(reader.copy()).toEqual(readerBytes);
    const next = writer.set('absent', 12);
    expect(next.get('absent')).toBe(12); expect(map.get('absent')).toBeUndefined();
    expect(reader.buf.slice(HEAP_START, readerBytes.length)).toEqual(readerBytes.slice(HEAP_START));
    expect(owner.buf.slice(HEAP_START, used)).toEqual(bytes.slice(HEAP_START));
    expect(() => map.set('absent', 12)).toThrow(/read-only/);
    expect(cacheOf(owner)).toBeUndefined(); expect(cacheOf(reader)?.roots.get('absent')).toBe(map.root);
  });

  it('keeps cache state local after memory growth and compaction', () => {
    const source = numeric(), arena = arenaOf(source);
    expect(source.get('absent')).toBeUndefined();
    const oldBuffer = arena.memory.buffer;
    arena.memory.grow(1);
    expect(arena.memory.buffer).not.toBe(oldBuffer);
    expect(source.get('absent')).toBeUndefined(); expect(source.get('anchor')).toBe(1);
    const next = source.set('absent', 9), moved = compact(next);
    expect(arenaOf(moved)).not.toBe(arena);
    expect(moved.get('absent')).toBe(9); expect(moved.get('another')).toBeUndefined();
    expect(source.get('absent')).toBeUndefined(); expect(next.get('absent')).toBe(9);
  });

  it('keeps ordered prefixes and sorted-map lookups independent', () => {
    const arena = new Arena(), map = numeric(arena);
    const ordered = new SharedOrderedMap('boolean', 0, 0, 0, 0, arena).set('only-ordered', false);
    const sorted = new SharedSortedMap('string', undefined, 0, 0, arena).set('only-sorted', '');
    for (let i = 0; i < 10; i++) {
      expect(map.has('only-ordered')).toBe(false); expect(map.get('only-sorted')).toBeUndefined();
      expect(ordered.has('only-ordered')).toBe(true); expect(ordered.get('only-ordered')).toBe(false);
      expect(sorted.has('only-sorted')).toBe(true); expect(sorted.get('only-sorted')).toBe('');
      expect(ordered.get('absent')).toBeUndefined(); expect(sorted.has('absent')).toBe(false);
    }
  });

  it('honors replaced kernels even after a native miss has been cached', () => {
    const map = numeric(), arena = arenaOf(map), native = arena.wasm;
    expect(map.get('cached-miss')).toBeUndefined();
    let calls = 0;
    const custom = { ...native, mapHashCandidateFrom(...args: number[]) { calls++; return native.mapHashCandidateFrom(...args); } };
    Object.defineProperty(arena, 'wasm', { value: custom, configurable: true });
    try {
      for (let i = 0; i < 3; i++) {
        expect(map.get('cached-miss')).toBeUndefined(); expect(map.has('custom-miss')).toBe(false);
      }
      expect(calls).toBe(6); expect(cacheOf(arena)).toBeNull();
      custom.mapHashCandidateFrom = () => { throw new Error('custom kernel'); };
      expect(() => map.get('cached-miss')).toThrow('custom kernel');
    } finally { Object.defineProperty(arena, 'wasm', { value: native, configurable: true }); }
    expect(map.has('cached-miss')).toBe(false); expect(map.get('anchor')).toBe(1);
  });

  it('does not populate a negative cache while custom kernels are installed', () => {
    const map = numeric(), arena = arenaOf(map), native = arena.wasm;
    Object.defineProperty(arena, 'wasm', { value: { ...native }, configurable: true });
    try {
      for (let i = 0; i < 3; i++) { expect(map.get('missing')).toBeUndefined(); expect(map.has('missing')).toBe(false); }
      expect(cacheOf(arena)).toBeNull();
    } finally { Object.defineProperty(arena, 'wasm', { value: native, configurable: true }); }
    expect(map.get('missing')).toBeUndefined(); expect(cacheOf(arena)).toBeNull();
  });

  it('does not cache a custom false miss when that kernel restores native exports', () => {
    const map = numeric(), arena = arenaOf(map), native = arena.wasm;
    const custom = { ...native, mapHashCandidateFrom() {
      Object.defineProperty(arena, 'wasm', { value: native, configurable: true });
      return 0;
    } };
    Object.defineProperty(arena, 'wasm', { value: custom, configurable: true });
    expect(map.get('anchor')).toBeUndefined();
    expect(cacheOf(arena)).toBeNull();
    expect(map.get('anchor')).toBe(1); expect(map.has('anchor')).toBe(true);
  });

  it('preserves dynamic kernel replacement between lookup stages', () => {
    const map = numeric(), arena = arenaOf(map), native = arena.wasm, stages: string[] = [];
    const final = { ...native, mapHashCandidateFrom(...args: number[]) { stages.push('candidate'); return native.mapHashCandidateFrom(...args); } };
    const second = { ...native, mapHashPrefix(...args: number[]) {
      stages.push('prefix'); Object.defineProperty(arena, 'wasm', { value: final, configurable: true });
      return native.mapHashPrefix(...args);
    } };
    const first = { ...native, mapSize(...args: number[]) {
      stages.push('size'); Object.defineProperty(arena, 'wasm', { value: second, configurable: true });
      return native.mapSize(...args);
    } };
    Object.defineProperty(arena, 'wasm', { value: first, configurable: true });
    try { expect(map.get('anchor')).toBe(1); expect(stages).toEqual(['size', 'prefix', 'candidate']); }
    finally { Object.defineProperty(arena, 'wasm', { value: native, configurable: true }); }
    expect(cacheOf(arena)).toBeNull();
  });

  it('does not reuse or publish misses through accessor-valued exports', () => {
    const map = numeric(), arena = arenaOf(map), native = arena.wasm;
    expect(map.get('missing')).toBeUndefined();
    let reads = 0;
    Object.defineProperty(arena, 'wasm', { get() { reads++; return native; }, configurable: true });
    try {
      expect(map.get('missing')).toBeUndefined(); expect(map.get('other')).toBeUndefined();
      expect(reads).toBeGreaterThanOrEqual(2); expect(cacheOf(arena)?.roots.has('other')).toBe(false);
    } finally { Object.defineProperty(arena, 'wasm', { value: native, configurable: true }); }
  });

  it('honors a replaced view getter after a cached miss', () => {
    const map = numeric(), arena = arenaOf(map);
    map.get('missing');
    Object.defineProperty(arena, 'dv', { get() { throw new Error('custom view'); }, configurable: true });
    try { expect(() => map.get('missing')).toThrow('custom view'); }
    finally { delete (arena as any).dv; }
    expect(map.get('missing')).toBeUndefined(); expect(map.get('anchor')).toBe(1);
  });

  for (const first of [null, undefined]) it(`reads a nullish custom view only once (${first})`, () => {
    const map = numeric(), arena = arenaOf(map), actual = arena.dv;
    map.get('missing');
    let reads = 0;
    Object.defineProperty(arena, 'dv', { get() { return reads++ ? actual : first; }, configurable: true });
    try { expect(() => map.get('missing')).toThrow(TypeError); expect(reads).toBe(1); }
    finally { delete (arena as any).dv; }
    expect(map.get('anchor')).toBe(1);
  });

  it('does not let a false custom view poison later native reads', () => {
    const map = numeric(), arena = arenaOf(map), actual = arena.dv;
    const falseView = new Proxy(actual, { get(target, key) {
      if (key === 'getUint32') return (offset: number, littleEndian?: boolean) =>
        offset >= HEAP_START && target.getUint32(offset - 8, true) === 0 ? 0 : target.getUint32(offset, littleEndian);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    Object.defineProperty(arena, 'dv', { get() { return falseView; }, configurable: true });
    try { expect(map.get('anchor')).toBeUndefined(); expect(cacheOf(arena)).toBeNull(); }
    finally { delete (arena as any).dv; }
    expect(map.get('anchor')).toBe(1);
  });

  it('retires miss admission after a custom prefix survives in the read directory', () => {
    const map = numeric(), arena = arenaOf(map), native = arena.wasm;
    const custom = { ...native, mapHashPrefix() { return 0; } };
    Object.defineProperty(arena, 'wasm', { value: custom, configurable: true });
    expect(map.get('anchor')).toBeUndefined();
    Object.defineProperty(arena, 'wasm', { value: native, configurable: true });
    // The original prefix cache remains until a different root is read. The
    // optional negative cache must not extend that custom result's lifetime.
    expect(map.get('anchor')).toBeUndefined();
    expect(map.set('fork-only', 4).get('uncached-fork-key')).toBeUndefined();
    expect(map.get('anchor')).toBe(1); expect(cacheOf(arena)).toBeNull();
  });

  it('preserves invalid-key errors before inspecting the miss cache', () => {
    const map = numeric();
    map.get('missing');
    for (const key of [undefined, null, 1, {}, Symbol('key')]) {
      expect(() => map.get(key as string)).toThrow(TypeError);
      expect(() => map.has(key as string)).toThrow(TypeError);
    }
  });
});
