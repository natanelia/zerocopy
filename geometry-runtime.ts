import { loadGeometryWasm } from './geometry-wasm';
import { SharedList } from './shared-list';

export interface GeometryKernel {
  bboxXY(root: number, depth: number, tail: number, size: number): void;
  bboxMinX(): number;
  bboxMinY(): number;
  bboxMaxX(): number;
  bboxMaxY(): number;
}
let compiled: WebAssembly.Module | undefined;
const instances = new WeakMap<WebAssembly.Memory, GeometryKernel>();

export function geometryKernel(memory: WebAssembly.Memory): GeometryKernel {
  const cached = instances.get(memory);
  if (cached) return cached;
  compiled ??= new WebAssembly.Module(loadGeometryWasm() as BufferSource);
  const kernel = new WebAssembly.Instance(compiled, { env: { memory } }).exports as unknown as GeometryKernel;
  instances.set(memory, kernel);
  return kernel;
}

export function assertXY(points: SharedList<'number'>): void {
  if (!(points instanceof SharedList) || points.type !== 'number') throw new TypeError('Expected a numeric SharedList');
  if (points.size & 1) throw new RangeError('Coordinates must contain complete x/y pairs');
}
