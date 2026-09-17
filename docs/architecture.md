# Architecture and memory

[Documentation](README.md) · [API](api.md) · [Migration](migration.md)

A collection is a frozen JavaScript handle over persistent nodes in a WebAssembly memory arena. An update allocates new storage and reuses unchanged nodes. The earlier handle keeps its root and remains readable.

## Source map

The runtime is kept in flat, focused modules. Tests sit next to the modules they exercise; browser examples and checks live under `demo/`.

| Module or directory | Responsibility |
| --- | --- |
| [`shared.ts`](../shared.ts) | Public collection exports and worker payload encoding/attachment |
| [`shared-map.ts`](../shared-map.ts) and other `shared-*.ts` wrappers | Collection methods, snapshot descriptors, and per-class default arenas |
| [`arena.ts`](../arena.ts) | Arena identity, allocation, WASM access, value storage, read caches, and snapshot ownership |
| [`persistent-core.as.ts`](../persistent-core.as.ts) | Persistent data-structure operations in AssemblyScript |
| [`shared-runtime.as.ts`](../shared-runtime.as.ts), [`shared-hash-reader.as.ts`](../shared-hash-reader.as.ts) | WASM entry points |
| [`codec.ts`](../codec.ts), [`types.ts`](../types.ts) | Value types and nested-collection reconstruction |
| [`read-cache.ts`](../read-cache.ts), [`utf8.ts`](../utf8.ts), [`set-key.ts`](../set-key.ts) | Bounded read caching, UTF-8 support, and set-key encoding |
| [`compaction.ts`](../compaction.ts) | Copy selected live snapshots into fresh storage |
| [`redux.ts`](../redux.ts), [`redux-codec.ts`](../redux-codec.ts), [`redux-heap-codec.ts`](../redux-heap-codec.ts) | Redux integration and portable value encoding |
| [`tanstack-db-collection.ts`](../tanstack-db-collection.ts) | Collection wrapper and sync-cache adapters |
| [`scripts/`](../scripts) | Build and documentation checks |
| [`demo/`](../demo) | Browser demo, module workers, and Chromium tests |
| [`proofs/`](../proofs) | Benchmark drivers, correctness experiments, and recorded results |

The small legacy collection-specific `.as.ts` entry points are not separate current implementations. Read `persistent-core.as.ts` for the engine.

## Storage choices

Maps use persistent hash tries. Sets reuse map storage with encoded keys. Lists and queues use block vectors with tail storage; queues also track a read offset. Linked-list interfaces use indexed block sequences. Ordered maps keep a persistent insertion-order log. Sorted maps use a sorted-key index, not the red-black tree described by early documentation. Custom comparators sort entries locally during iteration. Priority queues use persistent heap nodes.

These choices have different costs. A scalar update can allocate path nodes, a string write needs encoding, and a JSON read can allocate decoded values. Repeated reads can hit a process-local cache. First-use construction includes memory and WASM-instance setup. None of these costs disappears because transport shares memory.

## Ownership and publication

Each arena has one allocating owner. Worker attachment creates a read-only view. The owner can create new versions while workers read old published nodes. Application messages publish complete snapshot descriptors; a reader does not follow the owner's latest JavaScript variable automatically.

The immutable contract applies to supported collection APIs. Allocation scratch, caches, and unpublished construction are mutable implementation details. Raw memory is writable by code that holds it. Shared memory is not an authentication or isolation boundary; use it only with trusted application workers.

The current transport format is **4**. Producer and reader must use compatible bundles. A descriptor needs both its matching arena and the correct collection layout. A numerical root alone is not a portable reference or a saved collection.

## Arena lifetime

Arenas are append-only and have an allocation ceiling below 2 GiB. There is no per-node reclamation. Retaining a single snapshot can retain the full arena, including unreachable intermediate nodes. Nested dependencies can retain other arenas. Queues can retain consumed prefixes, and ordered collections can retain old log entries.

An arena becomes eligible for garbage collection only when every holder releases it. Holders include collection handles, worker views, transport payloads, selectors, nested dependencies, and module-default references. Garbage collection is not immediate or guaranteed at a particular time.

`resetMap()` and the other reset functions select fresh default arenas for future collections. They do not compact existing collections or invalidate earlier snapshots. `dispose()` and `configureAutoGC()` are deprecated no-ops; they do not free individual snapshots.

## Compact at an application boundary

<!-- example: compaction -->
```ts
import { SharedMap, compact, compactMany } from 'zerocopy';

const original = new SharedMap('number').set('lane-1', 30);
const owned = compact(original);
const updated = owned.set('lane-1', 50);
const group = compactMany({ original, updated });

original.get('lane-1');       // 30
owned.get('lane-1');          // 30
group.updated.get('lane-1');  // 50
```

Compaction copies live data into a fresh writable arena. Group compaction can retain shared live blobs and nested snapshots within the copied group. The source remains valid. Compaction can temporarily retain both arenas and requires CPU time, so do not put it on every Redux dispatch or frame.

After replacing live state, release old history, worker views, and payloads when the application no longer needs them. Replace relevant default arena references where applicable. Dropping a local variable alone does not prove that all other holders are gone.

A store can start with `compact(new SharedMap('number'))` to give its data a separate arena lifetime. This is a deliberate allocation, not free initialization.

## Measuring memory

Distinguish allocated payload bytes, retained backing buffers, JavaScript heap, peak temporary memory, and total process RSS. The [README measurements](../README.md#memory-shared-vs-immutablejs-vs-native) count post-GC heap plus full retained buffers, not payload bytes alone. Compaction results exclude the time and temporary peak of the copy.
