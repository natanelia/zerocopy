# Accepted: scalar bulk point counts

## Exact implementation and evidence

The accepted code is `9c87bd4075e01807c26168448bcce7e0a29af58c`, stacked on numeric range head `141bd6c02f3071d1a84f099a7017fcdb9362250c`. The production baseline for existing list iteration remains main `75e3626ccc6400d1ae195aefdd3526906622009e`. Existing `SharedList.forEach` code is unchanged.

[Proof run 36251558718](https://github.com/natanelia/zerocopy/actions/runs/36251558718) passed on both Linux x64 and ARM64 before the PR was opened. Both jobs passed all **591 tests across 30 files**, source and strict public type checks, Wasm/browser/declaration builds, real Node worker proofs, and Node/Bun spatial performance gates. The earlier numeric range performance gate also passed.

## Measured public API change

These are median milliseconds for **32 scans of 131,072 points**, stored as 262,144 interleaved f64 values. The box is inclusive from (-1000, -1000) to (1000, 1000). Five warm-up rounds precede fifteen measured rounds. Order alternates and all implementations return the same checked result.

| Runtime / architecture | Existing forEach | New public countPointsInBox | Throughput improvement |
| --- | ---: | ---: | ---: |
| Node 22.23.2 / x64 | 39.177794 | 4.797551 | 8.166x |
| Node 22.23.2 / ARM64 | 58.176774 | 6.221516 | 9.351x |
| Bun 1.4.2 / x64 | 28.588160 | 5.882339 | 4.860x |
| Bun 1.4.2 / ARM64 | 39.796228 | 5.979044 | 6.656x |

All-hit boxes were also measured. At this size they improved public throughput by 7.146x, 9.106x, 5.354x, and 7.974x in the same row order. All 512-point and larger cases exceeded the explicit 5% public improvement gate on both runtimes and architectures. Small cases are recorded but are not used as the acceptance threshold.

This is **not a spatial SIMD speedup**. Both numeric module builds use the same scalar spatial source. The improvement comes from running the complete fused scan in Wasm instead of calling JavaScript for each value. Numeric range counting retains its independently measured SIMD path.

The benchmark excludes input conversion, first compilation, worker startup/messages, and building the input list. It is a steady-state operation comparison, not a complete Map Creator workload or a benchmark on Apple Silicon. Hosted x64 machines can differ between runs; compare variants within a pinned job, not raw times from unrelated jobs.

## Browser and worker coverage

Chromium 153.0.8010.12, Firefox 155.0, and WebKit 26.6 each passed 275 spatial cases under normal module selection and 275 under forced scalar fallback, plus old-snapshot and same-realm read-only attachment checks. These are **not** browser-worker tests. The real Node worker proof separately passed concurrent reads during owner append, edit, and memory growth on both architectures.

The range PR verified Chromium/Firefox browser-worker transport and documented a WebKit worker allocation failure reproduced on unmodified main. This spatial PR does not claim to fix that existing transport limitation.

## Raw samples and reproduction

[Raw x64 samples and browser cases](https://github.com/natanelia/zerocopy/actions/runs/36251558718/artifacts/10909291245). [Raw ARM64 samples](https://github.com/natanelia/zerocopy/actions/runs/36251558718/artifacts/10909630489). Artifacts retain samples for 30 days. This summary and the reproduction scripts remain in the repository.

Run `PERF_GATE=1 node proofs/spatial-bulk-benchmark.mjs` and `PERF_GATE=1 bun proofs/spatial-bulk-benchmark.mjs` after the Wasm and browser builds. See `spatial-bulk.md` for API semantics. Rejected vectorized kernels remain on the experiment branch only.
