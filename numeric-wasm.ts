import { readFileSync } from 'node:fs';

// The browser build replaces only this module with embedded numeric kernels.
// Importing the ordinary zerocopy entry point does not load these kernels.
export function loadNumericWasm(simd: boolean): Uint8Array {
  return readFileSync(new URL(simd ? './numeric-kernels-simd.wasm' : './numeric-kernels.wasm', import.meta.url));
}
