import { arenaOf, validListRange } from './arena';
import { SharedList } from './shared-list';
import { assertXY, geometryKernel } from './geometry-runtime';

/** Bounds in the input coordinate system: [minX, minY, maxX, maxY]. */
export type BoundsXY = readonly [number, number, number, number];

/**
 * Recompute bounds from interleaved [x0, y0, x1, y1, ...] snapshot values.
 * NaN axes are ignored. Equal extrema retain the first sign of zero.
 * Empty input returns [Infinity, Infinity, -Infinity, -Infinity].
 * The optional [start, end) range uses element indexes aligned to XY pairs.
 * Reads the snapshot without an input copy or writes to shared memory.
 * Returns a fresh tuple. This does not parse GeoJSON, transform coordinates,
 * or use cached bounds. The kernel uses scalar Wasm, not SIMD.
 */
export function bboxXY(points: SharedList<'number'>, range?: { start?: number; end?: number }): BoundsXY {
  assertXY(points);
  const { size, root, depth, tail } = points;
  const { start = 0, end = size } = range ?? {};
  const full = start === 0 && end === size;
  if (!full && (!validListRange(start, end, size) || ((start | end) & 1))) {
    throw new RangeError('Coordinate range must be within the list and aligned to x/y pairs');
  }
  if (start === end) return [Infinity, Infinity, -Infinity, -Infinity];
  const kernel = geometryKernel(arenaOf(points).memory);
  if (full) kernel.bboxXY(root, depth, tail, size);
  else kernel.bboxXYRange(root, depth, tail, size, start, end);
  // Synchronous, callback-free result transfer from instance-local globals.
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}
