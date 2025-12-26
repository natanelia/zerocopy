# shared-immutable

High-performance immutable data structures using WebAssembly with SharedArrayBuffer for multi-threaded JavaScript applications.

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
import { SharedMap, SharedSet, SharedList, SharedStack, SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue } from './shared';

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

**SharedMap vs Immutable.Map vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 6.4ms | 4.3ms | 1.5x slower | 0.6ms | 10x slower |
| get | 2.8ms | 1.0ms | 2.9x slower | 0.02ms | 180x slower |
| has | 0.8ms | 1.1ms | 1.4x faster | 0.02ms | 53x slower |
| delete | 0.007ms | 0.005ms | 1.4x slower | 0.8ms | 115x faster |
| setMany(100) | 0.06ms | 0.05ms | 1.2x slower | 0.6ms | 10x faster |

**SharedList vs Immutable.List vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 1.9ms | 2.3ms | 1.2x faster | 0.08ms | 23x slower |
| get | 0.10ms | 0.08ms | 1.2x slower | 0.01ms | 10x slower |
| pop | 0.001ms | 0.002ms | 1.6x faster | 0.12ms | 122x faster |
| forEach | 0.09ms | 0.17ms | 1.9x faster | 0.02ms | 5x slower |

**SharedStack vs Immutable.Stack vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 0.18ms | 0.13ms | 1.4x slower | 0.08ms | 2x slower |
| peek | 0.015ms | 0.019ms | 1.3x faster | 0.013ms | 1.2x slower |
| pop | 0.0003ms | 0.0002ms | 1.6x slower | 0.10ms | 341x faster |

**SharedQueue vs Native Array** (no Immutable.Queue)
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| enqueue | 0.22ms | 0.03ms | 8x slower |
| peek | 0.014ms | 0.005ms | 3x slower |
| dequeue | 0.0003ms | 0.05ms | 152x faster |
| enq+deq(100) | 0.007ms | 0.05ms | 7x faster |

> Note: Native Array.shift() is O(n), making SharedQueue dramatically faster for dequeue operations.

**SharedLinkedList vs Native Array** (N=10000)
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 0.18ms | 9.8ms | 54x faster |
| append | 0.18ms | 0.07ms | 2.5x slower |
| get(0-99) | 0.009ms | 0.0005ms | 16x slower |
| removeFirst | 0.008ms | 0.17ms | 23x faster |

**SharedDoublyLinkedList vs Native Array** (N=10000)
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 0.18ms | 9.8ms | 53x faster |
| append | 0.19ms | 0.03ms | 8x slower |
| get(front) | 0.003ms | 0.0001ms | 28x slower |
| get(back) | 0.003ms | 0.0001ms | 23x slower |
| removeFirst | 0.001ms | 0.04ms | 34x faster |
| removeLast | 0.01ms | 0.02ms | 2x faster |

> Note: Linked lists excel at prepend and remove operations where arrays require O(n) element shifting. DoublyLinkedList optimizes access from both ends.

**SharedOrderedMap vs Immutable.OrderedMap vs Native Map** (N=10000)
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 5.1ms | 8.3ms | 1.6x faster | 1.2ms | 4x slower |
| get | 3.3ms | 1.5ms | 2.2x slower | 0.02ms | 200x slower |
| has | 1.6ms | 1.4ms | 1.1x slower | 0.02ms | 100x slower |
| delete | 0.006ms | 0.009ms | 1.5x faster | 0.14ms | 25x faster |
| forEach | 3.2ms | 0.23ms | 14x slower | 0.21ms | 15x slower |

> Note: SharedOrderedMap maintains insertion order while providing O(log32 n) lookups via HAMT + DoublyLinkedList hybrid.

**SharedSortedMap vs Native Map** (N=10000)
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| set | 4.6ms | 1.1ms | 4x slower |
| get | 2.3ms | 0.02ms | 125x slower |
| has | 2.8ms | 0.02ms | 160x slower |
| delete | 0.002ms | 0.17ms | 90x faster |
| keys(sorted) | 2.1ms | 3.3ms | 1.6x faster |

> Note: SharedSortedMap uses a Red-Black Tree for O(log n) sorted operations. Native Map requires sorting on iteration which is O(n log n).

## License

MIT
