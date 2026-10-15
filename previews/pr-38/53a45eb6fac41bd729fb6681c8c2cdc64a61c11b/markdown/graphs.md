# Graphs and developer tools

[All use cases](../../docs/use-cases.md) · [Nested collections](../../docs/api.md#nested-collections)

Dependency viewers, build inspectors, and diagram tools can run layout, traversal, and diagnostics against the same changing graph. Shared immutable snapshots let those components keep a stable input while the owner accepts new graph edits.

## Model the graph

Use stable string IDs for nodes. A shared map can hold metadata; another can hold adjacency lists as nested shared collections. Keep large nested collections out of JSON values: JSON does not preserve working shared collection handles.

The allocating owner publishes node and edge roots together. Each reader captures that root group before traversing it. Layout and diagnostics can return small result records or publish separate output collections from arenas they own. They must not allocate into the input owner's arena.

## Show only relevant output

The UI can inspect a selected node directly. A layout request should represent the whole layout operation, not a series of remote `get()` calls. Tag its output with the graph revision and reject it when edits make it obsolete.

Do not assume that two independently scheduled tasks capture the same revision. Pass retained snapshot handles explicitly when a group of operations must share an exact input.

## Limits

Zerocopy supplies collections and transport, not a graph algorithm, language server, conflict resolver, or parser. Long-lived analysis caches can retain old arenas. Bound cache lifetime, and compare against one graph-owning worker before adding more shared readers.

This is a design pattern. The repository does not claim a completed graph application or measured graph-specific speedup.
