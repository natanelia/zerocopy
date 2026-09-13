# zerocopy

Persistent data structures for JavaScript, backed by shared WebAssembly memory.
Updates return new frozen collection handles. Existing versions remain readable.
Node and supported browsers can give read-only worker views access to the same
backing memory. Bun uses a used-prefix copy by default.

**v0.2 changes the binary layout, worker format, and memory lifetime rules.**
It is not compatible with v0.1 root pointers or WASM binaries. Read the migration
section before upgrading. Some operations are faster; some writes are slower.
The [performance and correctness report](proofs/README.md) includes all measured
regressions, raw results, and reproducible tests.

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

## Collections

| Type | Storage | Main operations |
|---|---|---|
| `SharedMap` | 32-way persistent HAMT | `get`, `has`, `set`, `delete`, `setMany`, `getMany`, `deleteMany` |
| `SharedSet` | HAMT with tagged keys | `add`, `addMany`, `has`, `delete`, `values`, `forEach` |
| `SharedList` | 32-way persistent vector | `get`, `set`, `push`, `pushMany`, `pop`, `toArray` |
| `SharedStack` | Persistent cons nodes | `push`, `pop`, `peek` |
| `SharedQueue` | Persistent vector and read offset | `enqueue`, `dequeue`, `peek` |
| `SharedLinkedList` | Indexed persistent AVL sequence | `append`, `prepend`, `insertAfter`, `removeAfter`, `removeFirst`, `get` |
| `SharedDoublyLinkedList` | Indexed persistent AVL sequence | Sequence operations, `insertBefore`, `remove`, `removeLast`, reverse iteration |
| `SharedOrderedMap` | HAMT and persistent insertion index | Map operations in insertion order |
| `SharedOrderedSet` | Ordered map with tagged keys | `add`, `has`, `delete`, iteration in insertion order |
| `SharedSortedMap` | Persistent AVL tree | Map operations in sorted key order |
| `SharedSortedSet` | Sorted map with tagged keys | `add`, `has`, `delete`, iteration in sorted order |
| `SharedPriorityQueue` | Persistent leftist heap | `enqueue(value, priority)`, `dequeue`, `peek`, `peekPriority` |

The linked list interfaces now use balanced trees. Indexed reads and sequence
updates are O(log n); append is not O(1). Vector reads and scalar updates are
O(log32 n). Queue dequeue is an O(1) descriptor operation. Ordered map iteration
can include a scan over deleted insertion slots. Hash collisions can require a
linear scan of the collision bucket. These costs exclude value encoding and
returned JavaScript allocations.

Primitive value types are `number`, `string`, and `boolean`. The `object` codec
uses JSON. Nested type strings select persistent values, for example:

```ts
const inner = new SharedList('number').pushMany([10, 20]);
const outer = new SharedMap('SharedList<number>').set('lane', inner);
console.log(outer.get('lane')?.get(1)); // 20
```

Sets distinguish numeric and string keys. Sorted collections use their encoded
key order by default. A custom comparator must be pure and consistent; a
comparator with mutable external state cannot provide stable ordering. Custom
comparators cannot be sent to workers.

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
per-node garbage collection or compaction. A live snapshot retains its entire
arena, including unreachable intermediate nodes and staging bytes. Nested values
retain their dependent arenas. Queues can retain consumed prefixes. Ordered maps
can retain deleted insertion slots. Rotate application lifetimes or rebuild
needed data into a fresh arena for long-running write workloads.

`resetMap()`, `resetSharedList()`, and the other `reset*()` functions select a new
default arena for future empty collections. Existing versions stay valid. An
update to an old collection continues to use that collection's old arena. An old
arena becomes eligible for JavaScript garbage collection only after all snapshots,
worker views, payloads, and dependent arenas stop referencing it. Collection timing
is controlled by the runtime.

## Migration from v0.1

Rebuild all application and worker bundles together. Recreate data rather than
loading old raw roots. Worker format 2 rejects older payloads. All WASM node
layouts and the mutation ABI have changed.

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
bunx playwright install --with-deps chromium
bun run test:browser
```

The full comparison uses a pinned v0.1 checkout and matched compiler flags. See
[the proof report](proofs/README.md) for the commands, exact source hashes, test
scope, measured improvements, regressions, and memory tradeoffs.

## License

MIT. See [LICENSE](LICENSE).
