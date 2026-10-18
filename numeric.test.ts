import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { countInRange } from './numeric';
import { SharedList, resetSharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';
import { Arena } from './arena';

beforeEach(() => resetSharedList());
const reference = (values: readonly number[], lo: number, hi: number): number => values.reduce((n, v) => n + Number(v >= lo && v <= hi), 0);
describe('numeric countInRange', () => {
  it.each([0, 1, 2, 3, 15, 16, 17, 31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 1056, 1057, 32768, 32769, 32800, 32801])('matches scalar semantics at size %i', size => {
    const values = Array.from({ length: size }, (_, i) => (i * 7919) % 10007 - 5000);
    if (size) values[0] = NaN;
    if (size > 1) values[1] = Infinity;
    if (size > 2) values[2] = -Infinity;
    if (size > 3) values[3] = -0;
    const list = new SharedList('number').pushMany(values);
    for (const lo of [-Infinity, -1000, -0, 1000, Infinity, NaN]) for (const hi of [-Infinity, -0, 1000, Infinity, NaN]) {
      expect(countInRange(list, lo, hi)).toBe(reference(values, lo, hi));
    }
  });
  it('preserves old snapshots through edits, pop, forks, and memory growth', () => {
    let list = new SharedList('number');
    const snapshots: { list: SharedList<'number'>; values: number[] }[] = [];
    const values: number[] = [];
    for (let i = 0; i < 1100; i++) {
      list = list.push(i % 11); values.push(i % 11);
      if (i % 31 === 0) snapshots.push({ list, values: [...values] });
    }
    const fork = list.set(0, -999).set(1024, 999).pop();
    list = list.pushMany(Array.from({ length: 32768 }, () => 5));
    for (const s of snapshots) expect(countInRange(s.list, 2, 7)).toBe(reference(s.values, 2, 7));
    expect(countInRange(fork, -999, -999)).toBe(1);
    expect(countInRange(list, -999, -999)).toBe(0);
  });
  it('reads attached arenas without allocating or changing shared bytes', async () => {
    const list = new SharedList('number').pushMany([1, 2, 3, NaN, 5]);
    const data = getWorkerData({ list }, { copy: false });
    const memory = data.arenas[0].memory!;
    const before = new Uint8Array(memory.buffer).slice();
    const attached = await initWorker(data);
    expect(countInRange(attached.list, 2, 5)).toBe(3);
    expect(new Uint8Array(memory.buffer)).toEqual(before);
    expect(() => attached.list.push(9)).toThrow();
  });
  it('rejects non-numeric lists and non-number bounds', () => {
    expect(() => countInRange(new SharedList('string') as never, 0, 1)).toThrow(TypeError);
    expect(() => countInRange(null as never, 0, 1)).toThrow(TypeError);
    expect(() => countInRange(new SharedList('number'), '0' as never, 1)).toThrow(TypeError);
  });
  it('uses the scalar fallback when the SIMD probe fails', async () => {
    vi.resetModules();
    const validate = vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    try {
      const { SharedList: List } = await import('./shared-list');
      const { countInRange: scalarCount } = await import('./numeric');
      expect(scalarCount(new List('number').pushMany([1, 2, 3]), 1, 2)).toBe(2);
      expect(validate).toHaveBeenCalledOnce();
    } finally { validate.mockRestore(); vi.resetModules(); }
  });
  it.each(['numeric-kernels.wasm', 'numeric-kernels-simd.wasm'])('%s does not overread the last visible pair', filename => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
    const module = new WebAssembly.Module(readFileSync(filename));
    const kernel = new WebAssembly.Instance(module, { env: { memory } }).exports as any;
    const view = new DataView(memory.buffer);
    for (let size = 1; size <= 32; size++) {
      const tail = memory.buffer.byteLength - size * 8;
      for (let i = 0; i < size; i++) view.setFloat64(tail + i * 8, i, true);
      expect(kernel.countInRange(0, 0, tail, size, -Infinity, Infinity)).toBe(size);
    }
  });
  it.each(['numeric-kernels.wasm', 'numeric-kernels-simd.wasm'])('%s scans a partial tree with a full leaf at the memory boundary', filename => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const kernel = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(filename)), { env: { memory } }).exports as any;
    const view = new DataView(memory.buffer);
    const root = 64, firstBranch = 256, lastBranch = 384, tail = 512;
    view.setUint32(root, firstBranch, true);
    view.setUint32(root + 4, lastBranch, true);
    // Unused children point outside memory. A snapshot must not read them.
    view.setUint32(root + 8, 0xffffff00, true);
    view.setUint32(lastBranch + 4, 0xffffff00, true);
    const special = [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE, 1, -1];
    const values: number[] = [];
    for (let leaf = 0; leaf < 33; leaf++) {
      const pointer = leaf === 32 ? memory.buffer.byteLength - 256 : 1024 + leaf * 256;
      view.setUint32(leaf === 32 ? lastBranch : firstBranch + leaf * 4, pointer, true);
      for (let index = 0; index < 32; index++) {
        const value = special[(leaf * 32 + index) % special.length];
        values.push(value);
        view.setFloat64(pointer + index * 8, value, true);
      }
    }
    for (let tailSize = 1; tailSize <= 32; tailSize++) {
      const value = special[(values.length + tailSize - 1) % special.length];
      view.setFloat64(tail + (tailSize - 1) * 8, value, true);
      const visible = [...values, ...Array.from({ length: tailSize }, (_, i) => view.getFloat64(tail + i * 8, true))];
      for (const [lo, hi] of [[-Infinity, Infinity], [-0, 0], [-Number.MIN_VALUE, Number.MIN_VALUE], [Infinity, Infinity], [-Infinity, -Infinity]]) {
        expect(kernel.countInRange(root, 2, tail, visible.length, lo, hi)).toBe(reference(visible, lo, hi));
      }
    }
  });
  it.each(['numeric-kernels.wasm', 'numeric-kernels-simd.wasm'])('%s scans a depth-zero root leaf at the memory boundary', filename => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const kernel = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(filename)), { env: { memory } }).exports as any;
    const view = new DataView(memory.buffer);
    const root = memory.buffer.byteLength - 256, tail = 64;
    const special = [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE, 1, -1];
    const leaf = Array.from({ length: 32 }, (_, i) => special[i % special.length]!);
    const tailValues = Array.from({ length: 32 }, (_, i) => special[(i + 3) % special.length]!);
    leaf.forEach((value, i) => view.setFloat64(root + i * 8, value, true));
    tailValues.forEach((value, i) => view.setFloat64(tail + i * 8, value, true));
    const before = Buffer.from(new Uint8Array(memory.buffer));
    for (let tailSize = 1; tailSize <= 32; tailSize++) {
      const visible = [...leaf, ...tailValues.slice(0, tailSize)];
      for (const [lo, hi] of [[-Infinity, Infinity], [-0, 0], [-Number.MIN_VALUE, Number.MIN_VALUE], [Infinity, Infinity], [-Infinity, -Infinity], [NaN, 1], [0, NaN], [1, -1]]) {
        expect(kernel.countInRange(root, 0, tail, visible.length, lo, hi)).toBe(reference(visible, lo!, hi!));
      }
    }
    expect(memory.buffer.byteLength).toBe(before.length);
    expect(Buffer.from(memory.buffer).equals(before)).toBe(true);
    expect(kernel.countInRange(0xffffff00, 0, 0xffffff00, 0, -Infinity, Infinity)).toBe(0);
  });
  it('preserves snapshots across the next tree depth with binary64 edge values', async () => {
    const size = 1048609;
    const special = [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE, 1000, -1000];
    const values = Array.from({ length: size }, (_, i) => i % 31 === 0 ? special[Math.floor(i / 31) % special.length] : i % 2001 - 1000);
    const original = new SharedList('number', 0, 0, 0, new Arena()).pushMany(values);
    const data = getWorkerData({ original }, { copy: false });
    const attached = (await initWorker(data)).original;
    const changed = original.set(1048576, Infinity).pushMany([NaN, -Infinity, 1000]);
    const fork = original.set(32768, -Infinity).pop();
    const changedValues = [...values]; changedValues[1048576] = Infinity; changedValues.push(NaN, -Infinity, 1000);
    const forkValues = values.slice(0, -1); forkValues[32768] = -Infinity;
    for (const [lo, hi] of [[-Infinity, Infinity], [-0, 0], [-1000, 1000], [Infinity, Infinity]]) {
      const expected = reference(values, lo, hi);
      expect(countInRange(original, lo, hi)).toBe(expected);
      expect(countInRange(attached, lo, hi)).toBe(expected);
      expect(countInRange(changed, lo, hi)).toBe(reference(changedValues, lo, hi));
      expect(countInRange(fork, lo, hi)).toBe(reference(forkValues, lo, hi));
    }
    const before = new Uint8Array(data.arenas[0].memory!.buffer).slice();
    expect(countInRange(attached, -1000, 1000)).toBe(reference(values, -1000, 1000));
    expect(Buffer.from(data.arenas[0].memory!.buffer).equals(before)).toBe(true);
  });
});
