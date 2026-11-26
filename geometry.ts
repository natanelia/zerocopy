import { arenaOf, validListRange } from './arena';
import { SharedList } from './shared-list';
import { assertXY, geometryKernel } from './geometry-runtime';
import { checkBounds, type BoundsXY } from './xy-bounds';

export type { BoundsXY } from './xy-bounds';

function assertPairRange(start: number, end: number, size: number): void {
  if (!validListRange(start, end, size) || ((start | end) & 1)) {
    throw new RangeError('Coordinate range must be within the list and aligned to x/y pairs');
  }
}

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
  if (!full) assertPairRange(start, end, size);
  if (start === end) return [Infinity, Infinity, -Infinity, -Infinity];
  const kernel = geometryKernel(arenaOf(points).memory);
  if (full) kernel.bboxXY(root, depth, tail, size);
  else kernel.bboxXYRange(root, depth, tail, size, start, end);
  // Synchronous, callback-free result transfer from instance-local globals.
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}

// Every finite binary64 value is an integer multiple of 2^-1074. The common
// scale cancels when comparing products. Only uncertain orientations need it.
function exactUnits(value: number, bits: DataView): bigint {
  bits.setFloat64(0, value);
  const word = bits.getBigUint64(0);
  const exponent = (word >> 52n) & 0x7ffn;
  const fraction = word & ((1n << 52n) - 1n);
  const units = exponent === 0n ? fraction : ((1n << 52n) | fraction) << (exponent - 1n);
  return value < 0 ? -units : units;
}

function orientation(ax: number, ay: number, bx: number, by: number, x: number, y: number): number {
  const left = (bx - ax) * (y - ay);
  const right = (by - ay) * (x - ax);
  const det = left - right;
  // Bound roundoff in the differences, products and final subtraction.
  // The absolute term covers underflow. Overflow also takes the exact path.
  const error = 8 * Number.EPSILON * (Math.abs(left) + Math.abs(right)) + 8 * Number.MIN_VALUE;
  if (Math.abs(det) > error) return Math.sign(det);

  const bits = new DataView(new ArrayBuffer(8));
  const a = exactUnits(ax, bits), b = exactUnits(ay, bits);
  const exact = (exactUnits(bx, bits) - a) * (exactUnits(y, bits) - b)
    - (exactUnits(by, bits) - b) * (exactUnits(x, bits) - a);
  return exact < 0n ? -1 : exact > 0n ? 1 : 0;
}

function segmentIntersectsBox(ax: number, ay: number, bx: number, by: number, box: BoundsXY): boolean {
  // Clip the box to the segment's extents. All remaining corners are finite,
  // even for an unbounded viewport. Within this overlap the line is a segment.
  const x0 = Math.max(box[0], Math.min(ax, bx)), x1 = Math.min(box[2], Math.max(ax, bx));
  const y0 = Math.max(box[1], Math.min(ay, by)), y1 = Math.min(box[3], Math.max(ay, by));
  if (x0 > x1 || y0 > y1) return false;
  if (ax === bx || ay === by) return true;
  // Orientation is linear in x and y. Its two extrema over this rectangle
  // straddle zero exactly when the segment touches or crosses the rectangle.
  const min = orientation(ax, ay, bx, by, by > ay ? x1 : x0, bx > ax ? y0 : y1);
  if (min > 0) return false;
  return orientation(ax, ay, bx, by, by > ay ? x0 : x1, bx > ax ? y1 : y0) >= 0;
}

/** Intersect an open XY path with an inclusive planar box. Nonfinite vertices break the path. */
export function pathIntersectsBoxXY(points: SharedList<'number'>, box: BoundsXY, range?: { start?: number; end?: number }): boolean {
  assertXY(points);
  checkBounds(box, false);
  const { start = 0, end = points.size } = range ?? {};
  assertPairRange(start, end, points.size);
  if (start === end) return false;
  const arena = arenaOf(points), view = arena.dv;
  const tailStart = (points.size - 1) & ~31;
  let previousX = NaN, previousY = NaN;
  for (let first = start & ~31; first < end; first += 32) {
    const leaf = first === tailStart ? points.tail : arena.wasm.vecLeaf(points.root, points.depth, first) >>> 0;
    const stop = leaf + Math.min(32, end - first) * 8;
    for (let pos = leaf + Math.max(0, start - first) * 8; pos < stop; pos += 16) {
      const x = view.getFloat64(pos, true), y = view.getFloat64(pos + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        previousX = NaN;
        continue;
      }
      if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) return true;
      if (!Number.isNaN(previousX) && segmentIntersectsBox(previousX, previousY, x, y, box)) return true;
      previousX = x;
      previousY = y;
    }
  }
  return false;
}
