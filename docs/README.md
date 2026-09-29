# Documentation

Zerocopy is a shared-collection library for many kinds of applications. Start with [use cases and alternatives](use-cases.md), or explore the [working log explorer](../website/content/log-explorer.md). The demo does not limit the library to logs.

Start with the [two-file quickstart](getting-started.md). It shares state with a dedicated worker and uses direct, synchronous reads on both threads.

## Choose your next step

| You need | Guide |
| --- | --- |
| Installation and your first worker | [Get started](getting-started.md) |
| Maps, lists, sets, typed objects, or nesting | [Collection API](api.md) |
| Automatic updates, subscriptions, or streams | [State sessions](worker-sessions.md) |
| Work in an existing messaging or RPC system | [Manual snapshot transport](worker-sharing.md) |
| Run calculations through typed task calls | [Task quickstart](task-quickstart.md) |
| Existing workers, pools, ports, or SharedWorker connections | [Task execution guide](workers.md) |
| Redux Toolkit, selectors, or DevTools | [Redux](redux.md) |
| TanStack collection and sync-cache helpers | [TanStack adapters](tanstack.md) |

Collections provide data access. Sessions deliver new snapshots. Tasks are an optional way to schedule work; they are not required for a read.

## Understand the guarantees

[Memory and ownership](architecture.md) covers one-writer arenas, retained snapshots, and compaction. [Task consistency](workers.md#consistency) and [cancellation](workers.md#cancellation-timeouts-and-cleanup) explain what remote calls guarantee. Existing users should read [Migration to v0.2](migration.md).

## Inspect the evidence

The [benchmark report](benchmarks.md) retains all timing and memory tables, including slower results and reproduction commands. It measures collection workloads, not task or pool overhead. [Earlier reports](../proofs/README.md) and [recorded evidence](../proofs/results/README.md) keep their own source identifiers and methods.

The examples are extracted from Markdown and checked against the built package. See [Contributing](../CONTRIBUTING.md) for build and test commands.
