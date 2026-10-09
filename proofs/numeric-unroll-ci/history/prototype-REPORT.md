# Fixed two-way numeric SIMD prototype

**Result: the fixed prototype passes its standalone correctness corpus and has a concrete emitted-Wasm distinction. It is not performance-accepted, and the focused unit-test gate remains incomplete because of retained timeouts.** No operation timing, calibration, variant sweep, native-engine flag change, GitHub write, or PR occurred.

The original source report is unchanged at `/workspace/shared/zerocopy-numeric-scan-source-20261009/REPORT.md`. The prospectively recorded plan is [PLAN.md](PLAN.md); the exact eight-line runtime addition is [candidate.patch](candidate.patch).

## Exact source and build

- Baseline: `2e88bc4a53871476da9ca1ec4e6c374b61512436`, tree `11ad61e759f07f69fac6a5c6fa34ccb283a7563b`.
- Isolated worktrees: `/workspace/scratch/e7ec22ef2609/zerocopy-numeric-unroll-baseline-20261009` and `/workspace/scratch/e7ec22ef2609/zerocopy-numeric-unroll-candidate-20261009`.
- The candidate changes only `numeric-kernels.as.ts`: one second SIMD accumulator, a four-value loop, the original two-value loop, one integer-vector combine, and the original scalar remainder. No wrapper/API/format/traversal/spatial changes or opportunistic alternatives.
- Before execution, all 453 tracked files per role, build scripts, main compiler JavaScript, official tool executables, dependency metadata/lock, and proof inputs were hashed in [pre-execution-manifest.json](pre-execution-manifest.json), SHA-256 `55cb6817756a249b6f1cd504a6642453868f5dca6a59192346a6f2ee471f6e4b`. All these pins still match after execution.
- Existing official toolchain: AssemblyScript 0.28.20, Binaryen 131.0.0-nightly.20260721, Node 24.19.0, Bun 1.4.2, x64. Unchanged Wasm/browser/declaration build commands passed for both sources. Dependencies were referenced without edits; tool caches stayed inside the new worktrees. The supplemental complete compiler standard-library inventory is explicitly post-build, not represented as an earlier pin.

## What optimized Wasm actually changes

The baseline still contains its two-value loop; AssemblyScript/Binaryen has **not** already applied the proposed four-value transformation. The candidate has a four-value loop followed by the unchanged pair/scalar remainders. Of five SIMD-module function bodies, only span-count function index 2 changes. All other bodies, exports/imports and module contracts remain identical in the decoded WAT comparison.

For a full 32-value leaf, direct derivation from that WAT gives:

| Emitted-Wasm structure | Baseline | Fixed candidate |
| --- | ---: | ---: |
| Vector-loop body executions / backward branches | 16 | 8 |
| Vector-loop guard evaluations, including exits/remainder guard | 17 | 10 |
| Vector address shift/add calculations | 16 | 8 |
| Vector loads | 16 | 16 |
| Vector f64 comparisons | 32 | 32 |
| Integer-vector mask subtractions | 16 | 16 |
| Additional integer-vector combine | 0 | 1 |
| Declared vector locals in span function | 3 | 4 |

The second load uses a constant offset of 16 from the first computed address. These counts describe the emitted Wasm structure, not measured native instruction counts or latency. See [derived-loop-counts.csv](derived-loop-counts.csv) for sizes 1–32 and [emitted/](emitted/) for both decoded modules. The candidate adds one vector local, implicitly zero-initialized by Wasm; it does not emit a separate explicit zero-vector assignment. Native handling of that local, instruction selection, register allocation, unrolling, and dependencies is unknown.

The counterweight is real too: for 1–3 values, the new four-value loop does no work but adds a failed guard and one vector combine. At four values the total vector-loop guard count is unchanged (3); there is one fewer backward branch and address calculation, opposed by the added combine/local. No tiny-tail bypass was added.

## Emitted footprint and unaffected controls

| Artifact | Baseline | Candidate | Difference |
| --- | ---: | ---: | ---: |
| SIMD numeric Wasm | 782 B | 874 B | +92 B |
| Scalar numeric Wasm | 720 B | 720 B | Identical bytes |
| Portable numeric.js, raw | 4,303 B | 4,427 B | +124 B |
| Portable numeric.js, gzip | 1,847 B | 1,827 B | −20 B |
| Portable numeric.js, Brotli | 1,649 B | 1,654 B | +5 B |

Compression rows use the same pinned Node default compressors on each complete file; they are not download or startup measurements. Eleven of twelve Wasm artifacts are byte-identical, including scalar numeric, persistent core and geometry. All 41 declarations are identical. Eleven of twelve emitted JS files are identical; only the optional numeric entry changes. The numeric module's scalar `countPointsInBox` implementation is unchanged.

