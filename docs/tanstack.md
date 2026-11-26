# TanStack adapters

[Documentation](README.md) · [API](api.md) · [Worker sharing](worker-sharing.md)

`zerocopy/tanstack` exports `SharedCollection`, `sharedCollectionConfig`, and `withSharedCache`. These are small adapters around shared collection storage. They do not replace TanStack DB or configure a complete database application.

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
continues reading the previous snapshot. After
`await transaction.isPersisted.promise`, capture a new snapshot. Old handles
stay readable. The adapter has transaction and live-query coverage against TanStack DB
0.15.2. The packed-package check also edits nested metadata using the minimum
supported peer, 0.5.0. TanStack receives its own mutable metadata rows while
worker snapshots retain immutable values.

### Confirm a group of edits

For a manual TanStack transaction, call the adapter's acceptance helper once
inside the mutation function, after validation or persistence succeeds. The
helper processes the transaction's mutations for this collection in order.
It applies updated fields to the confirmed row, which keeps an unrelated
optimistic edit out of the worker snapshot. Await the helper as the final
step in a successful mutation function. A downstream write failure discards
the pending sync batch on TanStack DB 0.15.2.

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
