import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { bboxXY, pathIntersectsBoxXY, type BoundsXY } from './geometry';
import { buildSpatialIndex, querySpatialIndex } from './spatial';
import { SharedList, resetSharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';

// Vitest shares modules across files. Keep the byte-integrity assertion scoped
// to this test's arena, rather than a large arena left by another test suite.
beforeEach(() => resetSharedList());

describe('bboxXY', () => {
  it('reads Float64 views from other realms and honors buffer offsets, ranges and IEEE extrema', () => {
    const xy: Float64Array = runInNewContext('Float64Array.of(-99, -99, -0, 0, NaN, Infinity, 0, -0, 99, 99).subarray(2, 8)');
    const list = new SharedList('number').pushMany(xy);
    for (let start = 0; start <= xy.length; start += 2) for (let end = start; end <= xy.length; end += 2) {
      expect(bboxXY(xy, { start, end })).toEqual(bboxXY(list, { start, end }));
    }
    const shared = new Float64Array(new SharedArrayBuffer(xy.byteLength));
    shared.set(xy);
    expect(bboxXY(shared)).toEqual([-0, 0, -0, Infinity]);
    expect(pathIntersectsBoxXY(xy, [1, 1, 2, 2])).toBe(false);
    expect(pathIntersectsBoxXY(xy, [0, 0, 0, 0])).toBe(true);
    for (const wrong of [Float32Array.of(1, 2), [1, 2], { [Symbol.toStringTag]: 'Float64Array' }]) {
      expect(() => bboxXY(wrong as never)).toThrow(TypeError);
      expect(() => pathIntersectsBoxXY(wrong as never, [0, 0, 1, 1])).toThrow(TypeError);
    }
    const detached = Float64Array.of(1, 2);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => bboxXY(detached)).toThrow(TypeError);
    expect(() => bboxXY(Float64Array.of(1))).toThrow(RangeError);
    expect(() => pathIntersectsBoxXY(xy, [0, 0, 1, 1], { start: 1 })).toThrow(RangeError);
    expect(pathIntersectsBoxXY(Float64Array.of(-1, 0, 1, 0), [0, 0, 0, 0], { start: 2 })).toBe(false);
  });
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

describe('pathIntersectsBoxXY', () => {
  const path = (...xy: number[]) => new SharedList('number').pushMany(xy);
  const viewport: BoundsXY = [1, 1, 3, 3];

  it('refines bounding-box candidates with inclusive, open path segments', () => {
    const lanes = [path(0, 0, 0, 4, 4, 4), path(0, 2, 4, 2), path(0, 2, 2, 0)];
    const base = buildSpatialIndex(lanes.map((line, id) => ({ id, bounds: bboxXY(line) })));
    const candidates = querySpatialIndex(base, viewport);
    expect(candidates).toEqual([0, 1, 2]);
    expect(candidates.filter(id => pathIntersectsBoxXY(lanes[id], viewport))).toEqual([1, 2]);
    const moved = lanes[0].setMany([[2, 2], [3, 2]]);
    expect(bboxXY(moved)).toEqual(bboxXY(lanes[0]));
    expect(pathIntersectsBoxXY(moved, viewport)).toBe(true);
    expect(pathIntersectsBoxXY(lanes[0], viewport)).toBe(false);
    expect(pathIntersectsBoxXY(path(), viewport)).toBe(false);
    expect(pathIntersectsBoxXY(path(1, 2), viewport)).toBe(true);
    expect(pathIntersectsBoxXY(path(0, 2, 0, 2), viewport)).toBe(false);
    expect(pathIntersectsBoxXY(path(4, 3, 0, 3), viewport)).toBe(true);
    expect(pathIntersectsBoxXY(path(1, 5, 1, -1), [1, 0, 1, 0])).toBe(true);
    expect(pathIntersectsBoxXY(path(0, 0, 4, 4), [Infinity, -Infinity, Infinity, Infinity])).toBe(false);
    expect(pathIntersectsBoxXY(path(0, 0, 4, 4), [-Infinity, 3, 2, Infinity])).toBe(false);
  });

  it('breaks on either nonfinite axis and never joins across the ends of a range', () => {
    for (const gap of [[NaN, 0], [0, NaN], [Infinity, 2], [0, -Infinity]]) {
      expect(pathIntersectsBoxXY(path(0, 2, ...gap, 4, 2), viewport)).toBe(false);
      expect(pathIntersectsBoxXY(path(0, 2, ...gap, 4, 2, 0, 2), viewport)).toBe(true);
    }
    expect(pathIntersectsBoxXY(path(2, 2, 4, 2), viewport, { start: 2 })).toBe(false);
    expect(pathIntersectsBoxXY(path(2, 2), viewport, { end: 0 })).toBe(false);
    expect(() => pathIntersectsBoxXY(path(1), viewport)).toThrow(RangeError);
    expect(() => pathIntersectsBoxXY(new SharedList('string') as never, viewport)).toThrow(TypeError);
    for (const range of [{ start: -2 }, { end: 1 }, { end: 4 }, { start: 2, end: 0 }]) {
      expect(() => pathIntersectsBoxXY(path(2, 2), viewport, range)).toThrow(RangeError);
    }
    expect(() => pathIntersectsBoxXY(path(), [1, 0, 0, 3])).toThrow(RangeError);
    expect(() => pathIntersectsBoxXY(path(), [0, NaN, 2, 3])).toThrow(RangeError);
  });

  it('finds a crossing over a leaf boundary and keeps retained shared geometry readable', async () => {
    const original = new SharedList('number').pushMany(new Float64Array(32770).fill(-1));
    for (const boundary of [32, 1024, 32768]) {
      const edited = original.setMany([[boundary, 5], [boundary + 1, 5]]);
      const data = getWorkerData({ edited, original }, { copy: false });
      const attached = await initWorker(data);
      const memory = data.arenas[0].memory!;
      const before = new Uint8Array(memory.buffer).slice();
      const range = { start: boundary - 2, end: boundary + 2 };
      expect(pathIntersectsBoxXY(attached.original, viewport, range)).toBe(false);
      expect(pathIntersectsBoxXY(attached.edited, viewport, range)).toBe(true);
      expect(pathIntersectsBoxXY(attached.edited, viewport, { ...range, start: boundary })).toBe(false);
      expect(Buffer.from(memory.buffer).equals(Buffer.from(before.buffer))).toBe(true);
    }
  });

  it('distinguishes a point on a segment from a near miss through cancellation, underflow and overflow', () => {
    const n = 2 ** 40;
    expect(pathIntersectsBoxXY(path(0, 0, n, n - 1), [n - 1, n - 2, n - 1, n - 2])).toBe(false);
    for (const size of [Number.MIN_VALUE * 8, 2 ** 40, Number.MAX_VALUE]) {
      const xy = Float64Array.of(-size, -size, size, size);
      for (const line of [xy, path(...xy)]) {
        expect(pathIntersectsBoxXY(line, [0, 0, 0, 0])).toBe(true);
        expect(pathIntersectsBoxXY(line, [0, Number.MIN_VALUE, 0, Number.MIN_VALUE])).toBe(false);
      }
    }
  });

  it('agrees with rational interval clipping on seeded segments at five binary scales', () => {
    // Independent oracle: intersect both axis constraints with 0 <= t <= 1.
    // The source grid is integral and all selected powers of two scale it exactly.
    function clipped(x: number, y: number, u: number, v: number, box: BoundsXY): boolean {
      let low = 0n, lowDen = 1n, high = 1n, highDen = 1n;
      for (const [a, b, min, max] of [[x, u, box[0], box[2]], [y, v, box[1], box[3]]]) {
        if (a === b) {
          if (a < min || a > max) return false;
          continue;
        }
        const den = BigInt(Math.abs(b - a));
        const enter = BigInt(b > a ? min - a : a - max);
        const leave = BigInt(b > a ? max - a : a - min);
        if (enter * lowDen > low * den) { low = enter; lowDen = den; }
        if (leave * highDen < high * den) { high = leave; highDen = den; }
      }
      return low * highDen <= high * lowDen;
    }
    let seed = 104729;
    const coord = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 16) % 65 - 32;
    };
    for (const scale of [2 ** -1070, 2 ** -500, 1, 2 ** 500, 2 ** 1000]) {
      for (let test = 0; test < 250; test++) {
        const x = coord(), y = coord(), u = coord(), v = coord();
        const left = coord(), bottom = coord();
        const box: BoundsXY = [left, bottom, left + Math.abs(coord()), bottom + Math.abs(coord())];
        const scaled: BoundsXY = [box[0] * scale, box[1] * scale, box[2] * scale, box[3] * scale];
        const xy = Float64Array.of(x * scale, y * scale, u * scale, v * scale);
        const expected = clipped(x, y, u, v, box);
        expect(pathIntersectsBoxXY(xy, scaled)).toBe(expected);
        expect(pathIntersectsBoxXY(path(...xy), scaled)).toBe(expected);
      }
    }
  });
});
