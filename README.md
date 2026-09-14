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

**Zerocopy vs Immutable.js vs native collections.** `Shared` means Zerocopy.
The original eight groups and operation columns are retained. All times are
per complete workload, not per individual operation. Lower times are better.
The ratio columns describe Shared relative to the named reference.

Measured on September 14, 2026, in the completed [GitHub validation run](https://github.com/natanelia/zerocopy/actions/runs/34793289405).
Timing uses Bun 1.4.2, Immutable.js 5.1.9, AssemblyScript 0.28.20, Linux x64,
and an AMD EPYC 9V45 processor. Each entry is the median of 45 samples from
three process rounds, with ten warm-ups per case. Each round rotates the
library order. Result checks run outside the timed sections. Read results
are consumed and checked; they are not unused expressions.

**These first tables measure operations in an initialized arena and repeated
reads.** Shared arena creation happens before each timed build. Every build
still creates a fresh collection through individual persistent updates.
The first-use tables below include arena creation inside the timer. This is
an explicit distinction, not a claim that initialization became free.

**Native update rows include a copy.** Native builds use a fresh mutable Map
or Array. An update workload on an existing native collection copies it once
inside the timer, then applies the changes. Shared and Immutable.js return
new versions. Native timing is therefore not always an in-place mutation cost.
All retained bases and final results are checked.

Build, read, peek, and scan rows process 10,000 items unless a row says otherwise.
Removal rows apply ten removals to a 10,000-item base. `setMany(100)` changes
100 entries; Immutable.js uses persistent `set`, not `withMutations`.
`enq+deq(100)` performs 100 enqueue/dequeue pairs. Linked-list indexed reads
cover 100 positions; front/back reads cover 50 each. Map and ordered-map
values are strings. Sequence and sorted-map values are numbers. Sorted keys
use a fixed shuffled insertion order; native sorted iteration includes sorting.

<!-- library-timing-tables:start -->
**SharedMap vs Immutable.Map vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 2.5176ms | 3.3243ms | 1.32x faster | 0.1793ms | 14.04x slower |
| get | 0.1433ms | 0.5325ms | 3.72x faster | 0.0700ms | 2.05x slower |
| has | 0.2493ms | 0.7487ms | 3.00x faster | 0.2174ms | 1.15x slower |
| delete | 0.003647ms | 0.002726ms | 1.34x slower | 0.0322ms | 8.84x faster |
| setMany(100) | 0.0416ms | 0.0248ms | 1.67x slower | 0.0412ms | 1.01x slower |

**SharedList vs Immutable.List vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 0.4781ms | 0.8271ms | 1.73x faster | 0.0490ms | 9.76x slower |
| get | 0.0587ms | 0.0485ms | 1.21x slower | 0.0189ms | 3.11x slower |
| pop | 0.000391ms | 0.001687ms | 4.31x faster | 0.0377ms | 96.45x faster |
| forEach | 0.0364ms | 0.0922ms | 2.53x faster | 0.0172ms | 2.11x slower |

**SharedStack vs Immutable.Stack vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 0.5624ms | 0.1341ms | 4.19x slower | 0.0483ms | 11.64x slower |
| peek | 0.0702ms | 0.0706ms | 1.01x faster | 0.0600ms | 1.17x slower |
| pop | 0.000354ms | 0.000745ms | 2.10x faster | 0.0315ms | 88.98x faster |

**SharedQueue vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| enqueue | 0.6258ms | 0.0465ms | 13.46x slower |
| peek | 0.0909ms | 0.0467ms | 1.95x slower |
| dequeue | 0.000256ms | 0.0284ms | 111.02x faster |
| enq+deq(100) | 0.006464ms | 0.0284ms | 4.39x faster |

**SharedLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 3.0895ms | 4.4120ms | 1.43x faster |
| append | 0.5374ms | 0.0185ms | 29.11x slower |
| get(0-99) | 0.003823ms | 0.000458ms | 8.34x slower |
| removeFirst | 0.001781ms | 0.0381ms | 21.41x faster |

**SharedDoublyLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 3.0961ms | 4.4078ms | 1.42x faster |
| append | 0.6071ms | 0.0189ms | 32.19x slower |
| get(front) | 0.002589ms | 0.000225ms | 11.49x slower |
| get(back) | 0.003050ms | 0.000225ms | 13.53x slower |
| removeFirst | 0.001774ms | 0.0452ms | 25.47x faster |
| removeLast | 0.000416ms | 0.0106ms | 25.36x faster |

**SharedOrderedMap vs Immutable.OrderedMap vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 3.2692ms | 5.8191ms | 1.78x faster | 0.2786ms | 11.73x slower |
| get | 0.2123ms | 0.8679ms | 4.09x faster | 0.2583ms | 1.22x faster |
| has | 0.2748ms | 1.0113ms | 3.68x faster | 0.2439ms | 1.13x slower |
| delete | 0.003783ms | 0.004929ms | 1.30x faster | 0.0186ms | 4.91x faster |
| forEach | 0.8722ms | 0.1095ms | 7.96x slower | 0.0401ms | 21.75x slower |

**SharedSortedMap vs Native Map**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| set | 3.2059ms | 0.4259ms | 7.53x slower |
| get | 0.2519ms | 0.2346ms | 1.07x slower |
| has | 0.1605ms | 0.1548ms | 1.04x slower |
| delete | 0.002905ms | 0.0179ms | 6.17x faster |
| keys(sorted) | 1.2281ms | 0.5249ms | 2.34x slower |

<!-- library-timing-tables:end -->

The repeated Map `get` and `has` rows exceed 2x Immutable.js in this run.
That does **not** establish 2x performance for all operations. Map writes,
list append, and ordered-map writes remain below that target. List indexed
reads, stack push, map batch updates, and ordered-map scans still lose to
Immutable.js in these tests. Native mutable construction is usually faster.

### First-use builds, including arena creation

The next table includes Shared arena reset, new WebAssembly memory, and
WASM instance creation in the timed workload, as the earlier benchmark did.
It uses the same three libraries, inputs, and 45-sample method. Native and
Immutable.js have no equivalent arena initialization. Small one-off builds
must pay this cost; do not substitute the initialized-arena results for them.

| Workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| SharedMap.set | 5.5816ms | 3.1420ms | 1.78x slower | 0.1745ms | 31.98x slower |
| SharedList.push | 4.2219ms | 0.8122ms | 5.20x slower | 0.0479ms | 88.17x slower |
| SharedStack.push | 4.4130ms | 0.1156ms | 38.16x slower | 0.0224ms | 197.32x slower |
| SharedQueue.enqueue | 4.4658ms | N/A | N/A | 0.0227ms | 196.52x slower |
| SharedLinkedList.prepend | 6.8818ms | N/A | N/A | 4.4026ms | 1.56x slower |
| SharedLinkedList.append | 4.8450ms | N/A | N/A | 0.0208ms | 233.26x slower |
| SharedDoublyLinkedList.prepend | 6.9103ms | N/A | N/A | 4.3595ms | 1.59x slower |
| SharedDoublyLinkedList.append | 4.8736ms | N/A | N/A | 0.0162ms | 300.56x slower |
| SharedOrderedMap.set | 7.2992ms | 5.6272ms | 1.30x slower | 0.2577ms | 28.32x slower |
| SharedSortedMap.set | 6.6584ms | N/A | N/A | 0.2927ms | 22.75x slower |

### Cold reads, larger key sets, and mixed updates

A repeated read can avoid tree traversal through a bounded process-local
cache. The following cases prevent that benefit from hiding other costs.
The first-read case attaches an empty read cache before each timed scan.
The 32,768-key case exceeds the 16,384-entry cache limit. The mixed case
changes a key, gets its new value, and checks membership 1,024 times.
Native makes one copy for the mixed batch to preserve its original state.
The final case alternates reads between two retained snapshots.

| Workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| First read of 10,000 numeric keys | 1.2365ms | 0.6794ms | 1.82x slower | 0.1391ms | 8.89x slower |
| Read 32,768 numeric keys | 2.4330ms | 2.3773ms | 1.02x slower | 0.6408ms | 3.80x slower |
| 1,024 set/get/has sequences | 0.9736ms | 0.3330ms | 2.92x slower | 0.0851ms | 11.45x slower |
| 10,000 reads alternating two snapshots | 0.1982ms | 0.7173ms | 3.62x faster | 0.2626ms | 1.32x faster |

The cold and mixed rows are still slower than Immutable.js. These remaining
costs are part of the result. Warm lookup gains must not be described as
uncached lookup gains or as guaranteed application speedups. These are Bun
microbenchmarks, not browser timings, worker-transfer timings, or a complete
application model. Small differences near 1.00x can reflect timing variation.

### How the fast paths work

The read cache stores a key's immutable leaf address and its last root.
An exact-root hit skips hashing, encoding, and tree traversal. A different
root must perform a real lookup. If it reaches the same immutable leaf,
the decoded primitive can be reused. Full key checks remain on uncached
and hash-collision paths. A cached primitive no-op update can return the
original handle without allocating a new path.

The cache is lazy and limited to 16,384 keys, 131,072 UTF-16 key code units,
and a 1 MiB logical primitive-value budget. Its address array can reach
256 KiB. JavaScript Map entries, keys, and array overhead are additional;
the memory measurements below include them. Unrelated misses do not occupy
cache entries. The cache is local to a process, not shared mutable state.

ASCII string writes use writer scratch directly instead of allocating
encoding buffers. Short records use inline byte copies and a smaller WASM
call interface. Unicode and large values keep the full encoding path.
HAMT insertion carries one size-change result up the copied path instead
of repeatedly loading child sizes. Nearby vector reads reuse one immutable
leaf address. Vector scans process blocks without nested generators.
Stack peek stores the encoded top value in the frozen handle, never a
mutable reference to the caller's object.

### Evidence

The [library evidence summary](proofs/results/hot-path-libraries-summary.json)
contains every median, ratio, memory result, environment, and checksum.
The [raw timing and memory archive](https://github.com/natanelia/zerocopy/actions/runs/34793289405/artifacts/10328518177)
contains all 4,005 primary timing samples, 1,080 first-use samples, 540 extra
workload samples, 108 isolated memory measurements, and the Node worker result.
The archive is retained until December 13, 2026. The summary and executable
benchmark drivers remain in the repository. The reproduction command is below.

## Memory: Shared vs Immutable.js vs native

These are measured retained-memory comparisons, not comparisons with an older
Zerocopy build. One MiB is 1,048,576 bytes. Lower memory is better. `vs Imm`
and `vs Native` describe Shared's retained bytes relative to each reference.
No claim of lower memory for every collection is made.

Memory uses Node.js 22.23.2 and the portable library build, with Immutable.js
5.1.9, on the same Linux x64 runner as the timing tests. It does not use Bun's
heap reporting. Each library, type, size, and scenario runs in an isolated
process with `--expose-gc`. The table shows the median of three processes.

The metric is **incremental V8 heap used after forced garbage collection,
plus the full retained backing-buffer bytes**. Shared's current WASM memory
and auxiliary typed-array buffers are counted once. JavaScript keys, values,
wrappers, caches, and index objects are included in the heap delta. Unused
space in the current WASM buffer is included; this is not just payload size.

Library imports, code warm-up, and empty default arenas are established before
the heap baseline. These figures exclude total process RSS, code memory,
startup cost, and peak temporary allocation. They are estimates of retained
data cost in this method, not an exact accounting of the entire process.

### One retained collection after reads

Maps store string keys and string values. Lists and stacks store numbers.
Each case builds through scalar updates and then checks all values. Thus,
Shared's read-cache cost is included. Intermediate handles are released, but
uncompacted Shared arenas still retain their allocated node history.

| Collection and workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| Map, 10,000 items | 4.060 MiB | 2.056 MiB | 97.5% more | 0.905 MiB | 348.5% more |
| List, 10,000 items | 0.289 MiB | 0.240 MiB | 20.4% more | 0.086 MiB | 234.5% more |
| Stack, 10,000 items | 0.298 MiB | 0.404 MiB | 26.3% less | 0.078 MiB | 279.6% more |
| OrderedMap, 10,000 items | 4.192 MiB | 2.935 MiB | 42.8% more | 0.905 MiB | 363.1% more |
| Map, 100,000 items | 33.759 MiB | 19.110 MiB | 76.7% more | 8.085 MiB | 317.6% more |
| List, 100,000 items | 1.908 MiB | 1.995 MiB | 4.4% less | 0.880 MiB | 116.7% more |
| Stack, 100,000 items | 1.675 MiB | 3.837 MiB | 56.3% less | 0.875 MiB | 91.4% more |
| OrderedMap, 100,000 items | 35.265 MiB | 27.207 MiB | 29.6% more | 8.085 MiB | 336.2% more |


Shared uses less retained memory for the 100,000-value stack in this run.
Uncompacted maps use more than Immutable.js and native Map. The list result
is also size-dependent. These results must not be replaced with live payload
bytes or with the claim that all shared-memory collections use less memory.

### Compacted collections and retained history

For compacted rows, only Shared requires an explicit live-data rebuild.
The source arena and its default reference are released, then all current
values are read again before measurement. Immutable.js and native collections
use their normal garbage-collected representations. Compaction time and the
peak memory while both arenas coexist are not part of this retained total.

For history rows, a 10,000-key map keeps 32 snapshots while updating one key.
Shared and Immutable.js retain their versions; native Map makes 31 shallow
copies and retains all 32 maps. Only the changed key is checked across these
versions, rather than warming all keys. Do not compare those cache states
as though they were identical to the full-read rows above.

| Collection and workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| Map, 10,000 items; Shared compacted | 2.101 MiB | 2.056 MiB | 2.1% more | 0.905 MiB | 132.0% more |
| Map, 10,000 items; 32 snapshots | 2.826 MiB | 2.053 MiB | 37.6% more | 14.470 MiB | 80.5% less |
| OrderedMap, 10,000 items; Shared compacted | 2.219 MiB | 2.939 MiB | 24.5% less | 0.905 MiB | 145.1% more |
| OrderedMap, 10,000 items; 32 snapshots | 2.965 MiB | 2.898 MiB | 2.3% more | 14.470 MiB | 79.5% less |


Compaction helps the ordered map beat Immutable.js for this single retained
collection. Keeping snapshots uses much less memory than copying native maps,
but Shared does not beat Immutable.js for both history cases. A compacted
arena still reserves at least 128 KiB. Old snapshots, worker payloads, nested
references, or default arenas can keep source memory alive. Compaction is
not automatic reclamation and does not release memory still in use.

Only directly corresponding Map, OrderedMap, List/Array, and Stack/Array
types are measured here. The benchmark does not invent an Immutable.js queue,
physical linked list, or sorted-map counterpart.

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
alive. See the retained-memory tables and measurement limits above.

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

The [completed validation run](https://github.com/natanelia/zerocopy/actions/runs/34793289405)
passed 373 unit tests in 19 files, 16 Chromium tests in five files, all build
steps, and both core and Redux type checks. The real Node worker checked
all 12 collection types, nested values, large retained sequences, repeated
attachment, and at least 10,000 reads during writer updates. These are
executable checks, not machine-checked verification of the whole system.

### Reproduce the timing and memory comparisons

Run the build steps above, then run this command from the project directory:

```sh
bash proofs/run-hot-path-evidence.sh
```

It records the original eight timing tables for initialized arenas, first-use
builds with arena creation, cold and mixed reads, and the three-library memory
comparison. All variants retain the same inputs and validate their results.
Raw JSON and generated tables are written below `proofs/results/hot-path/`
and `proofs/results/cold-build/`.

To run only the memory comparison after the portable build:

```sh
node proofs/library-memory.mjs proofs/results/library-memory.json
```

The driver starts isolated child processes with explicit garbage collection.
It saves all samples, heap measurements, backing-buffer totals, library
versions, and checksums. Later runtime versions or different hardware can
produce different results. Keep new runs separate from the recorded summary.

## License

MIT. See [LICENSE](LICENSE).
