# Worker sessions and automatic publication

Use `zerocopy/worker` to publish immutable snapshots to workers. Use `zerocopy/redux` to connect an existing Redux store. The collection engine and the low-level `getWorkerData` / `initWorker` APIs are unchanged.

## Automatic shared state

```ts
// main.ts
import { SharedMap, SharedList } from 'zerocopy';
import { createSharedState } from 'zerocopy/worker';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const shared = createSharedState({
  map: new SharedMap('number'),
  routes: new SharedList('number'),
});
await shared.connect(worker);

shared.update('map', map => map.set('way-123', 42));
shared.update(current => ({ ...current, routes: current.routes.push(123) }));
// Both changes publish together at the next microtask. No publish() call is needed.
```

```ts
// worker.ts
import type { SharedMap, SharedList } from 'zerocopy';
import { connectSharedSession } from 'zerocopy/worker';

interface AppState {
  map: SharedMap<'number'>;
  routes: SharedList<'number'>;
}
const shared = await connectSharedSession<AppState>();
console.log(shared.current.map.get('way-123'));
const unsubscribe = shared.subscribe((snapshot, version) => {
  // All roots in snapshot belong to this publication.
  console.log(version, snapshot.map.size, snapshot.routes.size);
});
```

A single collection also works:

```ts
const shared = createSharedState(new SharedMap('number'));
shared.update(map => map.set('a', 1));
shared.value = shared.value.set('b', 2);
```

`current` and `value` change synchronously on the owner. `version` increases only when a changed snapshot is published. A no-op does not increase the version. The outer record is copied and frozen; the caller's record is not frozen or changed. Only supported zerocopy collections can be record values. Put ordinary UI state elsewhere. Records cannot have enumerable symbol keys or accessors. Nested zerocopy collections work through the existing typed collection format.

Change detection compares collection kind, arena ID, and the complete snapshot descriptor. It does not scan collection entries. Two equal-content snapshots with different roots can still cause a publication. In particular, the existing map engine does not always return the old root for an equal-value write. Return the old handle from an update recipe to guarantee a no-op, or use an explicit value guard such as `setSharedMapValue` from `zerocopy/redux`.

## Redux and other stores

```ts
import { bindRedux } from 'zerocopy/redux';

const shared = bindRedux(store, {
  workers: [geometryWorker, routingWorker],
  select: state => ({ map: state.map, routes: state.routes }),
});
await shared.ready;

store.dispatch(updateWay(...));
// The normal store subscription publishes the selected snapshots.
```

Only selected collection descriptors are compared. A sidebar change does not publish when selected snapshots are unchanged. This adapter does not replace Redux reducers or change their ownership rules. It does not import Redux at runtime. Store setup still needs the existing zerocopy middleware policy when using Redux Toolkit checks.

The generic source interface is:

```ts
interface SharedSource<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

const shared = createSharedSession({
  source: {
    getSnapshot: () => selectedState,
    subscribe: listener => stateEvents.subscribe(listener),
  },
});
await shared.connect(worker);
```

The source is read again after subscription setup, so a synchronous update during setup is not missed. Source cleanup runs on `dispose()`. An invalid later source snapshot closes the session and calls `onError`.

The library cannot observe assignment to an unrelated local variable. Use `update`, the `value` setter, or a source subscription. Do not add a Proxy around collection values.

## Publication and delivery are separate

```ts
const shared = createSharedState(initial, {
  publish: { strategy: 'microtask' }, // Default. Coalesce synchronous updates.
  delivery: 'latest',                // Default. Keep one pending snapshot per reader.
  maxPending: 32,                    // Queue bound when delivery is 'all'.
  timeoutMs: 10000,
  onError: error => console.error(error),
});
```

Use `publish: { strategy: 'immediate' }` to publish each observed change. Use `delivery: 'all'` as well when every publication must reach a connected reader. Redux enhancers can batch store notifications; this adapter cannot recover states that the store did not expose.

