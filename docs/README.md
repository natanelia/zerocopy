# Documentation

Start with the [direct-read quickstart](../README.md#read-shared-state-directly). It reads shared state on the main thread and in a connected worker, then publishes an update. **Tasks are not required for reads.** Use the source package from the same revision as these docs; see [installation](../README.md#build-from-source).

## Choose your starting point

| You need | Start here |
| --- | --- |
| Direct, synchronous collection reads | [README quickstart](../README.md#read-shared-state-directly) and [Collection API](api.md) |
| Make new snapshots available in workers | [Automatic state sessions](worker-sessions.md) |
| Shared collections in your existing RPC/messages | [Manual snapshot transport](worker-sharing.md) |
| Optional calculation requests or job scheduling | [Typed tasks and worker setups](workers.md) |

Collections provide data access. Sessions deliver snapshots. Tasks schedule work. A state holder's `state.connect(worker)` makes its snapshots available in a worker; it is not the task executor function `connect()`.

The optional [task guide](workers.md) reuses one task definition for local execution, owned workers, borrowed workers, independent workers, pools, and dedicated MessagePorts. It also shows SharedWorker connections with explicit copy transport and Node worker setup. Use that layer for calculations, not as a required wrapper around each value read.

## Reference and integration

| Guide | Contents |
| --- | --- |
| [Collection API](api.md) | All collection classes, typed JSON, immutable updates, and nesting |
| [State sessions](worker-sessions.md) | Direct worker reads, publication, subscriptions, streams, Redux sources, and cleanup |
| [Optional task API reference](workers.md#api-reference) | Task definitions, executor options, server setup, and call options |
| [Redux](redux.md) | Toolkit, selectors, DevTools, and portable state |
| [TanStack adapters](tanstack.md) | Collection and sync-cache helpers, including current limits |
| [Architecture and memory](architecture.md) | Source layout, storage, ownership, and compaction |
| [Migration to v0.2](migration.md) | Lifetime changes and incompatible worker formats |
| [Contributing](../CONTRIBUTING.md) | Build, test, documentation checks, and benchmark changes |

## Guarantees before optimization

A worker reads its latest received snapshot, which can lag behind the owner. A retained snapshot does not change when a new one arrives. Shared backing bytes do not imply zero allocation or concurrent writers. See [state publication and delivery](worker-sessions.md#publication-and-delivery-are-separate) and [memory and ownership](architecture.md).

When using tasks, also read [task consistency](workers.md#consistency), [cancellation and cleanup](workers.md#cancellation-timeouts-and-cleanup), and [transport costs](workers.md#cost-and-limits). Tasks do not guarantee exact invocation-time snapshots.

Performance results stay in the [README](../README.md#performance). The [benchmark reports](../proofs/README.md) and [recorded evidence](../proofs/results/README.md) retain the methods and source identifiers needed to reproduce earlier experiments. Collection benchmarks are not measurements of task or pool overhead.
