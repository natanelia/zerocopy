import { readFileSync } from 'node:fs';
export function loadGeometryWasm(simd: boolean): Uint8Array {
  return readFileSync(new URL(simd ? './geometry-kernels-simd.wasm' : './geometry-kernels.wasm', import.meta.url));
}
