# How sharing works

A worker should not need a remote call for every value. With zerocopy, each connected thread has local collection handles that point into shared backing storage.

## Three things, three jobs

**Collections hold data.** A `SharedMap`, `SharedList`, or `SharedSet` has ordinary synchronous read methods. Collections work without a state holder.

**Sessions distribute snapshots.** A state holder tracks the current collection handles. A session makes new snapshots available to connected workers.

**Tasks schedule calculations.** They are optional. Use them to run a whole catalog filter or analysis, not to turn each `.get()` into a remote request.

[Watch actual snapshots in the playground](../README.md#playground).

## Connect once. Read locally.

After the [initial connection](../../docs/getting-started.md), a worker can capture its received state and read it directly:

```ts
const snapshot = shared.current;
const first = snapshot.stock.get('headphones');
const second = snapshot.stock.get('keyboard');
```

This is an excerpt inside an already connected worker. No request goes to the owner for either lookup. The library may still decode a string or JSON value locally.

## One writer. Many readers.

An arena is a region of backing memory. Each arena has one allocating writer. Other threads attach read-only snapshots. Shared memory does not make allocating writes safe from several threads.

The owner creates a new version with an immutable update. It does not modify the data reachable from an earlier root. A worker can finish a calculation on that earlier snapshot while the owner continues editing.

To change data, send a command to its owner. To create an independent writable copy, use explicit compaction. Both decisions belong in your application's ownership model.

## Current means received, not instantaneous

On the owner, `state.current` changes synchronously. A worker's `shared.current` means the newest snapshot **that worker has received**. Publication and delivery take place asynchronously.

Capturing `const snapshot = shared.current` keeps a stable read view. Reading `shared.current` again later can return a different snapshot.

A task waits for at least its requested publication. It can use a newer revision. Pool jobs select state on assignment, so a batch does not have one automatically pinned snapshot.

## Shared storage is not shared JavaScript identity

The collection's backing bytes can be shared. JavaScript handles, decoded strings, and decoded objects belong to the reading thread. A typed JSON object is not a live mutable object shared between realms.

Use `json<T>()` for typed object values. Use the [collection guide](../../docs/api.md) for supported nesting. Do not put arbitrary UI objects into a state record that expects shared collections.

## What still costs time

Connections send messages and attach views. Publications send descriptors and may create fresh WASM instances. Task calls add messages and Promises. Decoding can allocate. Appending versions retains storage until you compact and release old holders.

The benefit is avoiding a full copy of collection storage for every compatible reader—not eliminating every cost of multithreading.

Read [memory and ownership](../../docs/architecture.md) before keeping a large history. Use the [live benchmark](../README.md#benchmark-lab) to inspect one workload, not to predict all application behavior.
