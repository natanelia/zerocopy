import { describe, expect, test } from 'vitest';
import { Arena, arenaOf, hashBytes } from './arena';
import { SharedMap, getWorkerData, initWorker } from './shared';

describe('scratch-free short ASCII map lookups', () => {
  test.each([false, true])('complete keys and Unicode fallbacks preserve bytes (copy=%s)', async copy => {
    const keys = ['', '\0', 'costarring', 'liquid', 'prefix__019sdtkc', 'prefix__00vopef9', '界🙂', 'é', '\ufeff'];
    for (let length = 1; length <= 17; length++) {
      // Include zero and high ASCII bytes at every packed-word boundary.
      keys.push(Array.from({ length }, (_, i) => String.fromCharCode((length * 19 + i * 31) & 127)).join(''));
      keys.push('a'.repeat(length));
      keys.push('a'.repeat(length - 1) + '界');
      keys.push('a'.repeat(length - 1) + '\ud800');
    }
    const owner = new Arena();
    const source = new SharedMap('object', 0, 0, owner).setMany(keys.map((key, i) => [key, { i, nested: { value: i } }] as const));
    const before = owner.buf.slice();
    const { map } = await initWorker(getWorkerData({ map: source }, { copy }));
    for (let i = 0; i < keys.length; i++) {
      const value: any = map.get(keys[i]);
      expect(value.i).toBe(i);
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.nested)).toBe(true);
      expect(map.has(keys[i])).toBe(true);
      expect(map.has(keys[i] + '\x01')).toBe(false);
    }
    expect(map.get('\ufffd')).toEqual(map.get('\ud800'));
    expect(hashBytes(new TextEncoder().encode('costarring'))).toBe(hashBytes(new TextEncoder().encode('liquid')));
    expect(map.get('costarring')).not.toEqual(map.get('liquid'));
    // These real FNV collisions have equal lengths and equal first 8 bytes.
    // The second packed half must still distinguish both bucket entries.
    expect(hashBytes(new TextEncoder().encode('prefix__019sdtkc'))).toBe(2195937330);
    expect(hashBytes(new TextEncoder().encode('prefix__00vopef9'))).toBe(2195937330);
    expect(map.get('prefix__019sdtkc')).not.toEqual(map.get('prefix__00vopef9'));
    expect(Buffer.compare(Buffer.from(before), Buffer.from(owner.buf))).toBe(0);
    expect(arenaOf(map).used).toBe(owner.used);
    expect(() => map.set('forbidden', {})).toThrow(/read-only/);
  });

  test('packed comparisons never load past the end of shared memory', () => {
    for (let length = 0; length <= 16; length++) {
      const owner = new Arena(), key = 'k'.repeat(length);
      const bytes = new TextEncoder().encode(key), packed = new Uint32Array(4);
      for (let i = 0; i < length; i++) packed[i >>> 2] |= bytes[i] << ((i & 3) * 8);
      const capacity = owner.memory.buffer.byteLength;
      owner.wasm.setHeapEnd(capacity - ((16 + length + 3) & ~3));
      const leaf = owner.wasm.mapLeaf(length, 0) >>> 0;
      owner.dv.setUint32(leaf + 4, hashBytes(bytes), true);
      owner.buf.set(bytes, leaf + 16);
      owner.buf.fill(0xa5, leaf + 16 + length, capacity);
      expect(owner.used).toBe(capacity);
      expect(owner.wasm.mapFindAscii16(leaf, length, ...packed)).toBe(leaf);
    }
  });

  test('retained roots stay exact after updates, deletion and shared-memory growth', async () => {
    const owner = new Arena();
    const keys = Array.from({ length: 20000 }, (_, i) => `product/${i}`);
    const source = new SharedMap('number', 0, 0, owner).setMany(keys.map((key, i) => [key, i] as const));
    const { old } = await initWorker(getWorkerData({ old: source }, { copy: false }));
    const before = owner.buf.slice(65536, owner.used);
    const originalLength = owner.memory.buffer.byteLength;
    owner.alloc(originalLength);
    const changed = source.set('product/31', -31).delete('product/99').set('new', 30000);
    const { current } = await initWorker(getWorkerData({ current: changed }, { copy: false }));
    for (let round = 0; round < 2; round++) {
      // The second traversal exceeds both the key-character and entry caches.
      for (let i = 0; i < keys.length; i++) {
        expect(old.get(keys[i])).toBe(i);
        expect(current.get(keys[i])).toBe(i === 31 ? -31 : i === 99 ? undefined : i);
      }
    }
    expect(old.has('new')).toBe(false);
    expect(current.get('new')).toBe(30000);
    expect(owner.memory.buffer.byteLength).toBeGreaterThan(originalLength);
    expect(Buffer.compare(Buffer.from(before), Buffer.from(owner.buf.subarray(65536, 65536 + before.length)))).toBe(0);
  });
});
