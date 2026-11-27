import assert from 'node:assert/strict';
import { once } from 'node:events';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { RecordBatchReader, tableFromIPC, tableToIPC } from 'apache-arrow';
import { algorithm } from '@geoarrow/geoarrow-js';
import { SharedList } from 'zerocopy';
import { fromGeoArrowRecordBatch, packLineStringsXY, toGeoArrowTable } from 'zerocopy/geoarrow';
import { bboxXY, pathIntersectsBoxXY } from 'zerocopy/geometry';
import { buildLineStringIndex, buildLineStringLookup, getLineStringById, querySpatialIndex } from 'zerocopy/spatial';

if (isMainThread) {
  const path = new SharedList('number').pushMany([0, 1, 2, 3]);
  const original = packLineStringsXY([path, null, new SharedList('number')]);
  const edited = packLineStringsXY([path.set(2, 7), null, new SharedList('number')]);
  const ipc = tableToIPC(toGeoArrowTable(edited), 'stream');
  async function* chunks() {
    for (let start = 0; start < ipc.length; start += 37) yield ipc.subarray(start, start + 37);
  }
  const reader = await RecordBatchReader.from(chunks());
  const first = await reader.next();
  assert.equal(first.done, false);
  const { paths: imported } = fromGeoArrowRecordBatch(first.value);
  assert.equal((await reader.next()).done, true);
  const batches = [{ paths: imported, ids: Uint32Array.of(17, 0xffffffff, 0) }];
  const index = buildLineStringIndex(batches, 2);
  const lookup = buildLineStringLookup(batches);
  const worker = new Worker(new URL(import.meta.url), { workerData: { exports: [original, edited], lookup, index } });
  let views;
  try {
    [views] = await once(worker, 'message');
  } finally { await worker.terminate(); }
  // After the only reader stops, verify that its Arrow views share the packed
  // revision while the retained source and older export keep their values.
  assert.deepEqual([...views.coordinates], [0, 1, 7, 3]);
  views.coordinates[2] = 99;
  views.offsets[1] = 0;
  views.validity[0] = 0;
  assert.equal(edited.coordinates[2], 99);
  assert.equal(edited.offsets[1], 0);
  assert.equal(edited.validity[0], 0);
  assert.equal(original.coordinates[2], 2);
  assert.equal(path.get(2), 2);
  assert.deepEqual([...views.importedLane], [0, 1, 7, 3]);
  views.importedLane[0] = 55;
  assert.equal(imported.coordinates[0], 55);
} else {
  const { lookup } = workerData;
  const importedLane = getLineStringById(lookup, 17);
  assert.deepEqual(querySpatialIndex(workerData.index, [0, 3, 0, 3]), [17]);
  assert.deepEqual(bboxXY(importedLane), [0, 1, 7, 3]);
  assert.equal(pathIntersectsBoxXY(importedLane, [0, 3, 0, 3]), false);
  assert.equal(pathIntersectsBoxXY(importedLane, [3.5, 2, 3.5, 2]), true);
  assert.equal(getLineStringById(lookup, 0xffffffff), null);
  assert.deepEqual([...getLineStringById(lookup, 0)], []);
  assert.equal(getLineStringById(lookup, 41), undefined);
  assert.equal(new SharedList('number').pushMany(importedLane).set(2, 8).get(2), 8);
  for (const [index, packed] of workerData.exports.entries()) {
    const table = toGeoArrowTable(packed);
    const decoded = tableFromIPC(tableToIPC(table, 'stream'));
    for (const input of [table, decoded]) {
      const { minX, minY, maxX, maxY } = algorithm.totalBounds(input.getChild('geometry'), input.schema.fields[0]);
      assert.deepEqual([minX, minY, maxX, maxY], [0, 1, index === 0 ? 2 : 7, 3]);
    }
    assert.deepEqual(Array.from(decoded.getChild('geometry'), line => line && Array.from(line, xy => [...xy])),
      [[[0, 1], [index === 0 ? 2 : 7, 3]], null, []]);
    if (index === 1) {
      const data = table.getChild('geometry').data[0];
      parentPort.postMessage({ importedLane, coordinates: data.children[0].children[0].values,
        offsets: data.valueOffsets, validity: data.nullBitmap });
    }
  }
}
