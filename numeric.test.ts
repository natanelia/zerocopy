import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { countInRange } from './numeric';
import { SharedList, resetSharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';

beforeEach(() => resetSharedList());
const reference = (values: readonly number[], lo: number, hi: number): number => values.reduce((n, v) => n + Number(v >= lo && v <= hi), 0);
describe('numeric countInRange', () => {
  it.each([0, 1, 2, 3, 15, 16, 17, 31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 32768, 32769])('matches scalar semantics at size %i', size => {
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
});
