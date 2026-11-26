import assert from 'node:assert/strict';
import { once } from 'node:events';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { tableFromIPC, tableToIPC } from 'apache-arrow';
import { algorithm } from '@geoarrow/geoarrow-js';
import { SharedList } from 'zerocopy';
import { packLineStringsXY, toGeoArrowTable } from 'zerocopy/geoarrow';

if (isMainThread) {
  const path = new SharedList('number').pushMany([0, 1, 2, 3]);
  const original = packLineStringsXY([path, null, new SharedList('number')]);
  const edited = packLineStringsXY([path.set(2, 7), null, new SharedList('number')]);
  const worker = new Worker(new URL(import.meta.url), { workerData: [original, edited] });
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
} else {
  for (const [index, packed] of workerData.entries()) {
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
      parentPort.postMessage({ coordinates: data.children[0].children[0].values, offsets: data.valueOffsets, validity: data.nullBitmap });
    }
  }
}
