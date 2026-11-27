import {
  typedArrayTag
} from "./chunk-vb4t84x1.js";
import"./chunk-hdt16cen.js";
import {
  packLineStringsXY2
} from "./chunk-1bwne42x.js";
import {
  lineStringViewXY2,
  validateLineStringBuffersXY
} from "./chunk-33bn7rn9.js";

// geoarrow.ts
import {
  DataType,
  Field,
  FixedSizeList,
  Float64,
  List,
  Precision,
  RecordBatch,
  Schema,
  Struct,
  Table,
  makeData
} from "apache-arrow";
function planarMetadata(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("GeoArrow extension metadata must be a JSON object");
  }
  const { crs, edges } = value;
  if (edges !== undefined)
    throw new TypeError("Only planar GeoArrow LineStrings are supported");
  if (crs !== undefined && typeof crs !== "string" && (!crs || typeof crs !== "object" || Array.isArray(crs))) {
    throw new TypeError("Expected a PROJJSON object or a serialized CRS");
  }
}
function toGeoArrowTable(batch, extension = {}) {
  const nullCount = validateLineStringBuffersXY(batch);
  const { offsets, coordinates, validity } = batch, length = offsets.length - 1;
  planarMetadata(extension);
  const metadata = new Map([
    ["ARROW:extension:name", "geoarrow.linestring"],
    ["ARROW:extension:metadata", JSON.stringify(extension)]
  ]);
  const values = makeData({ type: new Float64, data: coordinates });
  const vertices = makeData({
    type: new FixedSizeList(2, new Field("xy", values.type, false)),
    length: coordinates.length / 2,
    child: values
  });
  const lines = makeData({
    type: new List(new Field("vertices", vertices.type, false)),
    length,
    valueOffsets: offsets,
    nullCount,
    nullBitmap: validity ?? undefined,
    child: vertices
  });
  const field = new Field("geometry", lines.type, true, metadata);
  const schema = new Schema([field]);
  return new Table(new RecordBatch(schema, makeData({ type: new Struct(schema.fields), length, children: [lines] })));
}
function xyLayout(vertices) {
  const double = (field) => DataType.isFloat(field.type) && field.type.precision === Precision.DOUBLE;
  if (DataType.isFixedSizeList(vertices) && vertices.listSize === 2 && double(vertices.valueField))
    return "interleaved";
  if (DataType.isStruct(vertices) && vertices.children.length === 2 && vertices.children.every(double))
    return "separated";
  throw new TypeError("Expected GeoArrow Float64 XY vertices");
}
function bitmap(data) {
  if (data.nullCount === 0)
    return null;
  if (!data.nullBitmap || data.nullBitmap.length < Math.ceil((data.offset + data.length) / 8)) {
    throw new RangeError("Incomplete Arrow validity bitmap");
  }
  return data.nullBitmap;
}
function requireValidRange(data, start, end) {
  if (end > data.length)
    throw new RangeError("Truncated GeoArrow vertices");
  const bits = bitmap(data);
  if (bits) {
    for (let i = data.offset + start;i < data.offset + end; i++) {
      if (!(bits[Math.floor(i / 8)] & 1 << i % 8))
        throw new TypeError("GeoArrow vertices and coordinates must be valid");
    }
  }
}
function importBatch(lines, layout, copy) {
  const rows = lines.length;
  if (rows === 0)
    return packLineStringsXY2([]);
  const source = lines.valueOffsets, vertices = lines.children[0];
  if (!vertices || xyLayout(vertices.type) !== layout)
    throw new TypeError("GeoArrow batch layout differs from its schema");
  if (source.length < rows + 1)
    throw new RangeError("Incomplete GeoArrow offsets");
  const first = Number(source[0]), last = Number(source[rows]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last > vertices.length) {
    throw new RangeError("GeoArrow offsets exceed the vertex range");
  }
  const bits = bitmap(lines);
  const validity = bits ? new Uint8Array(new SharedArrayBuffer(Math.ceil(rows / 8))) : null;
  const offsets = new Int32Array(new SharedArrayBuffer((rows + 1) * 4));
  let count = 0, previous = first;
  for (let row = 0;row < rows; row++) {
    const next = Number(source[row + 1]);
    if (next < previous || next > last)
      throw new RangeError("GeoArrow offsets must be nondecreasing");
    const bit = lines.offset + row;
    if (!bits || bits[Math.floor(bit / 8)] & 1 << bit % 8) {
      count += next - previous;
      if (count > 2147483647)
        throw new RangeError("Too many vertices for signed 32-bit LineString offsets");
      if (validity)
        validity[Math.floor(row / 8)] |= 1 << row % 8;
    }
    offsets[row + 1] = count;
    previous = next;
  }
  const interleaved = layout === "interleaved";
  const axes = vertices.children;
  if (axes.length !== (interleaved ? 1 : 2) || axes.some((axis) => typedArrayTag.call(axis.values) !== "Float64Array")) {
    throw new TypeError("Expected Float64 buffers for GeoArrow XY coordinates");
  }
  function validate(start, end) {
    requireValidRange(vertices, start, end);
    const stride = interleaved ? 2 : 1;
    for (const axis of axes) {
      if (axis.values.length < end * stride)
        throw new RangeError("Incomplete GeoArrow coordinate buffer");
      requireValidRange(axis, start * stride, end * stride);
    }
  }
  const contiguous = count === last - first;
  if (contiguous) {
    validate(first, last);
    const values = axes[0].values;
    if (interleaved && !copy && values.buffer instanceof SharedArrayBuffer) {
      const coordinates = new Float64Array(values.buffer, values.byteOffset + first * 16, count * 2);
      return { offsets, coordinates, validity };
    }
  }
  const coordinates = new Float64Array(new SharedArrayBuffer(count * 16));
  function copyRange(start, end, target) {
    if (interleaved) {
      coordinates.set(axes[0].values.subarray(start * 2, end * 2), target * 2);
    } else {
      const x = axes[0].values, y = axes[1].values;
      for (let i = start;i < end; i++, target++) {
        coordinates[target * 2] = x[i];
        coordinates[target * 2 + 1] = y[i];
      }
    }
  }
  if (contiguous) {
    copyRange(first, last, 0);
  } else {
    for (let row = 0;row < rows; row++) {
      if (offsets[row] === offsets[row + 1])
        continue;
      const start = Number(source[row]), end = Number(source[row + 1]);
      validate(start, end);
      copyRange(start, end, offsets[row]);
    }
  }
  return { offsets, coordinates, validity };
}
function fromGeoArrowTable(table, { column = "geometry", copy = false } = {}) {
  const index = table.schema.fields.findIndex((field) => field.name === column);
  const field = table.schema.fields[index];
  if (field?.metadata.get("ARROW:extension:name") !== "geoarrow.linestring") {
    throw new TypeError(`Expected geoarrow.linestring column "${column}"`);
  }
  const metadata = JSON.parse(field.metadata.get("ARROW:extension:metadata") ?? "{}");
  planarMetadata(metadata);
  if (!(DataType.isList(field.type) || DataType.isLargeList(field.type)))
    throw new TypeError("Expected a GeoArrow list");
  const layout = xyLayout(field.type.valueType);
  const batches = table.batches.map((batch) => importBatch(batch.data.children[index], layout, copy));
  return { metadata, batches };
}
export {
  fromGeoArrowTable,
  lineStringViewXY2 as lineStringViewXY,
  packLineStringsXY2 as packLineStringsXY,
  toGeoArrowTable
};
