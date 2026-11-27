# Shared-memory lane editor replay

The replay exercises public ZeroCopy APIs with TanStack DB 1.0.0-rc.1.5, Flatbush
4.9.0, and deck.gl 9.4.2. It generates a tile in projected XY metres and
runs identical commands against browser editors with different geometry storage. All data is synthetic.
The [recorded results](RESULTS.md) include all trials and the four-reader
memory and frame-time targets used to evaluate this design.

For a CPU-only comparison of incremental and full two-layer joins, run
`bun run build:browser` and `node proofs/spatial-editor/join-edits.mjs`.
The driver moves 1, 32, and 4,096 points across 2,048 rectangular road
bounds. It checks the patched pair set against full recomputation, then
times both queries over prepared snapshots. Output includes all measured
trials in milliseconds per call. Index preparation, worker messaging, and
TanStack publication are outside the timed region. On Node 26.13.1, moving
one point took a median 0.0074 ms incrementally and 2.95 ms for a full join.
Moving all 4,096 points took 8.90 ms incrementally and 3.24 ms for a full
join. [Environment, source checksums and raw samples](results/join-edits-node26.json)

To measure a fixed viewport from worker dispatch through TanStack publication,
run `node proofs/spatial-editor/viewport-edits.mjs` after the browser build.
A Node worker either searches a complete shared index or returns the IDs that
entered or left the viewport. Both paths update a real TanStack collection.
Each publication is checked against a scan of the 4,096 points.

| Edited points | IDs in full replies, forward / undo | IDs in each delta | Full publication | Delta publication |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 2,047 / 2,048 | 1 | 0.79 ms | 0.18 ms |
| 32 | 2,038 / 2,048 | 32 | 0.97 ms | 0.30 ms |
| 4,096 | 2,048 / 2,048 | 4,096 | 12.58 ms | 13.89 ms |

Values are medians of three fresh-process medians on Node 26.13.1 and
TanStack DB 1.0.0-rc.1.5. The worker starts with both indexes and the edits.
Timers include searching or computing crossings, transferring the result and
publishing membership. Index construction, input delivery, validation and
rendering are outside the timer. Replacing the full result was faster in
the dense case, where every point crossed the viewport edge.
[Source checksums and raw timings](results/viewport-edits-node.json)

To measure how a worker recovers edits from two retained row snapshots, run
`node proofs/spatial-editor/row-changes.mjs` after the browser build. It uses
16,384 synthetic rows with stable IDs, revisions and bounds. The edits include
insertions, deletions and rows updated twice while the reader is behind.

| Net changed rows | Shared snapshot diff | Independent copied snapshot diff | Full scan checking row revisions |
| ---: | ---: | ---: | ---: |
| 0 | 0.009 ms | 17.8 ms | 64.3 ms |
| 8 | 0.075 ms | 16.0 ms | 63.4 ms |
| 4,096 | 17.7 ms | 27.0 ms | 68.9 ms |

Each cell is the median of three fresh-process medians on Node 26.13.1.
All three methods materialize complete changes inside a worker. The full
scan compares row revision numbers and checks for deleted keys. The copied
snapshots must compare values across independent memories. Snapshot creation,
transport, result validation, UI publication and drawing are outside the
timer. [Source checksums and raw timings](results/row-changes-node.json)

For an editor that sends revisions in separate messages, run
`node proofs/spatial-editor/session-changes.mjs`. A worker retains the last
processed map while two TanStack transactions update the same eight rows
among 16,384. Both paths share the underlying storage. With
`createSharedSession({ source: options }, { copy: false })`, extracting the
eight net changes took **0.17 ms**. With a fresh `getWorkerData` envelope
sent for the next comparison it took **24.6 ms**. In all 36 measured
comparisons the session reused the same worker-side WebAssembly memory
object. The fresh envelopes received distinct objects, requiring both maps
to be scanned. These medians of three Node 26.13.1 process medians cover
change extraction after attachment. They exclude transactions, messaging,
validation and rendering. [Source checksums and raw timings](results/session-changes-node.json)

