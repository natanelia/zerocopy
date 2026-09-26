import { arenaOf } from './arena';
import { SharedList } from './shared-list';
import { loadNumericWasm } from './numeric-wasm';

interface NumericKernel {
  countInRange(root: number, depth: number, tail: number, size: number, lower: number, upper: number): number;
  countPointsInBox(root: number, depth: number, tail: number, size: number, minX: number, minY: number, maxX: number, maxY: number): number;
}
let compiled: WebAssembly.Module | undefined;
const instances = new WeakMap<WebAssembly.Memory, NumericKernel>();
function kernelFor(memory: WebAssembly.Memory): NumericKernel {
  const cached = instances.get(memory);
  if (cached) return cached;
  if (!compiled) {
    // A small, memory-free probe: i32.const 0; i8x16.splat; drop.
    // Unsupported SIMD selects a separately compiled scalar module.
    const probe = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]);
    compiled = new WebAssembly.Module(loadNumericWasm(WebAssembly.validate(probe)) as BufferSource);
  }
  const kernel = new WebAssembly.Instance(compiled, { env: { memory } }).exports as unknown as NumericKernel;
  instances.set(memory, kernel);
  return kernel;
}

/**
 * Count numeric values in the inclusive interval [lower, upper].
 * Reads the immutable snapshot directly, including read-only worker snapshots.
 * NaN values never match. A NaN bound or reversed bounds returns zero.
 * Infinite bounds are supported; both signed zeros compare as zero.
 * No values, scratch buffers, or result arrays are copied into shared memory.
 */
export function countInRange(list: SharedList<'number'>, lower: number, upper: number): number {
  if (!(list instanceof SharedList) || list.type !== 'number') throw new TypeError('Expected a numeric SharedList');
  if (typeof lower !== 'number' || typeof upper !== 'number') throw new TypeError('Range bounds must be numbers');
  if (!list.size || lower > upper || Number.isNaN(lower) || Number.isNaN(upper)) return 0;
  return kernelFor(arenaOf(list).memory).countInRange(list.root, list.depth, list.tail, list.size, lower, upper);
}

/** Inclusive bounds in the coordinate system used by the stored points. */
export interface Bounds2D {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Count points inside an axis-aligned box. The list is [x0, y0, x1, y1, ...].
 * An odd list size throws RangeError. NaN coordinates never match. NaN bounds
 * or reversed bounds return zero. Coordinates retain their f64 precision.
 * Reads the supplied snapshot directly; it does not create a spatial index.
 */
export function countPointsInBox(points: SharedList<'number'>, bounds: Bounds2D): number {
  if (!(points instanceof SharedList) || points.type !== 'number') throw new TypeError('Expected a numeric SharedList');
  if (points.size & 1) throw new RangeError('Point coordinates must contain complete x/y pairs');
  if (bounds === null || typeof bounds !== 'object') throw new TypeError('Expected numeric box bounds');
  const { minX, minY, maxX, maxY } = bounds;
  if (typeof minX !== 'number' || typeof minY !== 'number' || typeof maxX !== 'number' || typeof maxY !== 'number') throw new TypeError('Box bounds must be numbers');
  if (!points.size || minX > maxX || minY > maxY || Number.isNaN(minX) || Number.isNaN(minY) || Number.isNaN(maxX) || Number.isNaN(maxY)) return 0;
  return kernelFor(arenaOf(points).memory).countPointsInBox(points.root, points.depth, points.tail, points.size, minX, minY, maxX, maxY);
}
