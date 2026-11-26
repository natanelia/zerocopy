# Shared-memory lane editor replay

The replay exercises public ZeroCopy APIs with TanStack DB 0.15.2, Flatbush
4.9.0, and deck.gl 9.4.2. It generates a tile in projected XY metres and
runs identical commands against two browser editors. All data is synthetic.

| Component | Shared editor | Copy-based editor |
| --- | --- | --- |
| UI metadata | TanStack collection with confirmed ZeroCopy row map | TanStack local-only collection |
| Geometry | One immutable numeric list per path, keyed by feature ID | One Float64Array per path, keyed by feature ID |
| Worker input | Immutable collection roots with shared Wasm backing | Initial tile copied once per reader, then changed rows and coordinates |
| Spatial queries | Shared immutable Flatbush base and snapshot of recent bounds | Same shared Flatbush base and a reader-local map of recent bounds |
| Drawing | Binary PathLayer with reusable positions and vertex start indices | Same renderer |

Each cycle pulls a vertex into view, pans, inserts a vertex, deletes a lane,
undoes the deletion, rejects an optimistic edit, pans back, drags a vertex
within a visible lane, and undoes that drag. A worker rebuilds the base index
every 16 steps. Edits to a feature suppress its old base entry. The owner
installs the new base together with changes newer than the rebuild input.
Feature IDs in this fixture are stable decimal strings representing uint32
slots. A search returns bounding-box candidates in the tile coordinate system.

Each reader validates the geometry and row bounds in the same publication.
The harness compares the spatial result and the TanStack live join against a
full bounds scan after every step. A delayed validator finishes reading an
older revision after a new edit is installed. The editor checks its revision
and viewport request before accepting a result. The opening cycle checks
binary path offsets, coordinates and actual WebGL picking, including a vertex
drag that leaves the feature's ID and vertex count intact.

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

The full run uses fresh Chromium processes for both editors at one, four,
and eight readers, with three trials per editor and reader count. Trial 2
runs the editors in reverse order. Each trial uses 4,096 lanes with 256
vertices per lane (16 MiB of input coordinate values), 16 warmup commands
and 64 measured commands. To run a subset, use `--readers=4` and optionally
`--trial=0`, `1`, or `2`. Add `--soak` for 1,024 measured commands. Use
`CHROMIUM_PATH` to select an installed headless Chromium executable. The
server binds to loopback and serves cross-origin isolation headers.

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
  Chromium uses SwiftShader. This measures a completed headless frame and
  excludes physical display presentation and device input delivery.
- **Validation latency** ends after every dedicated reader replies. Timing
  includes worker attachment, messaging and viewport geometry checks.
- **Packing** measures CPU work preparing binary path attributes. A change
  of membership or vertex count repacks the visible paths. A same-length
  edit copies the dirty path into its existing span.
- **Uploads** count client bytes submitted to WebGL buffer upload calls and
  time spent inside those calls. Draw time includes `gl.finish()`. Upload
  call duration measures CPU submission and can include driver stalls.
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
