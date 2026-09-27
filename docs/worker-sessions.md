# State sessions and automatic publication

[Documentation](README.md) · [Typed tasks](workers.md) · [Manual transport](worker-sharing.md) · [Memory and ownership](architecture.md)

Use a session when workers need the latest state or a stream of snapshots, but you already have a task scheduler or RPC system. Use [typed task executors](workers.md) when you also need request/response calls or a pool.

Sessions publish collection handles and arena information. They do not run tasks, merge edits, or allow concurrent writers.

## Automatic shared state

Follow the [browser setup](workers.md#browser-setup) first. The owner stores the current immutable collections. Connected workers receive read-only snapshots.

**main.ts**

```ts
if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const worker = new Worker(new URL('./state.worker.ts', import.meta.url), {
  type: 'module',
});
const shared = createState({ limits: new SharedMap('number') });
await shared.connect(worker);
shared.update('limits', limits => limits.set('lane-1', 30));
// The changed snapshot is published at the next microtask.
// At application teardown: shared.dispose(); worker.terminate();
```

**state.worker.ts**

```ts
import type { SharedMap } from 'zerocopy';
import { connectSharedSession } from 'zerocopy/worker';

type Model = { limits: SharedMap<'number'> };
const shared = await connectSharedSession<Model>();
console.log(shared.current.limits.get('lane-1'));
const unsubscribe = shared.subscribe((snapshot, version) => {
  console.log(version, snapshot.limits.get('lane-1'));
});
// At teardown: unsubscribe(); shared.dispose();
```

The first read is the initial snapshot and can return `undefined`; the subscription receives the later update. `subscribe()` does not replay the initial state. Use `current` for it.

`createState()` is the `zerocopy/state` alias for `createSharedState()` from `zerocopy/worker`. Both accept one collection or a plain record of collections. `StateOf<typeof shared>` extracts the holder's state type. Records cannot contain scalar UI state, getters/setters, or enumerable symbol keys.

`current` and `value` change synchronously on the owner. `version` and subscriptions advance when a changed snapshot is published. A different root can publish even if its contents are equal. Change detection compares descriptors, not every collection entry. Return the current handle to guarantee a no-op.

## Update one root or a group

Within the owner's setup above, both forms install new immutable collection handles. The recipe returns the new handle or record; `update()` itself returns `void`:

```ts
shared.update('limits', limits => limits.set('lane-1', 50));
shared.update(current => ({
  ...current,
  limits: current.limits.set('lane-1', 60).set('lane-2', 40),
}));
```

A record update publishes the complete root group. Earlier snapshots remain readable. The outer record is copied and frozen; the caller's record is not frozen. Recipes must be synchronous and must not call `update()` recursively.

A single collection also works: `createState(new SharedMap('number'))`. Update it with `shared.update(map => map.set('lane-1', 30))` or assign a new collection to `shared.value`. Keyed updates apply only to record state.

## Redux and other stores

Use `bindRedux()` to publish selected collections from an existing store. This example continues an application that already has `store` and `workers`:

```ts
import { bindRedux } from 'zerocopy/redux';

const shared = bindRedux(store, {
  workers,
  select: state => ({ limits: state.limits, routes: state.routes }),
});
await shared.ready;
// Existing dispatches publish changed selected snapshots.
// At teardown: shared.dispose();
```

The adapter does not replace Redux reducers or add a Redux runtime dependency. It skips publications when selected descriptors do not change. Existing Redux Toolkit middleware policy still applies; see the [Redux guide](redux.md).

For a task executor, use `reduxSource(store, select)` as its `state` option instead. This supplies `getSnapshot()` and `subscribe()` without creating another store.

Other stores can provide the same source interface:

```ts
interface SharedSource<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
```

Pass it to `createSharedSession({ source })`, then connect workers. A session reads again after subscribing so a synchronous change during setup is not lost. Invalid later snapshots close the session and report an error. Disposal unsubscribes the source. Assignment to an unrelated local variable is not observable; provide a source or use the holder's update API.

## Publication and delivery are separate

Default publication coalesces synchronous updates into one microtask. Default delivery keeps one latest pending snapshot per reader.

```ts
const shared = createSharedState(initial, {
  publish: { strategy: 'microtask' },
  delivery: 'latest',
  maxPending: 32,
  timeoutMs: 10000,
  onError: error => console.error(error),
});
```

This configuration snippet assumes `initial` and `createSharedState` from the application setup. Use `publish: { strategy: 'immediate' }` to publish each observed change. Use `delivery: 'all'` as well to retain each publication for connected readers. Store-level notification batching can hide intermediate states from the adapter.

Each connection permits one unacknowledged snapshot. Latest delivery replaces pending state. All delivery has a bounded queue; overflow closes the affected connection and reports an error. This is not a durable event log or historical replay for new readers.

`shared.batch(() => { ... })` batches publication, not writes with rollback. Successful updates remain if the callback throws. Batch callbacks must be synchronous. `shared.flush()` publishes pending state now; it does not wait for receipt or application work. `shared.connect(worker)` resolves after acknowledgement of the first snapshot, not after an asynchronous calculation.

## Subscriptions and async work

`subscribe(listener)` returns an unsubscribe function. A listener error is reported to `onError` without preventing other listeners from running. Async listener rejections are observed too.

Readers also provide `snapshots()`:

```ts
for await (const snapshot of shared.snapshots({ strategy: 'latest' })) {
  await process(snapshot);
}
```

Here `shared` is a connected reader and `process` is application code. The stream includes the current snapshot unless `emitCurrent: false`. Latest mode replaces queued obsolete snapshots; it does not cancel the calculation already running.

Use `{ strategy: 'all', capacity: 32 }` for a bounded queue of every received snapshot. Iterator overflow rejects rather than silently dropping data. `signal` cancels the stream, not the source. `break`, `return()`, abort, and reader disposal release the stream subscription. Call `next()` sequentially.

## Manual and one-shot use

`createSharedSession(initial)` supports manual `publish(next)`. Connect endpoints before publication. For a one-shot send, use `shareWithWorker(endpoint, value)` on the sender and `receiveShared<State>()` on the reader. Returned collection handles retain their arenas after the one-shot session closes.

For control of the wire protocol itself, use [`getWorkerData()` and `initWorker()`](worker-sharing.md), not a session.

## Runtime and lifecycle

Browser dedicated workers can use the default reader endpoint. Pass `{ endpoint: port }` for MessagePorts. Node readers pass `parentPort` from `node:worker_threads`. Owners accept a Worker, MessagePort, or an array of endpoints. Sessions start ports and add listeners without replacing application handlers.

Use matching `channel` names on each end when several sessions share an endpoint. Both startup orders are supported. `connect(endpoint, { signal })` and `connectSharedSession({ signal })` support cancellation during connection setup.

`shared.disconnect(worker)` removes one owner connection. `shared.dispose()` removes all connections, pending publication, and source subscriptions. Neither closes caller-owned ports nor terminates workers. Dispose the session before application termination. Node exit/close events and message errors close affected sessions. Browser `worker.terminate()` has no reliable matching event here; pending acknowledgements also have a timeout.

Retained snapshots remain readable. Worker writes to an attached arena throw a read-only error. Send edit commands to the allocating owner, or explicitly [compact](architecture.md#compact-at-an-application-boundary) into an independent writable arena.

## Memory and limits

With `copy: false`, each newly needed memory handle is shared with a connection. Later frames carry root descriptors, arena IDs, and used lengths. Reset, compaction, and new nested arenas cause new attachment. Backing storage is shared, not transferred or detached.

Bun defaults to `copy: true`; Node and supported browsers default to shared mode. Copy mode copies used arena prefixes and is not zero-copy. A page-to-SharedWorker connection cannot share backing memory across the agent-cluster boundary; see the [SharedWorker task example](workers.md#connect-a-sharedworker). Copy mode still requires an environment able to create the engine's shared WASM arenas.

Transport cost depends on roots and reachable arena dependencies. Each received publication currently uses `initWorker()` and creates read-only arena views/WASM instances. Memory handles and unchanged top-level handles are reused, but attachment work is not eliminated. Strings and JSON values still require decoding and can allocate in every reader.

Connection registries drop memory handles absent from their latest acknowledged snapshot. Retained snapshots and historical arena dependencies can still keep full arenas alive. Release unused holders and compact explicitly at an application boundary. Sessions do not reclaim individual arena nodes.

These are trusted same-application protocols. Envelope checks do not authenticate senders or validate every possible WASM pointer. TypeScript generics are not runtime schema validation. Sessions do not schedule tasks, persist state, or permit concurrent allocation.

## Verification

`worker.test.ts` covers protocol transitions, publication, cleanup, and queue bounds. `proofs/worker-sessions.mjs` uses real Node workers and Redux. `demo/sessions.browser.test.ts` uses a real browser module worker. `tsconfig.worker.json` checks the public declarations.

After the [source build](../README.md#build-from-source), run:

```sh
bunx tsc --noEmit -p tsconfig.worker.json
bun run test
node proofs/worker-sessions.mjs
bun run test:browser
```

Task examples have their own [documentation checks](workers.md#api-reference). Collection and transport examples keep their existing Markdown checks.
