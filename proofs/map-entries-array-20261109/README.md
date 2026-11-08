# Map eager entries materialization: before/after proof (2026-11-09)

This branch builds on **PR #68**, which already provides a native,
generator-free traversal for `SharedMap.forEach`. The additive
`SharedMap.toEntriesArray()` allocates an eagerly materialized pair array
using that traversal. Existing `entries()`, `keys()`, `values()`,
`forEach()`, reads, writes and on-disk/worker formats do not change.

## Pinned comparison and method

- **Baseline:** PR #68 at `1f6d5bdd114217e8405f0518abfa7612d7db0cd9`.
- **Measured candidate:** `3bbb85c6746e26184a0a820b5e4cd4c5806919d7`.
- **Before:** `Array.from(map.entries())`.
- **After:** `map.toEntriesArray()`.
- Both sides build their own portable distribution bundles from the corresponding
  pinned source and use the same installed dependencies. The benchmark excludes
  map construction, serializing fixtures and process startup.
- Every child process runs ≥250ms of warmup, then records nine timed batches.
  A timed batch builds the full new array and consumes **every** key length
  and value. A complete reference traversal and returned pairs are verified
  before timing; checksum and returned length are checked outside the timer.
- **Six fresh before/after process pairs per workload/runtime**, alternating
  execution order, on Linux x64 with Node 24.22.1 and Bun 1.4.2.
  Ratios are geometric means of paired estimate ratios; 95% intervals are
  computed in log space using Student t with five degrees of freedom.
  Four separate identical-build A/A controls are reported unadjusted.

## Results

Times below are medians across six process estimates in microseconds per
complete materialization. Reductions are paired ratio estimates, not
necessarily ratios of displayed medians.

| Workload | Node before → after | Node paired reduction | Bun before → after | Bun paired reduction |
| --- | ---: | ---: | ---: | ---: |
| 64 number entries | 6.94 → 3.57 µs | **48.0%** | 3.04 → 1.40 µs | **53.4%** |
| 1,024 number entries | 111.15 → 61.71 µs | **44.2%** | 52.00 → 26.49 µs | **49.1%** |
| 8,192 number entries | 1,579.14 → 1,098.09 µs | **30.5%** | 1,069.46 → 896.29 µs | **14.1%** |
| 16,384 number entries | 3,595.48 → 3,737.00 µs | **inconclusive** (2/6 faster) | 2,577.50 → 2,167.75 µs | **14.0%** |
| 4,096 string entries | 1,086.85 → 834.85 µs | **21.7%** | 845.58 → 701.85 µs | **15.7%** |

All six pairs improved in both runtimes at 64 and 1,024 numeric entries,
with 95% ratio intervals wholly below 1.
For Node 16,384, the paired ratio estimate is 0.944 but the 95% interval
0.777–1.147 includes 1, and only two of six pairs were faster. Its displayed
median also regressed, so **no speedup is claimed there**.

Bun's 8,192-number case improves in five pairs, with a 95% interval
0.783–0.943. Node string-4096 improves in all six pairs with interval
0.759–0.808. Bun string-4096 improves in all pairs with 0.822–0.865,
**but** its same-build control also shows a favorable 3.85% shift
(0.936–0.987). This environmental/measurement effect is not subtracted
from the results; the exact Bun string improvement magnitude is uncertain.

The other A/A controls are close to 1, with 95% intervals crossing 1:
Node number-8192 1.001 [0.986,1.017], Node string-4096 1.016
[0.992,1.042], Bun number-8192 0.998 [0.956,1.043].

## Correctness / CI

- [Completed proof run](https://github.com/natanelia/zerocopy/actions/runs/42533402778) builds both versions and passes
  **1,210 Bun regression tests across 62 files**, TypeScript and declaration
  builds, packed npm package checks and Node worker checks.
- The new tests verify order and values for empty/1/31/32/33/256/4096-entry
  maps, Unicode keys, signed zero/NaN, detached arrays, retained prior snapshots,
  string values, copied read-only worker attachments, custom iteration hooks and
  propagation of custom iterator errors.
- [Raw before/after nine-batch readings, all process pairs, all A/A controls and unit logs](https://github.com/natanelia/zerocopy/actions/runs/42533402778/artifacts/13638098660)
  (Actions retention: 7 days).
- An independent offline audit recomputed every per-process nine-sample
  median, all pair ratios, 95% intervals, counts, checksums and runtime/source
  identities from that artifact. The calculated values reproduce exactly.

## Reproduce

The branch contains `case.mjs` and `compare.mjs`, plus its branch-only workflow
`.github/workflows/map-entries-array-proof.yml`:

```bash
bun install && bun run build:wasm && bun run build:browser && bun run build:types
bun run test
# Build identical dependencies and the baseline bundle in a detached worktree.
node proofs/map-entries-array-20261109/compare.mjs /path/to/pr68-baseline "$PWD"
```

This PR must be merged **after #68**. It intentionally does not change existing
Map iteration semantics or replace `Array.from(map.entries())` in unrelated
code. The new eager API is recommended where a fully materialized array
is needed and its measured workload resembles the confirmed cases.
