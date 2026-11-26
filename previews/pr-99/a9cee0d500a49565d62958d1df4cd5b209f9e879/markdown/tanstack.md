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

### Confirm a group of edits

For a manual TanStack transaction, call the adapter's acceptance helper once
inside the mutation function, after validation or persistence succeeds. The
helper processes the transaction's mutations for this collection in order.
It applies updated fields to the confirmed row, which keeps an unrelated
optimistic edit out of the worker snapshot. Await the helper as the final
step in a successful mutation function. A downstream write failure discards
the pending sync batch on TanStack DB 1.0.0-rc.1.5.

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

## withSharedCache

`withSharedCache<T>(upstreamSync, options?)` wraps an object with a `sync(params)` function. It intercepts upstream insert, update, and delete messages before forwarding them to the caller. It returns a wrapped `sync` object plus `getCache()`, `get(key)`, `toArray()`, `getSharedState()`, and `fromSharedState()`.

Upstream inserts and updates supply a value with the configured string key.
Deletes can supply the key or the row. This wrapper mirrors each upstream write
as it arrives, so a reader can observe intermediate rows in an open batch. Use
the confirmed snapshot from `sharedCollectionConfig` for transactional worker
reads. The upstream provider owns persistence and reconnection.

## Pointer descriptors are not worker transport

`getRoot()`, `fromRoot()`, `getSharedState()`, and `fromSharedState()` expose low-level root/size descriptors. They do not include the matching arena memory or its identity. The current `fromRoot()` uses the module-default arena.

Do not post these descriptors to an unrelated worker and expect a valid collection. A root offset alone cannot identify its backing bytes. It is also not a reload-safe persistence format.

For worker reads, pass `config.getSnapshot()` or
`sharedCollection.getSnapshot()` through the existing
[`getWorkerData()` and `initWorker()` transport](worker-sharing.md).
The transport includes the matching memory and arena information. For
successive publications, use a [worker session](worker-sessions.md).
