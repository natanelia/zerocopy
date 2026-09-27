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
  let result = instances.get(memory);
  if (result) return result;
  if (!compiled) {
    const probe = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]);
    compiled = new WebAssembly.Module(loadGeometryWasm(WebAssembly.validate(probe)) as BufferSource);
  }
  result = new WebAssembly.Instance(compiled, { env: { memory } }).exports as unknown as GeometryKernel;
  instances.set(memory, result);
  return result;
}
export function assertXY(points: SharedList<'number'>): void {
  if (!(points instanceof SharedList) || points.type !== 'number') throw new TypeError('Expected a numeric SharedList');
  if (points.size & 1) throw new RangeError('Coordinates must contain complete x/y pairs');
}
