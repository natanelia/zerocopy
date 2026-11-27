import { createCollection, createTransaction, type SyncConfig } from '@tanstack/db';
import { sharedCollectionConfig, spatialJoinCollectionConfig, viewportCollectionConfig, withConfirmedSharedCache } from 'zerocopy/tanstack';
import { getWorkerData, initWorker } from 'zerocopy';
import { createSharedSession } from 'zerocopy/worker';
import { applySpatialEdits, buildSpatialIndex, diffSpatialJoin, diffSpatialViewport, prepareSpatialQuery, pruneSpatialEdits, querySpatialIndex, querySpatialJoin, rebuildSpatialIndex } from 'zerocopy/spatial';

interface Lane { id: string; revision: number }
declare const upstream: SyncConfig<Lane, string>;
const remote = withConfirmedSharedCache(upstream);
const remoteRevision: number | undefined = remote.getSnapshot().get('remote')?.revision;
const remoteLanes = createCollection({ id: 'remote', getKey: (row: Lane) => row.id, sync: remote.sync });
const remoteSession = createSharedSession({ source: remote }, { copy: false });
// @ts-expect-error A remote worker reads immutable lane metadata.
remoteSession.current.get('remote')!.revision = 1;
void remoteLanes; void remoteRevision;
const options = sharedCollectionConfig<Lane>({ id: 'lanes' });
const lanes = createCollection(options);
const tx = createTransaction<Lane>({
  mutationFn: ({ transaction }) => options.utils.acceptMutations(transaction),
});
tx.mutate(() => lanes.insert({ id: 'north', revision: 1 }));
await tx.when('settled');
const rows = options.getSnapshot();
const confirmed = createSharedSession({ source: options }, { copy: false });
const sessionRows: typeof rows = confirmed.current;
const unsubscribe = options.subscribe(() => { const snapshot: typeof sessionRows = options.getSnapshot(); });
unsubscribe(); confirmed.dispose();
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
const crossings = diffSpatialViewport([0, 0, 2, 3], [{ id: 17, before: [0, 0, 2, 3], after: null }]);
await visible.utils.applyVisibleChanges(Promise.resolve(crossings), visible.utils.getVersion());
// @ts-expect-error A viewport delta needs the version used to compute it.
visible.utils.applyVisibleChanges(crossings);
const featureId: number | undefined = visible.get(17)?.id;
void published; void featureId;
// @ts-expect-error The default viewport collection accepts numeric feature handles.
visible.utils.setVisibleIds(['lane']);
const rebuilt: typeof base = rebuildSpatialIndex(base, roots.edits, 1);
const prepared = prepareSpatialQuery(base, roots.edits, 1);
const overlaps = createCollection(spatialJoinCollectionConfig({ id: 'overlaps' }));
await overlaps.utils.setPairs(Promise.resolve(querySpatialJoin(base, base)));
const delta = diffSpatialJoin({ left: base, right: base }, { left: prepared, right: base }, {
  left: [{ id: 17, before: [0, 0, 2, 3], after: null }],
});
const applied: boolean = await overlaps.utils.applyPairChanges(Promise.resolve(delta), overlaps.utils.getVersion());
void applied;
// @ts-expect-error An incremental result requires the version of its published base.
overlaps.utils.applyPairChanges(delta);
const rightId: number | undefined = overlaps.get('17:17')?.rightId;
// @ts-expect-error A spatial pair requires two numeric handles.
overlaps.utils.setPairs([[17, 'road']]);
void rightId;
querySpatialIndex(structuredClone(prepared), [0, 0, 2, 3]);
// @ts-expect-error Prepared snapshots already capture the edit revision.
querySpatialIndex(prepared, [0, 0, 2, 3], edits);
void rebuilt;
pruneSpatialEdits(edits, 1);
const latest = applySpatialEdits(edits, 2, [{ id: 17, bounds: [1, 1, 3, 4] }]);
querySpatialIndex(rebuilt, [0, 0, 2, 3], pruneSpatialEdits(latest, rebuilt.revision, edits));
void candidates;
// @ts-expect-error Spatial feature handles are unsigned integers.
buildSpatialIndex([{ id: 'lane', bounds: [0, 0, 2, 3] }]);
// @ts-expect-error An XY box needs all four coordinates.
querySpatialIndex(base, [0, 2]);
