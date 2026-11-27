import { createCollection, createTransaction } from '@tanstack/db';
import { expect, it } from 'vitest';
import { SharedList, getWorkerData } from '../dist/shared.js';
import { applySpatialEdits, buildSpatialIndex, prepareSpatialQuery } from '../dist/spatial.js';
import type { SpatialViewportDelta } from '../spatial.ts';
import { sharedCollectionConfig, spatialJoinCollectionConfig, viewportCollectionConfig } from '../dist/tanstack-db-collection.js';

it('attaches confirmed rows and geometry from the same edit in a browser worker', async () => {
  const firstRow = { id: 'lane', revision: 0, style: { color: 'black', width: 2 } };
  const options = sharedCollectionConfig({ id: 'lanes', initialData: [firstRow] });
  const lanes = createCollection(options);
  const overlaps = createCollection(spatialJoinCollectionConfig({ id: 'lane-road-overlaps' }));
  const visible = createCollection(viewportCollectionConfig({ id: 'narrow-lanes' }));
  const reader = new Worker(new URL('./tanstack-worker.ts', import.meta.url), { type: 'module' });
  const initial = new SharedList('number').pushMany([0, 0, 2, 3]);
  const base = buildSpatialIndex([{ id: 7, bounds: [0, 0, 2, 3] }]);
  const roadIndex = buildSpatialIndex([{ id: 23, bounds: [0, 2.5, 0, 2.75] }]);
  const initialChanges = applySpatialEdits(undefined, 0, []);
  type WorkerRead = { narrowPairs: [number, number][] };
  type Delta = { added: [number, number][]; removed: [number, number][] };
  const read = (geometry, changes = initialChanges) => new Promise<{ first: WorkerRead; current: WorkerRead; delta: Delta; viewportDelta: SpatialViewportDelta }>((resolve, reject) => {
    reader.onerror = reject;
    reader.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
    const rows = options.getSnapshot();
    const prepared = prepareSpatialQuery(base, changes, rows.get('lane')!.revision);
    reader.postMessage({ base, prepared, roadIndex, roots: getWorkerData({ rows, geometry, changes }, { copy: false }) });
  });
  try {
    await lanes.preload();
    const before = { row: firstRow, bounds: [0, 0, 2, 3], candidates: [], rebuiltCandidates: [],
      preparedCandidates: [], narrowCandidates: [7], intersectsNarrow: false, narrowPairs: [] };
    const empty = { added: [], removed: [] };
    const seed = await read(initial);
    expect(seed).toEqual({ first: before, current: before, delta: empty, viewportDelta: empty });
    await overlaps.utils.setPairs(seed.current.narrowPairs);
    await visible.utils.setVisibleIds([]);
    const version = overlaps.utils.getVersion();
    const visibleVersion = visible.utils.getVersion();

    const geometry = initial.set(0, -12);
    const edits = applySpatialEdits(initialChanges, 1, [{ id: 7, bounds: [-12, 0, 2, 3] }]);
    const color = createTransaction({ autoCommit: false, mutationFn: async () => {} });
    color.mutate(() => lanes.update('lane', lane => { lane.style.color = 'red'; }));
    const tx = createTransaction({ autoCommit: false,
      mutationFn: ({ transaction }) => options.utils.acceptMutations(transaction) });
    tx.mutate(() => lanes.update('lane', lane => { lane.revision = 1; lane.style.width = 6; }));
    expect(lanes.get('lane')?.revision).toBe(1);
    expect(await read(initial)).toEqual({ first: before, current: before, delta: empty, viewportDelta: empty });
    await tx.commit();
    const after = { row: { id: 'lane', revision: 1, style: { color: 'black', width: 6 } }, bounds: [-12, 0, 2, 3], candidates: [7], rebuiltCandidates: [7],
      preparedCandidates: [7], narrowCandidates: [7], intersectsNarrow: true, narrowPairs: [[7, 23]] };
    const reply = read(geometry, edits);
    const published = overlaps.utils.applyPairChanges(reply.then(({ delta }) => delta), version);
    const visibleUpdate = visible.utils.applyVisibleChanges(reply.then(({ viewportDelta }) => viewportDelta), visibleVersion);
    expect(await reply).toEqual({ first: before, current: after, delta: { added: [[7, 23]], removed: [] },
      viewportDelta: { added: [7], removed: [] } });
    color.rollback();
    expect(lanes.get('lane')?.style).toEqual(after.row.style);
    expect(await published).toBe(true);
    expect(await visibleUpdate).toBe(true);
    expect([...visible.keys()]).toEqual([7]);
    expect(overlaps.get('7:23')).toMatchObject({ leftId: 7, rightId: 23 });
  } finally {
    reader.terminate();
    await visible.cleanup();
    await overlaps.cleanup();
    await lanes.cleanup();
  }
});
