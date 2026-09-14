import { describe, it, expect } from 'vitest';
import { Arena, arenaOf, HEAP_START, hashBytes } from './arena';
import { SharedMap } from './shared-map';
import { SharedOrderedMap } from './shared-ordered-map';

function fresh<T extends string>(type: T, arena = new Arena()) {
  return new SharedMap(type, 0, 0, arena);
}
function verify(map: SharedMap<any>, model: Map<string, any>) {
  expect(map.size).toBe(model.size);
  for (const [key, value] of model) expect(map.get(key)).toEqual(value);
  expect([...map.entries()].sort()).toEqual([...model.entries()].sort());
}
function payload(map: SharedMap<any>) {
  const a = arenaOf(map);
  return a.buf.slice(HEAP_START, a.used);
}
function unchanged(map: SharedMap<any>, before: Uint8Array) {
  expect(arenaOf(map).buf.slice(HEAP_START, HEAP_START + before.length)).toEqual(before);
}

describe('bounded writer prefix index', () => {
  it('preserves snapshots while every prefix is inserted and then overwritten', () => {
    let map = fresh('number');
    const retained: [SharedMap<any>, Map<string, number>][] = [];
    let model = new Map<string, number>();
    for (let i = 0; i < 3000; i++) {
      const key = `key${(i * 1999) % 3001}`;
      map = map.set(key, i); model.set(key, i);
      if (i % 311 === 0) retained.push([map, new Map(model)]);
    }
    const old = map, bytes = payload(old);
    for (let i = 0; i < 3000; i++) {
      const key = `key${(i * 1999) % 3001}`;
      map = map.set(key, -i - 1); model.set(key, -i - 1);
    }
    unchanged(old, bytes); verify(map, model);
    for (const [version, expected] of retained) verify(version, expected);
    expect(Object.isFrozen(map)).toBe(true);
  });

  it('keeps the byte hash unchanged across word boundaries', () => {
    const a = new Arena(); let map = fresh('number', a);
    const enc = new TextEncoder();
    for (let length = 0; length < 130; length++) {
      const key = Array.from({length}, (_, i) => String.fromCharCode((i * 47 + length) & 127)).join('');
      map = map.set(key, length);
      const leaf = a.find(map.root, key);
      expect(leaf).not.toBe(0);
      expect(a.dv.getUint32(leaf + 4, true)).toBe(hashBytes(enc.encode(key)));
      expect(map.get(key)).toBe(length);
    }
  });

  it('invalidates lanes on forks and interleaved maps in the same arena', () => {
    const a = new Arena();
    let first = fresh('number', a), second = fresh('string', a);
    const one = new Map<string, number>(), two = new Map<string, string>();
    for (let i = 0; i < 1200; i++) {
      const k = `lane/${i % 407}`;
      first = first.set(k, i); one.set(k, i);
      second = second.set(k, `${i}`); two.set(k, `${i}`);
    }
    const base = first, old = new Map(one);
    for (let i = 0; i < 50; i++) {
      const fork = base.set(`branch/${i}`, i);
      expect(fork.get(`branch/${i}`)).toBe(i);
      expect(base.has(`branch/${i}`)).toBe(false);
      first = first.set(`live/${i}`, i); one.set(`live/${i}`, i);
    }
    verify(first, one); verify(second, two); verify(base, old);
  });

  it('remains valid after bulk updates, deletes, and low-level inserts', () => {
    let map = fresh('number'); const model = new Map<string, number>();
    for (let i = 0; i < 1000; i++) { map = map.set(`k${i}`, i); model.set(`k${i}`, i); }
    for (let round = 0; round < 20; round++) {
      const changes = Array.from({length: 23}, (_, i) => [`k${(round * 17 + i) % 1100}`, round + i] as const);
      map = map.setMany(changes); for (const [k, v] of changes) model.set(k, v);
      map = map.delete(`k${round}`); model.delete(`k${round}`);
      const a = arenaOf(map), key = `raw/${round}`, leaf = a.leaf('number', key, round);
      map = new SharedMap('number', a.wasm.mapInsert(map.root, leaf) >>> 0, undefined, a); model.set(key, round);
      map = map.set(`regular/${round}`, round); model.set(`regular/${round}`, round);
    }
    verify(map, model);
  });

  it('checks complete keys when full hashes collide', () => {
    const keys = ['costarring', 'liquid']; const enc = new TextEncoder();
    expect(hashBytes(enc.encode(keys[0]))).toBe(hashBytes(enc.encode(keys[1])));
    let map = fresh('number');
    for (let i = 0; i < 1000; i++) map = map.set(`prefix${i}`, i);
    const base = map.set(keys[0], 1).set(keys[1], 2);
    map = base;
    for (let i = 0; i < 100; i++) map = map.set(keys[i & 1], i);
    expect(map.get(keys[0])).toBe(98); expect(map.get(keys[1])).toBe(99);
    expect(base.get(keys[0])).toBe(1); expect(base.get(keys[1])).toBe(2);
    expect(map.size).toBe(1002);
  });

  it('supports UTF-8 keys, long values and the generic codec path', () => {
    let map = fresh('string'); const model = new Map<string, string>();
    for (let i = 0; i < 600; i++) {
      const k = `路/${i}/🙂`, v = i % 101 === 0 ? 'x'.repeat(60000) : `值${i}`;
      map = map.set(k, v); model.set(k, v);
    }
    const base = map;
    map = map.set('\ud800', 'first').set('\ufffd', 'second');
    expect(map.get('\ud800')).toBe('second'); expect(map.size).toBe(601);
    verify(base, model);
  });

  it('resets partly updated scratch after allocation failure', () => {
    const memory = new WebAssembly.Memory({initial: 2, maximum: 2, shared: true});
    const a = new Arena({memory}); let map = fresh('number', a);
    for (let i = 0; i < 180; i++) map = map.set(`k${i}`, i);
    const before = payload(map), mark = a.used;
    // Exhaust memory after the new leaf / lower branch can be allocated, but
    // before every ancestor can be published. Rewind only unpublished test
    // allocations to allow a second attempt in the same memory.
    a.alloc(memory.buffer.byteLength - a.used - 48);
    expect(() => map.set('newkey', 400)).toThrow();
    unchanged(map, before);
    a.wasm.setHeapEnd(mark);
    const next = map.set('different', 500);
    expect(next.size).toBe(181); expect(next.get('different')).toBe(500);
    expect(next.has('newkey')).toBe(false);
    for (let i = 0; i < 180; i++) expect(next.get(`k${i}`)).toBe(i);
    unchanged(map, before);
  });

  it('finishes user callbacks before using the writer index', () => {
    const a = new Arena(); let other = fresh('number', a), map = fresh('object', a);
    for (let i = 0; i < 300; i++) map = map.set(`k${i}`, {i});
    const base = map, before = payload(base);
    let calls = 0;
    const value = {toJSON() { calls++; for (let i = 0; i < 40; i++) other = other.set(`n${i}`, i); return {ok: true}; }};
    map = map.set('callback', value);
    expect(calls).toBe(1); expect(map.get('callback')).toEqual({ok: true});
    expect(base.has('callback')).toBe(false); unchanged(base, before);
    for (let i = 0; i < 40; i++) expect(other.get(`n${i}`)).toBe(i);
  });

  it('keeps worker snapshots read-only with independent WASM globals', () => {
    let map = fresh('number'); for (let i = 0; i < 800; i++) map = map.set(`k${i}`, i);
    const a = arenaOf(map), attached = new Arena({memory: a.memory, used: a.used, readOnly: true});
    const old = SharedMap.fromWorkerData(map.root, 'number', map.size, attached);
    for (let i = 0; i < 800; i++) map = map.set(`k${i}`, i + 1);
    for (let i = 0; i < 800; i++) { expect(old.get(`k${i}`)).toBe(i); expect(map.get(`k${i}`)).toBe(i + 1); }
    expect(() => old.set('x', 1)).toThrow(/read-only/);
  });

  it('retains insertion order for ordered maps', () => {
    let map = new SharedOrderedMap('number');
    for (let i = 0; i < 800; i++) map = map.set(`k${i}`, i);
    const base = map;
    for (let i = 799; i >= 0; i--) map = map.set(`k${i}`, -i);
    expect([...map.keys()]).toEqual([...base.keys()]);
    expect(map.size).toBe(800);
    for (let i = 0; i < 800; i++) { expect(base.get(`k${i}`)).toBe(i); expect(map.get(`k${i}`)).toBe(-i); }
  });
});
