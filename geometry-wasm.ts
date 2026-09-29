import { readFileSync } from 'node:fs';
export function loadGeometryWasm(): Uint8Array {
  return readFileSync(new URL('./geometry-kernels.wasm', import.meta.url));
}
