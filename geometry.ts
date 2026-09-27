import { arenaOf } from './arena';
import { SharedList } from './shared-list';
import { assertXY, geometryKernel } from './geometry-runtime';
export { preparePolygonXY, pointsWithinPolygonXY } from './geometry-polygon';
export type { PreparedPolygonXY } from './geometry-polygon';

/** Bounds in the input coordinate system: [minX, minY, maxX, maxY]. */
export type BoundsXY = readonly [number, number, number, number];
/**
 * Recompute bounds from interleaved [x0, y0, x1, y1, ...] snapshot values.
 * No coordinate conversion, cached bbox, shared scratch, or arena writes.
 * NaN axes are ignored; ties retain the first value, including signed zero.
 * Empty input returns [Infinity, Infinity, -Infinity, -Infinity].
 * These are Turf bbox recomputation semantics for flat 2D coordinates,
 * not a general GeoJSON parser. Each call returns an independent tuple.
 */
export function bboxXY(points: SharedList<'number'>): BoundsXY {
  assertXY(points);
  const kernel = geometryKernel(arenaOf(points).memory);
  kernel.bboxXY(points.root, points.depth, points.tail, points.size);
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}
