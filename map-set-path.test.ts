import { describe, it, expect } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedMap, resetMap } from './shared-map';
import { SharedOrderedMap } from './shared-ordered-map';
import { SharedList } from './shared-list';

function attached<T extends string>(map: SharedMap<T>): SharedMap<T> {
  const a = arenaOf(map);
  return SharedMap.fromWorkerData(map.root, map.valueType, map.size,
    new Arena({ memory: a.memory, used: a.used, readOnly: true }));
}
function content(map: SharedMap<any>) { return [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); }

// The directory is writer-private. These checks always use actual stored values,
// including separate read-only instances that have no writer cache.
describe('scalar map write path', () => {
  it('preserves every retained root while adding and replacing distinct keys', () => {
    resetMap(); let map = new SharedMap('number');
    const saved: { map: SharedMap<'number'>; expected: Map<string, number> }[] = [];
    const model = new Map<string, number>();
    for (let i = 0; i < 2400; i++) {
      const key = `key${(i * 73) % 997}`, value = i + 0.25;
      map = map.set(key, value); model.set(key, value);
      expect(map.size).toBe(model.size);
      if (i % 97 === 0) saved.push({ map, expected: new Map(model) });
    }
    for (const { map: old, expected } of saved) {
      expect(content(attached(old))).toEqual([...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      expect(Object.isFrozen(old)).toBe(true);
      expect(arenaOf(old).wasm.mapSize(old.root)).toBe(old.size);
    }
  });

  it('does not change any old payload byte', () => {
    resetMap(); let base = new SharedMap('string');
    for (let i = 0; i < 2048; i++) base = base.set(`key${i}`, `value${i}`);
    const a = arenaOf(base), end = a.used, bytes = a.buf.slice(65536, end);
    let next = base;
    for (let i = 0; i < 2048; i++) next = next.set(`key${(i * 31) % 2048}`, `changed${i}`);
    expect(a.buf.slice(65536, end)).toEqual(bytes);
    expect(attached(base).get('key31')).toBe('value31');
    expect(attached(next).get('key31')).toBe('changed1');
  });

  it('keeps the compact allocation bound without allocating another index', () => {
    resetMap(); let map = new SharedMap('string'); const a = arenaOf(map);
    for (let i = 0; i < 10000; i++) map = map.set(`key${i}`, `val${i}`);
    // Same allocation as the previous compact-layout engine for this input.
    expect(a.used - 65536).toBe(979744);
    expect(a.memory.buffer.byteLength).toBe(1048576);
    expect(attached(map).size).toBe(10000);
  });

  it('falls back for forks, scalar writes after bulk updates, and deletions', () => {
    resetMap(); let base = new SharedMap('number');
    for (let i = 0; i < 512; i++) base = base.set(`k${i}`, i);
    const branch = base.set('left', 1).set('left2', 2);
    const other = base.set('right', 3).set('right2', 4);
    const bulk = base.setMany([['k1', -1], ['batch', 8]]).set('k2', -2);
    const removed = branch.delete('k3').set('k4', -4);
    for (const map of [branch, other, bulk, removed]) {
      expect(content(attached(map))).toEqual(content(map));
      expect(arenaOf(map).wasm.mapSize(map.root)).toBe(map.size);
    }
    expect(base.get('k1')).toBe(1); expect(base.has('left')).toBe(false);
    expect(other.has('left')).toBe(false); expect(branch.has('right')).toBe(false);
    expect(removed.has('k3')).toBe(false); expect(branch.get('k3')).toBe(3);
    expect(bulk.get('k2')).toBe(-2);
  });

  it('handles two maps, an ordered map, and a list in the same writer arena', () => {
    const a = new Arena();
    let first = new SharedMap('number', 0, 0, a), second = new SharedMap('string', 0, 0, a);
    let ordered = new SharedOrderedMap('number', 0, 0, 0, 0, a);
    let list = new SharedList('number', 0, 0, 0, a);
    for (let i = 0; i < 200; i++) {
      first = first.set(`a${i}`, i); second = second.set(`b${i}`, `b${i}`);
      ordered = ordered.set(`o${i}`, i); list = list.push(i);
    }
    expect(attached(first).get('a199')).toBe(199); expect(attached(second).get('b199')).toBe('b199');
    expect(first.size).toBe(200); expect(second.size).toBe(200);
    expect([...ordered.keys()]).toEqual(Array.from({ length: 200 }, (_, i) => `o${i}`));
    expect(list.toArray()).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('compares full keys for exact hash collisions', () => {
    resetMap(); let base = new SharedMap('string').set('costarring', 'a').set('liquid', 'b');
    for (let i = 0; i < 1000; i++) base = base.set(`k${i}`, `v${i}`);
    const next = base.set('costarring', 'changed-a').set('liquid', 'changed-b');
    const reader = attached(next);
    expect(reader.get('costarring')).toBe('changed-a'); expect(reader.get('liquid')).toBe('changed-b');
    expect(base.get('costarring')).toBe('a'); expect(base.get('liquid')).toBe('b');
    expect(next.size).toBe(base.size);
  });

  it.each(Array.from({ length: 18 }, (_, i) => i))('checks exact short-key bytes at length %i', length => {
    resetMap(); const key = 'a'.repeat(length), other = length ? 'a'.repeat(length - 1) + 'b' : 'b';
    const base = new SharedMap('string').set(key, 'first').set(other, 'other');
    const next = base.set(key, 'second');
    expect(attached(next).get(key)).toBe('second'); expect(attached(next).get(other)).toBe('other');
    expect(base.get(key)).toBe('first'); expect(next.size).toBe(2);
  });

  it('preserves Unicode replacement semantics and empty keys and values', () => {
    resetMap(); const base = new SharedMap('string').set('', '').set('🙂路', '中文').set('\ud800', 'a');
    const next = base.set('\ufffd', 'b').set('🙂路', '🙂');
    expect(next.size).toBe(3); expect(attached(next).get('\ud800')).toBe('b');
    expect(attached(next).get('')).toBe(''); expect(base.get('🙂路')).toBe('中文');
  });

  it('keeps size correct after large-record fallbacks and memory growth', () => {
    resetMap(); let map = new SharedMap('string');
    for (let i = 0; i < 300; i++) map = map.set(`k${i}`, 'v');
    const base = map, key = '界'.repeat(20000);
    map = map.set(key, 'large').set('k1', '🙂'.repeat(20000)).set('after', 'ok').set(key, 'changed');
    expect(map.size).toBe(302); expect(arenaOf(map).wasm.mapSize(map.root)).toBe(302);
    expect(attached(map).get(key)).toBe('changed'); expect(attached(map).get('after')).toBe('ok');
    expect(base.get('k1')).toBe('v');
  });

  it('keeps old handles valid after reset and interleaved object serialization', () => {
    const a = new Arena(); let map = new SharedMap('number', 0, 0, a).set('old', 1);
    const objects = new SharedMap('object', 0, 0, a);
    const object = { toJSON() { map = map.set('reentry', 2); return { value: 3 }; } };
    const next = objects.set('object', object); resetMap(); map = map.set('after', 4);
    expect(attached(map).size).toBe(3); expect(next.get('object')).toEqual({ value: 3 });
    expect(Object.isFrozen(next.get('object'))).toBe(true);
  });

  it('preserves numeric special values and no-op cache behavior', () => {
    resetMap(); let map = new SharedMap('number').set('nan', NaN).set('zero', -0).set('inf', Infinity);
    expect(Object.is(map.get('zero'), -0)).toBe(true);
    const same = map.set('zero', -0); expect(same).toBe(map);
    map = map.set('zero', 0).set('inf', -Infinity);
    const reader = attached(map);
    expect(Object.is(reader.get('zero'), 0)).toBe(true); expect(reader.get('nan')).toBeNaN();
    expect(reader.get('inf')).toBe(-Infinity); expect(map.size).toBe(3);
  });

  it('invalidates partial writer hints after allocation failure', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const a = new Arena({ memory }); let base = new SharedMap('number', 0, 0, a);
    for (let i = 0; i < 64; i++) base = base.set(`key${i}`, i);
    const end = a.used, old = a.buf.slice(65536, end);
    // Test-only fault injection: leave room for the leaf, but not its path.
    // Restore only unpublished allocation space after the failed call.
    a.wasm.setHeapEnd(memory.buffer.byteLength - 36);
    expect(() => base.set('key10', -99)).toThrow();
    a.wasm.setHeapEnd(end);
    const hash = (key: string) => { let h = 2166136261; for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h & 255; };
    let recovery = ''; for (let i = 0; ; i++) { recovery = `recovery${i}`; if (hash(recovery) === hash('key10')) break; }
    const next = base.set(recovery, 777), reader = attached(next);
    expect(reader.get('key10')).toBe(10); expect(reader.get(recovery)).toBe(777); expect(next.size).toBe(65);
    expect(a.buf.slice(65536, end)).toEqual(old);
  });

  it('rejects writes through attached readers and rejects invalid primitive values', () => {
    resetMap(); const map = new SharedMap('number').set('a', 1), reader = attached(map);
    expect(() => reader.set('a', 1)).toThrow(/read-only/);
    expect(() => map.set(7 as any, 2)).toThrow(TypeError);
    expect(() => map.set('a', 'bad' as any)).toThrow(TypeError);
    expect(() => new SharedMap('string').set('a', 7 as any)).toThrow(TypeError);
    expect(map.size).toBe(1); expect(map.get('a')).toBe(1);
  });
});
