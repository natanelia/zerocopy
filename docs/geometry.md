# Geometry operations

Import geometry operations from `zerocopy/geometry`. They are optional and do not change existing collection methods or the snapshot format.

```ts
import { SharedList } from 'zerocopy';
import { bboxXY } from 'zerocopy/geometry';
const coordinates = new SharedList('number').pushMany([0, 1, -2, 3, 4, -5]);
const bounds = bboxXY(coordinates); // [-2, -5, 4, 3]
```

`bboxXY` recomputes `[minX, minY, maxX, maxY]` from interleaved 2D coordinates. It does not parse GeoJSON, transform coordinates, or use a cached bbox. An odd list length throws `RangeError`; a non-numeric list throws `TypeError`. NaN axes are ignored. Equal values retain the first sign of zero. Infinite coordinates are supported. Empty input returns `[Infinity, Infinity, -Infinity, -Infinity]`. This matches Turf bbox recomputation on the corresponding flat MultiPoint, including its empty-input values.

The operation reads the supplied immutable snapshot directly. Attached read-only snapshots are supported. No arena bytes are written. Result scalars use module-instance globals and are copied to a new result tuple before the synchronous call returns. There are no imported callbacks or asynchronous steps within that interval. Workers have separate module instances.

The first call compiles the selected module. A feature probe chooses standard SIMD or a separately compiled scalar fallback. No relaxed SIMD or fast-math option is used. Numeric precision stays binary64. Keep and reuse bounds for unchanged snapshots when recomputation is unnecessary.

## Verify and measure

Build with `bun run build:wasm && bun run build:browser && bun run build:types`. Run `node proofs/geometry-bbox.mjs` and `bun proofs/geometry-bbox.mjs`. The proof compares the scalar module, SIMD module, public API, independent JavaScript loop, and pinned Turf 7.4.0. It uses deterministic random coordinates, random binary64 patterns, leaf/tree boundaries, signed zeros, infinities, NaNs, and end-of-memory loads. Failures identify the seed and shape. Exact comparisons use `Object.is`, never an epsilon.

Benchmarks include random point sets and smooth road-like lines. Raw reports include all 21 rounds, runtime versions, CPU, architecture, commit, and source digest. Each batch has eight warm-up rounds. Order alternates. The steady-state timers include result construction but exclude input construction, compilation, and worker messages. The `js-flat` row is a separate representation baseline. Turf is forced to recompute; cached Turf bbox is not compared against a scan. `PERF_GATE=1` requires more than 5% SIMD/scalar and public/Turf gains for both large workload sizes. This is a measured acceptance check, not a universal performance guarantee.
