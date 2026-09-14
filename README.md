# zerocopy

Persistent data structures for JavaScript, backed by shared WebAssembly memory.
Updates return new frozen collection handles. Existing versions remain readable.
Node and supported browsers can give read-only worker views access to the same
backing memory. Bun uses a used-prefix copy by default.

**This v0.2 candidate uses worker format 4 and changes the binary layout and
memory lifetime rules.** It is not compatible with v0.1 data or earlier
worker-format-2 or worker-format-3 candidates. Read the migration section before upgrading.
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
The original eight groups and operation columns are retained. Times are for
complete workloads, not single calls. Lower times are better. The ratio
columns describe Shared relative to the named reference.

Measured on September 14, 2026, in the completed [GitHub validation run](https://github.com/natanelia/zerocopy/actions/runs/34801792862).
The runner used Bun 1.4.2, Immutable.js 5.1.9, AssemblyScript 0.28.20,
Linux x64, and an AMD EPYC 7763 processor. Each result is the median of
45 samples across three process rounds, with ten warm-ups per case and
rotated library order. Results and retained bases are checked outside timing.

**The first tables exclude arena creation and use repeated reads.** Every
build still creates a fresh collection through individual persistent updates.
First-use results below include arena creation. Native builds use a fresh
mutable Map or Array. Updates to an existing native collection include one
copy per workload to preserve its base, then apply changes to that copy.
Shared and Immutable.js return new versions at each scalar update.

Build, read, peek, and scan rows process 10,000 items unless stated otherwise.
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

**The original string `SharedMap.set` row is 1.46x faster than Immutable.js,
not 2x.** The additional workloads below separate string inserts, numeric
inserts, dispersed overwrites, Unicode, and forks. Results near 1.00x are not
established improvements. These are Bun microbenchmarks, not application,
browser, or worker-transfer speed guarantees.

### First-use builds, including arena creation

This table includes Shared arena reset, new WebAssembly memory, and WASM
instance creation inside the timed workload. Inputs and sample counts are
the same as above. Immutable.js and native collections have no equivalent
arena initialization cost.

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

These tests call ordinary `set` for every update. They do not use a bulk
builder, `withMutations`, or repeated changes to just a few keys. The insert
order is a fixed shuffle. Overwrite rows change 1,000 distinct keys in a
10,000-item base. The long-prefix case uses a shared 128-character key prefix.
The fork row creates 64 separate snapshots from one base; native copies once
per fork. All returned versions are immediately readable and shareable.

Each workload and library runs in an independent process for each round.
There are 45 timed samples per cell. Setup and full output checks are outside
timing, except arena creation in the explicitly marked first-use row.

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

Numeric insertion and dispersed numeric overwrites exceed 2x Immutable.js in
this run. String insertion with shuffled keys reaches 1.99x, but string
overwrites, post-read writes, mixed operations, and first-use builds miss 2x.
Unicode construction and independent forks are slower than Immutable.js.
There is no claim of a 2x advantage for all scalar writes.

### Cold reads, larger key sets, and mixed updates

A repeated read can use a bounded process-local cache. The first-read case
attaches an empty read cache before each timed scan. The 32,768-key case
exceeds the value-cache entry limit. The mixed case changes a key, reads its
new value, and checks membership 1,024 times. The final case alternates reads
between two retained snapshots. Each cell has 45 samples.

| Workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| First read of 10,000 numeric keys | 2.5339ms | 1.1957ms | 2.12x slower | 0.3142ms | 8.07x slower |
| Read 32,768 numeric keys | 5.1745ms | 5.5349ms | 1.07x faster | 1.2018ms | 4.31x slower |
| 1,024 set/get/has sequences | 0.8499ms | 0.6452ms | 1.32x slower | 0.4404ms | 1.93x slower |
| 10,000 reads alternating two snapshots | 0.5495ms | 1.4999ms | 2.73x faster | 0.6843ms | 1.25x faster |

The fixed-order workloads here differ from the independent-process shuffled
write suite. Keep both results; do not substitute a favorable row for another
access pattern. Warm lookup gains are not uncached lookup gains.

### How the fast paths work

Scalar writes use a bounded WASM index for the first two hash digits. It
reuses resolved child pointers only while updating the exact last writer
root. Forks, interleaved maps, bulk changes, and deletes invalidate those
hints. The index uses 1,152 bytes inside the existing scratch prefix. It does
not allocate extra nodes, store another full map, or change snapshot bytes.
An allocation failure invalidates the index before a retry can use it.

The paired test checks equal allocated bytes for every sample and an equal
final payload checksum for every workload and round, with and without the
index. Thus, this write change preserves the compact node layout and its
allocation savings. It does not eliminate value encoding, version handles,
or the work needed to copy changed immutable paths.

Map branches use compact headers and bounded 12-byte immutable branch
changes. Reader hints and value caches are private and tied to an exact
root. Cache limits and costs are included in the memory test. ASCII writes
use scratch storage; Unicode and large values keep the general codec path.
Vector scans work by block. These optimizations preserve old versions.

### Evidence

The [recorded summary](proofs/results/map-set-index-summary.json) contains
scalar-write medians, memory results, source and driver checksums, and test counts.
The [raw archive](https://github.com/natanelia/zerocopy/actions/runs/34801792862/artifacts/10330799515) contains
1,800 paired scalar-write timing samples, 4,005 original-table samples,
1,080 first-use samples, 540 extra read-workload samples, 108 isolated memory
measurements, and test logs. Artifact retention ends on December 13, 2026.
The [scalar-write report](proofs/map-set-performance.md) states the remaining
limits and the comparison with the same engine without the writer index.

## Memory: Shared vs Immutable.js vs native

Lower memory is better. One MiB is 1,048,576 bytes. These measurements use
the same validated source and runner as the speed tables. They compare
libraries, not different Zerocopy releases.

The metric is **incremental post-GC V8 heap use plus full retained backing
buffers**. It includes Shared's JavaScript keys, values, caches, wrappers,
auxiliary buffers, and unused space in its active WASM memory. It is not a
comparison of Shared payload bytes with another library's complete storage.
Node.js v22.23.2 runs each library, type, size, and scenario in an isolated
process with `--expose-gc`. Results are medians of three independent processes.
Library imports, warm-up, and empty default arenas precede the heap baseline.
Startup, code memory, total process RSS, and peak temporary memory are excluded.

### One retained collection after reads

Maps use string keys and string values. Lists and stacks use numbers.
Construction uses scalar writes. All values are checked before measurement,
so Shared's normal read-cache cost is included. Only the latest handle is
retained, but Shared arenas still contain allocated intermediate nodes.

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

The 10,000-item map uses 4.1% less than Immutable.js in this run, while the
100,000-item map uses 22.7% less. The small difference at 10,000 items needs
care with heap-measurement variation. Shared still uses more memory than
native Map. The writer index adds no reserved backing memory: its small
scratch area fits in the prefix already reserved by each arena.

### Compacted collections and retained history

Compacted rows explicitly rebuild Shared's live data in a fresh arena.
The source and its default arena reference are released, then all live
values are checked again. The other libraries use their normal GC-managed
representations. Compaction time and peak memory while both arenas coexist
are not included in retained size.

History rows keep 32 snapshots of a 10,000-key map while changing one key.
Shared and Immutable.js retain versions; native Map retains 31 shallow copies
plus its original. Only the changed key is checked in these history cases.
Their cache state differs from the full-read cases above.

| Collection and workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| Map, 10,000 items; Shared compacted | 1.645 MiB | 2.051 MiB | 19.8% less | 0.898 MiB | 83.2% more |
| Map, 10,000 items; 32 snapshots | 1.054 MiB | 2.048 MiB | 48.5% less | 14.463 MiB | 92.7% less |
| OrderedMap, 10,000 items; Shared compacted | 1.747 MiB | 2.938 MiB | 40.6% less | 0.898 MiB | 94.5% more |
| OrderedMap, 10,000 items; 32 snapshots | 1.248 MiB | 2.912 MiB | 57.1% less | 14.463 MiB | 91.4% less |

Compaction is explicit, not automatic reclamation. Old snapshots, workers,
payloads, nested values, or default references can keep the source arena
alive. An arena still reserves at least 128 KiB. The tables do not imply
that every Shared collection is smaller than every alternative.
Only directly corresponding Map, OrderedMap, List/Array, and Stack/Array
representations are measured here. No missing Immutable.js type is invented.

## Collections

| Type | Storage | Main operations |
|---|---|---|
| `SharedMap` | 16-way persistent HAMT with compact branch changes | `get`, `has`, `set`, `delete`, `setMany`, `getMany`, `deleteMany` |
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

## Migration from v0.1 and older worker formats

Rebuild all application and worker bundles together. Recreate data rather than
loading old raw roots. Worker format 4 rejects older payloads, including formats 2 and 3. Node layouts, tail descriptors, the ordered-map
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

The [completed validation run](https://github.com/natanelia/zerocopy/actions/runs/34801792862)
passed 395 unit tests in 21 files, 16 Chromium tests in five files, all builds,
and core and Redux type checks. The real Node worker checked all 12 collection
types, nested values, retained sequences, repeated attachment, and at least
10,000 concurrent retained reads. Ten new writer-index tests cover forks,
collisions, Unicode, callback reentry, allocation failure, and old bytes.
These are executable checks, not machine-checked verification of the whole system.

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

To run the independent-process scalar-write comparison:

```sh
node proofs/run-map-set.mjs proofs/results/map-set.json
```

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
