import { createCollection, createTransaction } from '@tanstack/db';
import { sharedCollectionConfig } from 'zerocopy/tanstack';
import { getWorkerData, initWorker } from 'zerocopy';
import { applySpatialEdits, buildSpatialIndex, pruneSpatialEdits, querySpatialIndex, rebuildSpatialIndex } from 'zerocopy/spatial';

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
const rebuilt: typeof base = rebuildSpatialIndex(base, roots.edits, 1);
void rebuilt;
pruneSpatialEdits(edits, 1);
void candidates;
// @ts-expect-error Spatial feature handles are unsigned integers.
buildSpatialIndex([{ id: 'lane', bounds: [0, 0, 2, 3] }]);
// @ts-expect-error An XY box needs all four coordinates.
querySpatialIndex(base, [0, 2]);
