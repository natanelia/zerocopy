# Typed tasks: local, workers, and pools

[Documentation](README.md) · [Quickstart](../README.md#run-a-typed-task) · [State sessions](worker-sessions.md) · [Manual transport](worker-sharing.md)

Define a task once. Call it locally, connect it to an existing worker, or run it in a pool. Its inputs and results keep their TypeScript types. Inside a worker, collection reads are synchronous local reads—not one RPC per `get()`.

Start with the three-file [README quickstart](../README.md#run-a-typed-task). It reads a speed limit of `30`, updates the state, and reads `50`. You do not write a message handler or call `publish()` between those operations.

The examples below reuse `tasks.ts` and `limits.worker.ts` from that quickstart. Each `main.ts` block replaces the quickstart's `main.ts`; do not append them to one file. Each example creates and cleans up its own resources.

## Choose how much zerocopy manages

| Your application | Use | Resource ownership |
| --- | --- | --- |
| No worker yet | `local(tasks, { state })` | Runs on the calling thread |
| One new worker | `spawn<Tasks>(factory, { state })` | Executor owns the worker |
| Existing worker or port | `connect<Tasks>(endpoint, { state })` | Application owns the endpoint |
| Several independent workers | One executor per worker | Each connection has its own lifecycle |
| Jobs distributed over workers | `pool<Tasks>(factoryOrWorkers, { state })` | Owns factory-created workers; borrows supplied workers |
| Updates without a task API | [State sessions](worker-sessions.md) | Application owns workers |
| Existing RPC or custom messages | [Manual transport](worker-sharing.md) | Application owns the protocol |

Use small task inputs, such as IDs and query options. Put the large collections in `state`, not in every task argument. Arguments and ordinary results use structured cloning; bound collections use the snapshot transport.

## Browser setup

Use a secure context with cross-origin isolation. The page and worker scripts must be served with the required policies. A typical same-origin application uses:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Third-party resources must also satisfy the embedder policy. Check `crossOriginIsolated` before importing the library. Its current entry points initialize default shared-memory arenas during module loading, even for `local()`. Copy mode is not a fallback for a browser that cannot create shared WASM memory.

The examples use dynamic imports after that check. `import type` is safe before the check because it is removed from JavaScript. Use a TypeScript-aware worker bundler. Keep `new Worker(new URL('./limits.worker.ts', import.meta.url), { type: 'module' })` inside the factory so the bundler can identify the worker entry. See [Vite's worker documentation](https://vite.dev/guide/features#web-workers) and the [browser transport guide](worker-sharing.md#browser-setup).

## Start on the main thread

No worker file is loaded here. `local()` uses the same task definitions and Promise-based call shape, but the work still runs on the main thread. It does not move CPU work off the UI thread.

**main.ts**

<!-- example: dx-local -->
```ts
import type { Model } from './tasks';

if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const { local } = await import('zerocopy/worker');
const { tasks } = await import('./tasks');

const state = createState<Model>({
  limits: new SharedMap('number').set('lane-1', 30),
});
const compute = local(tasks, { state });
try {
  console.log(await compute.run.speedLimit('lane-1')); // 30
  state.update('limits', limits => limits.set('lane-1', 50));
  console.log(await compute.run.speedLimit('lane-1')); // 50
} finally {
  compute.dispose();
  state.dispose();
}
```

For direct synchronous access, use `state.current.limits.get('lane-1')`. The task layer is optional.

## Connect an existing worker

Keep your worker creation, URL, and lifecycle code. Add `serve(tasks)` to its entry, then connect the existing Worker object. Zerocopy adds event listeners; it does not replace `onmessage`.

**main.ts**

<!-- example: dx-connect -->
```ts
import type { Tasks } from './tasks';

if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const { connect } = await import('zerocopy/worker');

const state = createState({
  limits: new SharedMap('number').set('lane-1', 30),
});
const worker = new Worker(new URL('./limits.worker.ts', import.meta.url), {
  type: 'module',
});
try {
  const compute = await connect<Tasks>(worker, { state });
  try {
    console.log(await compute.run.speedLimit('lane-1')); // 30
  } finally {
    compute.dispose(); // Detach zerocopy; do not terminate this worker.
  }
} finally {
  worker.terminate(); // The application owns it.
  state.dispose();
}
```

Existing listeners can still see protocol messages and must ignore messages they do not handle. Use a dedicated port when your dispatcher requires a separate channel.

## Several independent workers

Use separate executors when workers have different roles or lifetimes. They can read the same owner state. Each `spawn()` below creates a different worker; this is not pool scheduling.

**main.ts**

<!-- example: dx-individual -->
```ts
import type { Tasks } from './tasks';
import type { Executor } from 'zerocopy/worker';

if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const { spawn } = await import('zerocopy/worker');

const state = createState({
  limits: new SharedMap('number').set('lane-1', 30),
});
const clients: Executor<Tasks>[] = [];
const createWorker = () => new Worker(
  new URL('./limits.worker.ts', import.meta.url), { type: 'module' },
);
try {
  const routing = await spawn<Tasks>(createWorker, { state });
  clients.push(routing);
  const validation = await spawn<Tasks>(createWorker, { state });
  clients.push(validation);
  state.update('limits', limits => limits.set('lane-1', 50));
  const results = await Promise.all([
    routing.run.speedLimit('lane-1'),
    validation.run.speedLimit('lane-1'),
  ]);
  console.log(results); // [50, 50]
} finally {
  for (const client of clients) client.dispose();
  state.dispose();
}
```

Each call waits for at least the state revision its client sends. Separate workers are not a barrier that guarantees one identical revision during concurrent updates.

## Use a worker pool

Keep the same handlers and worker entry. Change `spawn()` to `pool()`. Use `run` for one job and `map` for ordered results from many inputs.

**main.ts**

<!-- example: dx-pool -->
```ts
import type { Tasks } from './tasks';

if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const { pool } = await import('zerocopy/worker');

const state = createState({
  limits: new SharedMap('number').set('lane-1', 30).set('lane-2', 50),
});
try {
  const compute = await pool<Tasks>(
    () => new Worker(new URL('./limits.worker.ts', import.meta.url), {
      type: 'module',
    }),
    { state, size: 4, maxPending: 32 },
  );
  try {
    const ids = Array.from({ length: 1000 }, (_, i) => `lane-${i % 2 + 1}`);
    const values = await compute.map.speedLimit(ids);
    console.log([values.length, values[0], values[999]]); // [1000, 30, 50]
  } finally {
    compute.dispose(); // Terminate all four owned workers.
  }
} finally {
  state.dispose();
}
```

An existing worker array also works: `pool<Tasks>(workers, { state })`. That form borrows the workers. Dispose the pool before terminating application-owned workers.

The pool assigns jobs to idle workers. A large `map` call feeds a bounded number of inputs instead of putting the entire array in the queue. Result order matches input order, even when execution finishes out of order.

`maxPending` limits queued pool calls. Zero disables waiting when workers are busy. Batches share this queue with other work and can reject when it is full. `chunkSize` currently limits a batch's feeder concurrency, up to the pool size; it does **not** put several jobs into one wire message. On an error, the batch stops feeding new inputs. Already-running work is not rolled back.

A queued job reads the source when it is assigned to a worker. A batch can therefore use different revisions if state changes during execution. See [Consistency](#consistency).

## Keep an existing message protocol

Transfer a dedicated `MessagePort` through your own initialization message. Serve tasks on that port. Ordinary worker traffic stays on the original channel.

**integrated.worker.ts**

<!-- example: dx-port-worker -->
```ts
/// <reference lib="webworker" />
import { serve } from 'zerocopy/worker';
import { tasks } from './tasks';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener('message', (event: MessageEvent) => {
  if (event.data?.type !== 'attach-limits') return;
  const port: MessagePort = event.data.port;
  void serve(tasks, { endpoint: port }).catch(error => {
    console.error(error);
    port.close();
  });
});
```

**main.ts**

<!-- example: dx-port-main -->
```ts
import type { Tasks } from './tasks';

if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const { connect } = await import('zerocopy/worker');

const state = createState({
  limits: new SharedMap('number').set('lane-1', 30),
});
const worker = new Worker(new URL('./integrated.worker.ts', import.meta.url), {
  type: 'module',
});
const { port1, port2 } = new MessageChannel();
try {
  worker.postMessage({ type: 'attach-limits', port: port2 }, [port2]);
  const compute = await connect<Tasks>(port1, { state });
  try {
    console.log(await compute.run.speedLimit('lane-1')); // 30
  } finally {
    compute.dispose();
  }
} finally {
  port1.close();
  worker.terminate();
  state.dispose();
}
```

Only the port goes in the transfer list. Do not transfer shared memory. For two services on one endpoint, set the same distinct `channel` value on both `serve()` and `connect()`.

Already using an RPC library? You can use [state sessions](worker-sessions.md) or [manual snapshot transport](worker-sharing.md) without adopting these task executors.

## Connect a SharedWorker

A page and its SharedWorker are in different agent clusters. Shared backing memory cannot cross that boundary. This example opts into **copy transport** and serves a separate connection for each port. Both sides still need support for the library's shared-WASM engine. See the [HTML agent-cluster rules](https://html.spec.whatwg.org/multipage/webappapis.html#agents-and-agent-clusters).

This is a shared worker **instance with client-bound state**, not one automatically merged model across tabs. Two tabs can supply different collections to the same task definitions. The current API does not provide `serveShared()` or a worker-owned singleton state service.

**limits.shared-worker.ts**

<!-- example: dx-shared-worker -->
```ts
/// <reference lib="webworker" />
import { serve } from 'zerocopy/worker';
import { tasks } from './tasks';

const scope = self as unknown as SharedWorkerGlobalScope;
scope.addEventListener('connect', (event: MessageEvent) => {
  const port = event.ports[0];
  void serve(tasks, { endpoint: port }).catch(error => {
    console.error(error);
    port.close();
  });
});
```

**main.ts**, in each tab:

<!-- example: dx-shared-main -->
```ts
import type { Tasks } from './tasks';

if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
if (typeof SharedWorker === 'undefined') {
  throw new Error('This browser does not support SharedWorker');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');
const { spawn } = await import('zerocopy/worker');

const state = createState({
  limits: new SharedMap('number').set('lane-1', 30),
});
try {
  const compute = await spawn<Tasks>(
    () => new SharedWorker(new URL('./limits.shared-worker.ts', import.meta.url), {
      type: 'module', name: 'limits-v1',
    }),
    { state, memory: 'copy' },
  );
  try {
    console.log(await compute.run.speedLimit('lane-1')); // 30
    state.update('limits', limits => limits.set('lane-1', 50));
    console.log(await compute.run.speedLimit('lane-1')); // 50
  } finally {
    compute.dispose(); // Close this client's port, not other tabs' ports.
  }
} finally {
  state.dispose();
}
```

Copy transport copies used arena bytes for each sent snapshot. It can be expensive for large, frequently changing state. There is no silent copy fallback or dedicated-worker substitution. Feature detection and testing on your target browser remain necessary.

## Node.js workers

No browser headers are needed. Save these two files together in an application with the [built package](../README.md#build-from-source), then run `node main.mjs`.

**limits.worker.mjs**

<!-- example: dx-node-worker -->
```js
import { parentPort } from 'node:worker_threads';
import { defineTasks, serve } from 'zerocopy/worker';

if (!parentPort) throw new Error('Run this file as a Node worker');
const tasks = defineTasks()({
  speedLimit({ state }, laneId) { return state.limits.get(laneId); },
});
await serve(tasks, { endpoint: parentPort });
```

**main.mjs**

<!-- example: dx-node-main -->
```js
import { Worker } from 'node:worker_threads';
import { SharedMap } from 'zerocopy';
import { createState } from 'zerocopy/state';
import { spawn } from 'zerocopy/worker';

const state = createState({
  limits: new SharedMap('number').set('lane-1', 30),
});
try {
  const compute = await spawn(
    () => new Worker(new URL('./limits.worker.mjs', import.meta.url)),
    { state },
  );
  try {
    console.log(await compute.run.speedLimit('lane-1')); // 30
    state.update('limits', limits => limits.set('lane-1', 50));
    console.log(await compute.run.speedLimit('lane-1')); // 50
  } finally {
    compute.dispose();
  }
} finally {
  state.dispose();
}
```

For TypeScript, reuse the quickstart's `tasks.ts` and `Tasks` type, compile the worker to JavaScript, and still pass `parentPort` to `serve()`.

## Type checks that help at the call site

`spawn<Tasks>()`, `connect<Tasks>()`, and `pool<Tasks>()` need only the task type. The state type is derived from it. Keep it in a type-only import so the main thread does not run worker entry code.

This example is for type checking, not execution. Each `@ts-expect-error` line must produce a compiler error.

<!-- example: dx-type-errors -->
```ts
import { SharedMap } from 'zerocopy';
import { createState } from 'zerocopy/state';
import { local } from 'zerocopy/worker';
import { tasks } from './tasks';

const state = createState({ limits: new SharedMap('number') });
const compute = local(tasks, { state });
const result: Promise<number | undefined> = compute.run.speedLimit('lane-1');
// @ts-expect-error Lane IDs are strings.
compute.run.speedLimit(123);
// @ts-expect-error This task does not exist.
compute.run.missingTask('lane-1');
// @ts-expect-error The limits map stores numbers.
state.update('limits', limits => limits.set('lane-1', 'fast'));
void result;
compute.dispose();
state.dispose();
```

Use [`json<T>()`](api.md#typed-json-objects) for typed object values. It retains field types and deeply read-only decoded data, but it is not a runtime schema validator. Remote collection writes are rejected at runtime; the current task context types do not remove every allocating collection method. Keep handlers read-only, including when testing them with `local()`.

## Use an existing store

A task client accepts a collection record or a source with `getSnapshot()` and `subscribe(listener)`. `subscribe` must return an unsubscribe function. No new store is required.

For Redux, pass `reduxSource(store, state => ({ limits: state.limits }))` from `zerocopy/redux` as the executor's `state`. Keep ordinary UI state out of that selection. For continuous publication without tasks, use [`bindRedux()`](worker-sessions.md#redux-and-other-stores).

Before a remote task is sent, the client reads `getSnapshot()` again. An update whose store notification is still pending is therefore included. This does not change how reducers run or permit concurrent writers.

## Consistency

A remote call waits for **at least** the publication it requests. Newer state may be used when transport coalesces updates. Once a handler starts, its immutable snapshot remains fixed across `await` expressions.

A pool reads state on assignment, not when the job first enters its queue. A whole batch is not snapshot-pinned. Exact invocation-time snapshots, `.at(snapshot)`, and cross-worker transactions are not implemented.

To use one fixed input for a calculation, create an executor with a retained plain collection record instead of a changing source. Do not replace those handles while the calculation runs. To reject stale results in an application, track your own edit/request revision and compare it before applying the result.

`createState()` is an alias for `createSharedState()`: `current` changes synchronously, while `version` and subscriptions follow publication. See [Publication and delivery](worker-sessions.md#publication-and-delivery-are-separate).

## Cancellation, timeouts, and cleanup

Each `run.task(input, options)` accepts `{ signal, timeoutMs }`. A zero-input task uses `run.task(undefined, options)`. A remote timeout or abort rejects the caller's Promise, but it does not prove the handler has stopped.

Handlers receive `context.signal`. Long loops must check the signal and yield to the event loop so the worker can receive a cancel message. A repeated `await Promise.resolve()` only yields to microtasks; use an event-loop yield such as `await new Promise(resolve => setTimeout(resolve, 0))` between chunks of work.

Pools keep a worker slot occupied until the handler actually settles. Local handlers must observe their signal themselves; local timeout/disposal does not forcibly stop an active handler. Neither mode rolls back side effects or automatically retries failed tasks.

| Object | `dispose()` does |
| --- | --- |
| `spawn(() => new Worker(...))` | Disconnect and terminate the owned worker |
| `spawn(() => new SharedWorker(...))` | Disconnect and close this owned client port |
| `connect(workerOrPort)` | Disconnect; leave the borrowed endpoint open |
| `pool(factory)` | Disconnect and terminate owned workers |
| `pool(existingWorkers)` | Disconnect; leave borrowed workers alive |
| State/session holder | Remove its subscriptions and connections; not per-node memory reclamation |

Use `try/finally`, as above. Dispose an executor before terminating a borrowed worker or closing a borrowed port. Dispose the state holder when no other client needs it. Retained immutable snapshots can still keep their arenas alive; see [Memory and ownership](architecture.md).

## Cost and limits

Shared transport avoids copying collection backing bytes between compatible threads. It does not eliminate task messages, Promises, root descriptors, or JS allocation. Session updates currently reconstruct read-only arenas and WASM instances. JSON/string encoding and decoding can allocate, and ordinary task results are cloned.

`memory: 'share'` requests shared transport. `memory: 'copy'` requests used-prefix copies. When omitted, task clients follow session defaults: shared in Node and supported browsers, copies in Bun. No measured near-zero task or pool overhead is claimed. The [README benchmarks](../README.md#performance) measure collection workloads, not this task API.

Task messages are for trusted same-application peers. Type parameters and protocol IDs are not authentication or validation of unknown input. Custom comparator functions cannot cross the worker boundary. Returned shared collection instances are not automatically reconstructed from task results; return small results, or use a separate snapshot session for large collection output.

## API reference

| API | Contract |
| --- | --- |
| `defineTasks<State>()(handlers)` | Type the context once; infer task inputs and awaited results |
| `local(tasks, { state })` | Same call shape, current-thread execution |
| `spawn<Tasks>(factory, options)` | Create an owned resource and wait for startup |
| `connect<Tasks>(endpoint, options)` | Borrow an endpoint and wait for startup |
| `serve(tasks, options?)` | Register handlers; resolves to a server cleanup function |
| `pool<Tasks>(factoryOrWorkers, options)` | Await pool startup; expose `run`, `map`, and `size` |

Client options are `state` (required), `channel`, `timeoutMs` (startup), `memory`, and `onError`. Pool options additionally accept `size` for a factory and `maxPending`. Server options are `endpoint`, `channel`, `timeoutMs`, and `onError`. Per-call `timeoutMs` is separate from startup timeout; pool call timeouts start when the job is dispatched, not while it waits in the queue.

The new examples are extracted from Markdown by `scripts/check-worker-docs.mjs`. It type-checks the TypeScript files, executes the documented Node pair and local example, and checks browser workers, ports, pools, isolation guards, and SharedWorker connections in Chromium. The older low-level examples keep their existing checks.