To measure the owner's work after a rebuilt index arrives, run
`node proofs/spatial-editor/prune-edits.mjs` or `bun proofs/spatial-editor/prune-edits.mjs`
after the browser build. The worker's input contains 16,384 edits. While the
rebuild runs, the owner can move, insert or delete more features. The benchmark
times pruning the latest edit map through the captured revision. Each sample
checks the surviving records and a retained snapshot.

| Newer edits | Node scan and delete | Node prune with capture | Bun scan and delete | Bun prune with capture | Shared bytes allocated, scan and delete / prune with capture |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 38.54 ms | 0.015 ms | 48.43 ms | 0.011 ms | 852,560 / 0 |
| 8 | 33.13 ms | 0.130 ms | 41.48 ms | 0.125 ms | 853,756 / 40 |
| 8,192 | 37.87 ms | 20.89 ms | 52.32 ms | 28.72 ms | 606,068 / 93,332 |

Times are the median of three fresh-process medians on Node 26.13.1 and
Bun 1.4.2. Each process rotated the methods over two warmup and seven measured
rounds on the same synthetic data. With eight newer edits, the two-argument
`pruneSpatialEdits` took 22.02 ms on Node and 35.50 ms on Bun, allocating
40 shared bytes. Passing the capture also skips reading unchanged map branches.
The timer excludes index construction, worker messages, rendering and result
validation. Shared bytes measure growth of the writer's arena. [Source checksums and raw trials](results/prune-edits.json)

To measure the initial index build for an imported tile, run
`node proofs/spatial-editor/packed-index.mjs` or `bun proofs/spatial-editor/packed-index.mjs`
after the browser build. The fixture has 4,096 synthetic lanes of 64 vertices
each. Every build is checked against the same candidate IDs and exact viewport
hits. These are milliseconds to build the index from already shared XY data,
taking the median of three fresh-process medians per runtime.

| Runtime | Direct packed index | Bounds objects from XY views | Copy each lane into a list and build from bounds |
| --- | ---: | ---: | ---: |
| Node 26.13.1 | 1.63 | 2.28 | 9.00 |
| Bun 1.4.2 | 1.50 | 2.61 | 15.88 |

The timer covers bounds calculation and Flatbush construction. File decoding,
query checks, worker messaging, and rendering are outside it. The direct
builder keeps the stable ID set and writes into the shared index as it
processes each batch. [Source checksums and all samples](results/packed-index-load.json)

| Component | Shared editor | Copy-based editor |
| --- | --- | --- |
| UI metadata | TanStack collection with confirmed ZeroCopy row map | TanStack local-only collection |
| Geometry | One immutable numeric list per path, keyed by feature ID | One Float64Array per path, keyed by feature ID |
| Worker input | Immutable collection roots with shared Wasm backing | Initial tile copied once per reader, then changed rows and coordinates |
| Spatial queries | Shared immutable Flatbush base and snapshot of recent bounds | Same shared Flatbush base and a reader-local map of recent bounds |
| Drawing | Binary PathLayer with reusable CPU positions, GPU positions and vertex start indices | Same renderer |

Each cycle pulls a vertex into view, pans, inserts a vertex, deletes a lane,
undoes the deletion, rejects an optimistic edit, pans back, drags a vertex
within a visible lane, and undoes that drag. A worker rebuilds the base index
every 16 steps. Edits to a feature suppress its old base entry. The owner
installs the new base together with changes newer than the rebuild input.
The shared reader rebuilds from packed bounds and captured edits. To
benchmark rebuilding from shared metadata rows on the same executable, pass
`--rebuild=rows`. The copy control always uses its native metadata rows.
Feature IDs in this fixture are stable decimal strings representing uint32
slots. A search returns bounding-box candidates in the tile coordinate system.
Both editors publish full candidate lists on a pan. For confirmed edits in the
same viewport, they publish only membership changes. Rejected edits leave the
viewport alone. The TanStack membership collection drives the live join to
lane rows. Validation workers independently search the full view on every command.

Each reader validates the geometry and row bounds in the same publication.
The harness compares the spatial result and the TanStack live join against a
full bounds scan after every step. A delayed validator finishes reading an
older revision after a new edit is installed. The editor checks its revision
and viewport request before accepting a result. The opening cycle checks
binary path offsets, coordinates and actual WebGL picking, including a vertex
drag that leaves the feature's ID and vertex count intact.

