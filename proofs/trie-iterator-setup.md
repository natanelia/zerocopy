# HAMT iterator setup diagnostic

This experiment starts at exact main commit `3773c6e519c7c0958da13727ed1082f449f3ee25`. The only production change is `Arena.leaves`: empty and single-leaf iterators do not create work arrays, and other traversals allocate their private patch-resolution arrays only when a patched branch is reached. Every iterator still owns its continuation and scratch.

## Correctness and allocation mechanism

`trie-iterator-setup.test.ts` checks native generator/prototype behavior, lazy start/close, empty/single/canonical/collision roots, multiple patched branches, delayed allocation, independent forks, journal precedence, paused readers across writer growth, callback reentry, early return/throw, and both attachment modes. `trie-iterator-workers.mjs` uses actual Node worker threads for shared and copied payloads, including nested values and sets. It is run against both public bundles.

`trie-iterator-allocations.ts` extracts the exact baseline and candidate generator methods using the TypeScript AST and wraps their allocation expressions with counters. It verifies identical leaf-pointer sequences for eight fixtures and records full-source/method hashes. Counts describe executed source allocation sites, not retained heap, peak memory, RSS, or allocations surviving engine escape analysis. Each executed `new Uint32Array(16)` requests 64 bytes of backing storage.

- Empty and single-leaf traversals: three work-array allocation sites become zero
- Canonical and collision traversals: three become one
- Patched traversals: three remain three, with one lane buffer per iterator
- Creating and closing an unstarted iterator executes zero work-array allocation sites in both versions

## Paired timing protocol

The diagnostic workflow is limited to the `perf/trie-iterator-setup-*` branch. It uses Node 22 and Bun 1.4.2 on x64 and ARM64. There is no browser-performance claim.

Ten workloads cover empty/singleton/canonical maps, canonical size 32 and 4096 scans, full-hash collisions, patched size 32 and 4096 scans, a valid legacy v4 journal over a 32-entry base, a 4096-entry get control, and a prewarmed 32-entry no-op set control. The journal fixture is prepared in a private copied payload before timing. The set control measures the existing cached no-op behavior; it does not measure changed-value writes.

Each measurement process imports exactly one portable build from the same neutral module path. Source guards require the exact clean baseline, matching WASM/build inputs, and changes confined to the leaves method. Source/build hashes, runtime versions and CPU information are retained. Neutral files are checked before and after each child process. The final source hashes are checked again before completing the report.

For each workload, discarded baseline/candidate pilots warm for at least 150 ms and calibrate toward a 15 ms batch. All later subjects use the larger pilot work count, and an identical warm-up scan count equal to twice the larger pilot warm-up. Four blocks balance A/A versus A/B quartet order. Every quartet contains two adjacent pairs in ABBA or BAAB order. A/A uses four separate baseline processes, with the same lexical role ordering. Each measured process returns 11 raw batches. Dataset construction and validation occur before timing; iterator creation and full consumption are inside each scan. Every batch verifies its checksum. Calibration attempts, work counts, warm-up duration, all measured durations, and short-batch/warm-floor flags are retained.

A batch under 10 ms or measured warm-up under 150 ms is flagged. Timing flags preclude a non-inferiority conclusion from that workload; they are never silently discarded. Successful workflow execution establishes functional/proof completion, not performance acceptance.

## Predeclared inference rule

Before this CI run, the candidate-latency non-inferiority margin is 2%. Each ABBA/BAAB quartet contributes the mean of its two log(candidate latency / baseline latency) pair observations as one independent unit. Two-sided 95% Student t intervals use the number of quartets and its corresponding degrees of freedom: four quartets gives three degrees of freedom. Neither pairs within a quartet nor timed batches count as extra independent replicates. A/A is reported separately and is never subtracted from A/B.

- Lower interval bound greater than 1.02: detected material loss
- Upper interval bound at most 1.02: evidence within the declared margin
- Otherwise: inconclusive

Intervals are per-workload and unadjusted for multiple comparisons. Reports also retain absolute batch durations, nanoseconds per full scan, and sub-margin latency shifts. They do not establish exact-zero or universal no-regression claims. Small-sample intervals may remain wide, and all flagged evidence is diagnostic only.

## Reproduce

Build both checkouts with the same dependencies and unchanged WASM inputs, then run:

```sh
bun proofs/trie-iterator-allocations.ts .proof-baseline/arena.ts
node --test proofs/trie-iterator-performance.node.mjs
node proofs/trie-iterator-workers.mjs
node proofs/trie-iterator-workers.mjs .proof-baseline/dist/shared.js
TRIE_OUTPUT=proofs/results/trie-iterator/node.json node proofs/trie-iterator-performance.mjs
TRIE_OUTPUT=proofs/results/trie-iterator/bun.json bun proofs/trie-iterator-performance.mjs
```

The prospective CI defaults are four blocks, 11 samples, 150 ms warm-up, and a 10 ms measurement floor. Environment overrides are recorded in the output. Earlier short local screens are kept separately as inconclusive evidence; they used two blocks, five samples, and 100 ms warm-up and had substantial identical-build variation and timing flags.
