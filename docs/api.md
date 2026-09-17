# Collection API

[Documentation](README.md) · [Worker sharing](worker-sharing.md) · [Memory](architecture.md)

Import collections from `zerocopy`. Import optional adapters from `zerocopy/redux` or `zerocopy/tanstack`.

## Updates and values

Updates return a collection rather than editing the receiver. Keep the result of `set`, `add`, `push`, `pop`, `enqueue`, `dequeue`, and removal methods. `pop()` and `dequeue()` return the remaining collection, not the removed value; call `peek()` first when you need that value.

Handles are frozen. Earlier versions remain readable. An update can reuse a handle, but equal content does not guarantee the same handle. Do not use wrapper identity as a general value-equality test.

Map keys are strings. Set values are strings or numbers. Other collections take a value-type string:

| Type | Stored value |
| --- | --- |
| `'string'` | UTF-8 text |
| `'number'` | JavaScript number |
| `'boolean'` | Boolean |
| `'object'` | JSON data, decoded into deeply frozen values |
| `'SharedMap<number>'`, for example | A nested shared collection snapshot |

The `'object'` codec is not an arbitrary-object serializer. Functions, prototypes, cycles, and object identity are not preserved as general JavaScript values. Inserting JSON data involves serialization; reading it involves decoding. `toArray()` and entry tuples are detached containers, not shared JavaScript arrays.

## Maps

| Class | Constructor | Iteration order |
| --- | --- | --- |
| `SharedMap<T>` | `new SharedMap(type)` | Unspecified |
| `SharedOrderedMap<T>` | `new SharedOrderedMap(type)` | Insertion order |
| `SharedSortedMap<T>` | `new SharedSortedMap(type, comparator?)` | Sorted keys |

All three provide `set(key, value)`, `get(key)`, `has(key)`, `delete(key)`, `entries()`, `keys()`, `values()`, `forEach(fn)`, and `size`. Map callbacks receive `(value, key)`.

`SharedMap` also provides `setMany(entries)`, `getMany(keys)`, and `deleteMany(keys)` for batch work. Missing keys return `undefined` from `get`.

<!-- example: ordered-map -->
```ts
import { SharedOrderedMap } from 'zerocopy';

const labels = new SharedOrderedMap('string')
  .set('c', 'C')
  .set('a', 'A')
  .set('b', 'B');

[...labels.keys()]; // ['c', 'a', 'b']
```

### Custom ordering

A comparator receives string keys and returns a negative number, zero, or a positive number. It must be pure and consistent. Custom ordering sorts entries locally during iteration. It is not a custom shared-memory tree ordering, and comparator functions cannot be sent to workers.

<!-- example: sorted-map -->
```ts
import { SharedSortedMap } from 'zerocopy';

const reverse = new SharedSortedMap('string', (a, b) => b.localeCompare(a))
  .set('a', 'A')
  .set('c', 'C')
  .set('b', 'B');

[...reverse.keys()]; // ['c', 'b', 'a']
```

## Sets

| Class | Constructor | Iteration order |
| --- | --- | --- |
| `SharedSet<T>` | `new SharedSet<string>()` | Unspecified |
| `SharedOrderedSet<T>` | `new SharedOrderedSet<string>()` | Insertion order |
| `SharedSortedSet<T>` | `new SharedSortedSet<string>(comparator?)` | Sorted values |

Set type parameters are value types such as `string` or `number`, not the value-type strings used by maps. Sets provide `add(value)`, `has(value)`, `delete(value)`, `values()`, `forEach(fn)`, and `size`. `SharedSet` also provides `addMany(values)`.

<!-- example: sets -->
```ts
import { SharedSet, SharedOrderedSet, SharedSortedSet } from 'zerocopy';

const tags = new SharedSet<string>().add('admin').add('active');
const insertionOrder = new SharedOrderedSet<string>().add('z').add('a').add('m');
const sorted = new SharedSortedSet<string>().add('z').add('a').add('m');

tags.has('admin');           // true
[...insertionOrder.values()]; // ['z', 'a', 'm']
[...sorted.values()];         // ['a', 'm', 'z']
```

## Lists, stacks, and queues

| Class | Update methods | Read methods and properties |
| --- | --- | --- |
| `SharedList<T>` | `push(value)`, `pop()`, `set(index, value)` | `get(index)`, `forEach(fn)`, `toArray()`, `size` |
| `SharedStack<T>` | `push(value)`, `pop()` | `peek()`, `size`, `isEmpty` |
| `SharedQueue<T>` | `enqueue(value)`, `dequeue()` | `peek()`, `size`, `isEmpty` |

