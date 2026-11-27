# TanStack adapters

[Documentation](README.md) · [API](api.md) · [Worker sharing](worker-sharing.md)

`zerocopy/tanstack` connects shared storage and spatial query results to TanStack DB collections.

## SharedCollection

Items need a string `id` and JSON-compatible fields. Updates return a new wrapper; keep that return value.

<!-- example: shared-collection -->
```ts
import { SharedCollection } from 'zerocopy/tanstack';

type User = { id: string; name: string };

const before = new SharedCollection<User>('users')
  .insert({ id: '1', name: 'Alice' });
const after = before.update('1', { name: 'Alicia' });

before.get('1')?.name; // 'Alice'
after.get('1')?.name;  // 'Alicia'
```

The wrapper provides `get(key)`, `insert(item)`, `update(key, changes)`, `delete(key)`, `entries()`, `toArray()`, `size`, and `id`. An update of a missing key returns the existing wrapper. Treat item IDs as stable keys; changing an item's `id` field does not re-key an existing entry.

## sharedCollectionConfig

```ts
import { sharedCollectionConfig } from 'zerocopy/tanstack';

const config = sharedCollectionConfig({
  id: 'todos',
  initialData: [{ id: '1', text: 'Read the worker guide', completed: false }],
});
```

Pass the options to TanStack DB's `createCollection(config)`. The collection
uses the configured string key for both TanStack and ZeroCopy. The default is
`id`. Automatic inserts, updates and deletes update the shared map on
confirmation. A new sync connection loads the current confirmed rows, including
deletions made since the initial import.

`config.getSnapshot()` returns the immutable core `SharedMap` of confirmed
rows. The initial snapshot is available after `await collection.preload()`.
During a pending edit TanStack can show an optimistic row while a worker
continues reading the previous snapshot. With TanStack DB 1.0.0-rc.1.5,
capture a new snapshot after `await transaction.when('settled')`. On 0.5.0
and 0.15.2, use `await transaction.isPersisted.promise`. Old handles stay
readable. The packed-package check edits nested metadata on both the minimum
supported peer (0.5.0) and the pinned release candidate. TanStack receives its
own mutable metadata rows while worker snapshots retain immutable values.

### Send confirmed rows to a worker automatically

Pass the collection options as the session's `source`. Each accepted batch
installs one row snapshot. Sessions connected to that source pick it up
automatically, including inserts and deletes made through the collection.

<!-- example: tanstack-confirmed-source -->
```ts
import { createCollection } from '@tanstack/db';
import { sharedCollectionConfig } from 'zerocopy/tanstack';
import { createSharedSession, type SharedEndpoint } from 'zerocopy/worker';

export async function shareLanes(worker: SharedEndpoint) {
  const options = sharedCollectionConfig({
    id: 'lanes', initialData: [{ id: 'north', revision: 0 }],
  });
  const lanes = createCollection(options);
  await lanes.preload();
  const session = createSharedSession({ source: options }, { copy: false });
  try {
    await session.connect(worker);
    return { lanes, session };
  } catch (error) {
    session.dispose();
    await lanes.cleanup();
    throw error;
  }
}
```

