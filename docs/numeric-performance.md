# Numeric performance decision — 26 September 2026

## Scope and baseline

The production baseline is main commit `75e3626ccc6400d1ae195aefdd3526906622009e`.
The accepted candidate is `09e5fda3c6caa827e528e54a78f903079bb7556a`.
It adds an optional numeric API. It does not accelerate existing `get`, `set`, or `forEach` calls automatically.

The evidence below comes from [numeric proof run 36250211261](https://github.com/natanelia/zerocopy/actions/runs/36250211261). Both Linux x64 and Linux ARM64 jobs passed all 570 tests across 29 files, builds, type checks, the real Node worker proof, and the explicit Node performance gate. There are 24 numeric tests. The suite tests the scalar fallback, numeric edge cases, old snapshots, forks, growth, attached read-only arenas, and loads at the end of Wasm memory.

Raw sample artifacts: [x64](https://github.com/natanelia/zerocopy/actions/runs/36250211261/artifacts/10908533907) and [ARM64](https://github.com/natanelia/zerocopy/actions/runs/36250211261/artifacts/10908713437). These artifacts have a 30-day retention period. The committed benchmark and this summary remain available after artifact expiry.

## Accepted: bulk numeric range count

The following table shows median elapsed milliseconds for **32 scans of 262,144 numbers**, not one scan. Five warm-up rounds precede 15 measured rounds. Execution order alternates. Every implementation returns the same checked result. Setup, initial compilation, and worker messaging are outside these steady-state measurements.

| Runtime / architecture | Existing list forEach | Scalar Wasm | SIMD Wasm | New public API | SIMD / scalar throughput | Public / forEach throughput |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node 22.23.2 / x64 | 60.734487 | 8.273655 | 4.405323 | 4.446801 | 1.878x | 13.658x |
| Node 22.23.2 / ARM64 | 54.905001 | 7.129883 | 4.320710 | 4.351179 | 1.650x | 12.618x |
| Bun 1.4.2 / x64 | 48.485161 | 11.450756 | 4.094193 | 4.125952 | 2.797x | 11.751x |
| Bun 1.4.2 / ARM64 | 71.919192 | 6.535645 | 3.782093 | 3.789516 | 1.728x | 18.978x |

The public API gain includes removal of per-element JavaScript callbacks and decoding. Only the scalar-versus-SIMD column isolates vector instructions. The scalar kernel uses a branchless predicate and the same tree traversal. Values remain f64. No floating-point summation or changed arithmetic grouping is involved.

Node public API throughput relative to existing forEach at 1,024 numbers was 10.957x on x64 and 10.898x on ARM64. At 32 numbers it was 5.501x and 5.459x, respectively. These are measurements of this range predicate, not universal library speedups.

The production core and persistent layout are unchanged. An unsupported SIMD feature probe selects a separately compiled scalar numeric module. The first non-empty call has a compilation/initialization cost not represented in the table. Linux ARM64 results are not measurements on Apple Silicon. Browser validation and later reruns are recorded separately in CI; this table is pinned to the run above.

## Rejected: byte helpers

The initial prefix kernel extracted a SIMD byte mask on every group. It was slower than optimized scalar on ARM64. A second experiment computed the mask only after a mismatch and split equality from ordering.

That refined kernel improved low-level long-key comparisons. However, the public API did not meet a no-regression acceptance rule. In [experiment run 36249972846](https://github.com/natanelia/zerocopy/actions/runs/36249972846), 15,000 existing-key writes with 8-byte keys took 6.925848 ms on baseline versus 7.491265 ms with SIMD on x64. With 36-byte keys, ARM64 took 6.974900 ms versus 7.548836 ms. A modest gain with 512-byte keys did not justify these regressions. No byte-helper production change is included.

The experiment's repeated-read case for 512-byte keys exceeds the character cache budget. Despite its original `warm-get` label, it is not an all-cache-hit benchmark. It must not be used to claim warm-cache acceleration.

## Rejected: blanket fixed-copy replacement

Larger isolated copy loops became faster, but complete immutable vector writes did not consistently improve. In the same experiment, 100,000 tail writes to a 32-element vector took 2.026838 ms on baseline versus 2.179404 ms with SIMD on x64. ARM64 took 2.329374 ms versus 2.482486 ms. Larger vector cases were mostly neutral. No copy replacement or allocation-layout change is included.

The rejected experiments remain on `agent/simd-performance-lab`, with generated code, Wasm text, correctness checks, and raw sample artifacts linked from their workflow. They are not production PRs.

## Reproduction

Build the candidate, then run `node proofs/numeric-benchmark.mjs` and `bun proofs/numeric-benchmark.mjs`. Set `PERF_GATE=1` to require a greater than 5% gain over both the scalar kernel and the existing forEach baseline for cases of at least 1,024 values. The gate is in the dedicated performance workflow, not ordinary unit tests.

Compare multiple runs and devices before changing defaults. No hash, typed-column storage, JSON codec, or worker scheduling redesign is part of this change.
