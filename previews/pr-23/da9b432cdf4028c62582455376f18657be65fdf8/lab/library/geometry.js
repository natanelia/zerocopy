import {
  arenaOf
} from "./chunk-jbm7ythy.js";
import {
  SharedList2
} from "./chunk-96jzev05.js";

// geometry-wasm.ts
function loadGeometryWasm() {
  const text = atob("AGFzbQEAAAABGARgAAF8YAAAYAV/f39/fwF/YAR/f39/AAISAQNlbnYGbWVtb3J5AgMCgIAEAwgHAQIDAAAAAAYxBHwBRAAAAAAAAPB/C3wBRAAAAAAAAPB/C3wBRAAAAAAAAAAAC3wBRAAAAAAAAAAACwdIBwhiYm94TWluWAAECGJib3hNaW5ZAAMIYmJveE1heFgABghiYm94TWF4WQAFBnh5TGVhZgABBmJib3hYWQACBm1lbW9yeQIACAEACvgCBxgARAAAAAAAAPD/JAJEAAAAAAAA8P8kAws8ACAEIANBAWtBYHFPBEAgAg8LA0AgAQRAIAAgBCABQQVsdkEfcUECdGooAgAhACABQQFrIQEMAQsLIAALiwICA38GfCADQQFxBEAAC0QAAAAAAADwfyEHRAAAAAAAAPB/IQlEAAAAAAAA8P8hCkQAAAAAAADw/yELA0AgAyAESwRAIAQhBiACIQQgA0EBa0FgcSAGSwRAIAAhBCABIQUDQCAFBEAgBCAGIAVBBWx2QR9xQQJ0aigCACEEIAVBAWshBQwBCwsLIARBICADIAZrIgUgBUEgSxtBA3RqIQUDQCAEIAVJBEAgBCsDCCEMIAcgBCsDACIIZARAIAghBwsgDCAJIAkgDGQbIQkgCCAKIAggCmQbIQogDCALIAsgDGMbIQsgBEEQaiEEDAELCyAGQSBqIQQMAQsLIAckACAJJAEgCiQCIAskAwsEACMBCwQAIwALBAAjAwsEACMCCw==");
  const bytes = new Uint8Array(text.length);
  for (let i = 0;i < text.length; i++)
    bytes[i] = text.charCodeAt(i);
  return bytes;
}

// geometry-runtime.ts
var compiled;
var instances = new WeakMap;
function geometryKernel(memory) {
  const cached = instances.get(memory);
  if (cached)
    return cached;
  compiled ??= new WebAssembly.Module(loadGeometryWasm());
  const kernel = new WebAssembly.Instance(compiled, { env: { memory } }).exports;
  instances.set(memory, kernel);
  return kernel;
}
function assertXY(points) {
  if (!(points instanceof SharedList2) || points.type !== "number")
    throw new TypeError("Expected a numeric SharedList");
  if (points.size & 1)
    throw new RangeError("Coordinates must contain complete x/y pairs");
}

// geometry.ts
function bboxXY(points) {
  assertXY(points);
  if (!points.size)
    return [Infinity, Infinity, -Infinity, -Infinity];
  const kernel = geometryKernel(arenaOf(points).memory);
  kernel.bboxXY(points.root, points.depth, points.tail, points.size);
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}
export {
  bboxXY
};
