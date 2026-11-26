# Geometry operations

Import optional geometry operations from `zerocopy/geometry`.

```ts
import { SharedList } from 'zerocopy';
import { bboxXY } from 'zerocopy/geometry';
const importedXY = new Float64Array([0, 1, -2, 3, 4, -5]);
const coordinates = new SharedList('number').pushMany(importedXY);
const bounds = bboxXY(coordinates); // [-2, -5, 4, 3]
const renderBuffer = coordinates.toFloat64Array();
```

Pass packed interleaved coordinates directly to `pushMany()` when importing
lane or tile data. Use `toFloat64Array()` when handing a numeric snapshot to
a renderer or transferring a coordinate buffer out of a worker. The returned
array owns its buffer.

`bboxXY` recomputes `[minX, minY, maxX, maxY]` from interleaved 2D coordinates. It reads the supplied snapshot directly and returns a fresh readonly tuple. It does not parse GeoJSON, transform coordinates, use cached bounds, or change existing collection methods. A caller must use this new API to benefit from it. Reuse previously calculated bounds when a snapshot has not changed.

An odd coordinate count throws `RangeError`. A non-numeric collection throws `TypeError`. NaN axes are ignored. Equal extrema retain the first sign of zero. Infinite coordinates are supported. Empty input returns `[Infinity, Infinity, -Infinity, -Infinity]`. These rules match Turf bbox recomputation for the corresponding flat MultiPoint; this is not the full Turf GeoJSON API.

The accepted kernel is scalar Wasm. SIMD implementations remain rejected experiments because they did not consistently beat the best scalar control on x64 and ARM64 across Node and Bun. Bulk traversal is a separate optimization: it removes per-value JavaScript callbacks and nested GeoJSON traversal. It must pass a separate full-API benchmark before release. No claim of a SIMD speedup applies to this function.

## Path intersection

`pathIntersectsBoxXY(points, box, range?)` returns whether any vertex or
straight segment of an open planar path touches the inclusive XY box. A
single vertex can match, and an empty path returns `false`. Coordinates and
bounds use the same units. Boxes can have zero width, zero height or infinite
extents. Reversed bounds and NaN bounds throw.