### Open and edit a GeoArrow tile

`--source=geoarrow` serves one Arrow IPC stream with a uint32 ID column and a
planar XY LineString column in batches of up to 64 lanes. Every editor fetches the
same bytes. Each trial starts a fresh browser, and the three trials rotate
editor order. Full performance trials use ordered handles. The CI smoke
fixture uses descending sparse handles up to `0xffffffff` in uneven batches.

| Mode | Base geometry | Editing and worker reads |
| --- | --- | --- |
| `copy` | Float64 row views into an ordinary decoded Arrow buffer | Each worker receives its own copy on first attachment and sparse edits thereafter. |
| `shared` | One immutable ZeroCopy numeric list per imported row | Workers share every list from the first publication. |
| `packed` | Shared coordinate and offset buffers from `fromGeoArrowRecordBatch` | Workers receive the base buffers once. The owner creates lists for edited lanes and publishes those with confirmed metadata. |

The packed editor builds its initial Flatbush index with `buildLineStringIndex`
and resolves stable handles through `buildLineStringLookup`.
A geometry lookup checks the confirmed row and reads its replacement list or
original packed path. Removing the row hides its original path even after the
spatial edit log is pruned. A validator can still finish reading the older
publication. Only the visible paths are packed for deck.gl.

```sh
node proofs/spatial-editor/run.mjs --source=geoarrow --output=/tmp/geoarrow-editor.json
node proofs/spatial-editor/summarize.mjs /tmp/geoarrow-editor.json
```

GeoArrow runs stream the response through Apache Arrow's record batch reader.
Pass `--ipc=buffered` to download the entire response and decode a table
before importing its batches. Both loaders apply the same conversion to
each batch. The first-batch and total import timers start before the fetch
and end when the corresponding geometry and feature IDs are available.
TanStack and the spatial index are initialized after the full tile arrives.

The report records the IPC fixture hash, list or path-map entry counts, the
time to load coordinates and create initial metadata rows, the initial
index-build time, and the time until every reader replies to its first
viewport validation. Startup timing begins after renderer initialization
and worker construction and includes the fetch from the loopback server.
Per-command frame timings start after this initial load. The Linux PSS
samples cover the entire browser process tree throughout both phases.
The path-entry count measures keys reachable from the current geometry map.
Process memory also includes earlier revisions, staged edits, buffers,
indexes, browser runtimes, and renderer allocations.
The edit timing ends at entry into CPU path packing. It includes transaction
work, viewport membership and dispatch to workers. The summary takes the
median trial p95 for edit commands, including rollbacks and undo. Pan-only
commands are excluded from that metric.

## Run

Use the repository toolchain and build the portable library. The proof's
renderer and index dependencies are installed inside this directory.

```sh
bun install
bun run build:wasm
bun run build:browser
npm ci --prefix proofs/spatial-editor
bunx playwright install chromium
node proofs/spatial-editor/run.mjs --smoke
node proofs/spatial-editor/run.mjs --output=/tmp/zerocopy-editor.json
```

The full run uses a fresh Chromium process per editor at one, four,
and eight readers, with three trials per editor and reader count. The
generated workload alternates its two editors. The GeoArrow workload
rotates its three editors. Each trial uses 4,096 lanes with 256
vertices per lane (16 MiB of input coordinate values), 16 warmup commands
and 64 measured commands. To run a subset, use `--readers=4` and optionally
`--trial=0`, `1`, or `2`. Add `--soak` for 1,024 measured commands. Use
`CHROMIUM_PATH` to select an installed headless Chromium executable. The
server binds to loopback and serves cross-origin isolation headers.
Use `--trace` to log startup phases and every tenth command for diagnosis.
`--timeout-ms` sets the per-case watchdog. Samples are written after a case
finishes, and the summary requires three completed trials per editor.
CI runs the small generated and GeoArrow replays and archives their samples with
the other browser regression evidence. Performance targets use the full
trials above.

