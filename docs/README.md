# Documentation

Start with the [typed task quickstart](../README.md#run-a-typed-task). It creates a worker, reads a value, updates the state, and reads the new value. Use the source package from the same revision as these docs; see [installation](../README.md#build-from-source).

## Choose your starting point

| You need | Start here |
| --- | --- |
| Tasks on the main thread, workers, or a pool | [Typed tasks and worker setups](workers.md) |
| Continuous state updates without a task system | [Automatic state sessions](worker-sessions.md) |
| Shared collections in your existing RPC/messages | [Manual snapshot transport](worker-sharing.md) |

The [task guide](workers.md) reuses one task definition for local execution, owned workers, borrowed workers, independent workers, pools, and dedicated MessagePorts. It also shows SharedWorker connections with explicit copy transport and Node worker setup. The guide states where those execution modes have different guarantees.

## Reference and integration

| Guide | Contents |
| --- | --- |
| [Collection API](api.md) | All collection classes, typed JSON, immutable updates, and nesting |
| [Task API reference](workers.md#api-reference) | Task definitions, executor options, server setup, and call options |
| [State sessions](worker-sessions.md) | Publication, subscriptions, streams, Redux sources, and cleanup |
| [Redux](redux.md) | Toolkit, selectors, DevTools, and portable state |
| [TanStack adapters](tanstack.md) | Collection and sync-cache helpers, including current limits |
| [Architecture and memory](architecture.md) | Source layout, storage, ownership, and compaction |
| [Migration to v0.2](migration.md) | Lifetime changes and incompatible worker formats |
| [Contributing](../CONTRIBUTING.md) | Build, test, documentation checks, and benchmark changes |

## Guarantees before optimization

Read [task consistency](workers.md#consistency), [cancellation and cleanup](workers.md#cancellation-timeouts-and-cleanup), and [transport costs](workers.md#cost-and-limits) before using workers for long-running work. Shared backing bytes do not imply zero allocation, concurrent writers, or exact invocation-time snapshots.

Performance results stay in the [README](../README.md#performance). The [benchmark reports](../proofs/README.md) and [recorded evidence](../proofs/results/README.md) retain the methods and source identifiers needed to reproduce earlier experiments. Collection benchmarks are not measurements of task or pool overhead.
