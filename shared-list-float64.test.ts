import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SharedList, resetSharedList } from './shared-list';
import { fromFloat64 } from './numeric';
import { arenaOf, HEAP_START } from './arena';
import { configureMemory } from './memory';
import { compact, getWorkerData, initWorker } from './shared';

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const numbers = (size: number) => Float64Array.from({ length: size }, (_, i) => i === 0 ? -0 : (i - 17) / 4);
function bits(list: SharedList<'number'>): bigint[] {
  const a = arenaOf(list), view = a.dv, result: bigint[] = [];
  for (let i = 0; i < list.size; i++) {
    const leaf = (i >>> 5) === ((list.size - 1) >>> 5)
      ? list.tail : a.wasm.vecLeaf(list.root, list.depth, i) >>> 0;
    result.push(view.getBigUint64(leaf + (i & 31) * 8, true));
  }
  return result;
}

describe('fromFloat64 storage and persistence', () => {
  beforeEach(() => resetSharedList());
  afterEach(() => { configureMemory({ maximumBytes: 256 * 1024 * 1024 }); resetSharedList(); });

  test.each([0, 1, 31, 32, 33, 63, 64, 65, 1024, 1025, 1056, 1057, 32768, 32769, 32800, 32801])(
    'matches existing numeric leaf layout and allocations at size %i', size => {
      const input = numbers(size);
      resetSharedList();
      // The existing runtime already accepts typed numeric inputs. Keep the
      // identical input here instead of materializing an ordinary array.
      const prior = new SharedList('number').pushMany(input as unknown as readonly number[]);
      const a = arenaOf(prior), descriptor = prior.toWorkerData();
      const used = a.used, raw = a.buf.slice(HEAP_START, used);
      resetSharedList();
      const copied = fromFloat64(input), b = arenaOf(copied);
      expect(copied.toWorkerData(), `descriptor at ${size}`).toEqual(descriptor);
      expect(b.used, `allocation at ${size}`).toBe(used);
      expect(b.buf.slice(HEAP_START, b.used), `layout at ${size}`).toEqual(raw);
      expect(copied.toArray(), `values at ${size}`).toEqual(Array.from(input));
      expect(Object.isFrozen(copied)).toBe(true);
    });

  test('copies exact signed-zero, subnormal, infinity and NaN payload bits across leaves', () => {
    const patterns = [0n, 0x8000000000000000n, 1n, 0x8000000000000001n,
      0x7ff0000000000000n, 0xfff0000000000000n,
      0x7ff8000012345678n, 0x7ff0000087654321n, 0xfff8000000000001n];
    const input = new Float64Array(1057), raw = new DataView(input.buffer);
    const expected = Array.from({ length: input.length }, (_, i) => patterns[i % patterns.length]);
    expected.forEach((value, i) => raw.setBigUint64(i * 8, value, littleEndian));
    const copied = fromFloat64(input);
    expect(bits(copied)).toEqual(expected);
    expect(Object.is(copied.get(1), -0)).toBe(true);
    expect(Number.isNaN(copied.get(6))).toBe(true);
    expect([...copied.values()]).toEqual(copied.toArray());
    const visited: number[] = [];
    copied.forEach((value, index) => { expect(index).toBe(visited.length); visited.push(value); });
    expect(visited).toEqual(copied.toArray());
  });

  test('copies only the selected subview and survives later source mutation and detachment', () => {
    const input = numbers(1089), selected = input.subarray(16, 1073), expected = Array.from(selected);
    const copied = fromFloat64(selected), retained = bits(copied);
    input.fill(999);
    structuredClone(input.buffer, { transfer: [input.buffer] });
    expect(input.byteLength).toBe(0);
    expect(copied.toArray()).toEqual(expected);
    expect(bits(copied)).toEqual(retained);
  });

  test('preserves old snapshots and independent forks when importing grows the owning arena', () => {
    const old = new SharedList('number').pushMany([7, -0, 11]), a = arenaOf(old);
    const end = a.used, published = a.buf.slice(HEAP_START, end), capacity = a.memory.buffer.byteLength;
    const input = numbers(32769), copied = fromFloat64(input), initial = bits(copied);
    expect(arenaOf(copied)).toBe(a);
    expect(a.memory.buffer.byteLength).toBeGreaterThan(capacity);
    const edited = copied.set(31, 123).set(32768, -456), appended = copied.push(12).pushMany([13, 14]);
    const shortened = copied.pop();
    expect(edited.get(31)).toBe(123); expect(edited.get(32768)).toBe(-456);
    expect(appended.toArray()).toEqual([...input, 12, 13, 14]);
    expect(shortened.toArray()).toEqual(Array.from(input.subarray(0, input.length - 1)));
    expect(copied.toArray()).toEqual(Array.from(input));
    expect(bits(copied)).toEqual(initial);
    expect(old.toArray()).toEqual([7, -0, 11]);
    expect(a.buf.slice(HEAP_START, end)).toEqual(published);
  });

  test('works with existing worker descriptors, copied attachments and compaction', async () => {
    const copied = fromFloat64(numbers(1057)), original = bits(copied);
    for (const copy of [false, true]) {
      const reader = await initWorker(getWorkerData({ copied }, { copy }));
      expect(reader.copied.toArray()).toEqual(copied.toArray());
      expect(bits(reader.copied)).toEqual(original);
      expect(() => reader.copied.push(9)).toThrow(/read-only/);
    }
    const owned = compact(copied);
    expect(bits(owned)).toEqual(original);
    expect(owned.push(9).get(1057)).toBe(9);
    expect(copied.size).toBe(1057);
  });

  test('keeps published bytes intact when allocation fails before or after copying the input', () => {
    const capacity = 2 * 65536, input = numbers(1057), inputBytes = input.byteLength;
    for (const budget of [0, inputBytes]) {
      configureMemory({ maximumBytes: capacity }); resetSharedList();
      const old = fromFloat64(numbers(65)), a = arenaOf(old);
      const end = a.used, published = a.buf.slice(HEAP_START, end), retained = old.toArray();
      a.alloc(capacity - a.used - budget);
      const before = a.used;
      expect(() => fromFloat64(input)).toThrow(WebAssembly.RuntimeError);
      expect(a.used).toBe(before + budget);
      expect(a.memory.buffer.byteLength).toBe(capacity);
      expect(old.toArray()).toEqual(retained);
      expect(a.buf.slice(HEAP_START, end)).toEqual(published);
      expect(Array.from(input)).toEqual(Array.from(numbers(1057)));
    }
  });
});
