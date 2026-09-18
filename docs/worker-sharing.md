# Worker sharing

[Documentation](README.md) · [API](api.md) · [Memory and ownership](architecture.md)

Use `getWorkerData()` to describe snapshots and their arenas. Use `initWorker()` to attach read-only collection views in another worker. This guide covers the transport exported by `zerocopy`.

## Browser setup

Shared browser memory requires a secure context and cross-origin isolation. For a typical same-origin application, serve the document with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Check `crossOriginIsolated` in the application. Review third-party scripts, images, and frames before enabling these headers; resources may need compatible CORS or Cross-Origin-Resource-Policy settings. The [local demo server](../demo/serve.ts) supplies isolation headers.

Use a bundler that supports TypeScript module workers and `new URL(..., import.meta.url)`. Build the package first. These are two separate files. Load the library with a dynamic import after the isolation check: a static import initializes its default arenas before the module body runs.

**main.ts**

<!-- example: browser-owner -->
```ts
if (!crossOriginIsolated) {
  throw new Error('Shared worker memory requires cross-origin isolation');
}

const { SharedMap, getWorkerData } = await import('zerocopy');
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
});
worker.addEventListener('message', event => console.log(event.data));
worker.addEventListener('error', event => console.error(event.message));

const limits = new SharedMap('number').set('lane-1', 30);
worker.postMessage(getWorkerData({ limits }, { copy: false }));
// Terminate the worker when the application no longer needs it.
```

**worker.ts**

<!-- example: browser-reader -->
```ts
import { initWorker, type SharedMap, type WorkerData } from 'zerocopy';

self.addEventListener('message', async (event: MessageEvent<WorkerData>) => {
  try {
    const { limits } = await initWorker<{ limits: SharedMap<'number'> }>(event.data);
    self.postMessage({ ok: true, value: limits.get('lane-1') });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
});
```

Do not put the shared memory in a transfer list. Shared transport shares its backing storage; it does not detach it from the owner.

## Node.js

Node workers do not use browser isolation headers. Save the files below together and run `node main.mjs` from an application with the built package installed.

**main.mjs**

<!-- example: node-owner -->
```js
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { SharedMap, getWorkerData } from 'zerocopy';

const limits = new SharedMap('number').set('lane-1', 30);
const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
  workerData: getWorkerData({ limits }, { copy: false }),
});

try {
  const [value] = await once(worker, 'message');
  console.log(value); // 30
} finally {
  await worker.terminate();
}
```

**worker.mjs**

<!-- example: node-reader -->
```js
import { parentPort, workerData } from 'node:worker_threads';
import { initWorker } from 'zerocopy';

if (!parentPort) throw new Error('Run this file as a Node worker');
const { limits } = await initWorker(workerData);
parentPort.postMessage(limits.get('lane-1'));
```

## API

### getWorkerData(structures, options?)

`structures` is a record of built-in shared collections. Record keys become names in the attached result. The payload includes the dependent arenas needed by nested snapshots.

| Option | Behavior |
| --- | --- |
| `{ copy: false }` | Send shared WebAssembly memory handles and snapshot descriptors |
| `{ copy: true }` | Copy each arena's used prefix into transport data |
| Omitted | Copy mode in Bun; shared mode otherwise |

Copy mode is not zero-copy. It also does not turn the library into a non-shared-memory browser fallback: the runtime still uses WebAssembly shared-memory arenas.

A shared payload contains metadata and memory handles, not a serialized copy of every entry. Creating JavaScript descriptors, posting the message, attaching a WASM instance, and decoding read values still cost time. Do not interpret zero-copy storage transport as zero work.

### initWorker(data)

`initWorker()` returns a promise for a frozen record of attached collection handles. In TypeScript, specify the expected record type, as in the browser example. This type parameter is not runtime schema validation or authentication.

The current wire version is 4. Attachment checks the envelope, version, arena lengths, and known structure types. Use only trusted producers with compatible builds; these checks do not validate every possible hostile pointer graph.

## Publish a new version

An attached handle is a snapshot, not a subscription. Updating a collection on the owner does not change data reachable from the worker's previous root. Send a new `getWorkerData()` payload and attach it to read the new version.

Keep publication outside reducers. Include an application revision or request ID when results can arrive out of order, and reject stale results. The transport does not schedule jobs, cancel calculations, or merge concurrent writes.

There is one allocating writer per arena. An attached worker cannot allocate updates in that arena. Use `compact()` for an independent writable copy when necessary. A copy does not alter old snapshots or revoke another worker's view.

## Lifetime and limits

Retained worker views and message payloads can keep full arenas alive. Release them when a job ends. Terminating a worker does not release references that remain on the owner. Follow the [compaction guidance](architecture.md#compact-at-an-application-boundary) for long-lived data.

Custom comparator functions cannot be transported. Strings and JSON still require decoding; some runtimes copy a requested byte range before UTF-8 decoding. Objects returned by decoding are JavaScript values local to the reader, not shared object identities.

For the transport tests, see [`workers.test.ts`](../workers.test.ts), the [Node worker check](../proofs/node-worker.mjs), and the [Chromium tests](../demo/workers.browser.test.ts). Documentation checks execute the Node pair and both browser examples directly from Markdown. The browser checks cover shared transport with isolation headers and rejection before library loading without those headers.
