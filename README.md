# zerocopy

Zero-copy immutable data structures for multi-threaded JavaScript via SharedArrayBuffer + WASM.

## Features

- Immutable persistent data structures (Map, Set, List, Stack, Queue, LinkedList, DoublyLinkedList, OrderedMap, OrderedSet, SortedMap, SortedSet, PriorityQueue)
- WASM-accelerated operations via AssemblyScript
- SharedArrayBuffer for cross-worker sharing
- Typed value support: `string`, `number`, `boolean`, `object`
- **Nested structures**: Any structure can contain other structures (e.g., `SharedMap<'SharedSet<string>'>`)
- Reference counting with automatic cleanup via FinalizationRegistry

## Installation

```bash
bun install
bun run build:wasm
```

## Usage

```typescript
import { SharedMap, SharedSet, SharedList, SharedStack, SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue } from 'zerocopy';

// SharedMap - O(log32 n) operations
const map = new SharedMap('string').set('name', 'Alice');
map.get('name'); // 'Alice'

// SharedSet - O(log32 n) operations
const set = new SharedSet<string>().add('a').add('b');
set.has('a'); // true

// SharedList - O(log32 n) random access
const list = new SharedList('number').push(1).push(2).push(3);
list.get(0); // 1

// SharedStack - O(1) LIFO operations
const stack = new SharedStack('number').push(1).push(2);
stack.peek(); // 2

// SharedQueue - O(1) FIFO operations
const queue = new SharedQueue('string').enqueue('first').enqueue('second');
queue.peek(); // 'first'

// SharedLinkedList - O(1) prepend/removeFirst, O(n) random access
const ll = new SharedLinkedList('number').append(1).prepend(0).append(2);
ll.toArray(); // [0, 1, 2]

// SharedDoublyLinkedList - O(1) prepend/append/removeFirst/removeLast
const dll = new SharedDoublyLinkedList('string').append('b').prepend('a').append('c');
dll.toArrayReverse(); // ['c', 'b', 'a']

// SharedOrderedMap - O(log32 n) with insertion order iteration
const om = new SharedOrderedMap('string').set('c', 'C').set('a', 'A').set('b', 'B');
[...om.keys()]; // ['c', 'a', 'b'] - insertion order preserved

// SharedOrderedSet - O(log32 n) with insertion order iteration
const os = new SharedOrderedSet<string>().add('z').add('a').add('m');
[...os.values()]; // ['z', 'a', 'm'] - insertion order preserved

// SharedSortedMap - O(log n) with sorted key iteration
const sm = new SharedSortedMap('number').set('c', 3).set('a', 1).set('b', 2);
[...sm.keys()]; // ['a', 'b', 'c'] - sorted order

// SharedSortedSet - O(log n) with sorted value iteration
const ss = new SharedSortedSet<string>().add('z').add('a').add('m');
[...ss.values()]; // ['a', 'm', 'z'] - sorted order

// Custom comparator for sorted structures
const customSorted = new SharedSortedMap('string', (a, b) => b.localeCompare(a));
customSorted.set('a', 'A').set('c', 'C').set('b', 'B');
[...customSorted.keys()]; // ['c', 'b', 'a'] - reverse sorted

// SharedPriorityQueue - O(log n) enqueue/dequeue, O(1) peek
const pq = new SharedPriorityQueue('string')
  .enqueue('low', 3)
  .enqueue('high', 1)
  .enqueue('med', 2);
pq.peek(); // 'high' - lowest priority first (min-heap)
pq.peekPriority(); // 1

// Max-heap priority queue
const maxPq = new SharedPriorityQueue('number', { maxHeap: true })
  .enqueue(10, 1)
  .enqueue(30, 3);
maxPq.peek(); // 30 - highest priority first
```

## Nested Structures

Any data structure can contain other data structures as values. Use the type string format `'StructureName<innerType>'`:

```typescript
// Map containing Sets
const userTags = new SharedMap<'SharedSet<string>'>('SharedSet<string>');
const tags = new SharedSet<string>().add('admin').add('active');
const userTags2 = userTags.set('user1', tags);
userTags2.get('user1')!.has('admin'); // true

// List containing Maps
const records = new SharedList<'SharedMap<number>'>('SharedMap<number>');
const record = new SharedMap('number').set('x', 10).set('y', 20);
const records2 = records.push(record);
records2.get(0)!.get('x'); // 10

// Deeply nested structures
const nested = new SharedMap<'SharedMap<SharedList<string>>'>('SharedMap<SharedList<string>>');

// Works with all structures: Stack, Queue, LinkedList, OrderedMap, SortedMap, PriorityQueue, etc.
const stack = new SharedStack<'SharedSet<number>'>('SharedSet<number>');
const queue = new SharedQueue<'SharedMap<string>'>('SharedMap<string>');
```

