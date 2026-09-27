import { readFileSync } from 'node:fs';
export function loadPolygonWasm(simd: boolean): Uint8Array {
  return readFileSync(new URL(simd ? './polygon-kernels-simd.wasm' : './polygon-kernels.wasm', import.meta.url));
}
