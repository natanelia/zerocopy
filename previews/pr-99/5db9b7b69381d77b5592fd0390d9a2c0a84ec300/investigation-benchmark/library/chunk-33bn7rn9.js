import {
  typedArrayTag
} from "./chunk-vb4t84x1.js";

// xy-bounds.ts
function packedBoundsXY(xy, start, end, finiteVertices) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = start;i < end; i += 2) {
    const x = xy[i], y = xy[i + 1];
    if (finiteVertices && !(Number.isFinite(x) && Number.isFinite(y)))
      continue;
    if (x < minX)
      minX = x;
    if (y < minY)
      minY = y;
    if (x > maxX)
      maxX = x;
    if (y > maxY)
      maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
function checkBounds(box, finite) {
  if (!Array.isArray(box) || box.length !== 4)
    throw new TypeError("Expected four XY bounds");
  for (const value of box) {
    if (typeof value !== "number")
      throw new TypeError("Expected numeric XY bounds");
    if (Number.isNaN(value) || finite && !Number.isFinite(value))
      throw new RangeError("Invalid XY bounds");
  }
  if (box[0] > box[2] || box[1] > box[3])
    throw new RangeError("Reversed XY bounds");
}

// line-string-buffers.ts
function lineStringViewXY2({ offsets, coordinates, validity }, row) {
  if (!Number.isSafeInteger(row) || row < 0 || row >= offsets.length - 1) {
    throw new RangeError("LineString row is outside the batch");
  }
  if (!lineStringPresent(validity, row))
    return null;
  return coordinates.subarray(offsets[row] * 2, offsets[row + 1] * 2);
}
function lineStringPresent(validity, row) {
  return validity === null || (validity[Math.floor(row / 8)] & 1 << row % 8) !== 0;
}
function validateLineStringBuffersXY({ offsets, coordinates, validity }) {
  if (typedArrayTag.call(coordinates) !== "Float64Array" || typedArrayTag.call(offsets) !== "Int32Array" || validity !== null && typedArrayTag.call(validity) !== "Uint8Array") {
    throw new TypeError("Expected Float64 coordinates, Int32 offsets and an optional Uint8 validity bitmap");
  }
  const length = offsets.length - 1;
  if (length < 0 || offsets[0] !== 0 || offsets[length] * 2 !== coordinates.length) {
    throw new RangeError("LineString offsets must span all XY vertices");
  }
  if (validity && validity.length < Math.ceil(length / 8))
    throw new RangeError("Incomplete LineString validity bitmap");
  let nullCount = 0;
  for (let i = 0;i < length; i++) {
    if (offsets[i] > offsets[i + 1])
      throw new RangeError("LineString offsets must be nondecreasing");
    if (!lineStringPresent(validity, i))
      nullCount++;
  }
  return nullCount;
}

export { packedBoundsXY, checkBounds, lineStringViewXY2, lineStringPresent, validateLineStringBuffersXY };
