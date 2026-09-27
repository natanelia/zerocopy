# Get started: share state with a worker

[README](../README.md) · [State sessions](worker-sessions.md) · [Collection API](api.md)

Create state on the main thread. Connect a dedicated worker. Both threads can then read their collection snapshots directly.

A product catalog starts with 12 headphones in stock. An inventory update marks them as sold out. The UI reads `0`, while a worker can still read `12` from its earlier snapshot. No task definition or task server is needed.

## Install the source package

These examples describe the source in this repository. They do not assume that the same API is published on npm. Build the current `main` branch:

```sh
git clone --branch main https://github.com/natanelia/zerocopy.git
cd zerocopy
bun install
bun run build:wasm
bun run build:browser
bun run build:types
npm pack --ignore-scripts
```

Install the resulting `zerocopy-0.2.0.tgz` in your application:

```sh
npm install /path/to/zerocopy-0.2.0.tgz
```

The package includes JavaScript bundles, embedded WASM, and TypeScript declarations. Your application does not need an AssemblyScript build. The repository's CI uses Bun 1.4.2 and Node.js 22.

## Set up the browser

Use a TypeScript-aware worker bundler and a secure context. Serve your application with cross-origin isolation:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Apply the policies to the page and worker scripts. Third-party resources must also satisfy the embedder policy. See [browser setup](workers.md#browser-setup) for the details.

The main-thread example checks `crossOriginIsolated` before loading the library. Keep the dynamic imports after that check: the current entry points create default shared-memory arenas when imported. Copy transport does not remove that requirement.

For Node.js, use `parentPort` instead of a browser worker endpoint. The [Node guide](workers.md#nodejs-workers) has a complete example without browser headers.

## Copy these two files

Save the files in the same directory. Load `main.ts` through your application's module entry point.

**main.ts**

<!-- example: readme-direct-owner -->
```ts
if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedMap } = await import('zerocopy');
const { createState } = await import('zerocopy/state');

const state = createState({
  stock: new SharedMap('number').set('headphones', 12),
});
console.log(state.current.stock.get('headphones')); // 12; no task or await.

const worker = new Worker(new URL('./state.worker.ts', import.meta.url), {
  type: 'module',
});
await state.connect(worker); // Attach the worker's initial snapshot once.

// An inventory update says the headphones are sold out.
state.update('stock', stock => stock.set('headphones', 0));
console.log(state.current.stock.get('headphones')); // 0 immediately on the owner.
// New snapshots are published automatically. Worker delivery is asynchronous.

// At application teardown: state.dispose(); worker.terminate();
```

**state.worker.ts**

<!-- example: readme-direct-reader -->
```ts
import type { SharedMap } from 'zerocopy';
import { connectSharedSession } from 'zerocopy/worker';

type Model = { stock: SharedMap<'number'> };
const shared = await connectSharedSession<Model>(); // Initial connection only.

const initial = shared.current;
console.log('Worker initial:', initial.stock.get('headphones')); // 12

// Subscribe only when you need to react to new snapshots.
shared.subscribe(snapshot => {
  console.log('Worker current:', snapshot.stock.get('headphones')); // 0
  console.log('Worker retained:', initial.stock.get('headphones')); // Still 12
});

// Elsewhere in this worker: shared.current.stock.get('headphones').
// Every get() is a local synchronous read. No task or per-read message.
// At worker teardown: shared.dispose();
```

The owner logs `12`, then `0`. The worker logs its initial stock `12`, the received stock `0`, and the retained stock `12`.

This is a local catalog view. A server must still validate stock and reserve items at checkout; a browser snapshot is not an inventory transaction.

## Read whenever you need a value

On the owner, use `state.current.stock.get(id)`. In the worker, use `shared.current.stock.get(id)`. These reads do not send messages. A subscription is only needed to react when a new snapshot arrives.

`state.current` changes synchronously on the owner. `shared.current` is the latest snapshot received by that worker, so it can lag behind the owner. Capture `shared.current` once when a calculation needs one stable snapshot.

The owner is the allocating writer. Workers cannot write into the owner's arena. Updates return new immutable collections; they do not change earlier snapshots.

## Add another worker

Create each worker through your existing setup, then connect them together:

```ts
await state.connect([workerA, workerB]);
```

Each worker uses the same `connectSharedSession<Model>()` setup and reads locally. A pool is not required. Browser SharedWorker connections have a different sharing boundary; use the [SharedWorker guide](workers.md#connect-a-sharedworker) for explicit copy transport.

## Clean up

At application teardown, call `state.dispose()` before `worker.terminate()`. In a worker that remains alive for other work, call `shared.dispose()` to remove its session listeners.

Disposal does not free individual collection nodes. Retained snapshots can keep their arenas alive. See [memory and compaction](architecture.md) for long-lived applications.

## Next steps

[Typed objects and nested collections](api.md) · [Subscriptions and Redux sources](worker-sessions.md) · [Optional tasks and pools](workers.md) · [Manual snapshot transport](worker-sharing.md)