Each connection permits one unacknowledged snapshot. In latest mode, later publications replace the pending snapshot. In all mode, pending snapshots are queued up to `maxPending`; overflow closes the affected connection and reports an error. This is not a durable event log and does not replay history to a newly connected worker.

```ts
shared.batch(() => {
  shared.update('map', map => map.set('a', 1));
  shared.update('map', map => map.set('b', 2));
});
shared.flush();
```

`batch` controls publication. It is not a rollback transaction: successful updates remain if the callback throws. Recipes and batch callbacks must be synchronous. `flush()` publishes pending owner state now; it does not wait for remote receipt or task completion. `connect()` resolves when the reader acknowledges its first complete snapshot. An acknowledgement means receipt, not that an async application calculation has finished.

## Subscriptions and async work

`subscribe` reports later publications; use `current` for the initial state. A throwing callback is reported to `onError` without breaking other subscribers. `snapshots()` includes the current snapshot by default:

```ts
for await (const snapshot of shared.snapshots({ strategy: 'latest' })) {
  await process(snapshot);
}
```

Latest mode skips queued obsolete snapshots. It does not interrupt a running calculation. A synchronous CPU-heavy calculation also blocks that worker's message loop. Use the callback version number to reject obsolete results in application code.

For every received snapshot, use `snapshots({ strategy: 'all', capacity: 32 })`. This iterator has its own bounded queue. Overflow rejects the iterator; it does not silently drop data. Use `emitCurrent: false` to wait for future snapshots only. Pass `signal` to cancel a stream. `break`, `return()`, abort, and reader disposal remove its subscription. Consume `next()` calls sequentially.

## Manual and one-shot use

```ts
const session = createSharedSession({ map });
await session.connect(worker);
session.publish({ map: nextMap });
```

```ts
// Sender
await shareWithWorker(worker, { map });
// Receiver
const { map } = await receiveShared<{ map: SharedMap<'number'> }>();
```

The one-shot helpers close their session after the first snapshot. Returned handles remain usable because they retain their own arenas.

## Runtime and lifecycle

Browser dedicated workers use the default worker endpoint. Pass `{ endpoint: port }` for MessagePort/SharedWorker ports. Node workers must pass `{ endpoint: parentPort }` from `node:worker_threads`. The owner accepts a browser Worker, Node Worker, MessagePort, or an array of endpoints. It adds listeners without replacing application message handlers. It starts MessagePorts when needed.

Give independent sessions on the same endpoint distinct `channel` names on both sides. `default` is the default name. Startup handshakes work in either startup order. Pass an AbortSignal to `connect(endpoint, { signal })` or to `connectSharedSession` for connection cancellation.

```ts
shared.disconnect(worker); // Remove one connection.
shared.dispose();         // Remove all connections and the source subscription.
```

Disposal cancels scheduled publication and releases session references. It does not terminate a worker or close a caller-owned port. The caller retains control of those resources. Node exit/close events and message errors close affected sessions. Browser `worker.terminate()` has no matching reliable lifecycle event for this API; dispose/disconnect explicitly before termination. A pending acknowledgement also has a timeout.

Retained snapshots remain readable. Reader collection writes throw the existing read-only error. Keep one writer per arena; send edit commands to that writer rather than trying to write into an attached snapshot.

## Memory and limits

With `copy: false`, the sender shares each newly needed `WebAssembly.Memory` handle with each connection. Later frames carry root descriptors and arena IDs/used lengths. They do not copy collection bytes. A new arena after reset, compaction, or a new nested dependency is attached automatically. Memory is shared, not transferred, so no SharedArrayBuffer transfer list is used.

Browser and Node sessions default to shared mode. Bun follows the existing library fallback and defaults to `copy: true`. Copy mode copies used arena bytes on each sent snapshot; it is not zero-copy. Do not enable Bun shared mode without checking support in the target Bun version. The real shared-mode proofs cover Node and Chromium.

