import { expect, it } from 'vitest';
import { tableFromIPC, tableToIPC } from 'apache-arrow';
import { SharedList } from '../dist/shared.js';
import { packLineStringsXY } from '../dist/geometry.js';
import { fromGeoArrowTable, toGeoArrowTable } from '../dist/geoarrow.js';
import { buildLineStringIndex } from '../dist/spatial.js';

it('passes shared XY paths into an Apache Arrow table in a dedicated worker', async () => {
  const path = new SharedList('number').pushMany([1, -0, 2, 3]);
  const batch = packLineStringsXY([null, path, new SharedList('number')]);
  const worker = new Worker(new URL('./geoarrow-worker.ts', import.meta.url), { type: 'module' });
  try {
    const data = await new Promise<{ extension: string; rows: unknown[]; coordinates: Float64Array }>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage(batch);
    });
    expect(data.extension).toBe('geoarrow.linestring');
    expect(data.rows).toEqual([null, [[1, -0], [2, 3]], []]);
    expect(data.coordinates.buffer).toBeInstanceOf(SharedArrayBuffer);
    data.coordinates[2] = 8;
    expect(batch.coordinates[2]).toBe(8);
    expect(path.get(2)).toBe(2);
  } finally { worker.terminate(); }
});

it('shares IPC-imported paths with a worker and materializes one edited lane', async () => {
  const lane = new SharedList('number').pushMany([1, 2, 3, 4]);
  const other = new SharedList('number').pushMany([1, 2, 1, 4, 3, 4]);
  const tile = toGeoArrowTable(packLineStringsXY([lane, null, other, lane]));
  const imported = fromGeoArrowTable(tableFromIPC(tableToIPC(tile)).slice(1, 4));
  const batch = imported.batches[0]!;
  const ids = Uint32Array.of(500, 42, 99);
  const index = buildLineStringIndex([{ paths: batch, ids }]);
  const worker = new Worker(new URL('./geoarrow-worker.ts', import.meta.url), { type: 'module' });
  try {
    const data = await new Promise<{ original: Float64Array; edited: Float64Array; visible: number[] }>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ batch, row: 2, ids, index, box: [2, 3, 2, 3] });
    });
    expect([...data.edited]).toEqual([1, 2, 9, 4]);
    expect([...data.original]).toEqual([1, 2, 3, 4]);
    expect(data.original.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(data.visible).toEqual([99]);
    // The reader has finished. A write to its returned row proves sharing across realms.
    data.original[0] = 77;
    expect([...batch.coordinates]).toEqual([1, 2, 1, 4, 3, 4, 77, 2, 3, 4]);
  } finally { worker.terminate(); }
});
