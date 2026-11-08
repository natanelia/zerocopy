import {
  vectorDepth,
  checkedSize,
  arenaOf,
  Arena,
  primitiveReadProtocol
} from "./chunk-vmm7z6ce.js";
import {
  SharedList2
} from "./chunk-aysdem6q.js";

// numeric-wasm.ts
function loadNumericWasm(simd) {
  const text = atob(simd ? "AGFzbQEAAAABMwVgB39/f3x8fHwBf2AFf39/fHwBf2AEf398fAF/YAh/f39/fHx8fAF/YAZ/f39/fHwBfwISAQNlbnYGbWVtb3J5AgMCgIAEAwYFAAECAwQHLAMMY291bnRJblJhbmdlAAQQY291bnRQb2ludHNJbkJveAADBm1lbW9yeQIACoQFBaABAgR/AXwgAUUEQANAIAIgB0sEQCAIIAUgACAHQQN0aiIBKwMAIgtmIAMgC2VxIAQgASsDCCILZXEgBiALZnFqIQggB0ECaiEHDAELCyAIDwtBASABQQVsdCEJA0AgAgRAIAAgB0ECdGooAgAgAUEBayACIAkgAiAJSRsiCiADIAQgBSAGEAAgCGohCCACIAprIQIgB0EBaiEHDAELCyAIC2ABBH8gAUUEQCAAIAIgAyAEEAIPC0EBIAFBBWx0IQUDQCACBEAgACAGQQJ0aigCACABQQFrIAIgBSACIAVJGyIIIAMgBBABIAdqIQcgAiAIayECIAZBAWohBgwBCwsgBwuMAQMCfwN7AXwgAv0UIQcgA/0UIQgDQCABIARrQQJPBEAgBiAAIARBA3Rq/QAEACIGIAf9TCAGIAj9S/1O/dEBIQYgBEECaiEEDAELCyAG/R0ApyAG/R0Bp2ohBQNAIAEgBEsEQCAFIAAgBEEDdGorAwAiCSACZiADIAlmcWohBSAEQQFqIQQMAQsLIAULqAECA38BfCADQQFxBEAACyADRSAEIAZkciAFIAdkciAEIARiciAFIAViciAGIAZiciAHIAdicgRAQQAPCyADIANBAWtBYHEiCmshAwNAIAMgCEsEQCAJIAIgCEEDdGoiCSsDACILIARmIAYgC2ZxIAkrAwgiCyAFZnEgByALZnFqIQkgCEECaiEIDAELCyAKBH8gACABIAogBCAFIAYgBxAABUEACyAJagtHACADRSAEIAVkciAEIARiciAFIAVicgRAQQAPCyACIAMgA0EBa0FgcSICayAEIAUQAiACBH8gACABIAIgBCAFEAEFQQALags=" : "AGFzbQEAAAABKwRgB39/f3x8fHwBf2AFf39/fHwBf2AIf39/f3x8fHwBf2AGf39/f3x8AX8CEgEDZW52Bm1lbW9yeQIDAoCABAMFBAABAgMHLAMMY291bnRJblJhbmdlAAMQY291bnRQb2ludHNJbkJveAACBm1lbW9yeQIACs8EBKABAgR/AXwgAUUEQANAIAIgB0sEQCAIIAUgACAHQQN0aiIBKwMAIgtmIAMgC2VxIAQgASsDCCILZXEgBiALZnFqIQggB0ECaiEHDAELCyAIDwtBASABQQVsdCEJA0AgAgRAIAAgB0ECdGooAgAgAUEBayACIAkgAiAJSRsiCiADIAQgBSAGEAAgCGohCCACIAprIQIgB0EBaiEHDAELCyAIC4kBAgR/AXwgAUUEQANAIAIgBUsEQCAGIAQgACAFQQN0aisDACIJZiADIAllcWohBiAFQQFqIQUMAQsLIAYPC0EBIAFBBWx0IQcDQCACBEAgACAFQQJ0aigCACABQQFrIAIgByACIAdJGyIIIAMgBBABIAZqIQYgAiAIayECIAVBAWohBQwBCwsgBguoAQIDfwF8IANBAXEEQAALIANFIAQgBmRyIAUgB2RyIAQgBGJyIAUgBWJyIAYgBmJyIAcgB2JyBEBBAA8LIAMgA0EBa0FgcSIKayEDA0AgAyAISwRAIAkgAiAIQQN0aiIJKwMAIgsgBGYgBiALZnEgCSsDCCILIAVmcSAHIAtmcWohCSAIQQJqIQgMAQsLIAoEfyAAIAEgCiAEIAUgBiAHEAAFQQALIAlqC3YCA38BfCADRSAEIAVkciAEIARiciAFIAVicgRAQQAPCyADIANBAWtBYHEiCGshAwNAIAMgBksEQCAHIAIgBkEDdGorAwAiCSAEZiAFIAlmcWohByAGQQFqIQYMAQsLIAgEfyAAIAEgCCAEIAUQAQVBAAsgB2oL");
  const bytes = new Uint8Array(text.length);
  for (let i = 0;i < text.length; i++)
    bytes[i] = text.charCodeAt(i);
  return bytes;
}