Browsers need a secure, cross-origin-isolated context. Configure `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and check `crossOriginIsolated`. Cross-origin assets must also satisfy the embedder policy. Copy mode does not remove the engine's need for shared WASM memory when it constructs an arena.

Transport cost depends on the number of roots and reachable arena dependencies, not only the amount of collection data. It is not a fixed byte count. This implementation reuses the existing `initWorker` decoder for each publication, with per-publication read-only arena views. Memory handles are cached, but wrapper creation and WASM instance setup are not eliminated. Unchanged top-level collection handles are reused for stable identity.

The connection registry drops memory handles that are absent from its latest acknowledged snapshot. External snapshots and the engine's historical dependency references can still retain arenas. Use explicit compaction and release unused snapshots. Sessions do not reclaim individual arena nodes.

Plain `object` values still use the engine's JSON encoding and per-reader decoding. Strings and decoded objects can allocate in each reader. The zero-copy claim concerns the shared collection backing memory, not every JavaScript allocation.

Session messages are for trusted same-application workers. Envelope checks do not authenticate a sender or validate every WASM pointer. The TypeScript reader type is a compile-time contract, not a runtime schema. This implementation does not add concurrent writers, a worker pool, task cancellation, persistence, or atomic shared-control polling.

## Verification

`worker.test.ts` covers the deterministic protocol and state transitions. `proofs/worker-sessions.mjs` uses real Node workers and a real Redux Toolkit store. `demo/sessions.browser.test.ts` uses an actual Chromium module worker. `tsconfig.worker.json` checks generated public declarations with strict TypeScript, including named interfaces and invalid API calls.

Run:

```sh
bun install
bun run build:wasm
bun run build:browser
bun run build:types
bun run typecheck
bunx tsc --noEmit -p tsconfig.worker.json
bun run test
node proofs/worker-sessions.mjs
bunx playwright install chromium
bun run test:browser
```

## Typed tasks and managed workers

Use tasks when workers need to run code against a consistent immutable snapshot. The same task definitions work locally, in an existing worker, in a managed worker, or in a pool.

```ts
// tasks.ts
import type { SharedMap } from 'zerocopy';
import { defineTasks } from 'zerocopy/worker';

export interface Model { map: SharedMap<'number'> }
export const tasks = defineTasks<Model>()({
  get({ state }, key: string) { return state.map.get(key); },
});
export type Tasks = typeof tasks;
```

```ts
// worker.ts
import { serve } from 'zerocopy/worker';
import { tasks } from './tasks';
await serve(tasks);
```

```ts
// main.ts
import { createState } from 'zerocopy/state';
import { spawn } from 'zerocopy/worker';
import type { Tasks } from './tasks';

const state = createState({ map: new SharedMap('number') });
const compute = await spawn<Tasks>(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  { state },
);
await compute.run.get('lane-1');
```

Use `connect(existingWorker, { state })` when the application owns the worker. Disposing a connected executor only detaches zerocopy. Disposing a spawned executor terminates its owned Worker, or closes its owned SharedWorker port. `local(tasks, { state })` keeps the same typed call surface without worker transport.

A pool changes only execution placement:

```ts
const compute = await pool<Tasks>(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  { state, size: 4, maxPending: 128 },
);
const values = await compute.map.get(['a', 'b', 'c']);
```

Calls flush pending state publication before dispatch. The worker captures `reader.current` when it accepts the call, so the task keeps one immutable snapshot even if newer publications arrive while an async task is running. Cancellation is cooperative: `context.signal` aborts when a cancel message can be processed. A synchronous CPU-bound task cannot process cancellation until it yields.

`SharedWorker` is accepted through its `.port`. Browser pages and SharedWorkers can belong to different agent clusters, so use `memory: 'copy'` when shared memory cannot cross that boundary. Copy mode is explicit and can be expensive for large state. There is no silent topology fallback.

Task arguments and ordinary results use structured cloning. Bound zerocopy state uses the existing snapshot transport. For large shared results, keep the result in shared state or return a small identifier rather than nesting collection handles inside arbitrary task results.
