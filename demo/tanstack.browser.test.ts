import { createCollection, createTransaction } from '@tanstack/db';
import { expect, it } from 'vitest';
import { SharedList, getWorkerData } from '../dist/shared.js';
import { applySpatialEdits, buildSpatialIndex, prepareSpatialQuery } from '../dist/spatial.js';
import { sharedCollectionConfig } from '../dist/tanstack-db-collection.js';

it('attaches confirmed rows and geometry from the same edit in a browser worker', async () => {
  const options = sharedCollectionConfig({ id: 'lanes', initialData: [{ id: 'lane', revision: 0 }] });
  const lanes = createCollection(options);
  const reader = new Worker(new URL('./tanstack-worker.ts', import.meta.url), { type: 'module' });
  const initial = new SharedList('number').pushMany([0, 0, 2, 3]);
  const base = buildSpatialIndex([{ id: 7, bounds: [0, 0, 2, 3] }]);
  const initialChanges = applySpatialEdits(undefined, 0, []);
  const read = (geometry, changes = initialChanges) => new Promise((resolve, reject) => {
    reader.onerror = reject;
    reader.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
    const rows = options.getSnapshot();
    const prepared = prepareSpatialQuery(base, changes, rows.get('lane')!.revision);
    reader.postMessage({ base, prepared, roots: getWorkerData({ rows, geometry, changes }, { copy: false }) });
  });
  try {
    await lanes.preload();
    const before = { row: { id: 'lane', revision: 0 }, bounds: [0, 0, 2, 3], candidates: [], rebuiltCandidates: [],
      preparedCandidates: [], narrowCandidates: [7], intersectsNarrow: false };
    expect(await read(initial)).toEqual({ first: before, current: before });

    const geometry = initial.set(0, -12);
    const edits = applySpatialEdits(initialChanges, 1, [{ id: 7, bounds: [-12, 0, 2, 3] }]);
    const tx = createTransaction({ autoCommit: false,
      mutationFn: ({ transaction }) => options.utils.acceptMutations(transaction) });
    tx.mutate(() => lanes.update('lane', lane => { lane.revision = 1; }));
    expect(lanes.get('lane')?.revision).toBe(1);
    expect(await read(initial)).toEqual({ first: before, current: before });
    await tx.commit();
    const after = { row: { id: 'lane', revision: 1 }, bounds: [-12, 0, 2, 3], candidates: [7], rebuiltCandidates: [7],
      preparedCandidates: [7], narrowCandidates: [7], intersectsNarrow: true };
    expect(await read(geometry, edits)).toEqual({ first: before, current: after });
  } finally {
    reader.terminate();
    await lanes.cleanup();
  }
});
