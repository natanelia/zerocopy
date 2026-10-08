import {
  arenaOf
} from "./chunk-bngxdyck.js";
import {
  SharedList2
} from "./chunk-374wjbs3.js";

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
export {
  countInRange,
  countPointsInBox
};