Nested structures use zero-copy sharing across workers - only pointers are transferred, the actual data stays in SharedArrayBuffer.

## Worker Sharing

### Seamless API (Recommended)

Use `getWorkerData()` and `initWorker()` for easy cross-worker sharing:

```typescript
// Main thread
import { SharedMap, SharedList, getWorkerData } from './shared';

const map = new SharedMap('string').set('key', 'value');
const list = new SharedList('number').push(1).push(2);

worker.postMessage(getWorkerData({ map, list }));

// Worker
import { initWorker, SharedMap, SharedList } from './shared';

const { map, list } = await initWorker<{
  map: SharedMap<'string'>;
  list: SharedList<'number'>;
}>(workerData);

map.get('key');  // 'value'
list.get(0);     // 1
```

## API

### SharedMap<T>
- `new SharedMap<T>(type)` - Create with value type ('string' | 'number' | 'boolean' | 'object')
- `set(key, value)` / `get(key)` / `has(key)` / `delete(key)`
- `setMany(entries)` / `getMany(keys)` / `deleteMany(keys)` - Batch ops
- `forEach(fn)` / `entries()` / `keys()` / `values()` / `size`

### SharedSet<T>
- `new SharedSet<T>()` - Create set for string | number
- `add(value)` / `has(value)` / `delete(value)`
- `addMany(values)` / `values()` / `forEach(fn)` / `size`

### SharedList<T>
- `new SharedList<T>(type)` - Create with value type
- `push(value)` / `pop()` / `get(index)` / `set(index, value)`
- `forEach(fn)` / `toArray()` / `size`

### SharedStack<T>
- `new SharedStack<T>(type)` - O(1) LIFO stack
- `push(value)` / `pop()` / `peek()` / `size` / `isEmpty`

### SharedQueue<T>
- `new SharedQueue<T>(type)` - O(1) FIFO queue
- `enqueue(value)` / `dequeue()` / `peek()` / `size` / `isEmpty`

### SharedLinkedList<T>
- `new SharedLinkedList<T>(type)` - Singly linked list
- `prepend(value)` / `append(value)` / `removeFirst()`
- `get(index)` / `getFirst()` / `getLast()`
- `insertAfter(index, value)` / `removeAfter(index)`
- `forEach(fn)` / `toArray()` / `size` / `isEmpty`

### SharedDoublyLinkedList<T>
- `new SharedDoublyLinkedList<T>(type)` - Doubly linked list
- `prepend(value)` / `append(value)` / `removeFirst()` / `removeLast()`
- `get(index)` / `getFirst()` / `getLast()`
- `insertAfter(index, value)` / `insertBefore(index, value)` / `remove(index)`
- `forEach(fn)` / `forEachReverse(fn)` / `toArray()` / `toArrayReverse()`
- `size` / `isEmpty`

### SharedOrderedMap<T>
- `new SharedOrderedMap<T>(type)` - Map with insertion order iteration
- `set(key, value)` / `get(key)` / `has(key)` / `delete(key)`
- `forEach(fn)` / `entries()` / `keys()` / `values()` / `size`

### SharedOrderedSet<T>
- `new SharedOrderedSet<T>()` - Set with insertion order iteration
- `add(value)` / `has(value)` / `delete(value)`
- `values()` / `forEach(fn)` / `size`

### SharedSortedMap<T>
- `new SharedSortedMap<T>(type, comparator?)` - Map with sorted key iteration
- `set(key, value)` / `get(key)` / `has(key)` / `delete(key)`
- `forEach(fn)` / `entries()` / `keys()` / `values()` / `size`
- Optional custom comparator for non-natural ordering

### SharedSortedSet<T>
- `new SharedSortedSet<T>(comparator?)` - Set with sorted value iteration
- `add(value)` / `has(value)` / `delete(value)`
- `values()` / `forEach(fn)` / `size`
- Optional custom comparator for non-natural ordering

### SharedPriorityQueue<T>
- `new SharedPriorityQueue<T>(type, options?)` - Binary heap priority queue
- `enqueue(value, priority)` / `dequeue()` / `peek()` / `peekPriority()`
- `size` / `isEmpty`
- Options: `{ maxHeap: true }` for max-heap (default is min-heap)

