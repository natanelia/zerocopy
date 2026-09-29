# Geometry operations

Import optional geometry operations from `zerocopy/geometry`.

```ts
import { SharedList } from 'zerocopy';
import { bboxXY } from 'zerocopy/geometry';
const coordinates = new SharedList('number').pushMany([0, 1, -2, 3, 4, -5]);
const bounds = bboxXY(coordinates); // [-2, -5, 4, 3]
```

`bboxXY` recomputes `[minX, minY, maxX, maxY]` from interleaved 2D coordinates. It reads the supplied snapshot directly and returns a fresh readonly tuple. It does not parse GeoJSON, transform coordinates, use cached bounds, or change existing collection methods. A caller must use this new API to benefit from it. Reuse previously calculated bounds when a snapshot has not changed.

An odd coordinate count throws `RangeError`. A non-numeric collection throws `TypeError`. NaN axes are ignored. Equal extrema retain the first sign of zero. Infinite coordinates are supported. Empty input returns `[Infinity, Infinity, -Infinity, -Infinity]`. These rules match Turf bbox recomputation for the corresponding flat MultiPoint; this is not the full Turf GeoJSON API.

The accepted kernel is scalar Wasm. SIMD implementations remain rejected experiments because they did not consistently beat the best scalar control on x64 and ARM64 across Node and Bun. Bulk traversal is a separate optimization: it removes per-value JavaScript callbacks and nested GeoJSON traversal. It must pass a separate full-API benchmark before release. No claim of a SIMD speedup applies to this function.

Attached read-only snapshots and historical versions are supported. The kernel uses neither an allocator nor shared scratch. Results use instance-local globals and are copied to a new tuple before the synchronous call returns. There are no imported callbacks or asynchronous steps during the transfer. Workers have separate instances. Non-empty calls compile the module lazily and cache one instance per memory; empty input does not compile a module.

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