Fresh numeric users can still pay different decode/compile costs, even if they call only spatial counting. Both numeric binaries are embedded in the portable entry, so forced-scalar browser usage still sees the changed entry bytes. Normal nonnumeric entry files remain identical. The earlier optional text-SIMD module's extra-module startup cost is not imported into this result: this prototype adds no module or loader. Actual startup, browser and ARM behavior remains unmeasured.

## Correctness completed

The same fixed-seed corpus passed in eight fresh processes: baseline/candidate × Node/Bun × automatic/forced-scalar public selection. The built public entry was used for the standalone corpus. Both direct scalar and SIMD modules were checked in every process. All eight return the same checksum `486050`, final xorshift state `1012861933`, and expected counters.

Across those processes:

- 171,584 direct range assertions, including all tail sizes 0–32, actual memory-end loads, accessible poisoned bytes beyond visible tails, every exceptional-value lane position, and 256 fixed-seed cases per process.
- 5,792 public range assertions across tiny, leaf/tree-boundary and 32,801-value lists, old/set/pop/fork/grown snapshots, NaNs, both zeros, infinities, exact endpoints, invalid/reversed bounds and validation errors.
- 720 unrelated public spatial comparisons and 192 same-realm shared/copied attachment range checks.
- 6,992 memory-digest preservation checks. Attached reader arena-used values also remain unchanged, and writes through read-only attachments reject.
- 16 actual shared/copied worker lifetimes, with 176,016 checked range calls, scheduled reads alongside owner append/edit, verified owner memory growth, and reads after growth. Worker termination is awaited. Scheduling overlap is not a claim that a particular kernel instruction overlapped a grow instruction.

Both strict numeric public-consumer type checks passed. All eight originally planned existing built worker-proof commands passed: numeric/spatial × Node/Bun × both sources. Scalar fallback probes execute once per realm/worker. No browser, ARM, Apple hardware, native-JIT inspection, or broad full suite was run.

For valid public data, source reasoning still bounds total counts by `MAX_SIZE = 0x3fffffff`, with at most 32 contributions per leaf and at most 16 per combined SIMD lane; regrouping remains exact integer arithmetic. The corpus does not claim to allocate or execute a maximum-size billion-element list. Memory-end and poisoned-tail checks supplement, rather than replace, the source proof that every vector load stays within the immutable visible span.

## Failures preserved; no clearance reruns

The original focused Vitest command has **not passed** in either role:

- Baseline: 44/45 tests passed; spatial attachment/snapshot/growth test exceeded its existing 5,000 ms limit.
- Candidate: 43/45 passed; the same spatial case and numeric read-only attachment/byte-comparison case exceeded that same limit.

These errors report timeouts, not value mismatches. The candidate-only numeric timeout is unresolved. Neither suite was retried; no timeout, assertion, fixture or production code was changed. Passing the separate fixed corpus does not erase these failures or diagnose their cause. Original logs are under [logs/baseline/](logs/baseline/) and [logs/candidate/](logs/candidate/).

The first custom baseline process also failed because the proof's worker cleanup parameter shadowed its error-listener function. The original proof/log remain intact. [correctness-v2.mjs](correctness-v2.mjs) changes only that parameter name and its reject/resolve use; all inputs/assertions/work remain identical. The corrected version was separately pinned before its first run; [PROOF-CORRECTION.md](PROOF-CORRECTION.md) records the correction. The initial failed process is not counted as a pass.

## Verified evidence and stopping decision

[VERIFIED.json](VERIFIED.json) reconciles every source/build/proof/tool pin, all 30 command receipts and log hashes, the expected three failed commands, and all successful corpus results. There were no command safety timeouts. The source/build archive contains 1,036 individually verified regular files, including both full tracked-source snapshots and every generated Wasm/JS/declaration artifact: [source-and-builds.tar.gz](source-and-builds.tar.gz), SHA-256 `18fc16ffb973ea066317d2b60011d705b80d9a6a856e15eccc298bc7a3cbdac7`.

**Stop here.** The fixed emitted-work reduction survives this compiler, so the lead is stronger than the initial source-only hypothesis. However, focused test prerequisites are still incomplete, later native optimization is unknown, and no speed/startup/regression evidence exists. Keep the single candidate unchanged. Any next step should be a separately scoped diagnosis/review of the retained test failures before considering a bounded timing plan with cold, tiny-tail, spatial, scalar, browser and ARM controls. No additional variant or favorable-result rerun is justified by this prototype.
