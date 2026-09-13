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

### Benchmark Results (N=10000)

**Zerocopy vs Immutable.js vs native collections**, in the original table format.
`Shared` means Zerocopy. `vs Imm` and `vs Native` describe Zerocopy relative to
that reference. All times are per workload, not per individual operation.

Measured on [GitHub Actions](https://github.com/natanelia/zerocopy/actions/runs/34767533327)
on September 13, 2026, using commit
[`4d2934a`](https://github.com/natanelia/zerocopy/commit/4d2934a177c0490c01c7787656117b0861806b08):
Bun 1.4.2, Immutable.js 5.1.9, AssemblyScript 0.28.20, Linux x64,
AMD EPYC 7763. Each value is the median of 45 samples across three process
rounds. The variant order rotates between rounds. Each case has 10 warm-ups.
Output and retained-base checks run outside the timed section; reads return a
checked result rather than an unused expression.

**Native update rows include a copy.** Native builds use a fresh mutable Map or
Array. Updates to an existing native collection copy it once inside each timed
workload, then apply the changes. Zerocopy and Immutable.js return new versions.
Thus, native update timings are not the cost of an in-place mutation alone.
Build rows include Zerocopy's arena reset, as in the original benchmark. The
separate revision comparison excludes that setup. Do not compare times between
these different test methods.

Build, read, peek, and scan rows process 10,000 items, except the explicitly
limited indexed reads. `delete`, `pop`, `dequeue`, `removeFirst`, and `removeLast`
apply 10 removals to a 10,000-item base. `setMany(100)` changes 100 entries;
Immutable.js uses 100 persistent `set` calls, not `withMutations`.
`enq+deq(100)` performs 100 enqueue/dequeue pairs. Linked-list `get(0-99)` reads
100 positions; doubly linked-list front/back reads each cover 50 positions.
Map and ordered-map values are strings; sequences and sorted-map values are
numbers. Sorted-map keys are inserted in a fixed shuffled order, and the native
`keys(sorted)` row includes sorting.

**SharedMap vs Immutable.Map vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 14.9972ms | 6.0262ms | 2.49x slower | 0.4025ms | 37.26x slower |
| get | 2.5561ms | 0.9427ms | 2.71x slower | 0.1582ms | 16.16x slower |
| has | 1.9670ms | 1.3029ms | 1.51x slower | 0.4959ms | 3.97x slower |
| delete | 0.006529ms | 0.006770ms | 1.04x faster | 0.0921ms | 14.11x faster |
| setMany(100) | 0.0788ms | 0.0568ms | 1.39x slower | 0.1139ms | 1.45x faster |

**SharedList vs Immutable.List vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 6.9640ms | 1.5909ms | 4.38x slower | 0.0524ms | 132.83x slower |
| get | 0.1399ms | 0.1050ms | 1.33x slower | 0.0381ms | 3.67x slower |
| pop | 0.000805ms | 0.003240ms | 4.02x faster | 0.0559ms | 69.37x faster |
| forEach | 0.4856ms | 0.1789ms | 2.72x slower | 0.0328ms | 14.83x slower |

**SharedStack vs Immutable.Stack vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 8.2205ms | 0.2006ms | 40.98x slower | 0.0816ms | 100.71x slower |
| peek | 0.2382ms | 0.1313ms | 1.81x slower | 0.1140ms | 2.09x slower |
| pop | 0.000585ms | 0.001055ms | 1.80x faster | 0.0517ms | 88.36x faster |

**SharedQueue vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| enqueue | 8.4668ms | 0.0830ms | 102.00x slower |
| peek | 0.2477ms | 0.0789ms | 3.14x slower |
| dequeue | 0.000551ms | 0.0537ms | 97.42x faster |
| enq+deq(100) | 0.0120ms | 0.0419ms | 3.49x faster |

**SharedLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 12.0599ms | 9.3513ms | 1.29x slower |
| append | 9.1034ms | 0.0490ms | 185.97x slower |
| get(0-99) | 0.008144ms | 0.000666ms | 12.22x slower |
| removeFirst | 0.003056ms | 0.0560ms | 18.34x faster |

**SharedDoublyLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 12.0646ms | 9.3586ms | 1.29x slower |
| append | 9.7454ms | 0.0533ms | 182.81x slower |
| get(front) | 0.006268ms | 0.000341ms | 18.37x slower |
| get(back) | 0.007473ms | 0.000345ms | 21.68x slower |
| removeFirst | 0.003018ms | 0.0878ms | 29.09x faster |
| removeLast | 0.000879ms | 0.0227ms | 25.80x faster |

**SharedOrderedMap vs Immutable.OrderedMap vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 17.6527ms | 10.2759ms | 1.72x slower | 0.8526ms | 20.70x slower |
| get | 3.0094ms | 1.6540ms | 1.82x slower | 0.6434ms | 4.68x slower |
| has | 2.0607ms | 1.8913ms | 1.09x slower | 0.5614ms | 3.67x slower |
| delete | 0.006755ms | 0.0102ms | 1.50x faster | 0.0708ms | 10.47x faster |
| forEach | 1.6116ms | 0.2227ms | 7.24x slower | 0.1001ms | 16.11x slower |

**SharedSortedMap vs Native Map**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| set | 12.8450ms | 0.7639ms | 16.81x slower |
| get | 1.8042ms | 0.4767ms | 3.78x slower |
| has | 1.7830ms | 0.4370ms | 4.08x slower |
| delete | 0.006014ms | 0.1193ms | 19.84x faster |
| keys(sorted) | 2.4067ms | 0.8586ms | 2.80x slower |


The native-only groups keep the original format: no direct Immutable.js queue,
linked-list, doubly linked-list, or sorted-map type is used in this comparison.
The results include slow paths as well as fast paths. These are single-runtime
microbenchmarks, not browser, worker-transfer, or application performance claims.
Differences near 1.00x are not established improvements.

[Exact medians and source checksums](proofs/results/readme-libraries-summary.json)
are committed with this README. The
[raw CI artifact](https://github.com/natanelia/zerocopy/actions/runs/34767533327/artifacts/10320684023)
contains all 4,005 samples, the three round files, and the generated tables.
The artifact retention ends on December 12, 2026. The benchmark source is
[readme-libraries.ts](proofs/readme-libraries.ts); the
[summarizer](proofs/summarize-readme-libraries.mjs) checks the data and generates
the tables. Build samples contain one workload. Other samples average 20
workloads to reduce timer overhead. These validated figures replace the older
unchecked `benchmark.ts` readings; the operation groups and table columns stay
the same.

The **Zerocopy revision-vs-revision** comparison is kept separately in the
[revision performance report](proofs/revision-performance.md). It does not
replace the library comparison above.

## Memory and compaction measurements

The memory figures below come from the separate
[performance revision CI run](https://github.com/natanelia/zerocopy/actions/runs/34764774485)
for commit `6e0510c`, not the library timing run above. The
[recorded memory summary](proofs/results/readme-ci-summary.json) retains its data.

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

For code revision `6e0510c`, [CI](https://github.com/natanelia/zerocopy/actions/runs/34764774487),
[the full proof workflow](https://github.com/natanelia/zerocopy/actions/runs/34764774481),
and [performance revision verification](https://github.com/natanelia/zerocopy/actions/runs/34764774485)
all passed. They cover builds, type checking, unit and snapshot tests, a real
Chromium worker, a Node worker, and allocation checks. The Node proof includes
all 12 collection types, nested snapshots, and at least 10,000 retained reads
during writer updates. These are executable checks, not formal verification of
the entire implementation.

### Reproduce the library comparison

Run the original-format library comparison from the project directory after
installing dependencies and building WASM. Use the versions listed above to
compare with the recorded run. The commands generate three raw JSON files,
a validated summary, and the eight Markdown tables.

```sh
for round in 1 2 3; do
  SOURCE_COMMIT="$(git rev-parse HEAD)" ROUND="$round" SAMPLES=15 bun proofs/readme-libraries.ts
done
node proofs/summarize-readme-libraries.mjs
```

### Reproduce the revision-to-revision comparison

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
