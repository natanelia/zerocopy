# zerocopy

Immutable collections with direct, synchronous reads on the main thread and in connected workers, backed by shared WebAssembly memory.

[Direct-read quickstart](#read-shared-state-directly) · [State sessions](docs/worker-sessions.md) · [Optional tasks and pools](#run-a-typed-task) · [Collection API](docs/api.md) · [Documentation](docs/README.md) · [Benchmarks](#performance)

**Reading shared state does not require tasks or RPC.** Use collection methods such as `.get()` directly. After a worker connects, its reads are local and synchronous; they do not send a request to the owner. Sessions deliver new snapshots. Tasks are an optional way to schedule calculations, not a requirement for data access.

## Read shared state directly

Use the [built source package](#build-from-source) and a TypeScript-aware worker bundler. Browser shared memory requires cross-origin isolation: serve the page with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. See [browser setup](docs/workers.md#browser-setup) for worker scripts and third-party resources.

These are two files in the same directory. No task definition or task server is needed.

**main.ts** — own the state, read it directly, and connect a worker:

<!-- example: readme-direct-owner -->
```ts
if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');

const state = createState({
  limits: new SharedMap('number').set('lane-1', 30),
});
console.log(state.current.limits.get('lane-1')); // 30; no task or await.

const worker = new Worker(new URL('./state.worker.ts', import.meta.url), {
  type: 'module',
});
await state.connect(worker); // Attach the worker's initial snapshot once.

state.update('limits', limits => limits.set('lane-1', 50));
console.log(state.current.limits.get('lane-1')); // 50 immediately on the owner.
// New snapshots are published automatically. Worker delivery is asynchronous.

// At application teardown: state.dispose(); worker.terminate();
```

**state.worker.ts** — connect once, then read directly:

<!-- example: readme-direct-reader -->
```ts
import type { SharedMap } from 'zerocopy';
import { connectSharedSession } from 'zerocopy/worker';

type Model = { limits: SharedMap<'number'> };
const shared = await connectSharedSession<Model>(); // Initial connection only.

const initial = shared.current;
console.log('Worker initial:', initial.limits.get('lane-1')); // 30

// Subscribe only when you need to react to new snapshots.
shared.subscribe(snapshot => {
  console.log('Worker current:', snapshot.limits.get('lane-1')); // 50
  console.log('Worker retained:', initial.limits.get('lane-1')); // Still 30
});

// Elsewhere in this worker: shared.current.limits.get('lane-1').
// Every get() is a local synchronous read. No task or per-read message.
// At worker teardown: shared.dispose();
```

The `await` is for initial attachment, not for each read. You can read outside a subscription or task. On the owner, `state.current` changes synchronously. In a worker, `shared.current` is the newest snapshot that worker has received; it can lag behind the owner. Captured snapshots, such as `initial`, do not change when a newer snapshot arrives.

For several dedicated workers, use `await state.connect([workerA, workerB])`. Each worker connects with `connectSharedSession()` and reads locally. No worker pool or task scheduler is required. A browser `SharedWorker` has a different sharing boundary; see [SharedWorker setup and explicit copying](docs/workers.md#connect-a-sharedworker) instead of assuming the dedicated-worker example applies unchanged.

The dynamic imports let the isolation check run before default arenas are initialized. Shared transport avoids copying collection backing bytes. It does not eliminate connection messages, snapshot publication, decoding, or other execution costs.

## Choose the layer you need

| Need | Use | What happens |
| --- | --- | --- |
| Read a value already available on this thread | `state.current.limits.get(id)` or `snapshot.limits.get(id)` | Synchronous local collection access; no task or per-read message |
| Make new snapshots available in workers | `state.connect(worker)` and `connectSharedSession()` | A session publishes and receives snapshots; reads stay local |
| Ask another thread to run a calculation | Optional `spawn()`, `connect()`, or `pool()` task executors | A task message runs a handler and returns a Promise |
| Keep your own transport | `getWorkerData()` and `initWorker()` | Attach snapshots through your existing messages or RPC |

**Collections provide data access. Sessions deliver snapshots. Tasks schedule work.** Use tasks for whole calculations, such as route assessment or geometry processing, rather than wrapping each collection lookup in a remote call. The task executor function `connect()` is different from the state holder's `state.connect(worker)` method.

See [state sessions](docs/worker-sessions.md) for direct worker reads, publication, and subscriptions. Use the [task guide](docs/workers.md) only when you also need its execution and scheduling features.

## Immutable by default

Create a new version without changing the old one. Keep the return value from each collection update. Collections also work without a state holder or any worker:

<!-- example: map-snapshots -->
```ts
import { SharedMap } from 'zerocopy';

const before = new SharedMap('number').set('lane-1', 30);
const after = before.set('lane-1', 50);

before.get('lane-1'); // 30
after.get('lane-1');  // 50
```

`before.set(...)` does not mutate `before`. A state holder stores the current immutable handles; it does not turn the collections into mutable shared objects.

## Run a typed task

**Optional: use this layer to request work on another thread, not to access shared values.** A remote task call sends messages and returns a Promise. Prefer a direct `.get()` when the calling thread already has the collection. Inside a task, collection reads are still local.

<details>
<summary>Task setup example: the smallest request/response call</summary>

This small lookup demonstrates the task call mechanism, not the recommended way to read each value. For application work, replace the handler with a complete calculation. These three files are a separate example from the direct-read quickstart above. They require the same browser setup.

**tasks.ts** — ordinary handlers with typed inputs and results:

<!-- example: dx-tasks -->
```ts
import type { SharedMap } from 'zerocopy';
import { defineTasks } from 'zerocopy/worker';

export interface Model { limits: SharedMap<'number'> }
export const tasks = defineTasks<Model>()({
  speedLimit({ state }, laneId: string) {
    return state.limits.get(laneId);
  },
});
export type Tasks = typeof tasks;
```

**limits.worker.ts** — expose those handlers:

<!-- example: dx-worker -->
```ts
import { serve } from 'zerocopy/worker';
import { tasks } from './tasks';

await serve(tasks);
```

**main.ts** — call, update, call again:

<!-- example: dx-main -->
```ts
import type { Tasks } from './tasks';

if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const { spawn } = await import('zerocopy/worker');

const state = createState({
  limits: new SharedMap('number').set('lane-1', 30),
});
try {
  const compute = await spawn<Tasks>(
    () => new Worker(new URL('./limits.worker.ts', import.meta.url), {
      type: 'module',
    }),
    { state },
  );
  try {
    console.log(await compute.run.speedLimit('lane-1')); // 30
    state.update('limits', limits => limits.set('lane-1', 50));
    console.log(await compute.run.speedLimit('lane-1')); // 50
  } finally {
    compute.dispose(); // Disconnect and terminate the owned worker.
  }
} finally {
  state.dispose();
}
```

The task result is `Promise<number | undefined>`. The executor handles task messages and publication. `limits.get()` inside the task is a local collection read, not another RPC. Task arguments and ordinary results still use structured cloning.

</details>

## Same tasks, different execution

These choices apply only when you use the optional task API. Direct collection reads do not need an executor, including on the main thread.

| Start with | Use | Guide |
| --- | --- | --- |
| Tasks on the main thread | `local(tasks, { state })` | [Run tasks locally](docs/workers.md#start-on-the-main-thread) |
| Tasks in a new dedicated worker | `spawn<Tasks>(factory, { state })` | [Task setup](#run-a-typed-task) |
| Tasks in your existing workers | `connect<Tasks>(worker, { state })` | [Connect an existing worker](docs/workers.md#connect-an-existing-worker) |
| Tasks in several separate workers | One executor per worker | [Independent workers](docs/workers.md#several-independent-workers) |
| Many jobs | `pool<Tasks>(factoryOrWorkers, { state })` | [Worker pool](docs/workers.md#use-a-worker-pool) |
| Tasks on your own message channel | `connect<Tasks>(port, { state })` | [MessagePort integration](docs/workers.md#keep-an-existing-message-protocol) |
| SharedWorker task connections | Explicit copy mode and a server per port | [SharedWorker limits and setup](docs/workers.md#connect-a-sharedworker) |

The [task guide](docs/workers.md) includes complete replacement entry files, error handling, cancellation, and ownership rules. It is separate from [direct reads and state sessions](docs/worker-sessions.md) and [manual snapshot transport](docs/worker-sharing.md).

## When to use it

Use zerocopy when workers need to read large collections while the owner retains snapshots or creates new versions. There is **one allocating writer per arena**. Remote readers cannot allocate in the owner's arena. Strings and JSON values still need encoding and decoding. Bun defaults to copy transport.

When you use the optional task API, a task waits for at least its requested revision, not an exact invocation-time snapshot. A running handler retains one snapshot, but a pool batch can use different revisions. See [task consistency](docs/workers.md#consistency).

For small, single-threaded data, a native `Map` or array is often simpler and faster. The benchmark tables below include slower workloads and cold starts; they do not measure task-dispatch or pool overhead.

## Build from source

These docs describe this source revision, not an assumed npm release. While PR #6 is open, check out `agent/worker-dx-api` for the APIs and examples shown here:

```sh
git clone https://github.com/natanelia/zerocopy.git
cd zerocopy
git switch agent/worker-dx-api
bun install
bun run build:wasm
bun run build:browser
bun run build:types
npm pack --ignore-scripts
```

Install the resulting `zerocopy-0.2.0.tgz` in your application with `npm install /path/to/zerocopy-0.2.0.tgz`. After the task API is merged, the default branch also includes it. The package contains the JavaScript bundles, embedded WASM, TypeScript declarations, and Bun source entry points. Applications do not need an AssemblyScript build.

The repository's CI uses Bun 1.4.2 and Node.js 22. See [Contributing](CONTRIBUTING.md) for build and test commands.

## Collections and integrations

| Collection | Use |
| --- | --- |
| `SharedMap`, `SharedSet` | Key lookup and membership |
| `SharedList` | Indexed sequence |
| `SharedStack`, `SharedQueue` | Last-in-first-out and first-in-first-out access |
| `SharedLinkedList`, `SharedDoublyLinkedList` | Indexed insertion and removal, with linked-list-style APIs |
| `SharedOrderedMap`, `SharedOrderedSet` | Insertion-order iteration |
| `SharedSortedMap`, `SharedSortedSet` | Sorted iteration |
| `SharedPriorityQueue` | Minimum or maximum priority first |

Use [`json<T>()`](docs/api.md#typed-json-objects) for typed plain objects and read-only fields. Compose nested types with helpers such as `list(json<Lane>())`.

The [API guide](docs/api.md) covers all 12 classes, value types, nested collections, and custom ordering. The collection names describe their interfaces, not necessarily their internal storage.

[Redux](docs/redux.md) provides Toolkit middleware options, selectors, DevTools support, and a portable value codec. [TanStack adapters](docs/tanstack.md) provide a collection wrapper and sync-cache helpers, with important limits on pointer-based state. Both are separate package entry points.

## Memory and ownership

Storage is append-only. Old snapshots, worker views, nested collections, transport payloads, and default arena references can keep an entire arena alive. There is no per-node garbage collection.

Use `compact()` or `compactMany()` at a controlled application boundary to copy live data into a new writable arena. Keep the result and release old holders. Compaction costs time and can temporarily keep both arenas in memory. Collection-level `dispose()` and `configureAutoGC()` are deprecated no-ops. Executor and session `dispose()` methods are different: they disconnect listeners and release owned resources.

See [Architecture and memory](docs/architecture.md) for the source map and lifetime model. Existing users should read [Migration to v0.2](docs/migration.md) before mixing producer and worker builds.

## Share a snapshot

Already own the protocol? Keep the low-level API. Use it to attach collections for direct reads through your existing messages, without a state session or task executor.

<details>
<summary>Manual browser transport example</summary>

Browser applications need cross-origin isolation for shared memory. Configure `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and check `crossOriginIsolated` before using shared transport.

**main.ts**

<!-- example: readme-browser-owner -->
```ts
if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}

const { SharedMap, getWorkerData } = await import('zerocopy');
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
});
const limits = new SharedMap('number').set('lane-1', 30);

worker.postMessage(getWorkerData({ limits }, { copy: false }));
```

Use a dynamic import here so the isolation check runs before the library initializes its default arenas. A static import runs before the module body.

**worker.ts**

<!-- example: readme-browser-reader -->
```ts
import { initWorker, type SharedMap, type WorkerData } from 'zerocopy';

self.addEventListener('message', async (event: MessageEvent<WorkerData>) => {
  const { limits } = await initWorker<{ limits: SharedMap<'number'> }>(event.data);
  self.postMessage(limits.get('lane-1'));
});
```

The message carries memory handles and snapshot descriptors. The worker reads the same stored collection bytes. Later owner updates do not change the attached snapshot; send another payload to publish a new version.

See [Worker sharing](docs/worker-sharing.md) for complete Node.js examples, browser setup, copy mode, and ownership rules.


</details>

## Performance

**Zerocopy vs Immutable.js vs native collections.** `Shared` means zerocopy. Times cover complete workloads, not single calls. Lower times are better. Ratios compare Shared with the named reference.

Measured on September 14, 2026, in the [GitHub validation run](https://github.com/natanelia/zerocopy/actions/runs/34801792862). The runner used Bun 1.4.2, Immutable.js 5.1.9, AssemblyScript 0.28.20, Linux x64, and an AMD EPYC 7763 processor. Each result is the median of 45 samples across three process rounds, with ten warm-ups per case and rotated library order. Results and retained bases are checked outside timing.

**The first tables exclude arena creation and use repeated reads.** Every build creates a fresh collection through individual persistent updates. First-use results below include arena creation. Native builds use a fresh mutable Map or Array. Updates to an existing native collection include one copy per workload to preserve its base, then apply changes to that copy. Shared and Immutable.js return new versions at each scalar update.

Build, read, peek, and scan rows process 10,000 items unless stated otherwise. Removal rows apply ten removals to a 10,000-item base. `setMany(100)` changes 100 entries; Immutable.js uses persistent `set`, not `withMutations`. `enq+deq(100)` performs 100 enqueue/dequeue pairs. Linked-list indexed reads cover 100 positions; front/back reads cover 50 each. Map and ordered-map values are strings. Sequence and sorted-map values are numbers. Sorted keys use a fixed shuffled insertion order; native sorted iteration includes sorting.

### Benchmark Results (N=10000)

<!-- library-timing-tables:start -->
**SharedMap vs Immutable.Map vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 3.8413ms | 5.6149ms | 1.46x faster | 0.4119ms | 9.33x slower |
| get | 0.2339ms | 0.9340ms | 3.99x faster | 0.1553ms | 1.51x slower |
| has | 0.5369ms | 1.2964ms | 2.41x faster | 0.4811ms | 1.12x slower |
| delete | 0.006908ms | 0.006835ms | 1.01x slower | 0.1233ms | 17.84x faster |
| setMany(100) | 0.0746ms | 0.0569ms | 1.31x slower | 0.1094ms | 1.47x faster |

**SharedList vs Immutable.List vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 0.7539ms | 1.5979ms | 2.12x faster | 0.0521ms | 14.47x slower |
| get | 0.1263ms | 0.1030ms | 1.23x slower | 0.0381ms | 3.32x slower |
| pop | 0.000648ms | 0.003137ms | 4.84x faster | 0.0392ms | 60.58x faster |
| forEach | 0.0549ms | 0.1764ms | 3.21x faster | 0.0240ms | 2.29x slower |

**SharedStack vs Immutable.Stack vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 1.0043ms | 0.2010ms | 5.00x slower | 0.0611ms | 16.45x slower |
| peek | 0.1310ms | 0.1313ms | 1.00x faster | 0.1144ms | 1.15x slower |
| pop | 0.000732ms | 0.001400ms | 1.91x faster | 0.0373ms | 50.94x faster |

**SharedQueue vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| enqueue | 1.2133ms | 0.0482ms | 25.17x slower |
| peek | 0.2426ms | 0.0661ms | 3.67x slower |
| dequeue | 0.000509ms | 0.0359ms | 70.45x faster |
| enq+deq(100) | 0.0116ms | 0.0425ms | 3.65x faster |

**SharedLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 5.4781ms | 9.2912ms | 1.70x faster |
| append | 1.3051ms | 0.0465ms | 28.08x slower |
| get(0-99) | 0.006275ms | 0.000666ms | 9.43x slower |
| removeFirst | 0.003049ms | 0.0393ms | 12.89x faster |

**SharedDoublyLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 5.8770ms | 9.3235ms | 1.59x faster |
| append | 1.3110ms | 0.0538ms | 24.39x slower |
| get(front) | 0.005538ms | 0.000344ms | 16.12x slower |
| get(back) | 0.005599ms | 0.000343ms | 16.34x slower |
| removeFirst | 0.003077ms | 0.0376ms | 12.24x faster |
| removeLast | 0.000863ms | 0.0259ms | 29.99x faster |

**SharedOrderedMap vs Immutable.OrderedMap vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 6.3215ms | 10.2688ms | 1.62x faster | 0.7616ms | 8.30x slower |
| get | 0.4301ms | 1.6793ms | 3.90x faster | 0.6198ms | 1.44x faster |
| has | 0.5580ms | 1.9326ms | 3.46x faster | 0.5494ms | 1.02x slower |
| delete | 0.006266ms | 0.0104ms | 1.65x faster | 0.0776ms | 12.38x faster |
| forEach | 1.5027ms | 0.2105ms | 7.14x slower | 0.0998ms | 15.06x slower |

**SharedSortedMap vs Native Map**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| set | 6.6242ms | 0.6876ms | 9.63x slower |
| get | 0.7011ms | 0.4880ms | 1.44x slower |
| has | 0.6468ms | 0.4476ms | 1.45x slower |
| delete | 0.006447ms | 0.0729ms | 11.32x faster |
| keys(sorted) | 2.4290ms | 0.9531ms | 2.55x slower |
<!-- library-timing-tables:end -->

The string `SharedMap.set` workload is 1.46x faster than Immutable.js in this run. Results near 1.00x are not established improvements. These are Bun microbenchmarks, not application, browser, or worker-transfer speed guarantees.

### First-use builds, including arena creation

This table includes Shared arena reset, new WebAssembly memory, and WASM instance creation inside the timed workload. Inputs and sample counts are the same as above. Immutable.js and native collections have no equivalent arena initialization cost.

| Workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| SharedMap.set | 9.3940ms | 5.8996ms | 1.59x slower | 0.4128ms | 22.75x slower |
| SharedList.push | 6.9694ms | 1.6735ms | 4.16x slower | 0.0940ms | 74.18x slower |
| SharedStack.push | 6.6314ms | 0.1973ms | 33.61x slower | 0.0840ms | 78.96x slower |
| SharedQueue.enqueue | 7.0335ms | N/A | N/A | 0.0492ms | 143.07x slower |
| SharedLinkedList.prepend | 11.3363ms | N/A | N/A | 9.3290ms | 1.22x slower |
| SharedLinkedList.append | 8.1099ms | N/A | N/A | 0.0453ms | 179.09x slower |
| SharedDoublyLinkedList.prepend | 11.7740ms | N/A | N/A | 9.1520ms | 1.29x slower |
| SharedDoublyLinkedList.append | 8.1714ms | N/A | N/A | 0.0371ms | 220.26x slower |
| SharedOrderedMap.set | 12.2661ms | 10.0788ms | 1.22x slower | 0.7581ms | 16.18x slower |
| SharedSortedMap.set | 11.5702ms | N/A | N/A | 0.6686ms | 17.31x slower |

### Scalar map writes across different keys

These tests call ordinary `set` for every update. They do not use a bulk builder, `withMutations`, or repeated changes to a few keys. The insert order is a fixed shuffle. Overwrite rows change 1,000 distinct keys in a 10,000-item base. The long-prefix case uses a shared 128-character key prefix. The fork row creates 64 separate snapshots from one base; native copies once per fork. All returned versions are immediately readable and shareable.

Each workload and library runs in an independent process for each round. There are 45 timed samples per cell. Setup and full output checks are outside timing, except arena creation in the explicitly marked first-use row.

| Workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| Insert 10,000 new string values; shuffled keys | 3.4796ms | 6.9285ms | 1.99x faster | 0.3104ms | 11.21x slower |
| Insert 10,000 new numeric values; shuffled keys | 2.6059ms | 6.3545ms | 2.44x faster | 0.3160ms | 8.25x slower |
| Insert 10,000 Unicode keys and values | 8.7007ms | 6.7029ms | 1.30x slower | 0.3389ms | 25.68x slower |
| Insert 10,000 keys with a long shared prefix | 7.5466ms | 20.2847ms | 2.69x faster | 0.3452ms | 21.86x slower |
| Change 1,000 distinct string entries | 0.3678ms | 0.6531ms | 1.78x faster | 0.1198ms | 3.07x slower |
| Change 1,000 distinct numeric entries | 0.3335ms | 0.8786ms | 2.63x faster | 0.0963ms | 3.46x slower |
| Change 1,000 numeric entries after a full read | 0.4374ms | 0.6407ms | 1.46x faster | 0.1059ms | 4.13x slower |
| 64 independent updates from one retained base | 0.0599ms | 0.0443ms | 1.35x slower | 9.6084ms | 160.32x faster |
| 1,000 changed set/get/has sequences | 0.5443ms | 0.8430ms | 1.55x faster | 0.1466ms | 3.71x slower |
| Insert 10,000 strings including arena creation | 3.7682ms | 7.1686ms | 1.90x faster | 0.3706ms | 10.17x slower |

Numeric insertion and dispersed numeric overwrites exceed 2x Immutable.js in this run. String insertion reaches 1.99x. Unicode construction and independent forks are slower than Immutable.js. There is no general 2x scalar-write advantage.

### Cold reads, larger key sets, and mixed updates

A repeated read can use a bounded process-local cache. The first-read case attaches an empty read cache before each timed scan. The 32,768-key case exceeds the value-cache entry limit. The mixed case changes a key, reads its new value, and checks membership 1,024 times. The final case alternates reads between two retained snapshots. Each cell has 45 samples.

| Workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| First read of 10,000 numeric keys | 2.5339ms | 1.1957ms | 2.12x slower | 0.3142ms | 8.07x slower |
| Read 32,768 numeric keys | 5.1745ms | 5.5349ms | 1.07x faster | 1.2018ms | 4.31x slower |
| 1,024 set/get/has sequences | 0.8499ms | 0.6452ms | 1.32x slower | 0.4404ms | 1.93x slower |
| 10,000 reads alternating two snapshots | 0.5495ms | 1.4999ms | 2.73x faster | 0.6843ms | 1.25x faster |

These fixed-order workloads differ from the independent-process shuffled write suite. Warm lookup gains are not uncached lookup gains; the mixed-update rows measure different access patterns.

### Evidence

The [recorded summary](proofs/results/map-set-index-summary.json) contains scalar-write medians, memory results, source and driver checksums, and test counts. The [raw archive](https://github.com/natanelia/zerocopy/actions/runs/34801792862/artifacts/10330799515) contains 1,800 paired scalar-write timing samples, 4,005 original-table samples, 1,080 first-use samples, 540 extra read-workload samples, 108 isolated memory measurements, and test logs. Artifact retention ends on December 13, 2026.

The [scalar-write report](proofs/map-set-performance.md) explains the comparison with the same engine without the writer index. [Earlier experiments](proofs/README.md) retain their own source versions, raw data, and results; they are not measurements of the current source.

## Memory: Shared vs Immutable.js vs native

Lower memory is better. One MiB is 1,048,576 bytes. These measurements use the same validated source and runner as the speed tables. They compare libraries, not different zerocopy releases.

The metric is **incremental post-GC V8 heap use plus full retained backing buffers**. It includes Shared's JavaScript keys, values, caches, wrappers, auxiliary buffers, and unused space in active WASM memory. It is not a comparison of Shared payload bytes with another library's complete storage.

Node.js v22.23.2 runs each library, type, size, and scenario in an isolated process with `--expose-gc`. Results are medians of three independent processes. Library imports, warm-up, and empty default arenas precede the heap baseline. Startup, code memory, total process RSS, and peak temporary memory are excluded.

### One retained collection after reads

Maps use string keys and string values. Lists and stacks use numbers. Construction uses scalar writes. All values are checked before measurement, so Shared's read-cache cost is included. Only the latest handle is retained, but Shared arenas still contain allocated intermediate nodes.

| Collection and workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| Map, 10,000 items | 1.966 MiB | 2.050 MiB | 4.1% less | 0.898 MiB | 118.9% more |
| List, 10,000 items | 0.297 MiB | 0.258 MiB | 15.3% more | 0.079 MiB | 274.5% more |
| Stack, 10,000 items | 0.292 MiB | 0.409 MiB | 28.6% less | 0.078 MiB | 272.9% more |
| OrderedMap, 10,000 items | 2.159 MiB | 2.938 MiB | 26.5% less | 0.898 MiB | 140.4% more |
| Map, 100,000 items | 14.770 MiB | 19.104 MiB | 22.7% less | 8.081 MiB | 82.8% more |
| List, 100,000 items | 1.922 MiB | 1.994 MiB | 3.6% less | 0.876 MiB | 119.3% more |
| Stack, 100,000 items | 1.669 MiB | 3.843 MiB | 56.6% less | 0.875 MiB | 90.6% more |
| OrderedMap, 100,000 items | 16.276 MiB | 27.210 MiB | 40.2% less | 8.081 MiB | 101.4% more |

The 10,000-item map uses 4.1% less than Immutable.js in this run, while the 100,000-item map uses 22.7% less. Treat the small difference at 10,000 items with care because heap measurements vary. Shared still uses more memory than native Map. The writer index adds no reserved backing memory: its scratch area fits in the prefix already reserved by each arena.

### Compacted collections and retained history

Compacted rows rebuild Shared's live data in a fresh arena. The source and its default arena reference are released, then all live values are checked again. The other libraries use their normal GC-managed representations. Compaction time and peak memory while both arenas coexist are not included in retained size.

History rows keep 32 snapshots of a 10,000-key map while changing one key. Shared and Immutable.js retain versions; native Map retains 31 shallow copies plus its original. Only the changed key is checked in these history cases. Their cache state differs from the full-read cases above.

| Collection and workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| Map, 10,000 items; Shared compacted | 1.645 MiB | 2.051 MiB | 19.8% less | 0.898 MiB | 83.2% more |
| Map, 10,000 items; 32 snapshots | 1.054 MiB | 2.048 MiB | 48.5% less | 14.463 MiB | 92.7% less |
| OrderedMap, 10,000 items; Shared compacted | 1.747 MiB | 2.938 MiB | 40.6% less | 0.898 MiB | 94.5% more |
| OrderedMap, 10,000 items; 32 snapshots | 1.248 MiB | 2.912 MiB | 57.1% less | 14.463 MiB | 91.4% less |

Compaction is explicit, not automatic reclamation. Old snapshots, workers, payloads, nested values, or default references can keep the source arena alive. An arena reserves at least 128 KiB. The tables do not imply that every Shared collection is smaller than every alternative. Only directly corresponding Map, OrderedMap, List/Array, and Stack/Array representations are measured here. Missing Immutable.js types are not substituted with unrelated types.

### Reproduce the timing and memory comparisons

From the project directory:

```sh
bun install
bun run build:wasm
bun run build:browser
bash proofs/run-hot-path-evidence.sh
```

This records the eight timing tables for initialized arenas, first-use builds with arena creation, cold and mixed reads, and the three-library memory comparison. All variants retain the same inputs and validate their results. Raw JSON and generated tables are written below `proofs/results/hot-path/` and `proofs/results/cold-build/`.

Run the independent-process scalar-write comparison:

```sh
node proofs/run-map-set.mjs proofs/results/map-set.json
```

Run only the memory comparison after the portable build:

```sh
node proofs/library-memory.mjs proofs/results/library-memory.json
```

The driver starts isolated child processes with explicit garbage collection. It saves samples, heap measurements, backing-buffer totals, library versions, and checksums. Later runtimes or different hardware can produce different results. Keep new runs separate from the recorded summary.

## License

[MIT](LICENSE)
