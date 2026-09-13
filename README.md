# zerocopy

Persistent data structures for JavaScript, backed by shared WebAssembly memory.
Updates return new frozen collection handles. Existing versions remain readable.
Node and supported browsers can give read-only worker views access to the same
backing memory. Bun uses a used-prefix copy by default.

**This v0.2 candidate uses worker format 3 and changes the binary layout and
memory lifetime rules.** It is not compatible with v0.1 data or earlier
worker-format-2 candidates. Read the migration section before upgrading.
The performance tables below include gains, remaining regressions, and their
source measurements.

## Example

```ts
import { SharedMap, SharedList } from 'zerocopy';

const first = new SharedMap('number').set('speed', 40);
const second = first.set('speed', 50);
console.log(first.get('speed'));  // 40
console.log(second.get('speed')); // 50

const values = new SharedList('number').pushMany([1, 2, 3]);
const changed = values.set(1, 20);
console.log(values.toArray());  // [1, 2, 3]
console.log(changed.toArray()); // [1, 20, 3]
```

`toArray()` and entry tuples are detached copies. Changing those containers does
not edit a collection. The `object` codec stores JSON and returns deeply frozen
JSON values. It does not preserve prototypes, functions, cycles, or arbitrary
JavaScript objects. Inserting an object does not freeze the caller's input.

```ts
const input = { position: { x: 1, y: 2 } };
const map = new SharedMap('object').set('point', input);
input.position.x = 99;
// map.get('point') still contains x: 1.
```

## Performance

