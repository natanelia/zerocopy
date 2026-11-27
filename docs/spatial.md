# Spatial viewport queries

Import the optional `zerocopy/spatial` entry point to search 2D bounding
boxes from an owner or a dedicated worker. A packed Flatbush index and its
feature ID table live in shared buffers. Sparse edits live in a separate
immutable ZeroCopy map. This lets workers finish queries against the original
tile while the editor moves or deletes features.

```ts
import { applySpatialEdits, buildSpatialIndex, querySpatialIndex } from 'zerocopy/spatial';

const base = buildSpatialIndex([
  { id: 12, bounds: [0, 0, 3, 3] },
  { id: 41, bounds: [10, 0, 12, 3] },
], 0);
const edits = applySpatialEdits(undefined, 1, [
  { id: 12, bounds: null },
  { id: 41, bounds: [2, 0, 12, 3] },
]);

querySpatialIndex(base, [0, 0, 3, 3]);        // [12]
querySpatialIndex(base, [0, 0, 3, 3], edits); // [41]
```

Use stable unsigned 32-bit feature handles. Applications with string IDs can
keep the handle on a TanStack metadata row. Handles must stay unique for the
lifetime of a retained tile history. The result lists matching handles in
ascending order. Bounds use `[minX, minY, maxX, maxY]` in one planar coordinate
system. Edges are inclusive. Indexed boxes require finite coordinates.
Query boxes allow infinite extents. For lane centerlines and boundaries, filter
the candidates with `pathIntersectsBoxXY` to select paths touching the viewport.
Applications selecting polygon interiors need a polygon predicate.

