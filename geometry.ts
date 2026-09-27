import { arenaOf } from './arena';
import { SharedList } from './shared-list';
import { assertXY, geometryKernel } from './geometry-runtime';
export { simplifyLineXY } from './geometry-simplify';
/** Bounds in the input coordinate system: [minX, minY, maxX, maxY]. */
export type BoundsXY = readonly [number, number, number, number];
/** Recompute flat XY bounds. Ignore NaN axes; retain the first signed-zero tie. */
export function bboxXY(points: SharedList<'number'>): BoundsXY {
  assertXY(points);
  const kernel = geometryKernel(arenaOf(points).memory);
  kernel.bboxXY(points.root, points.depth, points.tail, points.size);
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}
