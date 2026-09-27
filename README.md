# zerocopy

## Share your data. Not copies.

**Shared, immutable collections for JavaScript and TypeScript.** Let your UI and workers read the same collection storage, without cloning the dataset for each worker.

Connect a worker. Read locally. Keep working.

<!-- example: readme-sharing-preview -->
```ts
// Main thread
await state.connect(worker);

// Inside the worker
const shared = await connectSharedSession<Model>();
const event = shared.current.events.get(42);
```

That `.get()` is a synchronous local read—not a task, message, or RPC. This is the API after setup; the [quickstart](docs/getting-started.md) has the complete files.

**[Get started](docs/getting-started.md)** · [Browse the collections](docs/api.md) · [See the benchmarks](docs/benchmarks.md)

## More work. Less data movement.

Moving a calculation to a worker should not require sending another full copy of your dataset. With zerocopy, workers read shared collection storage through familiar maps, lists, and sets.

**Share the data, not a request for every value.** Connect your workers once. Read as often as needed on each thread. Sessions publish new snapshots when the owner updates its state.

**Keep editing while workers read.** Updates create new immutable versions. A worker can finish a calculation using an earlier snapshot while the UI moves on to the next one.

**Keep your existing stack.** Use your own workers and message channels. Connect an existing store. Add typed tasks or a worker pool only when you need scheduling.

Built for applications where several threads need the same large, changing dataset. Not tied to one domain.

## What could you build?

| Application | Share the input with… |
| --- | --- |
| Log and trace explorers | Search, timeline, and summary workers while new events arrive. |
| Document and design editors | Layout, validation, and export without stopping edits. |
| Large tables and dashboards | Independent filters, grouped summaries, and charts. |
| Large product catalogs | Facets, search, and availability calculations. |
| Graphs and developer tools | Traversal, layout, and dependency analysis. |
| Simulation tools | Analysis and visualization of published world snapshots. |

[Compare use cases and alternatives](docs/use-cases.md). These are application patterns, not claimed customer deployments.

### See the pattern in action

The **[live log explorer](website/README.md#log-explorer)** searches and summarizes 100,000 generated events with real workers. Freeze an investigation while ingestion continues. The UI still reads records directly. Logs are the demonstration—not the boundary of the library.

[Read its architecture](website/content/log-explorer.md) or [compare three worker designs](website/README.md#investigation-benchmark). The same shared-snapshot pattern applies to the applications above.

## New version. Same simple API.

A collection works on its own. No state holder or task system is required.

<!-- example: map-snapshots -->
```ts
import { SharedList } from 'zerocopy';

const before = new SharedList('string').push('Request completed');
const after = before.push('Upstream timeout');

before.size; // 1 — an earlier investigation keeps its input.
after.size;  // 2 — the live view includes the new event.
```

Keep the return value from each update. Share the versions your workers need; do not rewrite your reads around remote calls.

The [collection API](docs/api.md) includes maps, sets, lists, stacks, queues, ordered and sorted collections, and priority queues. Use [`json<T>()`](docs/api.md#typed-json-objects) for typed object values, or nest shared collections to model your data.

## Start small. Use your own setup.

| What you need | Start here |
| --- | --- |
| Read shared state on the main thread and in a worker | [Two-file quickstart](docs/getting-started.md) |
| Receive updates or connect a Redux store | [State sessions](docs/worker-sessions.md) · [Redux](docs/redux.md) |
| Keep an existing RPC or message protocol | [Manual snapshot transport](docs/worker-sharing.md) |
| Run whole calculations in workers or a pool | [Optional typed tasks](docs/workers.md) |

<a id="read-shared-state-directly"></a>
<a id="build-from-source"></a>
**Ready to try it?** [Build the source package and connect your first worker](docs/getting-started.md). Browser setup and cleanup are included. These docs describe the source in this branch, not an assumed npm release.

<a id="run-a-typed-task"></a>
Tasks are an optional execution layer. Use them for catalog filtering or a background calculation—not to wrap each `.get()`. The [task guide](docs/workers.md) covers existing workers, independent workers, pools, MessagePorts, SharedWorker connections, and Node.js.

<a id="performance"></a>
<a id="memory-shared-vs-immutablejs-vs-native"></a>
<a id="reproduce-the-timing-and-memory-comparisons"></a>

## Performance, with the evidence

The main advantage is sharing collection storage across threads. Collection performance is measured separately.

In the recorded 10,000-key test, warm `SharedMap` reads were **3.99× faster than Immutable.js**, but **1.51× slower than native Map**. Cold reads and other operations have different results. These are historical Bun collection benchmarks, not worker-transfer or application speed claims.

[Read the full benchmark report](docs/benchmarks.md) for all results, memory measurements, methods, and reproduction commands. No slower results are omitted.

## Know the trade-offs

Browser use requires **cross-origin isolation**. There is **one writer per arena**; other threads read immutable snapshots. Workers receive new snapshots asynchronously, so their current view can lag behind the owner.

Shared backing storage does not mean zero allocation. Strings and JSON still need decoding. Storage is append-only; long-lived applications need a [compaction strategy](docs/architecture.md#compact-at-an-application-boundary). Bun defaults to copy transport, and browser SharedWorker connections need [explicit copy mode](docs/workers.md#connect-a-sharedworker).

For small data that stays on one thread, use a native `Map` or array. Reach for zerocopy when sharing large, versioned data is the problem you need to solve.

---

[Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
