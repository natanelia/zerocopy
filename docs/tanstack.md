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

The returned object provides sync callbacks, mutation hooks, `getSharedState()`, and `fromSharedState()`. Its sync callback inserts `initialData` and calls `markReady()`.

**Current limits:** mutation hooks forward transaction messages to the registered sync callbacks, but do not update this adapter's internal `SharedCollection`. Its shared-state descriptor must not be treated as an always-current mirror of later mutations. The optional `primaryKey` field does not remove the requirement for each inserted item to have a string `id`.

The adapter's configuration shape is defined in [the source](../tanstack-db-collection.ts). Check it against the TanStack DB version used by your application. The repository's [adapter tests](../tanstack-db-collection.test.ts) exercise callbacks; they are not a complete integration test of every TanStack DB version or sync provider.

## withSharedCache

`withSharedCache<T>(upstreamSync, options?)` wraps an object with a `sync(params)` function. It intercepts upstream insert, update, and delete messages before forwarding them to the caller. It returns a wrapped `sync` object plus `getCache()`, `get(key)`, `toArray()`, `getSharedState()`, and `fromSharedState()`.

Upstream insert messages supply `value`; update messages supply a value with the configured primary-key field; delete messages supply `key`. Inserts still use `value.id`. Keep these keys consistent. Persistence, reconnection, and transaction semantics belong to the upstream provider and application, not this cache wrapper.

## Pointer descriptors are not worker transport

`getRoot()`, `fromRoot()`, `getSharedState()`, and `fromSharedState()` expose low-level root/size descriptors. They do not include the matching arena memory or its identity. The current `fromRoot()` uses the module-default arena.

Do not post these descriptors to an unrelated worker and expect a valid collection. A root offset alone cannot identify its backing bytes. It is also not a reload-safe persistence format.

For worker data today, keep application data in exported core collections and use `getWorkerData()` with `initWorker()`, as shown in [Worker sharing](worker-sharing.md). `SharedCollection` itself is not one of the built-in classes accepted by that transport. No complete zero-copy worker transport for the TanStack wrapper is claimed here.
