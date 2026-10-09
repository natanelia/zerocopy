# Independent audit: trie DataView capture, Bun x64

Run [37850139130](https://github.com/natanelia/zerocopy/actions/runs/37850139130), attempt 1, is **failed overall**. The [Bun job](https://github.com/natanelia/zerocopy/actions/runs/37850139130/job/113560732694) completed its screen; the [Node job](https://github.com/natanelia/zerocopy/actions/runs/37850139130/job/113560733023) failed before any pilot. There is no Node performance result.

The Bun x64 candidate has substantial full-traversal gains, but **empty HAMT map entries detects material loss: +3.78% [95% CI +3.33%, +4.23%]**. Its baseline/candidate absolute medians are 58.158/60.349 ns per complete operation, a 2.191 ns difference. All eight adjacent pairs and all four independent quartets are adverse. Gains elsewhere do not offset this control loss. Six other A/B cells are inconclusive. No aggregate acceptance or portable-performance claim is supported.

## Identity and scope

- Proof: `d7e097270fe80e785c6b7740f73f366d1ad3cb83`; exact tree `faed2ebe542c0beb849843be29a390300f1540c4`, verified through GitHub and the independently reviewed local tree.
- Baseline runtime: `3773c6e519c7c0958da13727ed1082f449f3ee25`.
- Candidate runtime: `47402ad2ec2ac7226831a577e6e224c555710af8`.
- Production delta: only `arena.ts`, 13 additions/10 deletions, capturing one DataView per nonempty `Arena.leaves`/`radixLeaves` traversal. Scratch allocation expressions are unchanged. Empty traversals still execute their previous scratch expressions.
- Runtime: Bun 1.4.2, Linux x64, AMD EPYC 7763; four logical CPUs exposed. Bun's compatibility `process.versions.node` field is 26.3.0; this is not a Node timing run. Prerequisite Node commands used Node 22.23.3.
- Measurement window: 2026-10-08T21:58:18.368Z to 2026-10-08T22:18:17.033Z.
- No new timing, retries, rebuilds, runtime/source edits, PR changes, or publication were performed for this audit.

## A/B results: every frozen case

Percentages are candidate/baseline latency changes. Absolute medians are medians across eight process medians per build, in ns per complete public operation. For a 4096-entry traversal, an operation consumes all 4096 entries; the number is not per entry. CV is the sample standard deviation divided by the mean of those eight process medians. Controls and targets retain their prospective classifications.

| Workload | Kind | A/B change and pointwise 95% CI | Baseline ns | Candidate ns | CV baseline / candidate | Classification |
|---|---|---|---:|---:|---:|---|
| hamt/4096/canonical/get | control | -6.04% [-23.04%, +14.71%] | 22.267 | 22.106 | 1.09% / 14.47% | inconclusive |
| hamt/object 4096/canonical/keys | target | -8.50% [-9.90%, -7.07%] | 397003.559 | 363219.324 | 1.09% / 1.31% | evidence within margin |
| hamt/4096/canonical/first | control | -6.83% [-9.43%, -4.15%] | 334.505 | 312.310 | 1.22% / 0.95% | evidence within margin |
| set hamt/0/canonical/values | control | +1.84% [+0.15%, +3.57%] | 87.372 | 89.046 | 0.72% / 0.90% | inconclusive |
| radix/object 4096/canonical/keys | target | -1.11% [-4.21%, +2.09%] | 3882031.409 | 3843362.636 | 1.08% / 2.18% | inconclusive |
| set hamt/1/canonical/values | control | -2.12% [-3.49%, -0.74%] | 194.566 | 189.551 | 0.88% / 1.32% | evidence within margin |
| hamt/4096/canonical/entries | target | -9.08% [-10.49%, -7.65%] | 447718.405 | 407551.977 | 0.88% / 1.02% | evidence within margin |
| radix/0/canonical/entries | control | +4.50% [+0.72%, +8.43%] | 81.513 | 83.769 | 1.02% / 4.42% | inconclusive |
| radix/1/canonical/entries | control | -0.48% [-3.30%, +2.43%] | 180.021 | 178.351 | 0.43% / 2.16% | inconclusive |
| hamt/0/canonical/entries | control | +3.78% [+3.33%, +4.23%] | 58.158 | 60.349 | 0.74% / 0.69% | detected material loss |
| radix/4096/canonical/get | control | -0.30% [-1.00%, +0.41%] | 22.776 | 22.737 | 0.65% / 0.50% | evidence within margin |
| set radix/0/canonical/values | control | +1.79% [-0.87%, +4.52%] | 141.328 | 142.975 | 1.08% / 2.56% | inconclusive |
| hamt/2/collision/entries | control | -7.82% [-9.02%, -6.60%] | 235.779 | 218.198 | 1.24% / 1.03% | evidence within margin |
| set radix/1/canonical/values | control | -1.75% [-4.88%, +1.49%] | 295.167 | 290.889 | 2.76% / 1.54% | evidence within margin |
| hamt/32/patched/entries | control | -7.51% [-10.88%, -4.01%] | 3622.154 | 3331.937 | 1.90% / 4.04% | evidence within margin |
| radix/4096/journal/entries | target | -3.25% [-5.59%, -0.85%] | 627682.194 | 609174.187 | 2.29% / 1.83% | evidence within margin |
| hamt/4096/patched/entries | target | -10.41% [-11.34%, -9.46%] | 476927.064 | 426996.186 | 1.13% / 0.99% | evidence within margin |
| radix/4096/canonical/entries | target | -10.57% [-12.88%, -8.20%] | 472885.986 | 422254.301 | 1.60% / 1.61% | evidence within margin |
| radix/4096/canonical/first | control | -5.17% [-7.46%, -2.83%] | 228.914 | 216.464 | 1.40% / 1.98% | evidence within margin |
| hamt/1/canonical/entries | control | -3.60% [-6.03%, -1.11%] | 153.251 | 147.207 | 1.21% / 1.00% | evidence within margin |

The 20 A/B cells comprise 13 with evidence within the predefined 2% margin, six inconclusive, and one detected material loss. Of six prospective targets, five establish a gain (upper interval below 1); radix object keys is inconclusive. These counts describe cells, not an aggregate acceptance decision. The inconclusive empty radix map estimate is adverse (+4.50%); the interval is too wide to classify it as a detected >2% loss or as within margin.

## A/A controls: every frozen case

These are independent baseline-only quartets, with right/left role ratios. They are reported directly and never used to normalize A/B. None meets both parts of the frozen drift rule: point estimate outside [1/1.02, 1.02] and interval excluding 1. Eleven A/A intervals are inconclusive against the 2% loss margin; they are not relabeled as passes. A lack of detected drift is not proof of an absence of drift.

| Workload | A/A change and pointwise 95% CI | Left ns | Right ns | Margin classification | Drift flag |
|---|---|---:|---:|---|---|
| hamt/4096/canonical/get | +0.23% [-0.34%, +0.80%] | 22.110 | 22.127 | evidence within margin | False |
| hamt/object 4096/canonical/keys | -0.20% [-2.37%, +2.02%] | 399457.076 | 396811.063 | inconclusive | False |
| hamt/4096/canonical/first | +0.92% [-0.35%, +2.21%] | 333.405 | 338.713 | inconclusive | False |
| set hamt/0/canonical/values | -0.37% [-1.22%, +0.49%] | 87.938 | 87.473 | evidence within margin | False |
| radix/object 4096/canonical/keys | -1.12% [-3.10%, +0.91%] | 3883914.909 | 3843865.409 | evidence within margin | False |
| set hamt/1/canonical/values | -0.42% [-1.45%, +0.62%] | 195.249 | 194.871 | evidence within margin | False |
| hamt/4096/canonical/entries | +1.87% [+0.03%, +3.75%] | 446696.973 | 452149.705 | inconclusive | False |
| radix/0/canonical/entries | -0.10% [-1.12%, +0.92%] | 81.614 | 81.616 | evidence within margin | False |
| radix/1/canonical/entries | +0.25% [-7.22%, +8.33%] | 182.129 | 179.542 | inconclusive | False |
| hamt/0/canonical/entries | -0.32% [-2.27%, +1.67%] | 58.336 | 57.753 | evidence within margin | False |
| radix/4096/canonical/get | +0.93% [-0.97%, +2.88%] | 22.756 | 23.039 | inconclusive | False |
| set radix/0/canonical/values | -0.58% [-1.75%, +0.61%] | 142.004 | 141.550 | evidence within margin | False |
| hamt/2/collision/entries | -0.13% [-1.43%, +1.18%] | 233.678 | 233.452 | evidence within margin | False |
| set radix/1/canonical/values | +0.03% [-4.71%, +5.01%] | 294.364 | 296.673 | inconclusive | False |
| hamt/32/patched/entries | +2.12% [-0.89%, +5.22%] | 3594.152 | 3711.578 | inconclusive | False |
| radix/4096/journal/entries | +2.46% [-3.86%, +9.20%] | 627309.948 | 639467.306 | inconclusive | False |
| hamt/4096/patched/entries | -2.32% [-7.31%, +2.95%] | 476992.500 | 473415.426 | inconclusive | False |
| radix/4096/canonical/entries | +0.94% [-1.63%, +3.59%] | 466098.764 | 472929.083 | inconclusive | False |
| radix/4096/canonical/first | -0.52% [-4.91%, +4.08%] | 228.434 | 230.162 | inconclusive | False |
| hamt/1/canonical/entries | +0.35% [-0.43%, +1.15%] | 153.176 | 153.302 | evidence within margin | False |

## Independent statistical reconstruction and completeness

The audit reads each archived raw subject stdout, independently recreates process medians and adjacent left/right pairing in Python, averages the two pair log ratios within each quartet, and computes the mean and sample variance of four quartet log ratios. The interval is exp(mean ± 3.182446305284263 × sqrt(variance/4)), with Student-t df=3. It does not import or execute the submitted estimator. All 40 recomputed A/B and A/A intervals and their validity/classification decisions agree with the submitted cells to numerical tolerance.

All 20 workload identities, 40 disposable pilots, 20 common plans, 160 quartets, 640 measured processes, and 13,440 measured batches are present. The complete seeded xorshift32 shuffle, pilot order, mode interleaving and ABBA/BAAB orientations were independently reconstructed; each mode has exactly two orientations of each kind per case. Every raw output binds to its chronological slot, build, phase and operation. All pilots finish before the common plans are frozen, and all plans are frozen before the first measured process. No retry, missing subject, dropped batch, failed measurement, or short sample is present in the Bun screen.

Both-build common work plans were recalculated from the fastest observed post-warmup pilot sample across every calibration step. All pilot prewarm and work limits, sample counts, final calibration floors, measured repeat counts and fixed warmup totals match the frozen rules. The fastest measured batch is 24.971 ms (floor 10 ms); the shortest measured warmup is 363.297 ms (floor 150 ms). No floor or cap invalidates a Bun cell.

The full JSON contains all 160 quartet log ratios, all 320 adjacent pair ratios, eight absolute process medians per role/mode/case, sample variance and CV, minima/maxima, all common plans and every cell's flags. The chronological file preserves each process's within-process sample variance as a descriptive statistic; batches are never counted as independent inferential replicates.

One HAMT existing-key get candidate process has a notably lower median than its peers (13.70 ns versus roughly 22 ns). It is retained without trimming, contributing to that cell's wide A/B interval [−23.04%, +14.71%]. Its batch/warmup floors pass. No unsupported causal explanation is assigned.

## Correctness, sources, builds and isolation

- All 42 registered Bun-job prerequisites have unique commands, zero exit status, no signal/error, matching raw-log hashes, and chronological completion before freeze. Baseline/candidate full standard Bun suites pass 753/767 tests; the supplemental Node-compatible source suites pass 729/743. The supplemental suite explicitly excludes `workers.test.ts`; full Bun coverage retains it.
- Both built Node worker-task lifecycle suites pass 18 tests. Actual Node and Bun shared/copy worker receipts each cover 18 structures, three arenas, growth before first read and while paused, interleaved iterators, no shared allocation, and unchanged source bytes. Installed-package checks, declarations, ordinary types, strict public worker consumers, both typed-value modes, Redux/geometry types and original worker helpers all have retained passing receipts. The 41 deterministic protocol/source/workload/negative tests pass.
- All 128 untimed mechanism cases preserve allocation sites and executed stack/lanes/patches/pending allocation counts. This is not a measurement of JS heap allocations, generator-frame size, retained memory, or speed.
- For each build, all 89 guarded production/compiler/test inputs and 107 baseline/112 candidate validation inputs match immutable Git content. The only changed guarded production file is `arena.ts`. All 21 archived proof files match the reviewed proof tree, including hidden and visible workflow copies.
- Both independently rebuilt 12-file WASM sets match exact pins and each other. Both exact 12-file emitted JS sets match the independently reviewed build pins. Complete dist/package manifests (54 files each) match the freeze and final archived builds.
- AssemblyScript 0.28.20, Binaryen 131.0.0-nightly.20260721, long 5.3.2 and TypeScript 5.9.3 package manifests are independently rehashed to their reviewed pins and equal between builds. These are archived per-file hash receipts; compiler package file bodies were not archived, and this audit does not claim a fresh rebuild.
- All 680 subjects use one physical neutral root, original package bytes, identical helper paths/cwd/executable, default runtime flags, and disabled compile cache. All 1,360 before/after complete manifests match the intended build plus three fixed helper files. No role/build label is supplied as a subject argument.
- All 680 complete-output digests and terminal values match independently recreated Python workload models, including FNV nibble order, patched snapshots, four-edit radix journals and object payloads. Shape checks, before/after payload hashes and allocator receipts agree. These validate the retained correctness evidence without executing fresh workloads.
- Final tracked-source status shows no tracked modifications; the retained status contains only untracked generated `geometry-kernels.wat`. Its presence does not change any pinned input, WASM, or staged bundle.

## Preserved Node prerequisite failure

The separate Node job records 15 prerequisite attempts: 14 passed and `baseline/unit-node-compatible` failed with exit 1, raw error `Worker exited unexpectedly`, Node 22.23.3. Its baseline standard Bun suite had passed all 753 tests. Twenty-seven prerequisites were never run, and sealing, freeze, pilots and measurements were skipped. The failure is preserved as a failed prerequisite, not converted into a performance result or a correctness pass. The successful scoped Node checks inside the Bun job are separate observations.

## Limits and decision

Keep this candidate unaccepted under the frozen screen: one material-loss control and six inconclusive A/B cells remain. The large traversal improvements are real findings within this Bun x64 screen, but cannot compensate for the empty-map regression. The small absolute size of that regression does not change the predefined relative margin.

Four independent quartets provide limited precision; intervals are pointwise and unadjusted across the frozen cells. This is one hosted x64 runner and one completed runtime. There is no Node timing, ARM64 result, browser result, application-level workload result, or heap-retention measurement here. Earlier rejected/held candidates and their adverse studies remain unchanged. No post-result extra sampling or threshold changes have been applied.

## Reproducible audit files

- `recompute.py`: independent raw-data statistical and chronological reconstruction.
- `audit_evidence.py`: source, compiler receipt, prerequisite, build, package, schedule, output-oracle and isolation validation.
- `independent-recomputation.json`: all case statistics, pair/quartet values, plans and flags.
- `all-cells.csv`: all A/B and A/A cells with absolute medians/variance and intervals.
- `chronological-subjects.json`: all 680 chronological subjects, including floor and variance diagnostics.
- `reconstructed-schedule.json`, `independent-workload-oracles.json`, `prerequisite-receipts.json`, `independent-evidence-audit.json`.
- `bun.zip`, `node.zip`: complete original archives; extracted `bun/` and partial `node/` contents remain untouched.
- `github-run.json`, `github-jobs.json`, `github-artifacts.json`, `github-proof-commit.json`: preserved connector metadata.
- `runtime-arena.diff`: exact production diff for review.

Artifact ZIP SHA-256 values:

- Bun artifact 11582896405: `fd2b617aa67a38af09d3ae20f5730d011ee14edeb91ef6bb1c294b97910fe51e` (6,082,923 bytes; 2,125 archive entries).
- Node artifact 11580928686: `044b50d0069b64e0153122e4f35fe6fc3035a3d026e218e66acac430feb02021` (2,743,318 bytes; 116 archive entries).

Both hashes match GitHub's recorded digests. ZIP CRCs, duplicate paths, traversal paths and symlinks were checked before relying on extracted contents. Independent audits report zero evidence or arithmetic mismatches. This audit does not erase the statistical loss or failed Node prerequisite.
