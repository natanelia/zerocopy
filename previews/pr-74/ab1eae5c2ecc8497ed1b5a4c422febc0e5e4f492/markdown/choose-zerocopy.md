# Should I use ZeroCopy?

Start here if several workers need to read the same large, changing dataset. ZeroCopy gives each reader local access to an immutable snapshot while one owner publishes new versions. The shared collection storage stays in shared WebAssembly memory.

The useful question is whether sharing that storage saves enough copying and retained memory in **your application** to justify the collection, setup, and lifetime costs.

## Check the fit

| Your application needs… | A sensible starting point |
| --- | --- |
| Several workers reading a large collection, with stable versions during edits | Try ZeroCopy with a representative workload. |
| A small dataset or state used on one thread | Native `Map`, arrays, and ordinary objects. |
| A worker that owns the data while the UI only needs small answers | Keep the data in that worker and exchange small messages. |
| Existing readers that already apply inexpensive incremental updates | Measure that design alongside shared snapshots. |
| A binary buffer passed to one owner at a time | Transferable `ArrayBuffer` and typed arrays. |
| SQL joins, persistence, recovery, or offline storage | A database or storage layer. |
| Concurrent writers, collaborative editing, or conflict resolution | A coordination or collaboration protocol. ZeroCopy does not merge edits. |

Product catalogs, editor documents, large tables, graphs, and simulations can fit this pattern. The [application patterns](../../docs/use-cases.md) explain what each worker would read. They are design examples, not measured production deployments.

## Four things to understand first

### One writer allocates; readers keep snapshots

Each arena has one allocating owner. Attached workers receive read-only collection views. Send edit commands to the owner, then publish the resulting snapshot. A worker can also create independent owned collections in its own arenas.

Updates create new immutable roots and reuse unchanged storage. A previously captured snapshot keeps its earlier values. A calculation should capture the snapshot it needs and label its result with the relevant revision before the UI applies it.

### Publication is explicit

Changing the owner's variable does not update a worker's existing handle. For automatic delivery, use a [state session](../../docs/worker-sessions.md). Its worker-side `current` is the latest received snapshot and can lag behind the owner.

If you already have a message protocol, [manual transport](../../docs/worker-sharing.md) uses `getWorkerData()` to describe snapshots and `initWorker()` to attach them. Send a new payload to expose a new revision. Individual collection reads happen locally after attachment; they do not make an RPC request.

### Browser shared memory needs cross-origin isolation

Use HTTPS or localhost and a host that can supply the required isolation response headers. Check `crossOriginIsolated` and shared-memory support before starting the application. Third-party scripts and resources must satisfy the embedder policy too.

The [complete browser quickstart](../../docs/getting-started.md) includes Vite configuration and a runnable main-thread/worker pair. Production hosting needs equivalent headers; local development configuration does not configure the deployed host. [Node.js worker threads](../../docs/workers.md#nodejs-workers) do not need browser isolation headers.

Use shared transport only between compatible workers in the same agent cluster. A page-to-`SharedWorker` connection cannot share the backing memory across its agent-cluster boundary. The [worker transport guide](../../docs/worker-sessions.md#memory-and-limits) describes copy mode and runtime differences. Copy mode still needs the engine's shared-memory support and is not zero-copy transport.

### Memory lifetime is part of the design

Arenas are append-only. Releasing one snapshot does not reclaim individual nodes. An old snapshot, a worker attachment, a pending payload, a nested dependency, or a default arena reference can keep an entire arena alive.

Use `compact()` or `compactMany()` at an application boundary when you want to copy selected live snapshots into fresh writable storage. Compaction takes time and can temporarily keep both source and destination arenas alive. Release old history and all other holders when they are no longer needed. Garbage collection is not immediate.

Read [memory and ownership](../../docs/architecture.md#compact-at-an-application-boundary) before building a long-running editor or stream. Plan history retention and compaction alongside the update path.

## What “zero-copy” means here

Shared publications carry snapshot descriptors and memory handles instead of serializing the entire collection into each reader's JavaScript heap. That is the storage-transport advantage.

It does not mean zero allocations or zero work. Building collections allocates storage. Encoding strings and objects, creating descriptors, attaching workers, decoding JSON, and returning results all have costs. Repeated reads can use process-local caches; those caches also consume memory. Native collections can be faster or smaller for a particular workload.

Shared memory is for trusted application workers. Code that holds the underlying memory can write to it; the supported immutable APIs do not turn raw shared memory into a security boundary.

## Try it in this order

1. **See the snapshot behavior.** Open the [snapshot playground](../README.md#playground), publish a change, and compare a reader's new revision with its retained earlier view.
2. **Build the smallest real integration.** Follow [Get started](../../docs/getting-started.md). It includes both source files, browser setup, and the expected output.
3. **Measure the boundary you want to improve.** Use the [product-catalog benchmark](../README.md#catalog-benchmark) for sparse edits and publication, the [Map transport control](../README.md#benchmark-lab) for worker fan-out, and the [recorded memory report](../../docs/feature-map-memory.md) to understand memory accounting. Historical results describe their original source and environment.
4. **Test your actual workload.** Keep the same data, readers, update pattern, and retained history in each design. Include a native owner with small replies and incremental replicas where they are realistic alternatives.

For the API details, continue to [collections and types](../../docs/api.md), [state and subscriptions](../../docs/worker-sessions.md), or [your own transport](../../docs/worker-sharing.md).
