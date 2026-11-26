import { expect, it } from 'vitest';
import { SharedList } from '../dist/shared.js';
import { packLineStringsXY } from '../dist/geometry.js';

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
