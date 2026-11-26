import { createCollection, createTransaction } from '@tanstack/db';
import { sharedCollectionConfig, spatialJoinCollectionConfig, viewportCollectionConfig } from 'zerocopy/tanstack';
import { getWorkerData, initWorker } from 'zerocopy';
import { applySpatialEdits, buildSpatialIndex, prepareSpatialQuery, pruneSpatialEdits, querySpatialIndex, querySpatialJoin, rebuildSpatialIndex } from 'zerocopy/spatial';

interface Lane { id: string; revision: number }
const options = sharedCollectionConfig<Lane>({ id: 'lanes' });
const lanes = createCollection(options);
const tx = createTransaction<Lane>({
  mutationFn: ({ transaction }) => options.utils.acceptMutations(transaction),
});
tx.mutate(() => lanes.insert({ id: 'north', revision: 1 }));
await tx.when('settled');
const rows = options.getSnapshot();
const worker = await initWorker<{ rows: typeof rows }>(getWorkerData({ rows }));
const row = worker.rows.get('north');
const revision: number | undefined = row?.revision;
void revision;
if (row) {
  // @ts-expect-error A decoded snapshot row is immutable.
  row.revision = 2;
}

const base = buildSpatialIndex([{ id: 17, bounds: [0, 0, 2, 3] }]);
const edits = applySpatialEdits(undefined, 1, [{ id: 17, bounds: null }]);
const roots = await initWorker<{ edits: typeof edits }>(getWorkerData({ edits }));
const candidates: number[] = querySpatialIndex(structuredClone(base), [0, 0, 2, 3], roots.edits);
const visible = createCollection(viewportCollectionConfig({ id: 'visible' }));
const published: boolean = await visible.utils.setVisibleIds(Promise.resolve(candidates));
const featureId: number | undefined = visible.get(17)?.id;
void published; void featureId;
// @ts-expect-error The default viewport collection accepts numeric feature handles.
visible.utils.setVisibleIds(['lane']);
const rebuilt: typeof base = rebuildSpatialIndex(base, roots.edits, 1);
const prepared = prepareSpatialQuery(base, roots.edits, 1);
const overlaps = createCollection(spatialJoinCollectionConfig({ id: 'overlaps' }));
await overlaps.utils.setPairs(Promise.resolve(querySpatialJoin(prepared, base)));
const rightId: number | undefined = overlaps.get('17:17')?.rightId;
// @ts-expect-error A spatial pair requires two numeric handles.
overlaps.utils.setPairs([[17, 'road']]);
void rightId;
querySpatialIndex(structuredClone(prepared), [0, 0, 2, 3]);
// @ts-expect-error Prepared snapshots already capture the edit revision.
querySpatialIndex(prepared, [0, 0, 2, 3], edits);
void rebuilt;
pruneSpatialEdits(edits, 1);
void candidates;
// @ts-expect-error Spatial feature handles are unsigned integers.
buildSpatialIndex([{ id: 'lane', bounds: [0, 0, 2, 3] }]);
// @ts-expect-error An XY box needs all four coordinates.
querySpatialIndex(base, [0, 2]);
