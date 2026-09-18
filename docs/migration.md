# Migration to v0.2

[Documentation](README.md) · [Architecture](architecture.md) · [Worker sharing](worker-sharing.md)

The persistent engine changes memory lifetime and binary representation. Treat this as a data-format migration, not a drop-in binary performance patch.

## Keep returned snapshots

Assign the result of every update:

```ts
map = map.set('lane-1', 30);
queue = queue.dequeue();
```

Earlier handles remain valid. Collection fields are frozen. `pop()` and `dequeue()` return collections rather than removed values.

## Rebuild producer and reader together

The current `WorkerData.version` is **4**. Older v0.1 pointers and intermediate v0.2 wire formats are incompatible. Rebuild worker and owner bundles together and recreate collection data. Do not mix old WASM files, stored roots, or snapshot descriptors with a new engine.

Use `getWorkerData()` and `initWorker()` rather than reconstructing a collection from a bare root. For saved application state, use the logical value codec described in the [Redux guide](redux.md#save-and-restore-application-state), then validate the application schema. That codec copies values; it is not zero-copy persistence.

## Replace disposal assumptions

`dispose()` and `configureAutoGC()` are deprecated no-ops. Reset functions select fresh default arenas without destroying earlier snapshots. There is no automatic per-node reclamation or update-count disposal.

For long editing sessions, compact live state at a controlled boundary and release unused history, worker views, payloads, and default references. Compaction is explicit and can temporarily keep source and destination memory alive.

## Keep writes with the owner

An arena has one allocating writer. Worker attachments are read-only. Use `compact()` to create a writable owned copy when a reader must begin an independent branch of updates. Do not treat that copy as a transfer of exclusive ownership while other readers still hold the old arena.

Bun defaults to used-prefix copy transport. Node.js and compatible isolated browsers support shared transport. Test the transport used by your application; copy fallback does not provide zero-copy sharing.

## Review implementation assumptions

Linked-list APIs now use indexed block sequences. Sorted maps no longer use the earlier red-black-tree implementation. Custom comparator functions stay local and cannot be transported to workers. Refer to the current [source map](architecture.md#source-map), not early design reports, for implementation details.

Low-level buffer exports can become stale after memory growth. Prefer the current memory buffer or the public worker transport. Legacy scratch exports and raw pointer constructors are not a concurrent reader protocol.

## Adopt typed JSON values

Existing primitive and `'object'` constructors keep their runtime behavior. Use [`json<T>()`](api.md#typed-json-objects) for checked object fields and deeply read-only results. This opt-in descriptor uses strict JSON compatibility checks; it does not execute `toJSON` methods.

The descriptor adds a `'json'` value-type name, not a new binary record layout. `WorkerData.version` remains 4. Rebuild owner and worker bundles together when adopting this descriptor; old bundles do not expose the new helpers. Do not cast existing `'object'` handles to the new type. Reinsert validated values to apply the strict write checks.

String-form nested collection types no longer resolve to `any`. Previously unchecked invalid calls can now produce compile errors. Fix those calls or use the typed descriptor helpers. `getWorkerData()` carries its producer's types to `initWorker()`, whose returned record is read-only, as it already was at runtime.
