# Fixed-work supplement for three Bun empty-array controls

This proof-only branch preserves runtime candidate `da9b432cdf4028c62582455376f18657be65fdf8` (tree `84882edc46755995393fbb7aac0f743707c86059`) against baseline `3773c6e519c7c0958da13727ed1082f449f3ee25`. It leaves the original 40-case workflow, timed kernel, workloads, source guard, statistics and browser fixtures byte-for-byte unchanged. The supplement workflow is limited to `proof/block-traversal-empty-controls`; pushing this branch cannot trigger the original workflow's `perf/block-traversal-*` filter.

## Why this supplement exists

Original run [37831469272](https://github.com/natanelia/zerocopy/actions/runs/37831469272) and artifact [11575288547](https://github.com/natanelia/zerocopy/actions/runs/37831469272/artifacts/11575288547) remain authoritative and immutable. The artifact ZIP SHA256 is `552b08659340e950c4795776b90a340c7dad346bd23c4882caa9510b565d3b3b`. Its extracted Node and Bun records have separately pinned SHA256 hashes.

Node had 32 within-margin cells and eight statistically inconclusive cells, with no validity flags. Bun had 34 within-margin cells, three statistically inconclusive cells and three timing-invalid empty-array cells. There were no material losses or matched A/A drift. Across the invalid Bun cells, 170 candidate batches fell below 10 ms (minimum 9.057015 ms), and 24 candidate warmups were 130.444–141.352 ms, below 150 ms. Pilot rates were roughly 41.9–42.1 ns versus later candidate rates around 26.6–26.9 ns. This demonstrates calibration undershoot; it does not establish compiler elimination or another runtime cause.

The old gate stays `flagged-inconclusive`. No old samples, summaries, flags or artifacts are edited, pooled with new samples, replaced, or waived. All eleven originally statistical-inconclusive cells remain inconclusive.

## Prospective fixed work

Only Bun 1.4.2 x64 runs, for the following numeric empty controls. Both A/B variants and both baseline A/A roles receive exactly twice the original common timed repeat and exactly twice the original common warmup scans.

| Cell | Original repeat | New repeat | Original warmup scans | New warmup scans |
| --- | ---: | ---: | ---: | ---: |
| linked.toArray | 386,202 | 772,404 | 4,634,424 | 9,268,848 |
| doubly.toArray | 391,881 | 783,762 | 4,702,572 | 9,405,144 |
| doubly.toArrayReverse | 345,230 | 690,460 | 4,487,990 | 8,975,980 |

The checked-in `block-traversal-empty-controls-plan.json` records the complete fixed study, original plans, original hashes, and all schedules. Before timing, preparation verifies this plan, hashes the original ZIP and records, recomputes the original summaries, checks the original eligibility conditions, builds exact sources, compares emitted JS/WASM hashes with the original study, archives complete emitted bundles and original helpers, and writes a hashed frozen study. There are no pilots or timing-dependent choices in this supplement. The original exported `makeSchedule`, `summarize`, `prepareSubject`, source helpers and `measureSingle` are reused. Each child invokes the archived original kernel's existing `--subject` entry point with `phase: measure`; the kernel file itself is pinned byte-for-byte.

There are four balanced quartets per comparison, exactly two ABBA and two BAAB, with A/B and baseline A/A interleaved by a fixed seed. Three cells × eight quartets × four fresh subjects = 96 measured subjects and 2,016 measured batches. Each has all 21 samples. The four quartet means remain the independent units, with Student-t df=3 pointwise 95% intervals and the unchanged 2% latency margin. The unchanged 10 ms batch and 150 ms warmup floors and original matched-control drift rule remain binding. A/A is never used to normalize A/B. There are no adaptive extra scans, timing-driven retries, sample exclusions, or waived flags. A failure stops the single study and retains partial evidence. CI run attempts beyond one are rejected; the runner refuses to overwrite measured evidence. A fresh dispatch must not be used to seek a favorable outcome.

## Complete evidence and neutral paths

Every fresh child imports one build at the same neutral physical `subject/dist/shared.js` path, with original package bytes and the complete dist tree. The archived original `prepareSubject` implementation performs its existing checks; additional receipts record the actual resolved root, entry and package paths, and a manifest of every emitted file before and after each child. All child stdout, stderr, exits and attempts are retained, including failed attempts. Complete baseline/candidate dist bytes, package files, original artifact ZIP and extracted records, original helpers, frozen plan and new proof sources are uploaded. The hidden workflow is additionally archived at visible `proof-source/workflow.yml`, and artifact upload includes hidden files explicitly.

## Browser eligibility and scope

The separate supplement may support the next correctness stage only if all three new A/B cells are valid and within the 2% margin, every matched A/A comparison is valid without control drift, and the original evidence has no material loss, control drift or other validity flags. This requirement is recomputed from raw results before each browser job. Derived floating-point summary comparisons allow only 32 binary64 machine epsilons (scaled by max(1, absolute value)) for Node/Bun final-bit differences in logarithms and exponentials. Raw evidence bytes, samples, hashes, schema, flags and classifications retain exact checks; statistical thresholds are unchanged. Statistical uncertainty in other original cells is explicitly retained. The original Bun gate is never rewritten as eligible.

Only after the focused job qualifies do three dependent jobs run Chromium, Firefox and WebKit correctness. They build exact main377 and da9b, verify their emitted bytes against the supplement, and reuse the unchanged original 40 fixtures and actual paused/grown shared/copy workers for both variants. They contain no performance measurement. Eligibility is permission to run correctness checks; it is not equivalence, adoption, or evidence covering every application, architecture or operation.

## Local review

Preparation is untimed. Deterministic tests cover the exact fixed work, schedules, unchanged helper hashes, original-evidence conditions, full bundle/path receipts, retained original flags and uncertainty, interval and control-drift failures, malformed samples, and workflow scope. The timing command explicitly rejects local execution. No timing run or publication is performed as part of preparing this branch.
