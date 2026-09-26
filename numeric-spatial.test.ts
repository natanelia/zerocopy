import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { countPointsInBox, type Bounds2D } from './numeric';
import { SharedList, resetSharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';
const ALL: Bounds2D = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
function reference(values: readonly number[], box: Bounds2D): number {
  let count = 0;
  for (let i = 0; i < values.length; i += 2) count += Number(values[i] >= box.minX && values[i] <= box.maxX && values[i + 1] >= box.minY && values[i + 1] <= box.maxY);
  return count;
}
beforeEach(() => resetSharedList());
describe('countPointsInBox', () => {
  it.each([0, 1, 2, 7, 8, 15, 16, 17, 31, 32, 33, 511, 512, 513, 16385])('matches scalar for %i interleaved points', count => {
    const values = Array.from({ length: count * 2 }, (_, i) => i % 31 - 15);
    if (count) values[0] = NaN;
    if (count > 1) values[2] = Infinity;
    if (count > 2) values[4] = -Infinity;
    if (count > 3) values[6] = -0;
    const list = new SharedList('number').pushMany(values);
    for (const minX of [-Infinity, -1, 0, Infinity, NaN]) for (const maxY of [-Infinity, 0, 12, Infinity, NaN]) {
      const box = { minX, minY: -10, maxX: 10, maxY };
      expect(countPointsInBox(list, box)).toBe(reference(values, box));
    }
  });
  it('includes boundaries and rejects NaN coordinates in either axis', () => {
    const points = new SharedList('number').pushMany([0, 0, 1, 1, -0, 1, NaN, 0, 0, NaN, 2, 2]);
    expect(countPointsInBox(points, { minX: 0, minY: 0, maxX: 1, maxY: 1 })).toBe(3);
    expect(countPointsInBox(points, ALL)).toBe(4);
  });
  it('preserves attached and old snapshots after append, edit, and growth', async () => {
    const original = new SharedList('number').pushMany(Array.from({ length: 34 }, () => 1));
    const data = getWorkerData({ points: original }, { copy: false });
    const attached = (await initWorker(data)).points;
    const changed = original.pushMany(Array.from({ length: 32768 }, () => 2)).set(0, 99).set(1, 99);
    expect(countPointsInBox(original, ALL)).toBe(17);
    expect(countPointsInBox(attached, ALL)).toBe(17);
    expect(countPointsInBox(changed, { minX: 99, minY: 99, maxX: 99, maxY: 99 })).toBe(1);
    const before = new Uint8Array(data.arenas[0].memory!.buffer).slice();
    expect(countPointsInBox(attached, ALL)).toBe(17);
    expect(new Uint8Array(data.arenas[0].memory!.buffer)).toEqual(before);
  });
  it('rejects incomplete points, incorrect list types, and incorrect bounds', () => {
    expect(() => countPointsInBox(new SharedList('number').push(1), ALL)).toThrow(RangeError);
    expect(() => countPointsInBox(new SharedList('string') as never, ALL)).toThrow(TypeError);
    expect(() => countPointsInBox(new SharedList('number'), null as never)).toThrow(TypeError);
    expect(() => countPointsInBox(new SharedList('number'), { ...ALL, minX: '0' } as never)).toThrow(TypeError);
  });
  it('works when the SIMD probe selects the scalar fallback', async () => {
    vi.resetModules();
    const validate = vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    try {
      const { SharedList: List } = await import('./shared-list');
      const { countPointsInBox: count } = await import('./numeric');
      expect(count(new List('number').pushMany([1, 2, 3, 4]), ALL)).toBe(2);
    } finally { validate.mockRestore(); vi.resetModules(); }
  });
  it.each(['numeric-kernels.wasm', 'numeric-kernels-simd.wasm'])('%s reads only complete points at the memory boundary', filename => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
    const kernel = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(filename)), { env: { memory } }).exports as any;
    const view = new DataView(memory.buffer);
    for (let points = 1; points <= 16; points++) {
      const tail = memory.buffer.byteLength - points * 16;
      for (let i = 0; i < points * 2; i++) view.setFloat64(tail + i * 8, i, true);
      expect(kernel.countPointsInBox(0, 0, tail, points * 2, -Infinity, -Infinity, Infinity, Infinity)).toBe(points);
    }
    expect(() => kernel.countPointsInBox(0, 0, 131064, 1, 0, 0, 1, 1)).toThrow();
  });
});
