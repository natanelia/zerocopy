import {
  validListRange,
  arenaOf
} from "./chunk-vb4t84x1.js";
import {
  copyFloat64Range,
  SharedList2
} from "./chunk-hdt16cen.js";
import {
  checkBounds
} from "./chunk-z3dbw0j2.js";

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
function packLineStringsXY2(paths) {
  const rows = Array.from(paths);
  let vertices = 0, hasNull = false;
  for (const path of rows) {
    if (path === null) {
      hasNull = true;
      continue;
    }
    assertXY(path);
    vertices += path.size / 2;
    if (vertices > 2147483647)
      throw new RangeError("Too many vertices for signed 32-bit LineString offsets");
  }
  const offsets = new Int32Array(new SharedArrayBuffer((rows.length + 1) * 4));
  const coordinates = new Float64Array(new SharedArrayBuffer(vertices * 16));
  const validity = hasNull ? new Uint8Array(new SharedArrayBuffer(Math.ceil(rows.length / 8))) : null;
  let offset = 0;
  for (let i = 0;i < rows.length; i++) {
    const path = rows[i];
    if (path !== null) {
      if (validity)
        validity[i >>> 3] |= 1 << (i & 7);
      copyFloat64Range(path, coordinates, 0, path.size, offset * 2);
      offset += path.size / 2;
    }
    offsets[i + 1] = offset;
  }
  return Object.freeze({ offsets, coordinates, validity });
}
function assertPairRange(start, end, size) {
  if (!validListRange(start, end, size) || (start | end) & 1) {
    throw new RangeError("Coordinate range must be within the list and aligned to x/y pairs");
  }
}
function bboxXY2(points, range) {
  assertXY(points);
  const { size, root, depth, tail } = points;
  const { start = 0, end = size } = range ?? {};
  const full = start === 0 && end === size;
  if (!full)
    assertPairRange(start, end, size);
  if (start === end)
    return [Infinity, Infinity, -Infinity, -Infinity];
  const kernel = geometryKernel(arenaOf(points).memory);
  if (full)
    kernel.bboxXY(root, depth, tail, size);
  else
    kernel.bboxXYRange(root, depth, tail, size, start, end);
  return [kernel.bboxMinX(), kernel.bboxMinY(), kernel.bboxMaxX(), kernel.bboxMaxY()];
}
function exactUnits(value, bits) {
  bits.setFloat64(0, value);
  const word = bits.getBigUint64(0);
  const exponent = word >> 52n & 0x7ffn;
  const fraction = word & (1n << 52n) - 1n;
  const units = exponent === 0n ? fraction : (1n << 52n | fraction) << exponent - 1n;
  return value < 0 ? -units : units;
}
function orientation(ax, ay, bx, by, x, y) {
  const left = (bx - ax) * (y - ay);
  const right = (by - ay) * (x - ax);
  const det = left - right;
  const error = 8 * Number.EPSILON * (Math.abs(left) + Math.abs(right)) + 8 * Number.MIN_VALUE;
  if (Math.abs(det) > error)
    return Math.sign(det);
  const bits = new DataView(new ArrayBuffer(8));
  const a = exactUnits(ax, bits), b = exactUnits(ay, bits);
  const exact = (exactUnits(bx, bits) - a) * (exactUnits(y, bits) - b) - (exactUnits(by, bits) - b) * (exactUnits(x, bits) - a);
  return exact < 0n ? -1 : exact > 0n ? 1 : 0;
}
function segmentIntersectsBox(ax, ay, bx, by, box) {
  const x0 = Math.max(box[0], Math.min(ax, bx)), x1 = Math.min(box[2], Math.max(ax, bx));
  const y0 = Math.max(box[1], Math.min(ay, by)), y1 = Math.min(box[3], Math.max(ay, by));
  if (x0 > x1 || y0 > y1)
    return false;
  if (ax === bx || ay === by)
    return true;
  const min = orientation(ax, ay, bx, by, by > ay ? x1 : x0, bx > ax ? y0 : y1);
  if (min > 0)
    return false;
  return orientation(ax, ay, bx, by, by > ay ? x0 : x1, bx > ax ? y1 : y0) >= 0;
}
function pathIntersectsBoxXY2(points, box, range) {
  assertXY(points);
  checkBounds(box, false);
  const { start = 0, end = points.size } = range ?? {};
  assertPairRange(start, end, points.size);
  if (start === end)
    return false;
  const arena = arenaOf(points), view = arena.dv;
  const tailStart = points.size - 1 & ~31;
  let previousX = NaN, previousY = NaN;
  for (let first = start & ~31;first < end; first += 32) {
    const leaf = first === tailStart ? points.tail : arena.wasm.vecLeaf(points.root, points.depth, first) >>> 0;
    const stop = leaf + Math.min(32, end - first) * 8;
    for (let pos = leaf + Math.max(0, start - first) * 8;pos < stop; pos += 16) {
      const x = view.getFloat64(pos, true), y = view.getFloat64(pos + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        previousX = NaN;
        continue;
      }
      if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3])
        return true;
      if (!Number.isNaN(previousX) && segmentIntersectsBox(previousX, previousY, x, y, box))
        return true;
      previousX = x;
      previousY = y;
    }
  }
  return false;
}

export { packLineStringsXY2, bboxXY2, pathIntersectsBoxXY2 };
