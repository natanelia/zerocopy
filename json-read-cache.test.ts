import { describe, expect, test, vi } from 'vitest';
import { Arena } from './arena';

describe('immutable JSON read cache', () => {
  test('shares cached JSON scalars and objects between both decoder entry points', () => {
    const arena = new Arena();
    const values = [null, false, 0, '', true, 123, 'text', { nested: [1] }, [null, false]];
    const records = values.map(value => {
      const raw = arena.encode('object', value);
      return { raw, length: arena.dv.getUint32(raw, true) };
    });
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const first = records.map(({ raw }) => arena.decode('object', raw));
      expect(first).toEqual(values);
      for (let round = 0; round < 3; round++) {
        records.forEach(({ raw, length }, index) => {
          expect(arena.decode('object', raw)).toBe(first[index]);
          expect(arena.decodeAt('object', raw + 4, length)).toBe(first[index]);
        });
      }
      expect(parse).toHaveBeenCalledTimes(values.length);
    } finally { parse.mockRestore(); }
  });

  test('keeps the 2048-entry limit while freezing values that do not enter the cache', () => {
    const arena = new Arena();
    const records = Array.from({ length: 2049 }, (_, value) => arena.encode('object', { nested: { value } }));
    for (let i = 0; i < 2048; i++) arena.decode('object', records[i]);
    const retained = arena.decode('object', records[0]);
    const first = arena.decode('object', records[2048]);
    const second = arena.decode('object', records[2048]);
    expect(arena.decode('object', records[0])).toBe(retained);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first.nested)).toBe(true);
    expect(Object.isFrozen(second.nested)).toBe(true);
  });

  test('includes the exact 2 MiB byte boundary and leaves later values uncached', () => {
    const arena = new Arena(), limit = 2 * 1024 * 1024;
    const overhead = JSON.stringify({ payload: '' }).length;
    const exact = arena.encode('object', { payload: 'x'.repeat(limit - overhead) });
    const later = arena.encode('object', { nested: [1] });
    expect(arena.dv.getUint32(exact, true)).toBe(limit);
    const retained = arena.decode('object', exact);
    expect(arena.decode('object', exact)).toBe(retained);
    const first = arena.decode('object', later), second = arena.decode('object', later);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(Object.isFrozen(second.nested)).toBe(true);
  });

  test('does not retain an oversized value or consume the budget for smaller values', () => {
    const arena = new Arena(), limit = 2 * 1024 * 1024;
    const oversized = arena.encode('object', { payload: 'x'.repeat(limit) });
    const small = arena.encode('object', { nested: [1] });
    expect(arena.dv.getUint32(oversized, true)).toBeGreaterThan(limit);
    const first = arena.decode('object', oversized), second = arena.decode('object', oversized);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    const retained = arena.decode('object', small);
    expect(arena.decode('object', small)).toBe(retained);
    expect(Object.isFrozen(retained.nested)).toBe(true);
  });
});

test.each(['number', 'boolean', 'string'] as const)('refreshes an older view before an uncached %s read', type => {
  const arena = new Arena(), previousView = arena.dv;
  // A direct WASM allocation grows memory without refreshing the JS views.
  const raw = arena.wasm.alloc(300000) >>> 0, ptr = raw + 200000;
  const view = new DataView(arena.memory.buffer);
  expect(previousView.byteLength).toBeLessThan(ptr);
  if (type === 'number') {
    view.setFloat64(ptr, -0, true);
    expect(arena.decodeAt(type, ptr, 8)).toBe(-0);
  } else if (type === 'boolean') {
    view.setUint8(ptr, 1);
    expect(arena.decodeAt(type, ptr, 1)).toBe(true);
  } else {
    const bytes = new TextEncoder().encode('lane-🙂');
    new Uint8Array(arena.memory.buffer).set(bytes, ptr);
    expect(arena.decodeAt(type, ptr, bytes.length)).toBe('lane-🙂');
  }
});
