import { describe, expect, it } from 'vitest';
import { bboxXY } from './geometry';
import { SharedList, resetSharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';

describe('bboxXY', () => {
  it('returns independent bounds with exact signed-zero and NaN handling', () => {
    const p = new SharedList('number').pushMany([-0, 0, 0, -0, NaN, NaN]);
    expect(bboxXY(p)).toEqual([-0, 0, -0, 0]);
    const output = bboxXY(p) as number[];
    output[0] = 99;
    expect(bboxXY(p)).toEqual([-0, 0, -0, 0]);
    expect(bboxXY(new SharedList('number'))).toEqual([Infinity, Infinity, -Infinity, -Infinity]);
  });
  it('rejects incomplete points and incorrect collection types', () => {
    expect(() => bboxXY(new SharedList('string') as never)).toThrow(TypeError);
    expect(() => bboxXY(new SharedList('number').push(1))).toThrow(RangeError);
    expect(() => bboxXY(null as never)).toThrow(TypeError);
  });
  it('preserves attached snapshots after append, fork, and memory growth', async () => {
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
  it('keeps old arenas and separate kernel instances independent', () => {
    const old = new SharedList('number').pushMany([0, 1, 2, 3]);
    resetSharedList();
    const newer = new SharedList('number').pushMany([-5, -4, -2, -1]);
    expect(bboxXY(newer)).toEqual([-5, -4, -2, -1]);
    expect(bboxXY(old)).toEqual([0, 1, 2, 3]);
    expect(bboxXY(newer)).toEqual([-5, -4, -2, -1]);
  });
});