The optional `{ start, end }` selects coordinate elements in a half-open
range. Both ends must align to XY pairs. A vertex with either axis nonfinite
breaks the path, so the finite vertices on either side remain disconnected.
The predicate reads the immutable list directly and can stop at the first hit.
Corner and edge touches count, including when a floating-point determinant
needs an exact sign calculation. [Spatial index example](spatial.md#select-intersecting-paths)

Attached read-only snapshots and historical versions are supported. The kernel uses neither an allocator nor shared scratch. Results use instance-local globals and are copied to a new tuple before the synchronous call returns. There are no imported callbacks or asynchronous steps during the transfer. Workers have separate instances. Non-empty calls compile the module lazily and cache one instance per memory; empty input does not compile a module.

## Refresh an edited lane

Keep each lane's coordinate range when packing several lanes into one list.
After editing a point, recompute the bounds of that lane and overwrite its
span in the existing render buffer. Both operations also work in a reader
after it receives the new snapshot.

```ts
const lane = { start: 2, end: 6 };
const edited = coordinates.setMany([[2, -3], [3, 5]]);
const laneBounds = bboxXY(edited, lane); // [-3, -5, 4, 5]
edited.copyToFloat64Array(renderBuffer, { ...lane, offset: lane.start });
```

`start` and `end` count individual coordinates. `bboxXY` requires both
indexes to be even and treats `end` as exclusive. A viewport can also pack
several visible lanes into a smaller buffer by assigning each lane its own
destination `offset`.

## Reproduce

```sh
bun install
bun run build:wasm && bun run build:browser && bun run build:types
bun run typecheck:geometry
bun run test
PERF_GATE=1 node proofs/geometry-bbox.mjs
PERF_GATE=1 bun proofs/geometry-bbox.mjs
bunx playwright install --with-deps chromium firefox webkit
node proofs/geometry-browsers.mjs
```

The differential proof checks an independent JavaScript loop, pinned Turf 7.4.0, raw scalar Wasm, and the public API with `Object.is`. It uses 4,096 reproducible seeds, random binary64 patterns, NaN/infinity/subnormal values, signed-zero ties, tree boundaries, end-of-memory loads, and retained snapshots in real Node/Bun workers. It does not substitute epsilon comparisons for exact equality. Random testing establishes agreement on tested inputs; it is not a proof over every possible input.

Each benchmark includes eight warm-up rounds and 21 measured rounds, with alternating execution order and checked output. Random points, road-like lines, and late-zero inputs are measured at four sizes. Timers include result construction but exclude input construction, compilation, and worker messaging. Turf is forced to recompute; its cached bbox path is not compared to a full scan. Flat JavaScript arrays and existing SharedList.forEach are reported separately. The bulk gate requires more than 5% public-API improvement over both Turf recomputation and existing SharedList iteration in every tested shape and size. It does not approve rejected SIMD versions.

Raw results include all samples, CPU, architecture, runtime, commit, source digest, and test counts. Browser checks verify main-thread execution and same-realm read-only attachments. They do not claim actual browser-worker or Safari-device validation. See the performance decision document for measured results and rejected variants.

### Map editing benchmarks

Build a baseline checkout and the current checkout, then pass their portable
build directories to the benchmark. It measures short lane writes, tile
imports, packing read-only snapshots, and an import, bounds, edit, and pack
workflow on synthetic lane geometry. It checks every result before timing and
emits the individual timing samples.

The combined workload imports two tiles of 131,072 XY points each, computes
their bounds, edits 128 points per tile, and packs the edited coordinates.
These are the recorded medians of 25 paired samples for `fd6195b` against
`2eb1bfd` on Linux x64.

| Runtime | `2eb1bfd` | `fd6195b` | Speedup |
| --- | ---: | ---: | ---: |
| Chromium 156.0.8078.4 | 17.39 ms | 6.62 ms | 2.63× |
| Node 26.13.1 | 14.64 ms | 4.82 ms | 3.04× |
| Bun 1.4.2 | 12.53 ms | 7.33 ms | 1.71× |

The baseline packs coordinates with `new Float64Array(list.toArray())`. The
benchmark covers collection work on a single thread. It excludes map data
fetching, renderer work, and worker message latency. The 24-point packing
case changed by less than 0.15 µs per call in each runtime.

```sh
node proofs/hd-map-performance.mjs /path/to/baseline/dist dist
bun proofs/hd-map-performance.mjs /path/to/baseline/dist dist
node proofs/hd-map-performance.mjs /path/to/baseline/dist dist chromium
```

### Range reads and reusable buffers

This run compares the lane-range implementation with `fd6195b` using a
synthetic tile of 131,072 XY points. The viewport cases read 16 lanes with
128 points each. The edit case moves one XY point, recomputes that lane's
bounds, and updates its span in an existing tile buffer. The baseline uses
indexed reads for the same selected lanes. For a complete tile refresh into
an existing buffer, it packs the snapshot and copies the result into that
buffer. Both versions use the same `setMany` edits.

Times are median microseconds per operation on an AMD EPYC-Milan Linux x64
host on November 25, 2026. Each row uses ten warmups and 25 measured pairs
with alternating build order and exact output checks before timing.

| Runtime | Copy full tile into buffer | Copy 16 visible lanes | Bounds for 16 lanes | Edit and refresh one lane |
| --- | ---: | ---: | ---: | ---: |
| Chromium 156.0.8078.4 | 1,803.13 → 238.75 (7.55×) | 41.37 → 4.80 (8.61×) | 82.63 → 7.72 (10.70×) | 8.09 → 2.71 (2.98×) |
| Node 26.13.1 | 672.61 → 160.42 (4.19×) | 45.45 → 5.63 (8.07×) | 73.59 → 6.55 (11.24×) | 8.24 → 2.43 (3.39×) |
| Bun 1.4.2 | 668.87 → 138.91 (4.82×) | 28.79 → 7.10 (4.06×) | 51.50 → 7.12 (7.24×) | 7.02 → 2.26 (3.11×) |

The measurements cover zerocopy operations before rendering or worker
messaging. Full-tile packing into a fresh buffer varied more. In Chromium the
edited-tile median rose from 1,518 to 1,786 µs, while the same-build control
ranged from 1,677 to 2,068 µs across its two arms. The benchmark above also
emits all control workloads and SHA-256 digests of the measured builds.
[Raw paired samples and same-build controls](../proofs/results/hd-map-lane-ranges).

### Spatial editing with dedicated workers

The [spatial entry point](spatial.md) adds indexed bounding-box searches to these geometry operations.
The [spatial editor replay](../proofs/spatial-editor/README.md) combines
immutable geometry, confirmed TanStack rows, a shared Flatbush base, and
deck.gl binary paths. It exercises viewport changes, edits during index
rebuilds, and workers finishing a prior revision. Its copy-based comparison
receives sparse edits after the initial load.
