import {
  arenaOf
} from "./chunk-855jx2y2.js";
import {
  SharedList2
} from "./chunk-6rmn2nvh.js";

// numeric-wasm.ts
function loadNumericWasm(simd) {
  const text = atob(simd ? "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" : "AGFzbQEAAAABKwRgBX9/f3x8AX9gB39/f3x8fHwBf2AGf39/f3x8AX9gCH9/f398fHx8AX8CEgEDZW52Bm1lbW9yeQIDAoCABAMFBAABAgMHLAMGbWVtb3J5AgAMY291bnRJblJhbmdlAAIQY291bnRQb2ludHNJbkJveAADCvAHBKACAgN/AXwCQAJAAkAgAUUEQCACQQFGDQIgAkEBcSEHIABBCGohASACQX5xIQIDQCAFAnwgAUEIRgRAQQArAwAMAQsgAUEIaysAAAsiCCADZiAEIAhmcWohBSAFAnwgAQRAIAErAAAMAQtBACsDAAsiCCADZiAEIAhmcWohBSABQRBqIQEgBkECaiIGIAJHDQALDAELIAFBAWshB0EBIAFBBWx0IQEDQCACIAEgASACSxshBgJ/IABFBEBBACgCAAwBCyAAKAAACyAHIAYgAyAEEAAgBWohBSAAQQRqIQAgAiAGayICDQALDAILIAdFDQELIAUCfCAGQQN0IABqIgAEQCAAKwAADAELQQArAwALIgggA2YgBCAIZnFqIQULIAUL3wECA38CfAJAIAFFBEAgAEEIaiEAQQAhAQNAAnwCQCAAQQhGBEBBACsDACEKDAELIABBCGsrAAAhCiAADQBBACsDAAwBCyAAKwAACyELIAEgAyAKZSAEIAtlcSAFIApmcSAGIAtmcWohASAAQRBqIQAgB0ECaiIHIAJJDQALDAELIAFBAWshCUEBIAFBBWx0IQdBACEBA0AgAiAHIAIgB0kbIQgCfyAARQRAQQAoAgAMAQsgACgAAAsgCSAIIAMgBCAFIAYQASABaiEBIABBBGohACACIAhrIgINAAsLIAELgAICBH8BfAJAIANFDQAgBCAFZUUNACADQQFrQWBxIggEQCAAIAEgCCAEIAUQACEJCwJAIAMgCEYNAEEAIQEgCEEBciADRwRAIANBAXEhACACQQhqIQYgA0F+cSAIayEDA0AgBwJ8IAZBCEYEQEEAKwMADAELIAZBCGsrAAALIgogBGYgBSAKZnFqIQcgBwJ8IAYEQCAGKwAADAELQQArAwALIgogBGYgBSAKZnFqIQcgBkEQaiEGIAMgAUECaiIBRw0ACyAARQ0BCyAHAnwgAUEDdCACaiIABEAgACsAAAwBC0EAKwMACyIKIARmIAUgCmZxaiEHCyAHIAlqIQYLIAYL6AECA38CfCADQQFxRQRAAkAgByAHYiAGIAZicg0AIAUgBWIgBCAEYnINACADRQ0AIAQgBmQNACAFIAdkDQAgA0ECa0FgcSIKBEAgACABIAogBCAFIAYgBxABIQkLIAMgCkcEQCADIAprIQEgAkEIaiEDQQAhAANAAnwCQCADQQhGBEBBACsDACELDAELIANBCGsrAAAhCyADDQBBACsDAAwBCyADKwAACyEMIAggBCALZSAFIAxlcSAGIAtmcSAHIAxmcWohCCADQRBqIQMgAEECaiIAIAFJDQALCyAIIAlqIQgLIAgPCwALAJ0BD3RhcmdldF9mZWF0dXJlcwkrB2F0b21pY3MrD211dGFibGUtZ2xvYmFscysTbm9udHJhcHBpbmctZnB0b2ludCsLYnVsay1tZW1vcnkrCHNpZ24tZXh0Kw9yZWZlcmVuY2UtdHlwZXMrCm11bHRpdmFsdWUrD2J1bGstbWVtb3J5LW9wdCsWY2FsbC1pbmRpcmVjdC1vdmVybG9uZw==");
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
