import { arenaOf } from './arena';
import { SharedList } from './shared-list';
import { loadNumericWasm } from './numeric-wasm';

interface NumericKernel {
  countInRange(root: number, depth: number, tail: number, size: number, lower: number, upper: number): number;
}
let compiled: WebAssembly.Module | undefined;
const instances = new WeakMap<WebAssembly.Memory, NumericKernel>();
function kernelFor(memory: WebAssembly.Memory): NumericKernel {
  const cached = instances.get(memory);
  if (cached) return cached;
  if (!compiled) {
    // A small, memory-free probe: i32.const 0; i8x16.splat; drop.
    // Unsupported SIMD selects a separately compiled scalar module.
    const probe = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]);
    compiled = new WebAssembly.Module(loadNumericWasm(WebAssembly.validate(probe)) as BufferSource);
  }
  const kernel = new WebAssembly.Instance(compiled, { env: { memory } }).exports as unknown as NumericKernel;
  instances.set(memory, kernel);
  return kernel;
}

/**
 * Count numeric values in the inclusive interval [lower, upper].
 * Reads the immutable snapshot directly, including read-only worker snapshots.
 * NaN values never match. A NaN bound or reversed bounds returns zero.
 * Infinite bounds are supported; both signed zeros compare as zero.
 * No values, scratch buffers, or result arrays are copied into shared memory.
 */
export function countInRange(list: SharedList<'number'>, lower: number, upper: number): number {
  if (!(list instanceof SharedList) || list.type !== 'number') throw new TypeError('Expected a numeric SharedList');
  if (typeof lower !== 'number' || typeof upper !== 'number') throw new TypeError('Range bounds must be numbers');
  if (!list.size || lower > upper || Number.isNaN(lower) || Number.isNaN(upper)) return 0;
  return kernelFor(arenaOf(list).memory).countInRange(list.root, list.depth, list.tail, list.size, lower, upper);
}
