import { arenaOf } from './arena';
import { SharedList } from './shared-list';
import { assertXY, geometryKernel } from './geometry-runtime';

/** Bounds in the input coordinate system: [minX, minY, maxX, maxY]. */
export type BoundsXY = readonly [number, number, number, number];

/**
 * Recompute bounds from interleaved [x0, y0, x1, y1, ...] snapshot values.
 * NaN axes are ignored. Equal extrema retain the first sign of zero.
 * Empty input returns [Infinity, Infinity, -Infinity, -Infinity].
 * Reads the snapshot without an input copy or writes to shared memory.
 * Returns a fresh tuple. This does not parse GeoJSON, transform coordinates,
 * or use cached bounds. The kernel uses scalar Wasm, not SIMD.
 */
export function bboxXY(points: SharedList<'number'>): BoundsXY {
  assertXY(points);
  if (!points.size) return [Infinity, Infinity, -Infinity, -Infinity];
  const kernel = geometryKernel(arenaOf(points).memory);
  kernel.bboxXY(points.root, points.depth, points.tail, points.size);
  // Synchronous, callback-free result transfer from instance-local globals.
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}