Select `--uploads=range` to update an existing WebGL position buffer for
a drag. Select `--uploads=full` to hand the updated CPU attribute to deck.gl
for upload, as in the earlier recordings. Both modes draw the same paths.
The range implementation is specific to WebGL2 and the pinned deck.gl
PathLayer. The positions buffer stores the high and low float32 parts of
each XY pair. It includes padding for PathLayer's neighboring vertex reads
and stays alive until the draw using its replacement completes. The first
cycle checks the uploaded values by GPU readback and checks actual picks.

SwiftShader is the default for repeatable headless runs. On a machine with
a physical GPU, select hardware rendering and use the same four-reader workload.

```sh
node proofs/spatial-editor/run.mjs --renderer=hardware --readers=4 --output=/tmp/editor-hardware.json
node proofs/spatial-editor/summarize.mjs --readers=4 /tmp/editor-hardware.json
```

Hardware mode disables Chromium's software fallback and requires an identified
WebGL2 renderer. Each report records the WebGL vendor and renderer from the
context that drew the paths. The summary requires matching graphics and host
metadata across trials. On macOS and Windows it reports frame and validation
times with the Linux-only memory measurement and target set to `null`.

The shared editor uses a ZeroCopy worker session by default. It sends the
memory handle on first attachment and publishes grouped roots on later edits.
Each validator waits for its exact requested publication. `--transport=manual`
uses a full `getWorkerData` envelope per edit for comparison. `--mode=copy`
or `--mode=shared` selects a single arm, for example during a soak run.
Use `node proofs/spatial-editor/summarize.mjs` with the output files to check
completeness and calculate medians of the three per-trial p95s.

## Reading the measurements

- **Frame latency** begins at command dispatch and ends when deck.gl issues
  the first screen draw after the update and WebGL finishes it. Headless
  Chromium uses the selected renderer. This measures a completed headless
  frame and excludes physical display presentation and device input delivery.
- **Frame phases** use the same main-thread clock. They cover command
  processing through entry into the renderer, packing binary paths, setting
  deck.gl props, waiting for the browser to enter the drawing animation
  callback, work within that callback up to `onBeforeRender`, and the draw
  through `gl.finish()`. The wait can include browser scheduling, other
  tasks and graphics backpressure. Callback preparation includes luma.gl and
  deck.gl layer updates. Time remaining after the draw covers returning to
  the command handler. Worker validation runs concurrently. The summary
  selects the slowest 5% of commands in each trial (rounded up) and reports
  each phase's share of their combined frame time. Timing version 1 combined
  the callback wait and preparation. Version 2 measures them separately.
- **Validation latency** ends after every dedicated reader replies. Timing
  includes worker attachment, messaging and viewport geometry checks.
- **Rebuild time** measures the index construction call inside the first
  reader. Each `rebuildMs` sample belongs to the build started two commands
  before the command that installs its result.
- **Packing** measures CPU work preparing binary path attributes. A change
  of membership or vertex count repacks the visible paths. In range mode a
  single-vertex edit copies the XY pair from the new snapshot and encodes
  its two float32 parts per coordinate. Full mode repacks that feature.
  `packedBytes` counts Float64 source bytes copied into the CPU positions
  array. It excludes subsequent conversion of those values.
- **Uploads** count client bytes submitted to WebGL buffer upload calls and
  time spent inside those calls. Draw time includes `gl.finish()`. Upload
  call duration measures CPU submission and can include driver stalls.
  In range mode, `positionUploadBytes` counts the bytes observed in WebGL
  calls during the explicit position-buffer write. `uploadBytes` also
  includes other attributes and uniforms submitted for the draw.
- **Memory** is the highest sampled sum of proportional set size (PSS) over
  the fresh Linux Chromium process tree, sampled approximately every 100 ms
  through initialization, retained geometry, edits, rebuilds and teardown.
  PSS apportions shared resident pages among their mappings. Short-lived
  peaks between samples can be missed. Other operating systems report null.
- **Raw evidence** contains per-command and memory samples, bundle hashes,
  Chromium version and CPU model. The output is atomically replaced after
  each completed case when an output path is supplied.

The copy-based editor sends one changed coordinate for a simple drag and a
replacement path for an insertion or restoration. Both modes use the same
shared base index. deck.gl consumes ordinary CPU render buffers and uploads
them to the GPU. The shared editor uses the built `zerocopy/spatial` entry point. The copy-based
editor uses an independent Flatbush implementation.
