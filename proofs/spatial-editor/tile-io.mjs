import { Field, FixedSizeList, Float64, List, RecordBatch, RecordBatchReader, Schema, Struct, Table, Uint32,
  makeData, tableFromIPC, tableToIPC } from 'apache-arrow';
import { fromGeoArrowRecordBatch } from '../../dist/geoarrow.js';
import { lane } from './workload.mjs';
const rowsPerBatch = 64;

// Built on the server, before launching any of the timed browsers.
export function encodeTile(count, vertices, layout = 'ordered') {
  const double = new Float64(), uint32 = new Uint32();
  const point = new FixedSizeList(2, new Field('xy', double, false));
  const lines = new List(new Field('vertices', point, false));
  const schema = new Schema([new Field('id', uint32, false), new Field('geometry', lines, false,
    new Map([['ARROW:extension:name', 'geoarrow.linestring']]))]);
  const batches = [];
  for (let start = 0; start < count;) {
    const length = Math.min(layout === 'sparse' && start === 0 ? 3 : rowsPerBatch, count - start);
    const xy = new Float64Array(length * vertices * 2);
    const ids = Uint32Array.from({ length }, (_, i) => {
      if (layout === 'ordered') return start + i;
      const slot = count - 1 - (start + i);
      // Keep the scripted edits and pick locations. Spread the other handles across the uint32 range.
      if (slot < 9) return slot;
      return slot === count - 1 ? 0xffffffff : 2 * slot;
    });
    const offsets = Int32Array.from({ length: length + 1 }, (_, i) => i * vertices);
    for (const [row, id] of ids.entries()) xy.set(lane(id, vertices), row * vertices * 2);
    const points = makeData({ type: point, length: xy.length / 2, child: makeData({ type: double, data: xy }) });
    const paths = makeData({ type: lines, length, child: points, valueOffsets: offsets });
    batches.push(new RecordBatch(schema, makeData({ type: new Struct(schema.fields), length,
      children: [makeData({ type: uint32, data: ids }), paths] })));
    start += length;
  }
  return tableToIPC(new Table(schema, batches), 'stream');
}

export async function loadTile(packed, count, ipc = 'stream') {
  const started = performance.now();
  const response = await fetch('/tile.arrow');
  if (!response.ok) throw new Error('Failed to fetch GeoArrow tile: ' + response.status);
  if (!response.body) throw new Error('Missing GeoArrow response body');
  const reader = ipc === 'stream' ? await RecordBatchReader.from(response.body) : undefined;
  const records = reader ?? tableFromIPC(await response.arrayBuffer()).batches;
  const batches = [];
  let rows = 0, firstBatchMs;
  try {
    for await (const batch of records) {
      rows += batch.numRows;
      if (rows > count) throw new Error('Wrong tile row count');
      const handles = batch.getChild('id');
      const ids = handles?.toArray();
      if (!(ids instanceof Uint32Array) || handles.nullCount || ids.length !== batch.numRows) {
        throw new Error('Expected a non-null uint32 handle per lane');
      }
      if (packed) {
        // The retained handles should not keep this IPC chunk's coordinate bytes alive.
        batches.push({ ids: ids.slice(), paths: fromGeoArrowRecordBatch(batch).paths });
      } else {
        // The two controls can read this known, interleaved fixture directly from ordinary Arrow memory.
        const data = batch.getChild('geometry').data[0];
        const offsets = data.valueOffsets.subarray(0, batch.numRows + 1);
        const coordinates = data.children[0].children[0].values.subarray(0, 2 * offsets[batch.numRows]);
        if (!(coordinates.buffer instanceof ArrayBuffer)) throw new Error('Copy control needs ordinary Arrow buffers');
        batches.push({ ids, paths: { offsets, coordinates, validity: null } });
      }
      firstBatchMs ??= performance.now() - started;
    }
  } finally {
    await reader?.cancel();
  }
  if (rows !== count) throw new Error('Wrong tile row count');
  return { batches, timing: { firstBatchMs, importMs: performance.now() - started, batchCount: batches.length } };
}
