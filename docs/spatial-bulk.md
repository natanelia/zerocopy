# Scalar bulk point-in-box count

This operation extends the optional `zerocopy/numeric` entry point. It uses a scalar Wasm loop, not explicit SIMD. The speedup being tested is removal of per-value JavaScript callbacks and a fused traversal over existing shared numeric leaves.

```ts
import { SharedList } from 'zerocopy';
import { countPointsInBox } from 'zerocopy/numeric';

const points = new SharedList('number').pushMany([0, 0, 1, 1, 10, 10]);
const count = countPointsInBox(points, {
  minX: 0, minY: 0, maxX: 2, maxY: 2,
}); // 2
```

Values are interleaved `[x0, y0, x1, y1, ...]`. An odd number of values throws `RangeError`. Bounds are inclusive and use the same coordinate system as the input. This is a linear scan, not a spatial index, geographic projection, antimeridian-aware query, or a conversion from arbitrary JSON-backed geometry.

Coordinates retain f64 precision. NaN coordinates never match. NaN or reversed bounds return zero. Infinite bounds are supported. Non-number bounds and non-numeric lists throw `TypeError`. No floating-point sum is reordered.

The operation reads the supplied immutable snapshot, including attached read-only snapshots. It does not allocate in the arena, write shared scratch, produce an intermediate list, or change the persistent storage format. It returns an ordinary number. Input conversion, initial kernel compilation, and worker messaging are separate costs and are not included in the steady-state benchmark.

## Why scalar

Two explicit SIMD point kernels were tested first. The first had a less than 5% Node ARM64 gain; the second was slower than scalar on ARM64. Those variants were dropped. The same branchless scalar point kernel is included in both numeric module builds. The range-count operation keeps its separately verified SIMD implementation.

This is a separate acceptance decision from the rejected SIMD experiment described in `numeric-experiment-followup.md`. A bulk API can be worthwhile without SIMD. It must independently beat the existing public `forEach` operation on both x64 and ARM64 before a PR is opened.

## Reproduction

```sh
bun run build:wasm
bun run build:browser
PERF_GATE=1 node proofs/spatial-bulk-benchmark.mjs
PERF_GATE=1 bun proofs/spatial-bulk-benchmark.mjs
node proofs/spatial-worker.mjs
```

The benchmark checks equal results, runs five warm-up rounds and fifteen measured rounds, alternates execution order, and retains raw samples. It tests low-hit and all-hit boxes. The performance gate requires at least a 5% public API improvement for 512 or more points. It does not claim a SIMD gain. Small inputs and direct kernel timings are reported separately.

Browser tests cover both module-selection paths and same-realm read-only attachment. Real Node Worker tests cover concurrent reads while the owner appends, edits, and grows memory. Browser worker transport support remains subject to the exact baseline checks in the numeric range PR; a same-realm attachment is not a browser-worker test.
