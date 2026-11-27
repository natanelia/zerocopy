import { Arena, arenaOf, checkedSize, vectorDepth, primitiveReadProtocol } from './arena';
import { SharedList } from './shared-list';
import { loadNumericWasm } from './numeric-wasm';

interface NumericKernel {
  countInRange(root: number, depth: number, tail: number, size: number, lower: number, upper: number): number;
  countPointsInBox(root: number, depth: number, tail: number, size: number, minX: number, minY: number, maxX: number, maxY: number): number;
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

/** Inclusive bounds in the coordinate system used by the stored points. */
export interface Bounds2D {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Count points inside an axis-aligned box. The list is [x0, y0, x1, y1, ...].
 * An odd list size throws RangeError. NaN coordinates never match. NaN bounds
 * or reversed bounds return zero. Coordinates retain their f64 precision.
 * Reads the supplied snapshot directly; it does not create a spatial index.
 */
export function countPointsInBox(points: SharedList<'number'>, bounds: Bounds2D): number {
  if (!(points instanceof SharedList) || points.type !== 'number') throw new TypeError('Expected a numeric SharedList');
  if (points.size & 1) throw new RangeError('Point coordinates must contain complete x/y pairs');
  if (bounds === null || typeof bounds !== 'object') throw new TypeError('Expected numeric box bounds');
  const { minX, minY, maxX, maxY } = bounds;
  if (typeof minX !== 'number' || typeof minY !== 'number' || typeof maxX !== 'number' || typeof maxY !== 'number') throw new TypeError('Box bounds must be numbers');
  if (!points.size || minX > maxX || minY > maxY || Number.isNaN(minX) || Number.isNaN(minY) || Number.isNaN(maxX) || Number.isNaN(maxY)) return 0;
  return kernelFor(arenaOf(points).memory).countPointsInBox(points.root, points.depth, points.tail, points.size, minX, minY, maxX, maxY);
}

/** Copy a Float64Array into a numeric list with a bulk byte copy.
 * The copy preserves every bit, including signed zero and NaN payloads.
 * Synchronize writers when the source uses shared memory: the copy is not
 * an atomic snapshot of concurrently changing elements.
 */
export function fromFloat64(values: Float64Array): SharedList<'number'> {
  if (float64Tag.call(values) !== 'Float64Array') throw new TypeError('Expected a Float64Array');
  // Even an empty detached or out-of-bounds view must be rejected. This
  // intrinsic validates its receiver without reading or writing elements.
  typedArraySet.call(values, emptyFloat64);
  const size = checkedSize(typedArrayLength.call(values));
  if (size * 8 > 0x7ffe0000) throw new RangeError('Allocation exceeds the arena limit');
  if (!size) return new SharedList('number');
  const buffer = typedArrayBuffer.call(values), offset = typedArrayOffset.call(values);
  const reusable = size <= FLOAT64_SCRATCH_LIMIT && !float64ScratchBorrowed;
  let snapshot: Float64Array;
  if (reusable) {
    if (!float64Scratch || typedArrayLength.call(float64Scratch) < size) float64Scratch = new NativeFloat64Array(size);
    snapshot = float64Scratch;
    float64ScratchBorrowed = true;
  } else {
    snapshot = new NativeFloat64Array(size);
  }
  try {
    // Copy before acquiring the writer: optional imports may follow custom
    // Arena hooks. Same-type intrinsic set preserves every source bit.
    typedArraySet.call(snapshot, new NativeFloat64Array(buffer, offset, size));
    const source = new NativeUint8Array(typedArrayBuffer.call(snapshot), 0, size * 8);
    const empty = new SharedList('number'), a = arenaOf(empty);
    a.assertWritable();
    const input = a.alloc(size * 8), native = nativeLittleEndian && nativeFloat64Arena(a);
    const target = a.dv;
    // Hooks may replace views during allocation. Use the current view and the
    // protocol identities captured by arena.ts, before any optional import.
    if (native && nativeFloat64Arena(a)) {
      const bytes = new NativeUint8Array(dataViewBuffer.call(target), dataViewOffset.call(target), dataViewLength.call(target));
      typedArraySet.call(bytes, source, input);
    } else {
      // Integer words preserve NaN payloads and normalize native byte order.
      const raw = new NativeDataView(source.buffer, source.byteOffset, source.byteLength);
      for (let i = 0; i < source.byteLength; i += 8) {
        target.setUint32(input + i, raw.getUint32(i + (nativeLittleEndian ? 0 : 4), nativeLittleEndian), true);
        target.setUint32(input + i + 4, raw.getUint32(i + (nativeLittleEndian ? 4 : 0), nativeLittleEndian), true);
      }
    }
    const length = ((size - 1) & 31) + 1, treeSize = size - length, depth = vectorDepth(treeSize);
    const root = a.wasm.vecLink(0, 0, depth, 0, input, treeSize) >>> 0;
    return new SharedList('number', root, depth, size, a, input + treeSize * 8);
  } finally {
    if (reusable) float64ScratchBorrowed = false;
  }
}

// Capture intrinsics once: subclasses and cross-realm views are accepted, but
// user properties, iterators, species and proxy wrappers are never consulted.
const NativeFloat64Array = Float64Array, NativeUint8Array = Uint8Array, NativeDataView = DataView;
const typedArrayPrototype = Object.getPrototypeOf(Float64Array.prototype);
const float64Tag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArraySet = typedArrayPrototype.set;
const emptyFloat64 = new NativeFloat64Array(0);
const nativeLittleEndian = new NativeUint8Array(new Uint32Array([1]).buffer)[0] === 1;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const FLOAT64_SCRATCH_LIMIT = 131072; // Retain at most one MiB between calls.
let float64Scratch: Float64Array | undefined, float64ScratchBorrowed = false;
function nativeFloat64Arena(a: Arena): boolean {
  for (const key of ['readOnly', 'memory', 'buffer', 'bytes', 'view']) {
    const field = Object.getOwnPropertyDescriptor(a, key);
    if (!field || !('value' in field)) return false;
  }
  return Object.getPrototypeOf(a) === Arena.prototype && primitiveReadProtocol.hasNativeWasm(a)
    && !Object.hasOwn(a, 'buf') && !Object.hasOwn(a, 'dv') && !Object.hasOwn(a, 'refresh')
    && Object.getOwnPropertyDescriptor(Arena.prototype, 'buf')?.get === primitiveReadProtocol.bytes
    && Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')?.get === primitiveReadProtocol.view
    && Object.getOwnPropertyDescriptor(Arena.prototype, 'refresh')?.value === primitiveReadProtocol.refresh;
}