// numeric.ts
var compiled;
var instances = new WeakMap;
function kernelFor(memory) {
  const cached = instances.get(memory);
  if (cached)
    return cached;
  if (!compiled) {
    const probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11]);
    compiled = new WebAssembly.Module(loadNumericWasm(WebAssembly.validate(probe)));
  }
  const kernel = new WebAssembly.Instance(compiled, { env: { memory } }).exports;
  instances.set(memory, kernel);
  return kernel;
}
function countInRange(list, lower, upper) {
  if (!(list instanceof SharedList2) || list.type !== "number")
    throw new TypeError("Expected a numeric SharedList");
  if (typeof lower !== "number" || typeof upper !== "number")
    throw new TypeError("Range bounds must be numbers");
  if (!list.size || lower > upper || Number.isNaN(lower) || Number.isNaN(upper))
    return 0;
  return kernelFor(arenaOf(list).memory).countInRange(list.root, list.depth, list.tail, list.size, lower, upper);
}
function countPointsInBox(points, bounds) {
  if (!(points instanceof SharedList2) || points.type !== "number")
    throw new TypeError("Expected a numeric SharedList");
  if (points.size & 1)
    throw new RangeError("Point coordinates must contain complete x/y pairs");
  if (bounds === null || typeof bounds !== "object")
    throw new TypeError("Expected numeric box bounds");
  const { minX, minY, maxX, maxY } = bounds;
  if (typeof minX !== "number" || typeof minY !== "number" || typeof maxX !== "number" || typeof maxY !== "number")
    throw new TypeError("Box bounds must be numbers");
  if (!points.size || minX > maxX || minY > maxY || Number.isNaN(minX) || Number.isNaN(minY) || Number.isNaN(maxX) || Number.isNaN(maxY))
    return 0;
  return kernelFor(arenaOf(points).memory).countPointsInBox(points.root, points.depth, points.tail, points.size, minX, minY, maxX, maxY);
}
function fromFloat64(values) {
  if (float64Tag.call(values) !== "Float64Array")
    throw new TypeError("Expected a Float64Array");
  typedArraySet.call(values, emptyFloat64);
  const size = checkedSize(typedArrayLength.call(values));
  if (size * 8 > 2147352576)
    throw new RangeError("Allocation exceeds the arena limit");
  if (!size)
    return new SharedList2("number");
  const buffer = typedArrayBuffer.call(values), offset = typedArrayOffset.call(values);
  const reusable = size <= FLOAT64_SCRATCH_LIMIT && !float64ScratchBorrowed;
  let snapshot;
  if (reusable) {
    if (!float64Scratch || typedArrayLength.call(float64Scratch) < size)
      float64Scratch = new NativeFloat64Array(size);
    snapshot = float64Scratch;
    float64ScratchBorrowed = true;
  } else {
    snapshot = new NativeFloat64Array(size);
  }
  try {
    typedArraySet.call(snapshot, new NativeFloat64Array(buffer, offset, size));
    const source = new NativeUint8Array(typedArrayBuffer.call(snapshot), 0, size * 8);
    const empty = new SharedList2("number"), a = arenaOf(empty);
    a.assertWritable();
    const input = a.alloc(size * 8), native = nativeLittleEndian && nativeFloat64Arena(a);
    const target = a.dv;
    if (native && nativeFloat64Arena(a)) {
      const bytes = new NativeUint8Array(dataViewBuffer.call(target), dataViewOffset.call(target), dataViewLength.call(target));
      typedArraySet.call(bytes, source, input);
    } else {
      const raw = new NativeDataView(source.buffer, source.byteOffset, source.byteLength);
      for (let i = 0;i < source.byteLength; i += 8) {
        target.setUint32(input + i, raw.getUint32(i + (nativeLittleEndian ? 0 : 4), nativeLittleEndian), true);
        target.setUint32(input + i + 4, raw.getUint32(i + (nativeLittleEndian ? 4 : 0), nativeLittleEndian), true);
      }
    }
    const length = (size - 1 & 31) + 1, treeSize = size - length, depth = vectorDepth(treeSize);
    const root = a.wasm.vecLink(0, 0, depth, 0, input, treeSize) >>> 0;
    return new SharedList2("number", root, depth, size, a, input + treeSize * 8);
  } finally {
    if (reusable)
      float64ScratchBorrowed = false;
  }
}
var NativeFloat64Array = Float64Array;
var NativeUint8Array = Uint8Array;
var NativeDataView = DataView;
var typedArrayPrototype = Object.getPrototypeOf(Float64Array.prototype);
var float64Tag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
var typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length").get;
var typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
var typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset").get;
var typedArraySet = typedArrayPrototype.set;
var emptyFloat64 = new NativeFloat64Array(0);
var nativeLittleEndian = new NativeUint8Array(new Uint32Array([1]).buffer)[0] === 1;
var dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get;
var dataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset").get;
var dataViewLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;
var FLOAT64_SCRATCH_LIMIT = 131072;
var float64Scratch;
var float64ScratchBorrowed = false;
function nativeFloat64Arena(a) {
  for (const key of ["readOnly", "memory", "buffer", "bytes", "view"]) {
    const field = Object.getOwnPropertyDescriptor(a, key);
    if (!field || !("value" in field))
      return false;
  }
  return Object.getPrototypeOf(a) === Arena.prototype && primitiveReadProtocol.hasNativeWasm(a) && !Object.hasOwn(a, "buf") && !Object.hasOwn(a, "dv") && !Object.hasOwn(a, "refresh") && Object.getOwnPropertyDescriptor(Arena.prototype, "buf")?.get === primitiveReadProtocol.bytes && Object.getOwnPropertyDescriptor(Arena.prototype, "dv")?.get === primitiveReadProtocol.view && Object.getOwnPropertyDescriptor(Arena.prototype, "refresh")?.value === primitiveReadProtocol.refresh;
}
export {
  countInRange,
  countPointsInBox,
  fromFloat64
};
