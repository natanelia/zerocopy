import { Field, Float32, Float64, LargeList, List, RecordBatch, Schema, Struct, Table, makeData, tableFromIPC, tableToIPC,
  vectorFromArray, type Data } from 'apache-arrow';
import { expect, it } from 'vitest';
import { fromGeoArrowTable, lineStringViewXY, packLineStringsXY, toGeoArrowTable } from './geoarrow';
import { SharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';

it('packs edited and retained numeric leaves into independent shared coordinates', async () => {
  const numbers = Float64Array.from({ length: 2114 }, (_, i) => i / 3);
  const path = new SharedList('number').pushMany(numbers);
  const edited = path.setMany([[30, -0], [1023, NaN], [2080, 1e-234]]);
  const { lines } = await initWorker<{ lines: typeof edited }>(getWorkerData({ lines: edited }, { copy: false }));
  const packed = packLineStringsXY([path, null, lines, new SharedList('number')]);
  expect([...packed.offsets]).toEqual([0, 1057, 1057, 2114, 2114]);
  expect([...packed.validity!]).toEqual([13]);
  expect(packed.coordinates.subarray(0, path.size)).toEqual(numbers);
  expect(packed.coordinates.subarray(path.size)).toEqual(edited.toFloat64Array());
  for (const view of [packed.offsets, packed.validity!, packed.coordinates]) expect(view.buffer).toBeInstanceOf(SharedArrayBuffer);
  packed.coordinates[30] = 23;
  expect(path.get(30)).toBe(numbers[30]);
  expect(edited.get(30)).toBe(-0);
  expect(() => packLineStringsXY([null, path.push(1)])).toThrow(RangeError);
  expect(() => packLineStringsXY([new SharedList('string') as never])).toThrow(TypeError);
});

function laneTable(data: Data, extension = '{}', name = 'geoarrow.linestring') {
  const field = new Field('lanes', data.type, true, new Map([['ARROW:extension:name', name], ['ARROW:extension:metadata', extension]]));
  const ids = vectorFromArray(Array.from({ length: data.length }, (_, i) => i), new Float64()).data[0];
  const schema = new Schema([new Field('id', ids.type), field]);
  return new Table(new RecordBatch(schema, makeData({ type: new Struct(schema.fields), length: data.length, children: [ids, data] })));
}

it('imports an independent separated XY column across batches, slices and Arrow IPC', () => {
  const point = new Struct([new Field('x', new Float64()), new Field('y', new Float64())]);
  const list = new List(new Field('vertices', point));
  const metadata = { crs: 'EPSG:3857', crs_type: 'authority_code', producer: 'test' };
  const rows = Array.from({ length: 16 }, (_, i) => i % 4 === 0 ? null : i % 4 === 1 ? [] :
    [{ x: i, y: -i }, { x: -0, y: 0.5 }]);
  const makeTable = (part: typeof rows) => laneTable(vectorFromArray(part, list).data[0], JSON.stringify(metadata));
  const table = makeTable(rows.slice(0, 10)).concat(makeTable(rows.slice(10)));
  for (const source of [table, tableFromIPC(tableToIPC(table, 'stream')), tableFromIPC(tableToIPC(table, 'file'))]) {
    const { batches, metadata: imported } = fromGeoArrowTable(source.slice(6, 14), { column: 'lanes' });
    expect(imported).toEqual(metadata);
    expect(batches.map(b => b.offsets.length - 1)).toEqual([4, 4]);
    for (const batch of batches) {
      expect(JSON.parse(toGeoArrowTable(batch, imported).schema.fields[0].metadata.get('ARROW:extension:metadata')!)).toEqual(metadata);
      for (const view of [batch.coordinates, batch.offsets, batch.validity!]) expect(view.buffer).toBeInstanceOf(SharedArrayBuffer);
    }
    const actual = batches.flatMap(batch => Array.from({ length: batch.offsets.length - 1 }, (_, i) => {
      const path = lineStringViewXY(batch, i);
      return path && [...path];
    }));
    expect(actual).toEqual(rows.slice(6, 14).map(row => row && row.flatMap(({ x, y }) => [x, y])));
  }
});

it('borrows only the selected shared XY range or copies it for an independent lifetime', () => {
  const path = new SharedList('number').pushMany([1, -0, 2, 3]);
  const original = packLineStringsXY([path, path, null, new SharedList('number'), path]);
  const table = toGeoArrowTable(original).slice(1, 4);
  const batch = fromGeoArrowTable(table).batches[0]!;
  const owned = fromGeoArrowTable(table, { copy: true }).batches[0]!;
  expect(batch.coordinates.buffer).toBe(original.coordinates.buffer);
  expect(batch.coordinates.byteOffset).toBe(original.coordinates.byteOffset + 32);
  expect([...batch.offsets]).toEqual([0, 2, 2, 2]);
  expect([...batch.validity!]).toEqual([5]);
  expect(owned.coordinates.buffer).not.toBe(original.coordinates.buffer);
  const view = lineStringViewXY(batch, 0)!;
  expect(view.buffer).toBe(batch.coordinates.buffer);
  expect([...view]).toEqual([1, -0, 2, 3]);
  expect(lineStringViewXY(batch, 1)).toBeNull();
  expect(lineStringViewXY(batch, 2)?.length).toBe(0);
  for (const row of [-1, 3, NaN, 0.5]) expect(() => lineStringViewXY(batch, row)).toThrow(RangeError);
  const editable = new SharedList('number').pushMany(view).set(0, 45);
  expect(editable.get(0)).toBe(45);
  expect(view[0]).toBe(1);
});

it('normalizes LargeList offsets and excludes hidden coordinates of null rows', () => {
  const source = toGeoArrowTable({ offsets: Int32Array.of(0, 4),
    coordinates: Float64Array.of(1, 2, -999, -888, 3, 4, 5, 6), validity: null }).getChild('geometry')!.data[0];
  const type = new LargeList(source.type.valueField);
  const data = makeData({ type, length: 4, child: source.children[0], nullBitmap: Uint8Array.of(13),
    valueOffsets: BigInt64Array.of(0n, 1n, 2n, 2n, 4n) });
  const batch = fromGeoArrowTable(laneTable(data), { column: 'lanes' }).batches[0]!;
  expect([...batch.offsets]).toEqual([0, 1, 1, 1, 3]);
  expect([...batch.coordinates]).toEqual([1, 2, 3, 4, 5, 6]);
  expect(lineStringViewXY(batch, 1)).toBeNull();
  expect([...lineStringViewXY(batch, 2)!]).toEqual([]);
  data.valueOffsets[4] = 9007199254740993n;
  expect(() => fromGeoArrowTable(laneTable(data), { column: 'lanes' })).toThrow(RangeError);
});

it('keeps sliced child coordinates aligned through every row slice of a shared tile', () => {
  const backing = new Float64Array(new SharedArrayBuffer(32 * 16));
  for (let i = 0; i < backing.length; i++) backing[i] = i + 0.5;
  const column = toGeoArrowTable({ offsets: Int32Array.of(0, 24), coordinates: backing.subarray(4, 52),
    validity: null }).getChild('geometry')!.data[0];
  const child = column.children[0].slice(3, 18);
  const source = makeData({ type: column.type, child, length: 11, nullBitmap: Uint8Array.of(0b11011011, 0b101),
    valueOffsets: Int32Array.of(1, 2, 3, 3, 4, 5, 5, 7, 9, 10, 10, 12) });
  const table = laneTable(source);
  for (let start = 0; start < 11; start++) {
    for (let end = start + 1; end <= 11; end++) {
      const batch = fromGeoArrowTable(table.slice(start, end), { column: 'lanes' }).batches[0]!;
      expect(batch.coordinates.buffer).toBe(backing.buffer);
      for (let i = start; i < end; i++) {
        const begin = 10 + source.valueOffsets[i] * 2, stop = 10 + source.valueOffsets[i + 1] * 2;
        const expected = source.getValid(i) ? backing.subarray(begin, stop) : null;
        expect(lineStringViewXY(batch, i - start)).toEqual(expected);
      }
    }
  }
});

it('checks the column type and edge interpretation even on empty tables, and rejects nested nulls', () => {
  const list = new List(new Field('vertices', new Struct([new Field('x', new Float64()), new Field('y', new Float64())])));
  const data = vectorFromArray([[{ x: 1, y: null }], [{ x: 1, y: 2 }]], list).data[0];
  const options = { column: 'lanes' };
  const table = laneTable(data);
  expect(fromGeoArrowTable(new Table(table.schema), options).batches).toEqual([]);
  expect(() => fromGeoArrowTable(table)).toThrow(/column/);
  expect(() => fromGeoArrowTable(table, options)).toThrow(/valid/);
  expect([...fromGeoArrowTable(table.slice(1), options).batches[0]!.coordinates]).toEqual([1, 2]);
  for (const invalid of [laneTable(data, '{"edges":"spherical"}'), laneTable(data, 'null'),
    laneTable(data, '{}', 'geoarrow.polygon'), laneTable(vectorFromArray([], new Float32()).data[0])]) {
    expect(() => fromGeoArrowTable(new Table(invalid.schema), options)).toThrow(TypeError);
  }
});

it('round-trips null, empty and multi-vertex lines with field metadata and shared buffers', () => {
  const path = new SharedList('number').pushMany([1, -0, 3, 4]);
  const paths = [path, null, new SharedList('number'), null, path, path, null, path, null, path];
  const packed = packLineStringsXY(paths.values());
  expect([...packed.validity!]).toEqual([181, 2]);
  const crs = { type: 'GeographicCRS', name: 'test metadata' };
  const table = toGeoArrowTable(packed, { crs });
  const geometry = table.getChild('geometry')!;
  const data = geometry.data[0]!;
  expect(data.valueOffsets.buffer).toBe(packed.offsets.buffer);
  expect(data.children[0]!.children[0]!.values.buffer).toBe(packed.coordinates.buffer);
  expect(data.nullBitmap.buffer).toBe(packed.validity!.buffer);
  const expected = paths.map(p => p?.size ? [[1, -0], [3, 4]] : p === null ? null : []);
  for (const result of [table, tableFromIPC(tableToIPC(table, 'file')), tableFromIPC(tableToIPC(table, 'stream'))]) {
    const field = result.schema.fields[0]!;
    expect(field.metadata.get('ARROW:extension:name')).toBe('geoarrow.linestring');
    expect(JSON.parse(field.metadata.get('ARROW:extension:metadata')!)).toEqual({ crs });
    const vertex = field.type.children[0]!, xy = vertex.type.children[0]!;
    expect([vertex.name, vertex.nullable, xy.name, xy.nullable]).toEqual(['vertices', false, 'xy', false]);
    const rows = result.getChild('geometry')! as typeof geometry;
    expect(Array.from(rows, line => line === null ? null : Array.from(line, point => [...point]))).toEqual(expected);
  }
});

it('accepts empty columns and buffer subviews and rejects malformed layouts', () => {
  for (const paths of [[], [null, null], [new SharedList('number')]]) {
    const batch = packLineStringsXY(paths);
    const table = toGeoArrowTable(batch);
    expect(table.numRows).toBe(paths.length);
    expect(table.getChild('geometry')!.nullCount).toBe(paths.filter(p => p === null).length);
    expect(table.schema.fields[0]!.metadata.get('ARROW:extension:metadata')).toBe('{}');
  }
  const offsets = Int32Array.of(99, 0, 2, 99).subarray(1, 3);
  const coordinates = Float64Array.of(99, 1, 2, 3, 4, 99).subarray(1, 5);
  const validity = Uint8Array.of(0, 1).subarray(1);
  const batch = { offsets, coordinates, validity };
  const data = toGeoArrowTable(batch).getChild('geometry')!.data[0]!;
  for (const [view, original] of [[data.valueOffsets, offsets], [data.children[0]!.children[0]!.values, coordinates],
    [data.nullBitmap, validity]] as const) {
    expect(view.buffer).toBe(original.buffer);
    expect(view.byteOffset).toBe(original.byteOffset);
  }
  for (const bad of [[], [1, 2], [0, 1], [0, 3, 2], [0, -1, 2]]) {
    expect(() => toGeoArrowTable({ ...batch, offsets: Int32Array.from(bad) })).toThrow(RangeError);
  }
  expect(() => toGeoArrowTable({ ...batch, validity: new Uint8Array() })).toThrow(RangeError);
  expect(() => toGeoArrowTable({ ...batch, coordinates: new Float32Array(4) as never })).toThrow(TypeError);
});
