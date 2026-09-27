import { describe, expect, it, vi } from 'vitest';
import { bboxXY } from './geometry';
import { SharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';

describe('bboxXY', () => {
  it('returns independent bounds and preserves first signed zero', () => {
    const p = new SharedList('number').pushMany([-0, 0, 0, -0, NaN, NaN]);
    expect(bboxXY(p)).toEqual([-0, 0, -0, 0]);
    const output = bboxXY(p) as number[]; output[0] = 99;
    expect(bboxXY(p)).toEqual([-0, 0, -0, 0]);
    expect(bboxXY(new SharedList('number'))).toEqual([Infinity, Infinity, -Infinity, -Infinity]);
  });
  it('validates the coordinate representation', () => {
    expect(() => bboxXY(new SharedList('string') as never)).toThrow(TypeError);
    expect(() => bboxXY(new SharedList('number').push(1))).toThrow(RangeError);
    expect(() => bboxXY(null as never)).toThrow(TypeError);
  });
  it('does not modify an attached snapshot after append, fork, or memory growth', async () => {
    const p = new SharedList('number').pushMany([0, 0, 2, 3]);
    const data = getWorkerData({ p }, { copy: false });
    const attached = (await initWorker(data)).p;
    const newer = p.pushMany(Array.from({ length: 32768 }, () => 4)).set(0, -99);
    const memory = data.arenas[0].memory!;
    const before = new Uint8Array(memory.buffer).slice();
    expect(bboxXY(attached)).toEqual([0, 0, 2, 3]);
    expect(bboxXY(p)).toEqual([0, 0, 2, 3]);
    expect(bboxXY(newer)).toEqual([-99, 0, 4, 4]);
    expect(new Uint8Array(memory.buffer)).toEqual(before);
  });
  it('uses a separately compiled scalar fallback', async () => {
    vi.resetModules();
    const probe = vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    try {
      const { SharedList: List } = await import('./shared-list');
      const { bboxXY: bounds } = await import('./geometry');
      expect(bounds(new List('number').pushMany([2, 4, -1, 8]))).toEqual([-1, 4, 2, 8]);
    } finally { probe.mockRestore(); vi.resetModules(); }
  });
});