In the worker, call `connectSharedSession()`, retain the last processed map
and use `current.changesSince(previous)` to catch up. A shared session sends
the memory handle once per arena. Later publications in that arena can skip
shared branches even across messages. At teardown, dispose the session and
clean up the collection. [Worker sessions](worker-sessions.md) · [Compare snapshots](api.md#compare-map-snapshots)

For an existing store, `options.subscribe(listener)` returns an unsubscribe
function. Read the initial value with `options.getSnapshot()`. The listener
runs after a new snapshot is installed, including initial seeding and an
explicit `fromSharedState` restore. Pending or rejected writes leave the
confirmed snapshot untouched. A metadata subscription covers rows only. When
geometry and index roots must advance together, publish them in one session
record with the corresponding confirmed rows.

### Confirm a group of edits

For a manual TanStack transaction, call the adapter's acceptance helper once
inside the mutation function, after validation or persistence succeeds. The
helper processes the transaction's mutations for this collection in order.
For an update, the adapter compares TanStack's original and edited values and
applies the changed JSON fields to the latest confirmed row. For example, an
editor can preview a red lane while a second transaction confirms a wider line.
Workers see the wider line in its confirmed color. Rolling back the color edit
preserves the new width. When two edits change the same scalar, the last
confirmation wins.

An open optimistic edit can keep an older revision visible in TanStack's
draft. For an edit that increments a confirmed revision, read it from
`config.getSnapshot()` when assigning the next number and serialize those
assignments on the writer.

Each array is a single value. If a transaction edits an array using a version
that differs from the confirmed one, and its result also differs, the adapter
rejects the batch before publishing any rows. The same applies when a nested
edit needs an object that another edit removed or replaced with a scalar.
Serialize dependent edits to the same array or retry the edit against the
current row. For a manual transaction that edits the same row several times,
group those updates in one synchronous `mutate` call. If another transaction
edits the same nested field between those calls, TanStack can fold its pending
value into the combined mutation. The adapter then sees that value as part of
the edit being confirmed.

Await the helper as the final step in a successful mutation function. A
downstream write failure discards the pending sync batch on TanStack DB
1.0.0-rc.1.5.

```ts
import { createCollection, createTransaction } from '@tanstack/db';
import { sharedCollectionConfig } from 'zerocopy/tanstack';

type Lane = { id: string; geometryId: string; revision: number };
const options = sharedCollectionConfig<Lane>({
  id: 'lanes',
  initialData: [{ id: 'north', geometryId: 'path/1', revision: 0 }],
});
const lanes = createCollection(options);
await lanes.preload();
const before = options.getSnapshot();

const tx = createTransaction<Lane>({
  autoCommit: false,
  mutationFn: async ({ transaction }) => {
    // Run application validation or persistence here. Throw to reject.
    await options.utils.acceptMutations(transaction);
  },
});
tx.mutate(() => lanes.update('north', row => { row.revision++; }));
await tx.commit();
const after = options.getSnapshot();
before.get('north')?.revision; // 0
after.get('north')?.revision;  // 1
```

Stage changed geometry before confirming an edit. After success, publish the row
map and its matching geometry together, for example with one
`state.update(() => ({ rows: after, geometry: stagedGeometry }))`. A failed
edit discards the staged handles. Include the application revision and viewport
request ID in worker jobs so the UI can discard obsolete results. Configure
one adapter per collection and serialize application commands that replace the
same geometry. [State sessions](worker-sessions.md).

## Live viewport membership

Use `viewportCollectionConfig` to join spatial candidates to a TanStack
metadata collection. Each membership row holds one stable ID. Publishing a
new viewport sends inserts and deletes together in a sync batch. A pan that
returns the same IDs produces no writes. Metadata changes for a visible
feature still propagate through TanStack's live join.

```ts
import { BTreeIndex, createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { buildSpatialIndex, querySpatialIndex } from 'zerocopy/spatial';
import { sharedCollectionConfig, viewportCollectionConfig } from 'zerocopy/tanstack';

const lanes = createCollection(sharedCollectionConfig({
  id: 'lanes', initialData: [{ id: 'north', handle: 7, direction: 'northbound' }],
}));
lanes.createIndex(row => row.handle, { indexType: BTreeIndex });
const visible = createCollection(viewportCollectionConfig({ id: 'visible-handles' }));
const visibleLanes = createLiveQueryCollection(q => q.from({ hit: visible })
  .innerJoin({ lane: lanes }, ({ hit, lane }) => eq(hit.id, lane.handle))
  .select(({ lane }) => ({ id: lane.id, direction: lane.direction })));

const index = buildSpatialIndex([{ id: 7, bounds: [0, 0, 4, 4] }]);
await visibleLanes.preload();
await visible.utils.setVisibleIds(querySpatialIndex(index, [1, 1, 2, 2]));
// visibleLanes now contains the northbound lane.
```

For an asynchronous search, call `visible.utils.setVisibleIds(searchPromise)`
when dispatching each request. The most recently dispatched request supersedes
older searches that have yet to publish. The promise resolves to `true` when
applied, including identical results, or `false`
when superseded. A current search failure rejects and preserves the previous
membership. Pass a new request for each viewport or map revision. Writes
already in progress finish before the next batch.

Pass an empty array to clear the viewport. Duplicate IDs collapse to one row.
Numeric handles are the default. Use `viewportCollectionConfig<string>` for
string keys. Treat the membership collection as read-only and write feature
properties through the metadata collection. You can seed the IDs before creating
the collection. The options instance retains its last successful membership
across cleanup and reconnect.

### Publish viewport edits from a worker

After a pan, seed the membership with the full result. For edits under the
same viewport, send the worker's `diffSpatialViewport` result directly to
`applyVisibleChanges`. Capture the membership version when dispatching the
job and register the promise immediately.

```ts
const version = visible.utils.getVersion();
const roots = getWorkerData({ previousRows, currentRows }, { copy: false });
const delta = worker.computeViewportChanges(viewport, roots);
const applied = await visible.utils.applyVisibleChanges(delta, version);
```

Here `worker.computeViewportChanges` is the application's worker call. Its
promise resolves to `{ added, removed }` with the same ID type as the viewport
collection. Include every edit since the accepted membership used as the
job's starting point. The adapter writes just the listed IDs in one sync
batch. An accepted publication advances the version even when membership
stays the same. A superseded job or an obsolete version returns `false`.
Use the newer accepted result, or run a full search if the matching edit
history is unavailable. The version belongs to the membership collection.
Keep the corresponding map revision and viewport with the worker request.
[Compute viewport changes](spatial.md#update-a-fixed-viewport-after-an-edit)

In the worker, attach the two confirmed snapshots and compare them. This also
works when the worker skips revisions. A long-lived shared session can retain
the snapshot for the accepted viewport and compare it with the next one it
receives. In this example each row stores a stable numeric handle and its
bounding box.

```ts
const { previousRows, currentRows } = await initWorker(roots);
const edits = Array.from(currentRows.changesSince(previousRows), change => ({
  id: change.type === 'delete' ? change.before.handle : change.after.handle,
  before: change.before?.bounds ?? null,
  after: change.after?.bounds ?? null,
}));
return diffSpatialViewport(viewport, edits);
```

If exact geometry or other filter inputs live outside the row, update the row's
revision in the same edit. The change then reaches the filter even when its
bounding box stays the same. [Compare map snapshots](api.md#compare-map-snapshots)

## Live spatial joins

Use `spatialJoinCollectionConfig` when a validation depends on **which two
features overlap**. Each result row contains `leftId`, `rightId`, and a stable
string key such as `"7:23"`. TanStack can join either handle to an indexed
metadata field. This example reports a boundary and road with opposing
directions where their bounds overlap.

```ts
import { BTreeIndex, createCollection, createLiveQueryCollection, eq, not } from '@tanstack/db';
import { buildSpatialIndex, querySpatialJoin } from 'zerocopy/spatial';
import { sharedCollectionConfig, spatialJoinCollectionConfig } from 'zerocopy/tanstack';

const boundaries = createCollection(sharedCollectionConfig({
  id: 'boundaries', initialData: [{ id: 'lane-7', handle: 7, direction: 'north' }],
}));
const roads = createCollection(sharedCollectionConfig({
  id: 'roads', initialData: [{ id: 'road-23', handle: 23, direction: 'south' }],
}));
const pairs = createCollection(spatialJoinCollectionConfig({ id: 'boundary-road-pairs' }));
boundaries.createIndex(row => row.handle, { indexType: BTreeIndex });
roads.createIndex(row => row.handle, { indexType: BTreeIndex });
pairs.createIndex(row => row.leftId, { indexType: BTreeIndex });
pairs.createIndex(row => row.rightId, { indexType: BTreeIndex });

const invalid = createLiveQueryCollection(q => q.from({ p: pairs })
  .innerJoin({ b: boundaries }, ({ p, b }) => eq(p.leftId, b.handle))
  .innerJoin({ r: roads }, ({ p, r }) => eq(p.rightId, r.handle))
  .where(({ b, r }) => not(eq(b.direction, r.direction)))
  .select(({ p, b, r }) => ({ id: p.id, boundary: b.id, road: r.id })));
await invalid.preload();

const left = buildSpatialIndex([{ id: 7, bounds: [0, 0, 4, 0] }]);
const right = buildSpatialIndex([{ id: 23, bounds: [1, -1, 3, 1] }]);
await pairs.utils.setPairs(querySpatialJoin(left, right));
// invalid contains { id: '7:23', boundary: 'lane-7', road: 'road-23' }.
```

Use `setPairs` for the initial view or a new viewport. It accepts the full
array or a worker promise and emits only entering and leaving pairs. Edits to
either direction field update the live query through TanStack.

For a geometry edit with known before and after bounds, pass the result of
`diffSpatialJoin` to `applyPairChanges`. This reads and writes only the listed
pair keys. In the example above, moving boundary 7 away from road 23 removes
one validation row.

```ts
import { applySpatialEdits, diffSpatialJoin, prepareSpatialQuery } from 'zerocopy/spatial';

// Capture the version alongside the frame that produced the confirmed pair set.
const version = pairs.utils.getVersion();
const edit = { id: 7, before: [0, 0, 4, 0], after: [10, 0, 14, 0] } as const;
const edits = applySpatialEdits(undefined, 1, [{ id: edit.id, bounds: edit.after }]);
const nextLeft = prepareSpatialQuery(left, edits, 1);
const delta = diffSpatialJoin({ left, right }, { left: nextLeft, right }, { left: [edit] });
const applied = await pairs.utils.applyPairChanges(delta, version); // true
```

The version starts at zero and advances after each successful publication,
including an empty delta. Capture it **before dispatching a worker** and pass
the worker promise directly to `applyPairChanges(promise, version)`. A stale
or superseded result resolves to `false`. A failed current publication rejects
and preserves the confirmed version. If an edit still needs publishing,
compute a fresh delta from the confirmed frame or call `setPairs` with a full
query of the newest frame. [Incremental spatial join API](spatial.md#update-a-join-after-an-edit)

## Mirror committed upstream batches

Use `withConfirmedSharedCache` to feed a worker from an existing remote sync
provider. Supply its sync configuration and give the wrapped configuration
to TanStack. The mirror uses the collection's string keys and keeps one
immutable map of JSON rows. A previously retained map stays readable through
tile replacement, deletion and reconnection.

<!-- example: upstream-confirmed -->
```ts
import { createCollection, type SyncConfig } from '@tanstack/db';
import { withConfirmedSharedCache } from 'zerocopy/tanstack';
import { createSharedSession } from 'zerocopy/worker';

type Road = { id: string; revision: number };
export function openRoads(provider: SyncConfig<Road, string>) {
  const mirror = withConfirmedSharedCache(provider);
  const roads = createCollection({
    id: 'roads', getKey: (road: Road) => road.id, sync: mirror.sync,
  });
  const session = createSharedSession({ source: mirror }, { copy: false });
  return { roads, mirror, session };
}
```

After `await roads.preload()`, connect workers with `await session.connect(worker)`.
Each batch can contain multiple edits. Partial updates merge supplied fields,
full updates replace the row, and `truncate()` discards earlier writes in that
batch and replaces the previous tile. Providers on TanStack DB 1.0.0-rc.1.5
can also declare a replacement with `begin({ snapshot: true })`.

When `commit()` returns a promise, publication waits for its visibility
receipt. For example, an accepted remote batch can still be waiting for a
persisting optimistic edit. Successful batches publish in commit order, and
a rejected receipt leaves its rows out of the mirror. Cores that return
`void`, including 0.5.0, provide a synchronous commit boundary. Cleanup
retires callbacks and pending receipts from that sync run. On reconnect the
provider can apply deltas against the retained rows or send a replacement.
The mirror covers writes made through the wrapped sync configuration. Use
well-formed Unicode string keys and supply a separate mirror per collection.

## withSharedCache

`withSharedCache<T>(upstreamSync, options?)` wraps an object with a `sync(params)` function. It intercepts upstream insert, update, and delete messages before forwarding them to the caller. It returns a wrapped `sync` object plus `getCache()`, `get(key)`, `toArray()`, `getSharedState()`, and `fromSharedState()`.

Upstream inserts and updates supply a value with the configured string key.
Deletes can supply the key or the row. This wrapper mirrors each upstream write
as it arrives, so a reader can observe intermediate rows in an open batch. Use
[the committed upstream mirror](#mirror-committed-upstream-batches) for
transactional worker reads. The upstream provider owns persistence and reconnection.

## Pointer descriptors are not worker transport

`getRoot()`, `fromRoot()`, `getSharedState()`, and `fromSharedState()` expose low-level root/size descriptors. They do not include the matching arena memory or its identity. The current `fromRoot()` uses the module-default arena.

Do not post these descriptors to an unrelated worker and expect a valid collection. A root offset alone cannot identify its backing bytes. It is also not a reload-safe persistence format.

For worker reads, pass `config.getSnapshot()` or
`sharedCollection.getSnapshot()` through the existing
[`getWorkerData()` and `initWorker()` transport](worker-sharing.md).
The transport includes the matching memory and arena information. For
successive publications, use a [worker session](worker-sessions.md).
