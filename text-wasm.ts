import { readFileSync } from 'node:fs';

// The portable build embeds exactly one experiment arm, selected at build time.
// Loading is lazy, but the embedded bytes remain reachable from ordinary imports.
export function loadTextWasm(): Uint8Array {
  return readFileSync(new URL('./text-aux-simd.wasm', import.meta.url));
}
