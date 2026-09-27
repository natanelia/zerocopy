import { readFileSync } from 'node:fs';
export function loadSimplifyWasm(simd: boolean): Uint8Array {
  return readFileSync(new URL(simd ? './simplify-kernels-simd.wasm' : './simplify-kernels.wasm', import.meta.url));
}