To keep UI rows in sync with these results, publish the IDs or a worker
search promise into a [TanStack viewport collection](tanstack.md#live-viewport-membership).

### Update a fixed viewport after an edit

Once a viewport is populated, `diffSpatialViewport(viewport, edits, filter?)`
returns the sorted handles that entered or left it. Supply each edited feature's
old and new bounds. Use `null` for an absent feature. For repeated edits to
one handle, the function compares its first before box and last after box.
Boundary touches count as visible.

<!-- example: spatial-viewport-edits -->
```ts
import { diffSpatialViewport } from 'zerocopy/spatial';

const delta = diffSpatialViewport([0, 0, 10, 10], [
  { id: 7, before: [20, 0, 22, 1], after: [10, 0, 12, 1] },
  { id: 9, before: [4, 4, 6, 6], after: null },
]); // { added: [7], removed: [9] }
```

For exact path selection, pass a synchronous `(id, frame) => boolean`
predicate. It runs only when the feature's bounds intersect the viewport in
that frame. Read geometry from the snapshot identified by `'before'` or
`'after'`. Include edits to interior vertices or filter properties even when
the bounding box stays the same. A pan or a change to the selection rule
requires a fresh search across the affected features.

## Select intersecting paths

Both lanes below have bounds that overlap the viewport. The first follows
the left and top edges of its own bounds and misses the viewport entirely.
Use the index and the path snapshots from the same map revision.

```ts
import { SharedList } from 'zerocopy';
import { bboxXY, pathIntersectsBoxXY, type BoundsXY } from 'zerocopy/geometry';
import { buildSpatialIndex, querySpatialIndex } from 'zerocopy/spatial';

const paths = [
  new SharedList('number').pushMany([0, 0, 0, 4, 4, 4]),
  new SharedList('number').pushMany([0, 2, 4, 2]),
];
const index = buildSpatialIndex(paths.map((path, id) => ({ id, bounds: bboxXY(path) })));
const viewport: BoundsXY = [1, 1, 3, 3];
const candidates = querySpatialIndex(index, viewport); // [0, 1]
const visible = candidates.filter(id => pathIntersectsBoxXY(paths[id]!, viewport)); // [1]
```

The same filter works on a prepared index and inside a worker attached to
the coordinates. Recheck an edited candidate even when its bounds stay the
same. An interior vertex can move into view. For a tile storing many paths
in one numeric list, pass the path's coordinate range. [Geometry API](geometry.md#path-intersection)

## Index a GeoArrow tile

`buildLineStringIndex` builds a shared spatial index directly from packed
planar XY batches. Supply one stable unsigned 32-bit handle for each geometry
row. Multiple batches form a single searchable layer. Handles must be unique
across them, including rows with missing geometry.

```ts
import { fromGeoArrowTable } from 'zerocopy/geoarrow';
import { pathIntersectsBoxXY, type BoundsXY } from 'zerocopy/geometry';
import { buildLineStringIndex, buildLineStringLookup, getLineStringById, querySpatialIndex } from 'zerocopy/spatial';

const { batches } = fromGeoArrowTable(tile, { column: 'lanes' });
// featureIds contains the handle column for each corresponding record batch.
const layer = batches.map((paths, i) => ({ paths, ids: featureIds[i]! }));
const index = buildLineStringIndex(layer, revision);
const lookup = buildLineStringLookup(layer);
const viewport: BoundsXY = [100, 25, 240, 90];
const visible = querySpatialIndex(index, viewport).filter(id => {
  const lane = getLineStringById(lookup, id);
  return lane != null && pathIntersectsBoxXY(lane, viewport);
});
```

The builder reads the coordinate buffers in place. It counts rows with a
finite vertex to size Flatbush, then writes each envelope into the index.
Null paths, empty paths, and paths with no complete finite vertex get no
index entry. A single finite vertex gets a point envelope. For paths with
gaps the envelope spans all finite vertices, and the exact predicate treats
each gap as a break. Workers can read the shared index and geometry while
the owner builds a later revision. Keep the handle lookup aligned with the
same revision. [Import and edit packed geometry](geometry.md#open-a-tile-and-edit-one-lane)

`buildLineStringLookup` copies the handles and retains the supplied geometry
buffers. Handles can arrive in any order across uneven or empty batches.
Send `{ index, lookup }` to each worker once with `postMessage`. The
directory uses shared memory. Geometry from `fromGeoArrowTable` is also
shared, while ordinary geometry buffers follow JavaScript's structured
clone rules. Treat all published buffers and borrowed views as read-only.

`getLineStringById` returns a borrowed Float64 view, an empty view for an
empty path, `null` for a row with null geometry, and `undefined` for an
unknown handle. The directory allocates four bytes per row for sorted
handles and four bytes per batch for end offsets. Unsorted input needs an
additional four bytes per row for the original positions. The largest
handle has no effect on allocation. If the application already stores a
batch and row in its confirmed metadata, it can call `lineStringViewXY`
directly and omit the directory.

For sparse editing, keep the imported buffers for the lifetime of the tile
and store edited lanes in a `SharedMap(list('number'))`. Send the immutable
base buffers to each worker once. On a lane's first edit, copy its borrowed
view into a numeric list. Stage that replacement together with its bounds
change. After the TanStack transaction succeeds, publish the confirmed
rows, replacement paths and spatial changes in one worker session update.

A reader resolves the feature against the confirmed rows in its own
publication. If the row is missing, the lane has been deleted. Otherwise
it reads the replacement path if present, then falls back to the base
location. This keeps deletions effective when a spatial rebuild prunes old
bounds changes and lets an older reader finish with its original geometry.
[Transaction example](tanstack.md#confirm-a-group-of-edits) · [Browser replay](../proofs/spatial-editor/README.md#open-and-edit-a-geoarrow-tile)

## Join two spatial layers

`querySpatialJoin(left, right)` returns `[leftId, rightId]` pairs whose
bounding boxes overlap or touch. Each side accepts a packed index or a
prepared snapshot with its own revision. The result is sorted by left ID
then right ID. Joining a layer to itself includes matching features paired
with themselves and both orders of every overlapping pair.

Using the two paths and their `index` from [Select intersecting paths](#select-intersecting-paths), select the
lanes that touch a rectangular road area.

```ts
import { querySpatialJoin } from 'zerocopy/spatial';

const roadAreas = new Map<number, BoundsXY>([[23, [1, 1, 3, 3]]]);
const roads = buildSpatialIndex(Array.from(roadAreas, ([id, bounds]) => ({ id, bounds })));
const candidatesByRoad = querySpatialJoin(index, roads); // [[0, 23], [1, 23]]
const intersecting = querySpatialJoin(index, roads, {
  filter: (laneId, roadId) => pathIntersectsBoxXY(paths[laneId]!, roadAreas.get(roadId)!),
}); // [[1, 23]]
```

Use `{ bounds: viewport }` to limit candidate pairs to boxes whose overlap
touches the viewport. The optional synchronous `filter` receives each candidate
pair once and can check geometry from the same publications. Each call computes
the result for the supplied snapshots. Dense layers can produce one result for
every pair of features. [Publish live pair membership to TanStack](tanstack.md#live-spatial-joins)

### Update a join after an edit

`diffSpatialJoin(previous, next, changes)` returns sorted `added` and
`removed` pairs. It searches the opposite index using each edited feature's
old and new boxes. If both endpoints changed, it refines their pair once per
frame. This is useful when a drag changes one boundary in a tile containing
thousands of otherwise unchanged features.

```ts
import { applySpatialEdits, diffSpatialJoin, prepareSpatialQuery } from 'zerocopy/spatial';

const before = { left: index, right: roads };
const moved = applySpatialEdits(undefined, 1, [{ id: 1, bounds: [10, 10, 12, 12] }]);
const after = { left: prepareSpatialQuery(index, moved, 1), right: roads };
const delta = diffSpatialJoin(before, after, {
  left: [{ id: 1, before: bboxXY(paths[1]!), after: [10, 10, 12, 12] }],
}); // { added: [], removed: [[1, 23]] }
```

Supply the actual before and after bounds for **every** feature edited between
the two frames. Use `null` for an absent feature. Repeated edits to an ID use
the first before box and the last after box in input order. For a self join,
report edits on both sides. Include IDs whose exact geometry or filter inputs
changed even when their boxes stayed the same. Each frame's optional `filter`
must read that frame's geometry and metadata.

Pass `{ bounds: viewport }` in the changes object to use one viewport for both
frames. Run a full query when the viewport changes, the edit history is
incomplete, or a filter change can affect pairs outside the listed IDs.

## Edit and rebuild

- `buildSpatialIndex(features, revision = 0)` creates a base for a complete
  tile revision. Every feature has a unique numeric `id` and a bounding box.
- `applySpatialEdits(previous, revision, edits)` returns a new change map.
  Pass `undefined` for the first batch. Assign a strictly increasing safe
  integer revision to each committed batch, starting above the base revision.
  A box replaces a feature's previous bounds. A null box deletes it. Replaying
  the same latest batch preserves the existing handle. A conflicting or older
  write to an already edited ID throws. Initializing a nonempty change map
  and applying later edits require an allocating owner.
- `querySpatialIndex(base, box, changes?)` searches the packed index and scans
  recent changes. An updated feature suppresses its old index hit even when
  its new bounds are outside the viewport. Changes at or before the base
  revision have already been incorporated and are skipped.
- `prepareSpatialQuery(base, changes, revision)` captures the base and builds
  a small packed index for live edits plus a sorted table of changed IDs.
  Use `querySpatialIndex(prepared, box)` for repeated pans or independent
  workers searching the same revision. Moves and deletions suppress old base
  hits. Preparation reads only the change map and reuses the base buffers.
  Pass a captured revision at or after both the base and its changes.
- `rebuildSpatialIndex(base, changes, revision)` creates a replacement index
  directly from packed bounds and the captured change map. A reader can build
  it using just those two inputs and the revision of their publication.
  It accepts a revision at or after the base and rejects changes newer than
  that revision. Capture the overlay when scheduling the job, since later
  edits may overwrite an earlier change for the same ID. If the overlay
  has no newer entries, the result reuses the base's buffers.
- `pruneSpatialEdits(changes, baseRevision, capturedChanges?)` removes entries incorporated by
  a replacement index. If a worker builds a base from revision 10 while the
  owner advances to 12, install that base with the current change map pruned
  through 10. Keep revisions, base and changes from the same tile history.
  Capture the replacement pair together before sending it to a reader.
  Pruning reduces future query work. The [arena lifetime rules](architecture.md)
  determine when old backing memory can be reclaimed.

```ts
// In a reader, after attaching the change map for this publication.
import { rebuildSpatialIndex } from 'zerocopy/spatial';

const rebuilt = rebuildSpatialIndex(base, capturedChanges, capturedRevision);
postMessage(rebuilt);
```

On the owner, install a returned base only if its tile is still active and its
revision is at least as recent as the installed base. Pair it with the latest
overlay pruned through the returned revision. An older job can finish last.
Keep the owner's original edit-map handle alongside the job. Pass it as the
third argument when the worker returns.

```ts
import { pruneSpatialEdits } from 'zerocopy/spatial';

const remaining = pruneSpatialEdits(currentChanges, rebuilt.revision, capturedChanges);
// Publish the pair together so that moves and tombstones stay in effect.
const next = { base: rebuilt, changes: remaining };
```

The owner skips immutable branches shared with the captured map and retains
the encoded records for later edits. If every edit in a tracked map has been
absorbed, pruning returns an empty map in the same arena without allocating
shared bytes. The two-argument call also works. When the capture is from
another arena or its revision bound is unknown, pruning checks the live map.
With 16,384 captured edits and eight later edits, pruning with the capture
took a median 0.13 ms in Node and allocated 40 shared bytes. The previous
scan and delete took 33.13 ms and allocated 853,756 shared bytes on the same
fixture. [Pruning workload and measurements](../proofs/spatial-editor/README.md)

The direct map query scans every unpruned change. Preparing the edits moves
that work to publication time. A full rebuild folds them into a single tree
and removes the per-hit changed-ID check. Choose between the three using
edit frequency, query frequency, and viewport size. The [browser replay](../proofs/spatial-editor/README.md)
includes deletes, retained readers, an index rebuilt while edits continue,
and binary deck.gl paths. Rebuilding from packed bounds took a median 2.6 ms
in that four-reader replay, compared with 22.3 ms for decoding the shared
metadata rows. See the [trial results and measurement conditions](../proofs/spatial-editor/RESULTS.md).

On a 16,384-feature tile with 2,048 edited IDs, preparing took 1.944 ms
and reduced subsequent small pan queries from 1.020 to 0.021 ms each.
The full rebuild took 4.392 ms and yielded 0.009 ms queries.
[Viewport workload and measurements](../proofs/spatial-editor/RESULTS.md#repeated-viewport-queries-over-accumulated-edits)

## Follow edits with a worker-local cursor

Use `createSpatialQueryCursor(base)` when a worker pans a tile while many
previous edits are still in its overlay. The cursor shares the packed Flatbush
base and keeps an RBush of live edits in the worker. Its first `advance` reads
the complete overlay. Later calls compare immutable map roots and apply the
net changes since the last revision the worker processed.

<!-- example: spatial-query-cursor -->
```ts
import { applySpatialEdits, buildSpatialIndex, createSpatialQueryCursor } from 'zerocopy/spatial';

const west = [0, 0, 2, 2] as const, east = [10, 0, 12, 2] as const;
const base = buildSpatialIndex([{ id: 7, bounds: west }]);
const cursor = createSpatialQueryCursor(base);
const before = cursor.search(west); // [7]
const moved = applySpatialEdits(undefined, 1, [{ id: 7, bounds: east }]);
cursor.advance(moved, 1);
const after = cursor.search(west); // []
const visible = cursor.search(east); // [7]
```

In a worker, pass the **complete overlay from the same publication as the
rows and paths**. Skipped revisions are fine. The cursor accepts equal or
increasing revision numbers. A failed advance preserves the last queryable
revision. Searches return independent arrays of sorted IDs and include edge
touches. Create a fresh cursor when installing a rebuilt base or switching
tiles. For asynchronous work that needs an earlier revision, retain its
immutable inputs or prepared query.

Each cursor retains the latest overlay and a local entry per unabsorbed edit,
including deletion markers. Shared branches allow `changesSince` to skip
unchanged rows. Independently copied or compacted maps may require a full
comparison. For many workers searching one fixed revision, a prepared
snapshot shares the edit index as well. [Changing-viewport benchmark](../proofs/spatial-editor/RESULTS.md#viewport-queries-between-edits)

## Dedicated worker transport

A prepared snapshot contains only structured-cloneable descriptors and shared
typed-array storage. Build it once and send it to all readers with ordinary
`postMessage`. A worker that only searches this snapshot can call
`querySpatialIndex` immediately. Keep the handle to finish queries at its
captured revision. Prepare another snapshot to include later edits.

```ts
import { prepareSpatialQuery, querySpatialIndex } from 'zerocopy/spatial';

const prepared = prepareSpatialQuery(base, edits, revision);
worker.postMessage({ prepared }); // Shared backing buffers need no transfer list.
const visible = querySpatialIndex(prepared, viewport); // The owner can also query it.
```

Send the base once per generation using ordinary structured clone, without a
transfer list. Treat the shared buffers as immutable in every realm. Send the
change map, metadata and geometry together with the normal ZeroCopy transport.

```ts
// Owner, with the worker and application data already available.
worker.postMessage({
  base,
  revision: 1,
  roots: getWorkerData({ edits, rows, geometry }, { copy: false }),
});
```

A reader uses `await initWorker(message.roots)` to obtain the matching
collections, then calls `querySpatialIndex(message.base, viewport, edits)`
with the attached edit map. Use a revision and a viewport request ID to
discard stale asynchronous results. A worker only needs a new base when the
index is rebuilt. Follow the [browser isolation setup](workers.md#browser-setup)
for shared-memory transport.
