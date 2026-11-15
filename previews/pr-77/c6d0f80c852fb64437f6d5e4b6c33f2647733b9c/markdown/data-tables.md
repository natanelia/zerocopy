# Large tables and dashboards

[All use cases](../../docs/use-cases.md) · [Collections](../../docs/api.md) · [Working multi-reader example](log-explorer.md)

A large table can have several views: a grid, a chart, a grouped summary, and an export preview. These components often need the same rows but perform different work. Sharing is useful when replicating the input becomes a measured cost.

## Data placement

Let the import or edit worker own the allocating arena. Store frequently scanned numeric fields as shared lists. Use a shared map for stable string-key lookup. Typed JSON works for irregular metadata, but decoding can create local objects; do not treat it as a direct binary record layout.

Connect independent filter and summary workers to published snapshots. Keep each calculation on one captured root group. Return row indices, bounded pages, or small aggregates instead of converting the entire collection to an ordinary array for every response.

The UI reads the visible rows directly. It does not need a remote task for each cell. Sorting produces an index order; it need not rearrange the source columns.

## Editing and result validity

A table edit creates a new version. Tag background results with their input revision and query identity. Discard results for a superseded filter or edit. Capturing a snapshot does not automatically cancel old calculations or choose which result the application should show.

Limit export history and retained views. Plan compaction or dataset replacement at a controlled boundary. Multiple readers do not remove the one-writer-per-arena rule.

## When another tool fits better

For small tables, native arrays are simpler. For SQL joins and column-oriented query planning, compare a database engine. For a central worker that already returns small results efficiently, sharing may add complexity without enough benefit.

This is an application pattern, not a table/grid component shipped by zerocopy. The [log explorer](log-explorer.md) implements its key elements: column data, two readers, bounded result pages, and a UI that reads selected rows locally.
