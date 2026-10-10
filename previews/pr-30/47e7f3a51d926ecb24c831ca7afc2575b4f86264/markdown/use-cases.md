# Where zerocopy fits

[Get started](getting-started.md) · [Collections](api.md) · [Memory and ownership](architecture.md)

Zerocopy is a shared-collection library, not a log engine, editor framework, or database. The log explorer is one working demonstration of a general access pattern: **large data, several readers, and versions that must remain stable**.

## Start with the problem, not the demo

| Application | What can be shared | Independent work | Why versions matter |
| --- | --- | --- | --- |
| Logs, traces, and observability | Event columns and indexes | Search, timeline counts, service summaries, visible-row inspection | Keep an investigation stable while ingestion continues. |
| Document, diagram, and design editors | Nodes, properties, and document indexes | Layout, validation, export, search | Finish work on an earlier document without blocking new edits. |
| Large tables and dashboards | Rows or primitive columns | Filters, grouping, charts, export previews | Different views can finish reading one consistent input. |
| Large product catalogs | Product records, category indexes, and availability | Facets, filtering, recommendations, UI inspection | Update the catalog without changing a running calculation's input. |
| Graphs and developer tools | Nodes, adjacency lists, symbols, dependencies | Traversal, layout, diagnostics, impact analysis | Keep results tied to the graph version that produced them. |
| Simulations and game tools | Published world state, entities, and event history | Analysis, inspection, planning, visual previews | Readers inspect a stable frame while the owner creates the next one. |
| General GIS and scientific tools | Feature metadata, topology, sample collections | Spatial selection, statistics, validation | Keep a stable analysis input while data is updated. |

These are design patterns, not customer testimonials, measured production case studies, or guarantees of a speedup.

## The strongest fit

Consider zerocopy when the input is large enough that copying it to several workers is a meaningful cost. Those workers should need local access to the same collections, not just a small answer from one central service.

Stable versions add value when inputs change during background work. Capture a collection record for one calculation and keep it until that calculation finishes. Use a result revision check before applying output to a newer UI state.

One thread allocates in each arena. Several readers can work independently. This is not a multi-writer mutable heap or a lock-free replacement for every JavaScript object.

## Choose the simpler alternative when it fits

| Requirement | Consider first |
| --- | --- |
| Small data on one thread | Native `Map`, arrays, and ordinary objects. |
| One worker owns data and the UI only needs small results | A data-owning worker with a small message API. |
| Existing workers already apply cheap deltas | Keep the incremental replication design; measure before replacing it. |
| A binary buffer has one owner at a time | Transfer the buffer rather than creating a shared collection model. |
| SQL scans, joins, and column analytics | A database or query engine designed for those operations. |
| Persistence, recovery, or offline storage | A storage layer. Shared memory alone is not persistence. |
| Concurrent user editing or conflict resolution | A collaboration protocol or CRDT. Zerocopy does not merge edits. |
| Audio samples, video frames, tensors, or GPU data | Their native buffer/compute APIs. General collections are not automatically the best representation. |

In particular, a log explorer can work well with a central worker, native column arrays, incremental replication, or a query engine. The live example explains shared access; the benchmark compares alternatives instead of claiming this application can only work with zerocopy.

## Explore the implementations

[Log explorer](../website/content/log-explorer.md): an implemented browser demonstration with a generated event stream, two calculation workers, direct UI reads, frozen investigations, and bounded retention.

[Editors and history](../website/content/editors.md), [large tables](../website/content/data-tables.md), [catalogs](../website/content/analytics.md), [graphs](../website/content/graphs.md), and [simulations](../website/content/simulations.md): application designs with ownership and lifetime guidance. These are not full applications shipped by the library.

## Budget for the real costs

Shared backing bytes still need JavaScript handles, worker messages, and read caches. Strings and JSON can decode into local allocations. JSON values are not direct binary field access. Immutable updates allocate new nodes; storage is append-only.

Use bounded retention and planned compaction for long-running applications. Retained snapshots can keep an entire arena alive. Browser use requires cross-origin isolation. See [memory and ownership](architecture.md) before building an unbounded stream or edit history.