Construct these with a value type, for example `new SharedList('number')`. List indexes start at zero. Stack and queue `peek()` return `undefined` when empty.

<!-- example: sequences -->
```ts
import { SharedList, SharedStack, SharedQueue } from 'zerocopy';

const list = new SharedList('number').push(1).push(2).push(3);
const stack = new SharedStack('number').push(1).push(2);
const queue = new SharedQueue('string').enqueue('first').enqueue('second');
const remaining = queue.dequeue();

list.get(0);      // 1
stack.peek();     // 2
queue.peek();     // 'first'
remaining.peek(); // 'second'
```

## Linked-list interfaces

These classes use indexed block sequences internally. Their names describe the public operations, not physical next/previous links or constant-time bounds for every end operation.

Both constructors take a value type. Both provide `prepend(value)`, `append(value)`, `removeFirst()`, `get(index)`, `getFirst()`, `getLast()`, `insertAfter(index, value)`, `forEach(fn)`, `toArray()`, `size`, and `isEmpty`.

`SharedLinkedList` also provides `removeAfter(index)`.

`SharedDoublyLinkedList` also provides `removeLast()`, `insertBefore(index, value)`, `remove(index)`, `forEachReverse(fn)`, and `toArrayReverse()`.

<!-- example: linked-lists -->
```ts
import { SharedLinkedList, SharedDoublyLinkedList } from 'zerocopy';

const numbers = new SharedLinkedList('number').append(1).prepend(0).append(2);
const letters = new SharedDoublyLinkedList('string')
  .append('b').prepend('a').append('c');

numbers.toArray();         // [0, 1, 2]
letters.toArrayReverse();  // ['c', 'b', 'a']
```

## Priority queues

`new SharedPriorityQueue(type, options?)` creates a minimum-priority queue by default. Use `{ maxHeap: true }` to remove maximum priorities first.

Methods are `enqueue(value, priority)`, `dequeue()`, `peek()`, and `peekPriority()`. Properties are `size` and `isEmpty`. `peek()` reads the value, while `peekPriority()` reads its numeric priority. Do not assume insertion-order stability for equal priorities.

<!-- example: priority-queues -->
```ts
import { SharedPriorityQueue } from 'zerocopy';

const pending = new SharedPriorityQueue('string')
  .enqueue('low', 3)
  .enqueue('high', 1)
  .enqueue('medium', 2);
const largest = new SharedPriorityQueue('number', { maxHeap: true })
  .enqueue(10, 1)
  .enqueue(30, 3);

pending.peek();         // 'high'
pending.peekPriority(); // 1
largest.peek();         // 30
```

## Nested collections

Value-bearing collections accept a type string of the form `'StructureName<innerType>'`. Sets themselves still contain only string or number values.

<!-- example: nested-collections -->
```ts
import { SharedMap, SharedSet, SharedList, SharedStack, SharedQueue } from 'zerocopy';

const tags = new SharedSet<string>().add('admin').add('active');
const users = new SharedMap<'SharedSet<string>'>('SharedSet<string>')
  .set('user-1', tags);

const record = new SharedMap('number').set('x', 10).set('y', 20);
const records = new SharedList<'SharedMap<number>'>('SharedMap<number>')
  .push(record);

const nested = new SharedMap<'SharedMap<SharedList<string>>'>(
  'SharedMap<SharedList<string>>',
);
const stack = new SharedStack<'SharedSet<number>'>('SharedSet<number>');
const queue = new SharedQueue<'SharedMap<string>'>('SharedMap<string>');

users.get('user-1')!.has('admin'); // true
records.get(0)!.get('x');         // 10
```

A parent stores the nested snapshot, not a live reference to a variable. Updating `tags` later does not change `users`. Set the new nested snapshot into a new parent version to publish it.

`getWorkerData()` includes the dependent arenas needed by nested collections. Do not send a bare root pointer. See [Worker sharing](worker-sharing.md).

## Compaction and low-level methods

`compact(snapshot)` returns the same collection type in a fresh writable arena. `compactMany({ map, list })` compacts a group together and returns a frozen record of new snapshots. Both copy live storage; neither changes the source snapshots.

Use `getWorkerData()` and `initWorker()` for transport. Per-class `toWorkerData()` and `fromWorkerData()` describe a snapshot but do not, by themselves, establish its memory or ownership. Reset functions select new default arenas for future collections; they do not erase existing snapshots. See [Architecture and memory](architecture.md).