These figures come from the completed [GitHub Actions run on September 13, 2026](https://github.com/natanelia/zerocopy/actions/runs/34764774485).
The measured code is commit [`6e0510c`](https://github.com/natanelia/zerocopy/commit/6e0510c66e3cee0dc7762d71256800c41207e161),
which uses worker format 3. These are CI results, not a mixture of the earlier
local measurements and new CI measurements.

The main improvements include **18.97x faster bulk vector creation**, **2.77x
faster scalar vector append**, and **1.67x faster map lookup** against the matched
original in this run. Indexed reads through the two linked-list interfaces are
**74.07x and 37.90x faster**. Those indexed-read gains compare block trees with
the original physical linked lists; they do not describe every sequence operation.

### Method and reference versions

The runner used **Bun 1.4.2**, **AssemblyScript 0.28.20**, Linux x64, and an
AMD EPYC 7763 processor. Each operation ran in a separate process. The driver
rotated the variant order across three rounds. Each process used 20 warm-ups
and 15 measured samples. Each table entry is the median of **45 samples per
operation per variant**. Output checks ran outside the timed sections.

The matched original is commit [`7aea444`](https://github.com/natanelia/zerocopy/commit/7aea44447177d37a303ab5c1b26d7c5e00e1c1f7),
rebuilt with the same AssemblyScript compiler and build flags as the revision.
The previous PR is commit [`59bd5ad`](https://github.com/natanelia/zerocopy/commit/59bd5ad9f84358f828968910c66b9a2e80c0673d).
The raw record also includes the original build with its original flags.
The matched build is not always faster than that original build.

**Ratio = reference median / revision median. Above 1.00x is faster; below
1.00x is slower.** Times are for the complete workload in each row, not one
operation. Differences near 1.00x are not established improvements. No confidence
intervals or application-level speed guarantees are claimed.

| Workload | Revision time (ms) | vs matched original | vs previous PR |
|---|---:|---:|---:|
| Vector bulk build (4,096 numbers) | 0.0404 | 18.97x | 2.22x |
| Vector scan (20 scans of 4,096 numbers) | 0.2501 | 3.39x | 1.20x |
| Vector append (4,096 pushes) | 0.2787 | 2.77x | 4.27x |
| Map bulk build (1,024 entries) | 0.2417 | 1.25x | 1.36x |
| Map lookup (4,096 hits over 1,024 keys) | 0.2339 | 1.67x | 2.41x |
| Singly linked-list indexed reads (4,096) | 0.1437 | 74.07x | 4.50x |
| Singly linked-list append (4,096) | 0.2616 | 1.00x | 4.98x |
| Doubly linked-list indexed reads (4,096) | 0.1603 | 37.90x | 4.04x |
| Doubly linked-list append (4,096) | 0.2593 | 0.96x | 5.15x |
| Ordered-map writes (1,024) | 0.3076 | 0.80x | 2.62x |
| Sorted-map writes (1,024) | 0.2921 | 1.09x | 2.01x |
| Priority-queue insertion (1,024) | 0.3693 | 1.63x | 0.95x |
| Queue build (4,096 numbers) | 0.2813 | 1.02x | 4.30x |
| Stack build (4,096 numbers) | 0.2391 | 1.24x | 1.06x |

Map lookup in this table uses keys written during setup. The cold-read workload
below measures a different access pattern. Both results matter.

### Complete write-and-read workloads

These tests include iteration or reads after writes. They use the same compiler
settings and sample counts. They expose costs that write-only timing can miss.

| Workload | Revision time (ms) | vs matched original | vs previous PR |
|---|---:|---:|---:|
| Ordered-map writes and scan (1,024) | 0.5029 | 0.77x | 3.28x |
| Sorted-map writes and scan (1,024) | 0.5452 | 1.14x | 2.07x |
| Sorted long-prefix writes and scan (512) | 1.0122 | 2.95x | 1.35x |
| Cold map reads after bulk build (1,024) | 0.1204 | 0.97x | 1.03x |
| Object-map writes and reads (512) | 1.1767 | 0.79x | 0.92x |
| Complete queue fill and drain (4,096) | 0.4689 | 0.90x | 3.04x |

**Remaining regressions are not hidden.** In this CI run, ordered-map writes
are about 25% slower than the matched original. Ordered-map writes plus a scan
are about 30% slower. Object-map writes plus reads are about 27% slower.
Doubly linked-list append, cold map reads, and a full queue cycle also trail
the matched original. Priority insertion and object writes plus reads trail
the previous PR in this run. The original also has separate snapshot-correctness
failures; passing these timing checks does not establish equivalent immutability.

These are small Bun workloads on one runner. They do not measure browser
performance, main-thread latency, worker transfer time, concurrent write
throughput, or every key distribution. Re-run them on the target runtime and
workload. All four variants disable the original automatic-GC mechanism because
it can invalidate retained snapshots. See the [snapshot counterexamples](proofs/snapshot-regressions.ts).

### What reduces the work

Tail blocks avoid a tree-path copy on most appends. A numeric append to a
non-full tail at the allocation boundary needs eight new payload bytes.
Old snapshots keep their original visible lengths. A fork or an intervening
allocation copies the visible tail instead. A full tail still needs index work.

Bulk vector input becomes the stored value blocks instead of a second staging
copy. Linked-list interfaces use blocks of up to 32 values. Numeric map writes
use a compact WASM command buffer, and the HAMT has 16-way branches. Ordered
maps use a persistent insertion log. Default sorted maps use a compressed radix
index with a bounded journal of up to four pending updates. These changes do not
remove encoding, decoding, returned-object allocation, or all update costs.

### Evidence

The [recorded CI summary](proofs/results/readme-ci-summary.json) preserves exact
medians, ratios, allocation measurements, environment details, and checksums.
The [raw CI artifact](https://github.com/natanelia/zerocopy/actions/runs/34764774485/artifacts/10319983686)
contains all timing samples, worker results, and allocation records. GitHub's
artifact retention ends on October 13, 2026; the committed summary remains.
Reproduction commands are below. The [earlier performance report](proofs/README.md)
and its `local.json` results describe the initial implementation, not this revision.

## Memory and compaction measurements

The allocation test uses 4,096 numeric values. A bulk vector build allocates
**33,408 bytes**, compared with **2,052,112 bytes** in the original bulk build:
**98.37% less WASM arena allocation**. Scalar vector construction now allocates
**61,312 bytes**. Compared with that original bulk-build allocation, this is
97.01% less; it is not a measurement of original scalar-build allocation.

Compaction copies live data into a fresh arena and leaves the source unchanged.
The following rows come from the same CI run. The queue starts with 4,096 values
and removes 4,064. Each map receives 4,096 writes to 128 distinct keys.

| Workload | Live items | Source allocated bytes | After compaction | Source reserved bytes | New arena reserved bytes |
|---|---:|---:|---:|---:|---:|
| Vector built with scalar appends | 4,096 | 61,312 | 33,408 | 131,072 | 131,072 |
| Vector built in bulk | 4,096 | 33,408 | 33,408 | 131,072 | 131,072 |
| Singly linked sequence | 4,096 | 56,984 | 35,816 | 131,072 | 131,072 |
| Doubly linked sequence | 4,096 | 56,984 | 35,816 | 131,072 | 131,072 |
| Queue after removals | 32 | 61,312 | 256 | 131,072 | 131,072 |
| Map after repeated updates | 128 | 676,584 | 5,856 | 786,432 | 131,072 |
| Ordered map after repeated updates | 128 | 710,376 | 7,904 | 786,432 | 131,072 |
| Sorted map after repeated updates | 128 | 380,952 | 9,672 | 458,752 | 131,072 |

**Allocated bytes are not total memory use.** They exclude the fixed 65,536-byte
arena prefix, JavaScript objects and caches, and temporary JavaScript buffers.
Reserved bytes are the backing `WebAssembly.Memory` buffer size. The new queue
has 256 allocated bytes but still has a 131,072-byte backing buffer. Thus, a
smaller live payload does not always reduce reserved memory at these sizes.

Compaction temporarily needs both arenas. It does not immediately return source
memory to the runtime. Old snapshots, worker views, payloads, nested dependencies,
and module-default arena references can all keep the source alive. Compaction
times in the raw file are single observations, not repeat-sampled latency claims.

The separate batch-update allocation test applies 4,096 updates to a 32,768-key
map. Fused updates allocate **427,384 bytes**, compared with **1,375,904 bytes**
for persistent scalar updates: **68.94% less**. Both paths use the revision and
preserve the old snapshot's bytes. This replaces the earlier revision's 81.14%
figure; it is a different engine measurement, not an extra saving to add to it.

## Collections

| Type | Storage | Main operations |
|---|---|---|
| `SharedMap` | 16-way persistent HAMT | `get`, `has`, `set`, `delete`, `setMany`, `getMany`, `deleteMany` |
| `SharedSet` | HAMT with tagged keys | `add`, `addMany`, `has`, `delete`, `values`, `forEach` |
| `SharedList` | 32-way persistent vector with a tail block | `get`, `set`, `push`, `pushMany`, `pop`, `toArray` |
| `SharedStack` | Persistent cons nodes | `push`, `pop`, `peek` |
| `SharedQueue` | Persistent vector, tail block, and read offset | `enqueue`, `dequeue`, `peek` |
| `SharedLinkedList` | Persistent AVL block sequence and tail | `append`, `prepend`, `insertAfter`, `removeAfter`, `removeFirst`, `get` |
| `SharedDoublyLinkedList` | Persistent AVL block sequence and tail | Sequence operations, `insertBefore`, `remove`, `removeLast`, reverse iteration |
| `SharedOrderedMap` | HAMT and persistent insertion log | Map operations in insertion order |
| `SharedOrderedSet` | Ordered map with tagged keys | `add`, `has`, `delete`, iteration in insertion order |
| `SharedSortedMap` | Compressed radix index and bounded update journal | Map operations in sorted key order |
| `SharedSortedSet` | Sorted map with tagged keys | `add`, `has`, `delete`, iteration in sorted order |
| `SharedPriorityQueue` | Persistent leftist heap | `enqueue(value, priority)`, `dequeue`, `peek`, `peekPriority` |

The linked-list interfaces use balanced block trees, not physical linked lists.
Indexed reads and middle edits use a logarithmic tree path. Tail operations
avoid that path until the block is full. Vector tree access is O(log32 n).
Queue dequeue changes only the descriptor. Ordered iteration traverses the
insertion log and can inspect deleted records and perform key lookups. Hash
collisions require full-key checks. Radix costs depend on key length and shared
prefixes. These descriptions exclude encoding and returned JavaScript objects.

Primitive value types are `number`, `string`, and `boolean`. The `object` codec
uses JSON. Nested type strings select persistent values, for example:

```ts
const inner = new SharedList('number').pushMany([10, 20]);
const outer = new SharedMap('SharedList<number>').set('lane', inner);
console.log(outer.get('lane')?.get(1)); // 20
```

Sets distinguish numeric and string keys. Sorted collections use their encoded
key order by default. A custom comparator sorts the returned entries; it does
not define key equality for lookup. It adds an output array and O(n log n)
sorting work. Comparators must be pure and consistent. A comparator with mutable
external state cannot provide stable ordering. Custom comparators cannot be sent
to workers.

## Workers

Send a completed snapshot with `getWorkerData()`. The transport includes every
required arena, including nested dependencies. No transfer list is required for
shared `WebAssembly.Memory`.

```ts
// Producer
import { SharedMap, getWorkerData } from 'zerocopy';
const map = new SharedMap('number').set('answer', 42);
worker.postMessage(getWorkerData({ map }));
```

```ts
// Browser worker
import { initWorker } from 'zerocopy';
self.onmessage = async ({ data }) => {
  const { map } = await initWorker(data);
  self.postMessage(map.get('answer'));
};
```

Node workers use the same payload with `worker_threads`. New snapshots can be
sent later; old views keep their own roots and arenas. `initWorker()` returns
read-only attached collections. An update that allocates memory throws. There
is **one allocating writer per arena**, not a concurrent multi-writer allocator.

In supported Node/browser runtimes, the payload shares memory and does not copy
the collection nodes. `getWorkerData(structures, { copy: true })` requests a
used-prefix copy. Bun chooses that fallback by default. Copy mode is not
zero-copy. String and JSON values still require decoding in the reader.

Browsers need cross-origin isolation for shared memory. Serve the application
with these headers and configure its external resources accordingly:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The `browser` and Node `import` entries use one bundled engine with embedded WASM.
The Bun entry uses the TypeScript sources and packaged WASM files. The TanStack
entry shares the bundled engine with the root entry, so arena and class identity
remain consistent.

## Immutability and memory limits

Published collection handles and decoded JSON values are frozen. Updates write
only fresh payload nodes. Shared nodes remain unchanged. Allocators, caches, and
unpublished staging are internal mutable mechanisms. They are not exposed as
persistent collection APIs.

A raw `SharedArrayBuffer` is still writable by code that holds it. Do not treat
this library as a security boundary against direct memory writes, raw WASM calls,
or malformed pointer descriptors. Use trusted producers and the public API.

Memory is append-only within each arena, with a limit below 2 GiB. There is no
per-node garbage collection or automatic compaction. A live snapshot retains its
entire arena, including unreachable intermediate nodes and staging bytes. Nested
values retain their dependent arenas. Queues can retain consumed prefixes.
Ordered maps can retain deleted insertion records. Use explicit compaction and
manage arena lifetimes for long-running write workloads.

`resetMap()`, `resetSharedList()`, and the other `reset*()` functions select a new
default arena for future empty collections. Existing versions stay valid. An
update to an old collection continues to use that collection's old arena. An old
arena becomes eligible for JavaScript garbage collection only after all snapshots,
worker views, payloads, dependent arenas, and module-default references stop
referencing it. Collection timing is controlled by the runtime.

## Compact live snapshots

`compact(snapshot)` returns an equivalent collection in a fresh writable arena.
`compactMany({ ... })` compacts a group together and returns a frozen record.
All 12 collection types and nested collection values are supported. Neither
function changes or invalidates the sources. String and JSON payload bytes are
copied without parsing; nested snapshot references are rebuilt for the new arena.

```ts
import { SharedMap, SharedList, compact, compactMany } from 'zerocopy';

const map = new SharedMap('number').set('answer', 42);
const list = new SharedList('number').pushMany([1, 2, 3]);
const packedMap = compact(map);
const packedGroup = compactMany({ map, list });

console.log(packedMap.get('answer'));         // 42
console.log(packedGroup.list.toArray());     // [1, 2, 3]
console.log(map.get('answer'));              // 42; source is unchanged.
```

Compaction is an explicit copy, not a zero-copy operation. Send the resulting
snapshot to workers with `getWorkerData()` as usual. Release unused old
snapshots and worker payloads when their readers finish. A `reset*()` call can
replace a module's default arena reference, but it does not invalidate old
snapshots or force garbage collection. Any remaining holder keeps the old arena
alive. See the allocated-versus-reserved memory table above.

## Migration from v0.1 and worker format 2

Rebuild all application and worker bundles together. Recreate data rather than
loading old raw roots. Worker format 3 rejects older payloads, including those
from the previous PR candidate. Node layouts, tail descriptors, the ordered-map
log, the sorted-map index, and the WASM interface have changed.

`dispose()` and `configureAutoGC()` are deprecated no-ops. They must not be used
as a promise of immediate memory reclamation. Reset no longer invalidates old
versions. Read-only worker attachment replaces the old shared allocator behavior.

Prefer `getWorkerData()` for transport. Direct low-level readers should obtain
`getBuffer()` or `sharedMemory.buffer` at the time of use. The legacy exported
`sharedBuffer` can be stale after memory growth. The legacy scratch-based WASM
`getInfo` export is only for serialized reader examples, not concurrent use.

## Build and test

```sh
bun install
bun run build:wasm
bun run build:browser
bun run build:types
bun run typecheck
bun run test
node proofs/node-worker.mjs
bun proofs/allocation.ts
bun proofs/revision-memory.ts
bunx playwright install --with-deps chromium
bun run test:browser
```

For the measured code revision, [CI](https://github.com/natanelia/zerocopy/actions/runs/34764774487),
[the full proof workflow](https://github.com/natanelia/zerocopy/actions/runs/34764774481),
and [performance revision verification](https://github.com/natanelia/zerocopy/actions/runs/34764774485)
all passed. They cover builds, type checking, unit and snapshot tests, a real
Chromium worker, a Node worker, and allocation checks. The Node proof includes
all 12 collection types, nested snapshots, and at least 10,000 retained reads
during writer updates. These are executable checks, not formal verification of
the entire implementation.

### Reproduce the performance comparison

Use Bun 1.4.2 and AssemblyScript 0.28.20 for comparison with the recorded run.
Run the build steps above first. Run these commands from the revision checkout
in a POSIX shell. The two worktree paths must not already exist.

```sh
git worktree add --detach ../zerocopy-original 7aea44447177d37a303ab5c1b26d7c5e00e1c1f7
git worktree add --detach ../zerocopy-previous 59bd5ad9f84358f828968910c66b9a2e80c0673d
ln -s "$PWD/node_modules" ../zerocopy-original/node_modules
ln -s "$PWD/node_modules" ../zerocopy-previous/node_modules
node proofs/run-revision.mjs ../zerocopy-original ../zerocopy-previous proofs/results/reproduction.json
node proofs/run-extended.mjs ../zerocopy-original ../zerocopy-previous proofs/results/reproduction-extended.json
bun proofs/revision-memory.ts > proofs/results/reproduction-memory.json
```

The drivers write build files and benchmark inputs into the separate reference
worktrees. They do not rewrite the candidate source. The output contains the
source checksums, raw timing samples, and summaries. Keep the recorded CI summary
unchanged when saving a new run. Later source versions or other hardware can
produce different results. Inspect the recorded source checksums rather than
assuming that a moving branch reproduces this exact measurement.

## License

MIT. See [LICENSE](LICENSE).
