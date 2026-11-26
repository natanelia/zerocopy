import { tableFromIPC, tableToIPC } from 'apache-arrow';
import { expect, it } from 'vitest';
import { packLineStringsXY, toGeoArrowTable } from './geoarrow';
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