## Architecture

```
shared-immutable/
├── shared.ts              # Unified API with worker support
├── shared-map.ts          # HAMT-based Map implementation
├── shared-set.ts          # Set (wraps SharedMap)
├── shared-list.ts         # Vector trie List implementation
├── shared-stack.ts        # Linked list Stack
├── shared-queue.ts        # Linked list Queue
├── shared-linked-list.ts  # Singly linked list
├── shared-doubly-linked-list.ts # Doubly linked list
├── shared-ordered-map.ts  # Insertion-ordered Map
├── shared-ordered-set.ts  # Insertion-ordered Set
├── shared-sorted-map.ts   # Sorted Map (Red-Black Tree)
├── shared-sorted-set.ts   # Sorted Set
├── types.ts               # Shared type definitions
├── codec.ts               # Value encoding/decoding
├── wasm-utils.ts          # WASM loading utilities
├── shared-map.as.ts       # WASM: HAMT implementation
├── shared-list.as.ts      # WASM: Vector trie implementation
├── linked-list.as.ts      # WASM: Linked list for Stack/Queue
├── singly-linked-list.as.ts   # WASM: Singly linked list
├── doubly-linked-list.as.ts   # WASM: Doubly linked list
├── ordered-map.as.ts      # WASM: HAMT + DoublyLinkedList
├── sorted-tree.as.ts      # WASM: Red-Black Tree
├── priority-queue.as.ts   # WASM: Binary heap
└── *.wasm                 # Compiled WASM modules
```

## Scripts

```bash
bun test          # Run tests (196 tests)
bun run bench     # Run benchmarks
bun run build:wasm # Build WASM modules
```

## Performance

Key characteristics:
- **SharedMap/Set**: O(log32 n) for all operations
- **SharedList**: O(log32 n) random access, O(1) amortized push
- **SharedStack**: O(1) push/pop/peek
- **SharedQueue**: O(1) enqueue/dequeue/peek (vs O(n) for Array.shift)
- **SharedOrderedMap/Set**: O(log32 n) operations with insertion order iteration
- **SharedSortedMap/Set**: O(log n) operations with sorted iteration (Red-Black Tree)
- **SharedPriorityQueue**: O(log n) enqueue/dequeue, O(1) peek (Binary Heap)
- **SharedLinkedList**: O(1) prepend/removeFirst, O(n) random access
- **SharedDoublyLinkedList**: O(1) prepend/append/removeFirst/removeLast, O(n) random access

The main advantage is **cross-worker sharing** via SharedArrayBuffer - native structures cannot be safely shared.

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

### Reproduce the timing and memory comparisons

From the project directory, build the library and run the benchmarks:

```sh
bun install
bun run build:wasm
bun run build:browser
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

## TanStack DB Integration

SharedArrayBuffer-backed collections compatible with [TanStack DB](https://tanstack.com/db).

### SharedCollection

```typescript
import { SharedCollection } from 'zerocopy/tanstack';

let col = new SharedCollection<{ id: string; name: string }>('users');
col = col.insert({ id: '1', name: 'Alice' });
col = col.update('1', { name: 'Alicia' });
col.get('1');  // { id: '1', name: 'Alicia' }

// Zero-copy worker transfer
worker.postMessage({ root: col.getRoot(), size: col.size });
// Worker: SharedCollection.fromRoot('users', root, size)
```

### sharedCollectionConfig

Standalone TanStack DB collection with SharedArrayBuffer storage:

```typescript
import { sharedCollectionConfig } from 'zerocopy/tanstack';

const config = sharedCollectionConfig({
  id: 'todos',
  initialData: [{ id: '1', text: 'Test', completed: false }],
});

// Use with TanStack DB Collection
const collection = new Collection(config);
```

### withSharedCache

Wrap any TanStack DB sync provider (e.g., Electric) to add a SharedArrayBuffer cache layer:

```typescript
import { electricSync } from '@electric-sql/tanstack';
import { withSharedCache } from 'zerocopy/tanstack';

// Wrap Electric sync with SharedArrayBuffer cache
const cached = withSharedCache(electricSync({
  url: 'http://localhost:3000/v1/shape',
  table: 'todos',
}).sync);

// Use in TanStack DB
const collection = new Collection({ id: 'todos', ...cached });

// Fast zero-copy reads (bypasses Electric)
cached.get('todo-1');
cached.toArray();

// Share with workers
worker.postMessage(cached.getSharedState());
```

## License

MIT
