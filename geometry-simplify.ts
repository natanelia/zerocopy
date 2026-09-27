import { SharedList } from './shared-list';
import { arenaOf } from './arena';
import { assertXY } from './geometry-runtime';
import { loadSimplifyWasm } from './simplify-wasm';
interface Kernel {
  finiteXY(root: number, depth: number, tail: number, size: number): number;
  farthestXY(root: number, depth: number, tail: number, size: number, first: number, last: number, threshold: number): number;
}
let compiled: WebAssembly.Module | undefined;
const instances = new WeakMap<WebAssembly.Memory, Kernel>();
function kernelFor(memory: WebAssembly.Memory): Kernel {
  let kernel = instances.get(memory);
  if (kernel) return kernel;
  if (!compiled) {
    const probe = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]);
    compiled = new WebAssembly.Module(loadSimplifyWasm(WebAssembly.validate(probe)) as BufferSource);
  }
  kernel = new WebAssembly.Instance(compiled, { env: { memory } }).exports as unknown as Kernel;
  instances.set(memory, kernel); return kernel;
}
/**
 * Return ascending retained vertex indices from 2D Douglas-Peucker reduction.
 * Tolerance is in input coordinate units. All coordinates and tolerance must
 * be finite, tolerance nonnegative, and tolerance squared finite. Retain both
 * endpoints and the first vertex on equal-distance ties. No coordinate
 * cleaning, radial prepass, ring repair, projection, or GeoJSON output.
 * Scalar and SIMD paths preserve binary64 operation order. No arena writes.
 */
export function simplifyLineXY(points: SharedList<'number'>, tolerance: number): Uint32Array {
  assertXY(points);
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || !Number.isFinite(tolerance * tolerance)) throw new RangeError('Tolerance must be finite, nonnegative, and have a finite square');
  const k = kernelFor(arenaOf(points).memory);
  if (!k.finiteXY(points.root, points.depth, points.tail, points.size)) throw new RangeError('Line coordinates must be finite');
  const count = points.size / 2;
  if (count <= 2) return Uint32Array.from({ length: count }, (_, i) => i);
  const marked = new Uint8Array(count), stack: number[] = [0, count - 1], squared = tolerance * tolerance;
  marked[0] = marked[count - 1] = 1;
  while (stack.length) {
    const last = stack.pop()!, first = stack.pop()!;
    const index = k.farthestXY(points.root, points.depth, points.tail, points.size, first, last, squared);
    if (index < 0) continue;
    marked[index] = 1;
    if (last - index > 1) stack.push(index, last);
    if (index - first > 1) stack.push(first, index);
  }
  let retained = 0;
  for (const mark of marked) retained += mark;
  const result = new Uint32Array(retained);
  for (let i = 0, at = 0; i < count; i++) if (marked[i]) result[at++] = i;
  return result;
}
