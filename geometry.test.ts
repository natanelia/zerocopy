import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { bboxXY } from './geometry';
import { SharedList, resetSharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';

// Vitest shares modules across files. Keep the byte-integrity assertion scoped
// to this test's arena, rather than a large arena left by another test suite.
beforeEach(() => resetSharedList());

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
  it('returns exact bounds for a subrange without including neighboring coordinates', () => {
    const points = new SharedList('number').pushMany([-99, 99, -0, 0, NaN, -0, 0, NaN, 60, 50]);
    expect(bboxXY(points, { start: 2, end: 8 })).toEqual([-0, 0, -0, 0]);
    expect(bboxXY(points, { end: 2 })).toEqual([-99, 99, -99, 99]);
    expect(bboxXY(points, { start: 8 })).toEqual([60, 50, 60, 50]);
    expect(bboxXY(points, { start: 6, end: 6 })).toEqual([Infinity, Infinity, -Infinity, -Infinity]);
    for (const range of [{ start: -2 }, { start: 1 }, { end: 7 }, { end: 12 }, { start: 6, end: 4 }, { end: 2.5 }]) {
      expect(() => bboxXY(points, range)).toThrow(RangeError);
    }
  });
  it('scans ranges across fragmented leaves, trie boundaries, and the partial tail', () => {
    const values = Float64Array.from({ length: 32870 }, (_, i) => Math.sin(i) * (i % 107));
    const initial = new SharedList('number').pushMany(values);
    const edited = initial.setMany([[30, -123], [1023, Infinity], [32768, -Infinity], [32869, NaN]]);
    for (const index of [30, 1023, 32768, 32869]) values[index] = edited.get(index)!;
    for (const [start, end] of [[30, 68], [992, 1030], [1030, 1120], [32758, 32838], [32838, 32870]]) {
      const slice = new SharedList('number').pushMany(values.subarray(start, end));
      expect(bboxXY(edited, { start, end })).toEqual(bboxXY(slice));
    }
  });
  it('preserves attached snapshots after append, fork, and memory growth', async () => {
    const p = new SharedList('number').pushMany([0, 0, 2, 3]);
    const data = getWorkerData({ p }, { copy: false });
    const attached = (await initWorker(data)).p;
    const newer = p.pushMany(Array.from({ length: 32768 }, () => 4)).set(0, -99);
    const memory = data.arenas[0].memory!;
    const before = new Uint8Array(memory.buffer).slice();
    expect(bboxXY(attached)).toEqual([0, 0, 2, 3]);
    expect(bboxXY(attached, { start: 2 })).toEqual([2, 3, 2, 3]);
    expect(bboxXY(p)).toEqual([0, 0, 2, 3]);
    expect(bboxXY(newer)).toEqual([-99, 0, 4, 4]);
    // Compare every byte without the test framework building a large diff tree.
    expect(Buffer.from(memory.buffer).equals(Buffer.from(before.buffer))).toBe(true);
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
