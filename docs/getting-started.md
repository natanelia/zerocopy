# Get started: share state with a worker

[README](../README.md) · [State sessions](worker-sessions.md) · [Collection API](api.md)

Create state on the main thread. Connect a dedicated worker. Both threads can then read their collection snapshots directly.

The first snapshot contains 10,000 event messages. The owner appends a timeout while a worker retains the earlier view. No task definition or task server is needed. This is a connection lesson; the [log explorer](../website/content/log-explorer.md) builds a complete investigation UI, and [other use cases](use-cases.md) apply the same pattern elsewhere.

## Before you start

Use Node.js 22.12 or later, npm, and a current browser with shared WebAssembly memory. This walkthrough uses **Vite 8.3.4**, TypeScript files, and **zerocopy 0.2.1**. Vite serves the TypeScript entry and bundles the worker; no framework is required. The [Vite guide](https://vite.dev/guide/) describes its runtime requirements.

You will see the owner and worker reach **10,001 events**, while the worker's retained snapshot stays at **10,000**. To see the result before setting up a project, open the [snapshot playground](../website/README.md#playground).

For a server-side application, start with the complete [Node.js worker example](workers.md#nodejs-workers). It does not need browser response headers.

## Install zerocopy

Create a small application with the [npm package](https://www.npmjs.com/package/zerocopy):

```sh
mkdir zerocopy-starter
cd zerocopy-starter
npm init -y
npm install --save-exact zerocopy@0.2.1
npm install --save-dev --save-exact vite@8.3.4
```

Keep the generated lockfile. The package includes JavaScript bundles, embedded WASM, and TypeScript declarations. This application does not need Bun or an AssemblyScript build.

Already have a TypeScript application? Install zerocopy there, then apply the browser settings below using your bundler's equivalent worker support.

## Set up the browser

Create **vite.config.mjs** in the project root:

<!-- example: starter-vite-config -->
```js
import { defineConfig } from 'vite';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers },
  preview: { headers },
  optimizeDeps: { include: ['zerocopy', 'zerocopy/state', 'zerocopy/worker'] },
  build: { target: 'esnext' },
  worker: { format: 'es' },
});
```

The [response headers](https://vite.dev/config/server-options.html#server-headers) enable shared memory on localhost. The [dependency list](https://vite.dev/guide/dep-pre-bundling#customizing-the-behavior) includes the worker entry so Vite can pre-bundle it before the first visit, avoiding a reload when the worker starts. The [worker format](https://vite.dev/config/worker-options.html#worker-format) preserves ES modules, including top-level `await`. This setup targets current browsers.

Create **index.html** beside it:

<!-- example: starter-html -->
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>My first shared snapshot</title>
  </head>
  <body>
    <h1>My first shared snapshot</h1>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

On a deployed host, use HTTPS and configure the same isolation headers for the page and worker scripts. Vite's local settings do not configure your production host. Third-party resources must satisfy the embedder policy too; see [browser setup](workers.md#browser-setup).

## Copy these two files

Save both files beside `index.html`. The [standard worker URL syntax](https://vite.dev/guide/features.html#web-workers) lets Vite include the worker in development and production builds.

**main.ts**

<!-- example: readme-direct-owner -->
```ts
const output = document.createElement('pre');
output.setAttribute('role', 'status');
output.textContent = 'Connecting the worker…';
document.body.append(output);

if (!crossOriginIsolated) {
  output.textContent = 'Shared memory is unavailable. Check the isolation headers and use localhost or HTTPS.';
  throw new Error('Shared worker memory requires cross-origin isolation');
}
const { SharedList } = await import('zerocopy');
const { createState } = await import('zerocopy/state');

let events = new SharedList('string');
for (let index = 0; index < 10_000; index++) {
  events = events.push(`Request completed #${index}`);
}
const state = createState({ events });
console.log(state.current.events.size); // 10000; a synchronous local read.

const worker = new Worker(new URL('./state.worker.ts', import.meta.url), {
  type: 'module',
});
window.addEventListener('pagehide', () => {
  state.dispose();
  worker.terminate();
}, { once: true });
// These small reports only display the result. Collection reads stay local.
worker.addEventListener('message', ({ data }) => {
  if (data?.type !== 'quickstart:counts') return;
  output.textContent = `Owner current: ${state.current.events.size}\n`
    + `Worker current: ${data.current}\nWorker retained: ${data.retained}`;
});
await state.connect(worker); // Attach the worker's initial snapshot once.

// A new event arrives. The earlier snapshot stays unchanged.
state.update('events', events => events.push('Upstream timeout'));
console.log(state.current.events.size); // 10001 immediately on the owner.
// New snapshots are published automatically. Worker delivery is asynchronous.
```

**state.worker.ts**

<!-- example: readme-direct-reader -->
```ts
import type { SharedList } from 'zerocopy';
import { connectSharedSession } from 'zerocopy/worker';

type Model = { events: SharedList<'string'> };
const shared = await connectSharedSession<Model>(); // Initial connection only.

const initial = shared.current;
console.log('Worker initial:', initial.events.size); // 10000

// Subscribe only when you need to react to new snapshots.
shared.subscribe(snapshot => {
  console.log('Worker current:', snapshot.events.size); // 10001
  console.log('Worker retained:', initial.events.size); // Still 10000
  self.postMessage({
    type: 'quickstart:counts',
    current: snapshot.events.size,
    retained: initial.events.size,
  });
});

// Elsewhere in this worker: shared.current.events.get(42).
// Every get() is a local synchronous read. No task or per-read message.
// At worker teardown: shared.dispose();
```

## Run it and check the result

```sh
npx vite --host 127.0.0.1
```

Open the localhost URL printed by Vite. The page should show:

```text
Owner current: 10001
Worker current: 10001
Worker retained: 10000
```

The owner logs `10000`, then `10001` in the browser console. The worker sees the updated length after publication, while its retained snapshot still has 10,000 messages. Reloading the page starts a new example; leaving it disconnects and terminates the worker.

### If the result does not appear

- **Shared memory is unavailable:** check `crossOriginIsolated` in the browser console. It must be `true`. Restart Vite after changing its config and open its localhost URL directly instead of an embedded preview or a file URL.
- **The page stays on “Connecting the worker…”:** check the browser console for a worker error. Both TypeScript files must sit beside `index.html`, and the worker URL must exactly match `state.worker.ts`.
- **A production build rejects top-level await:** keep `build.target: 'esnext'` and `worker.format: 'es'` in the config, then use a browser that supports them.

Keep the dynamic imports after the isolation check. Default arenas are allocated on first collection use; copy transport still needs that shared-memory support. [Browser setup](workers.md#browser-setup) explains the limits.

To inspect a production bundle locally, run `npx vite build`, then `npx vite preview --host 127.0.0.1`. Vite transforms TypeScript; it does not type-check it. Add your application's TypeScript checks before shipping.

## Read whenever you need a value

On the owner, use `state.current.events.get(index)`. In the worker, use `shared.current.events.get(index)`. These reads do not send messages. A subscription is only needed to react when a new snapshot arrives.

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

## Install the source package

To try unreleased changes, build the current `main` branch instead of installing from npm:

```sh
git clone --branch main https://github.com/natanelia/zerocopy.git
cd zerocopy
bun install
bun run build:wasm
bun run build:browser
bun run build:types
npm pack --ignore-scripts
```

Install the archive printed by `npm pack` in your application, for example:

```sh
npm install /path/to/zerocopy-0.2.1.tgz
```

The repository's CI uses Bun 1.4.2 and Node.js 22. The archive's version follows the source checkout.
