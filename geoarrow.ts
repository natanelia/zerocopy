import { Field, FixedSizeList, Float64, List, RecordBatch, Schema, Struct, Table, makeData } from 'apache-arrow';
import type { LineStringBuffersXY } from './geometry';
import { typedArrayTag } from './memory';

export { packLineStringsXY, type LineStringBuffersXY } from './geometry';

/** Wrap a packed XY column in an Apache Arrow table, retaining its coordinate, offset and validity buffers. */
export function toGeoArrowTable({ offsets, coordinates, validity }: LineStringBuffersXY,
  { crs }: { crs?: Readonly<Record<string, unknown>> } = {}): Table<{ geometry: List<FixedSizeList<Float64>> }> {
  if (typedArrayTag.call(coordinates) !== 'Float64Array' || typedArrayTag.call(offsets) !== 'Int32Array' ||
      (validity !== null && typedArrayTag.call(validity) !== 'Uint8Array')) {
    throw new TypeError('Expected Float64 coordinates, Int32 offsets and an optional Uint8 validity bitmap');
  }
  const length = offsets.length - 1;
  if (length < 0 || offsets[0] !== 0 || offsets[length] * 2 !== coordinates.length) {
    throw new RangeError('LineString offsets must span all XY vertices');
  }
  if (validity && validity.length < Math.ceil(length / 8)) throw new RangeError('Incomplete LineString validity bitmap');
  let nullCount = 0;
  for (let i = 0; i < length; i++) {
    if (offsets[i] > offsets[i + 1]) throw new RangeError('LineString offsets must be nondecreasing');
    if (validity && !(validity[i >>> 3] & (1 << (i & 7)))) nullCount++;
  }
  if (crs !== undefined && (!crs || typeof crs !== 'object' || Array.isArray(crs))) {
    throw new TypeError('Expected a PROJJSON object for the coordinate reference system');
  }
  const metadata = new Map([['ARROW:extension:name', 'geoarrow.linestring'],
    ['ARROW:extension:metadata', JSON.stringify({ crs })]]);
  const values = makeData({ type: new Float64(), data: coordinates });
  const vertices = makeData({ type: new FixedSizeList(2, new Field('xy', values.type, false)),
    length: coordinates.length / 2, child: values });
  const lines = makeData({ type: new List(new Field('vertices', vertices.type, false)),
    length, valueOffsets: offsets, nullCount, nullBitmap: validity ?? undefined, child: vertices });
  const field = new Field('geometry', lines.type, true, metadata);
  const schema = new Schema<{ geometry: List<FixedSizeList<Float64>> }>([field]);
  return new Table(new RecordBatch(schema, makeData({ type: new Struct(schema.fields), length, children: [lines] })));
}
