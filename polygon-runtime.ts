import { orient2d } from 'robust-predicates';
import { loadPolygonWasm } from './polygon-wasm';
export interface PolygonKernel {
  xyLeaf(root: number, depth: number, tail: number, size: number, index: number): number;
  boxMaskXY(p: number, count: number, lx: number, ly: number, hx: number, hy: number): number;
  ringMaskXY(p: number, count: number, active: number, root: number, depth: number, tail: number, size: number): number;
  ringPointXY(root: number, depth: number, tail: number, size: number, x: number, y: number): number;
}
let compiled: WebAssembly.Module | undefined;
const instances = new WeakMap<WebAssembly.Memory, PolygonKernel>();
export function polygonKernel(memory: WebAssembly.Memory): PolygonKernel {
  let result = instances.get(memory);
  if (result) return result;
  if (!compiled) {
    const probe = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]);
    compiled = new WebAssembly.Module(loadPolygonWasm(WebAssembly.validate(probe)) as BufferSource);
  }
  result = new WebAssembly.Instance(compiled, { env: { memory }, predicates: { orient2d } }).exports as unknown as PolygonKernel;
  instances.set(memory, result); return result;
}
