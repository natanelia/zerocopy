# Fresh-process method repair — 17 October 2026

This is a new measurement method, not a new production stage. The original
mixed-process methods and their failed samples remain unchanged. Stable
A/A shifts in run 39000214606 motivate this separate experiment.

## Fixed plan, set before measurement

The controller runs four blocks: ABBA, BAAB, ABBA, BAAB. A is the baseline;
B is the candidate. Each of the sixteen children loads only one build at
the same neutral module path. The controller replaces that owned temporary
copy between children, verifies its bytes, and uses a fresh runtime process.
No other measured process runs concurrently on the same machine.

A/A uses the candidate bytes for both labels. A/B uses the main and
candidate bytes. Both phases retain all 48 original endpoints at sizes
1, 2, 31, 32, 33, 1024, 1057, 32768, 32801, 262144 and 1048609. Each child
uses seven warm-up batches, twenty-one measured batches, eight million
requested values per batch and the original one-million-call cap. Neither
the workload nor the original numerical thresholds changes.

Adjacent children form eight pairs. Each pair uses the ratio of its two
within-child medians. Each block averages its two log ratios. The final
estimate is the geometric mean across all four blocks. A two-sided 95%
Student-t interval uses four block values, not the 21 correlated timer
samples as independent observations. This is a changed estimator, stated
before the new measurements, not a reinterpretation of old samples.

The original 0.95 regression floor, >1.05 target for large SIMD/public
range cases, and [0.95, 1/0.95] A/A interval remain. Additionally, each 95%
interval must clear the relevant threshold or lie fully in the A/A interval.
A failed or missing child, changed source, wrong bundle, incomplete endpoint,
invalid sample, changed runtime, or failed correctness check prevents a pass.
All planned children still run after a child error; no automatic retry exists.
Existing output directories are rejected, not overwritten.

The confidence intervals are per-endpoint and assume independent blocks.
They are not a simultaneous family-wise guarantee or a guarantee against
long-term host drift. Four blocks supply limited precision. Any failed A/A
cohort prevents production acceptance even if A/B looks faster.

## Scope and limits

The timer measures warm calls only. Imports, copying, list construction,
Wasm compilation, process startup, transport and assertions are excluded.
All results are checked against a JavaScript oracle after the timer stops.
Every size also checks the complete saved arena bytes and unchanged length.
Each fixture must stay within a 64 MiB arena; children are sequential and
have a 240-second timeout. This bounds the fixture and process lifetime;
it is not a hard operating-system RSS cap or a production memory benchmark.

The plan and source/bundle/driver hashes are written before timing. Every
child retains warm-up values, raw timer values, status, logs and partial
completed rows. The final summary keeps every pair and block ratio.
A process killed during a timer cannot supply that unfinished measurement.

Use Node and Bun separately on x64 and ARM64. Browser correctness, scalar
fallback, full integration, type checks and worker safety remain required.
A Node-only local run does not clear Bun, ARM64, browser speed, startup,
transport cost or general application performance. Optional diagnostic size
subsets are labelled `fullCoverage: false` and cannot establish full coverage.

```sh
node --test proofs/numeric-tree-process.node.mjs
BASE_DIR=../zerocopy-base CANDIDATE_DIR=. RUNTIME_BIN=node KIND=aa OUT_DIR=proofs/results/process-node-aa node proofs/numeric-tree-process.mjs
BASE_DIR=../zerocopy-base CANDIDATE_DIR=. RUNTIME_BIN=node KIND=ab OUT_DIR=proofs/results/process-node-ab node proofs/numeric-tree-process.mjs
```

Use a new output path for each declared experiment. Do not repeat an unchanged
cohort until it passes. Preserve its failure and investigate its cause first.
