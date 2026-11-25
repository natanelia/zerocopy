import {
  validListRange,
  arenaOf
} from "./chunk-b3bdsgfv.js";
import {
  SharedList2
} from "./chunk-mj9d2fhk.js";

// geometry-wasm.ts
function loadGeometryWasm() {
  const text = atob("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");
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
function bboxXY(points, range) {
  assertXY(points);
  const { size, root, depth, tail } = points;
  const { start = 0, end = size } = range ?? {};
  const full = start === 0 && end === size;
  if (!full && (!validListRange(start, end, size) || (start | end) & 1)) {
    throw new RangeError("Coordinate range must be within the list and aligned to x/y pairs");
  }
  if (start === end)
    return [Infinity, Infinity, -Infinity, -Infinity];
  const kernel = geometryKernel(arenaOf(points).memory);
  if (full)
    kernel.bboxXY(root, depth, tail, size);
  else
    kernel.bboxXYRange(root, depth, tail, size, start, end);
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}
export {
  bboxXY
};
