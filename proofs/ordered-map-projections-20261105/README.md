# Ordered-map projection study

In the final formal study, direct ordered-map keys and values improved every tested projection workload in every independent before/after pair in Node and Bun. The accepted scope is these complete repeated projections, including the ordered-set consumer. This is not a claim that every ordered-map operation becomes faster.

**Remaining control uncertainty:** Bun's unchanged entry scan had a paired latency ratio of 1.059, or about 5.9% slower, with four of six adverse pairs and a 95% interval of [0.962, 1.165]. This study does not establish either a material regression or equivalence for that control. The apparent improvement in unchanged lookups is not claimed as an optimization benefit.

## What changed

[SharedOrderedMap](../../shared-ordered-map.ts) now traverses its insertion log directly for `keys()` and `values()`. It decodes only the requested field, avoids temporary entry tuples and the intermediate `entries()` generator, and uses one already-valid memory view for immutable log and leaf metadata. Stale entries still resolve by full key bytes and matching insertion ordinal, preserving replacements and delete/reinsert order. Empty projections finish before acquiring an arena view or allocating the order array.

The source of `entries()` and `forEach()` remains byte-for-byte unchanged, as recorded in [the control method hashes](results/unchanged-controls.json). Lookup, writer, Arena, WASM, public signatures and the wire format are unchanged. Iteration still keeps a local order array and scans historical log entries; this is not a new compaction scheme or an asymptotic traversal improvement.

Keys can avoid substantial legitimate work: when a map exceeds the bounded decoder cache, baseline entry-backed keys continue parsing and freezing uncached JSON values on every scan. The 4,096-object case deliberately covers that existing behavior. Warm-up does not make all values cached. The smaller churned object case and primitive cases remain in the matrix.

## Formal before/after results

Recorded on 2026-11-05 using Node 24.22.1 and Bun 1.4.2 on Linux x64, AMD EPYC 9V74. All subjects were pinned to CPU 2. Each cell below measures one complete public operation materialized to an array. Empty projections materialize both keys and values arrays; the lookup control materializes all 4,096 requested results, including misses.

**Ratios are candidate latency / baseline latency; lower is faster.** Before and after times are marginal medians of the six process medians, shown in microseconds. The paired ratio is the geometric mean of six paired process ratios, so it need not equal the quotient of the two displayed times. Intervals are nominal per-case 95% log-ratio Student-t intervals with five degrees of freedom, without a multiple-comparison adjustment.

| Runtime | Case | Before (µs) | After (µs) | Paired ratio [95% CI] | Pair range |
|---|---|---:|---:|---:|---:|
| Node | keys-object-large | 5,259.789 | 945.585 | 0.183 [0.170, 0.196] | 0.167–0.201 |
| Node | keys-object-churn | 728.766 | 332.244 | 0.449 [0.419, 0.481] | 0.410–0.488 |
| Node | keys-number-small | 5.272 | 2.619 | 0.531 [0.412, 0.685] | 0.400–0.726 |
| Node | values-number-large | 1,158.289 | 201.300 | 0.179 [0.145, 0.221] | 0.137–0.239 |
| Node | values-string-churn | 846.134 | 343.456 | 0.400 [0.369, 0.433] | 0.361–0.433 |
| Node | values-boolean-small | 5.067 | 1.818 | 0.354 [0.323, 0.389] | 0.326–0.399 |
| Node | ordered-set-churn | 756.119 | 318.802 | 0.429 [0.354, 0.520] | 0.304–0.503 |
| Node | entries-number-control | 1,719.136 | 1,688.863 | 0.953 [0.899, 1.010] | 0.876–1.022 |
| Node | lookup-number-control | 222.149 | 211.898 | 0.942 [0.874, 1.016] | 0.837–1.007 |
| Node | empty-projections | 0.937 | 0.373 | 0.392 [0.349, 0.439] | 0.361–0.472 |
| Bun | keys-object-large | 7,141.432 | 1,125.743 | 0.159 [0.139, 0.181] | 0.130–0.185 |
| Bun | keys-object-churn | 635.891 | 436.603 | 0.703 [0.606, 0.815] | 0.558–0.851 |
| Bun | keys-number-small | 3.085 | 1.755 | 0.557 [0.465, 0.667] | 0.438–0.659 |
| Bun | values-number-large | 657.920 | 136.291 | 0.205 [0.176, 0.238] | 0.164–0.255 |
| Bun | values-string-churn | 679.767 | 477.755 | 0.735 [0.619, 0.871] | 0.622–0.922 |
| Bun | values-boolean-small | 3.082 | 1.420 | 0.456 [0.395, 0.526] | 0.376–0.522 |
| Bun | ordered-set-churn | 534.002 | 420.747 | 0.775 [0.712, 0.843] | 0.690–0.839 |
| Bun | entries-number-control | 1,296.767 | 1,329.158 | 1.059 [0.962, 1.165] | 0.928–1.174 |
| Bun | lookup-number-control | 176.812 | 154.558 | 0.909 [0.861, 0.960] | 0.847–0.972 |
| Bun | empty-projections | 0.723 | 0.445 | 0.585 [0.512, 0.669] | 0.500–0.702 |

The seven nonempty projection cases were faster in all six pairs in both runtimes. Their estimated time reductions were 47–82% in Node and 23–84% in Bun. Empty projections were also faster in all pairs. These are workload-specific observations; no browser, isolated first-read, allocation-rate or peak-memory performance claim is made.

The short V2 screen had slower lookup controls in both runtimes. That penalty did not persist in the independent formal study. The six formal control ratios remain explicit:

- Node lookup-number-control: 0.8367, 0.8928, 1.0073, 0.9778, 0.9940, 0.9571.
- Bun lookup-number-control: 0.9182, 0.9723, 0.9503, 0.8474, 0.9014, 0.8725.
- Bun entries-number-control: 0.9284, 1.0595, 1.1070, 1.1329, 1.1744, 0.9726.

## Separate baseline A/A controls

Both roles in these pairs load the same baseline build. These results describe the observed process variation; they are not used to subtract, correct or cancel an A/B result. A/A intervals use four process pairs and three degrees of freedom. The raw driver's generic progress text calls every ratio candidate/baseline, but `mode: aa-baseline` explicitly identifies these same-build pairs.

| Runtime | Case | Before (µs) | After (µs) | Paired ratio [95% CI] | Pair range |
|---|---|---:|---:|---:|---:|
| Node | entries-number-control | 1,739.851 | 1,747.619 | 1.029 [0.943, 1.122] | 0.969–1.104 |
| Node | empty-projections | 1.013 | 0.932 | 1.022 [0.701, 1.491] | 0.864–1.452 |
| Bun | entries-number-control | 1,258.734 | 1,275.393 | 0.947 [0.778, 1.154] | 0.798–1.052 |
| Bun | empty-projections | 0.688 | 0.756 | 1.078 [0.852, 1.362] | 0.948–1.262 |

The broad A/A intervals, particularly for empty projections, limit fine-grained comparisons. They do not prove the Bun entries result is neutral. The primary projection gains are much larger and repeat in every pair.

## Method and correctness checks

The fixed [plan](plan.md), [driver](benchmark.mjs) and [workloads](workloads.mjs) are retained. Each fresh process imports **one build and one case** at the same neutral pathname. The controller replaces the entire portable distribution before each process. Six A/B pairs per case and runtime alternate baseline-first and candidate-first order; case order rotates between pairs. A/A comparisons are interleaved separately. The formal run contains 272 measured processes: 240 A/B subjects and 32 A/A subjects. The 2,992 timed batches are repeated observations inside those processes, not independent sample units.

Fixture construction, native Map/Set oracle creation, memory hashing and result verification are outside timing. The timed region includes allocation of the outer retained-results array, every complete public operation and its returned arrays. Outputs escape through a global blackbox after timing, and every output row is checked against the independent ordered oracle. No other projection is called to prepare that oracle. The previous blackboxed batch may stay alive while the next one is constructed.

Published arena bytes, allocation position, exact output digests and complete outputs are checked for both builds. Both variants have identical initial operations and caches except for work intentionally removed by the candidate. There are no invalid nested descriptors or artificial decode failures in the performance cases.

Common repeat counts were calibrated prospectively from both builds during the V2 screen, then reused unchanged for formal confirmation with exact source, bundle, driver and plan guards. Calibration and both complete screens remain saved. Screening used two fresh pairs, seven samples and at least 150 ms timed warm-up per process. Formal subjects used eleven samples, at least 500 ms of actual timed warm-up, at least eight warm-up batches and at least 32,768 output-element bookkeeping units. The 512-batch warm-up limit is a failure condition, not an early-exit rule.

Batches target 20 ms, with caps of 65,536 calls, 1,048,576 materialized element slots and an estimated 32 MiB of returned storage **per batch**. The estimate includes arrays and strings; it is neither a measured heap/RSS value nor a total live/peak-memory cap. Warm-up uses the same elapsed-time floor for empty cases. No observation, case or adverse result was removed.

Formal warm-up actually lasted 500.183–1917.597 ms, across 8–25 batches. The shortest measured batch was 9.528 ms; 114 of 2,992 measured batches were below the 20 ms target. Caps and short batches are retained, not filtered. Capped subject cases: bun empty-projections (repeat 65536).

Across formal warm-up and measurement, the driver checked 64,897,449 complete results and 1,841,180,704 ordered output rows. An entry row checks both key and value; this is not a count of individual scalar fields. One initial untimed check per subject is additional to these counters.

All builds, tests and timings used the shared performance lock. CPU affinity and serialized jobs reduce interference but do not make the shared host a dedicated benchmark machine. No timing was rerun after the formal result, and no further source variant was tried.

## Screening history and correction

V1's exact source, tests, driver and original plan are in [rejected-v1](rejected-v1/archive-manifest.json). V1 improved all seven nonempty cases in both runtimes, but Node empty scans slowed in both pilot pairs (1.180 and 1.195). V2 added only the early empty return plus its correctness test; every workload and measurement setting stayed fixed.

The original V2 rationale incorrectly said baseline empty entries did not acquire a view. **The baseline already acquired that view.** The cause of the V1 slowdown was not established. The [erratum](plan-erratum.md), recorded during V2 screening before formal confirmation, corrects that claim without editing the hashed historical plan. V2 should be understood as skipping unused empty-path setup, with its effect judged by measurements.

Every pilot result is shown below. Each cell is a geometric ratio over two fresh process pairs, with no confidence interval; individual pair values and all batches remain in the raw recordings.

| Case | V1 Node | V2 Node | V1 Bun | V2 Bun |
|---|---:|---:|---:|---:|
| keys-object-large | 0.170 | 0.204 | 0.154 | 0.145 |
| keys-object-churn | 0.397 | 0.442 | 0.783 | 0.809 |
| keys-number-small | 0.475 | 0.580 | 0.518 | 0.581 |
| values-number-large | 0.230 | 0.167 | 0.197 | 0.225 |
| values-string-churn | 0.460 | 0.475 | 0.776 | 0.689 |
| values-boolean-small | 0.445 | 0.437 | 0.492 | 0.506 |
| ordered-set-churn | 0.511 | 0.523 | 0.817 | 0.796 |
| entries-number-control | 0.994 | 1.003 | 1.282 | 0.959 |
| lookup-number-control | 1.003 | 1.151 | 1.083 | 1.186 |
| empty-projections | 1.188 | 0.712 | 0.688 | 0.564 |

The adverse V1 Bun entry and lookup controls, V2 lookup controls, and formal Bun entry result remain visible. The source was not tuned in response to those unchanged-operation observations.

## Validation

[Regression tests](../../ordered-map-projections.test.ts) cover cold legitimate JSON and nested values with decode counters, primitive special values, frozen JSON, full key collisions, Unicode normalization, ordinal filtering, forks, old snapshots, legacy descriptors, lazy generators, early return/throw/break, empty roots, shared and copied readers, memory growth and nested-decoder reentry. [Projection tests](../../map-projection.test.ts) also verify the ordered nested-key boundary. The [real Node-worker proof](worker.mjs) pauses projections across writer growth and arena reset, checks full old-snapshot outputs in shared and copy modes, confirms read-only behavior, and proves the unrequested decoder is not called.

- [V1 focused validation](results/initial-validation.txt): portable build, 3 files / 41 tests, real shared/copy worker proof and typecheck passed.
- [V2 focused validation](results/v2-validation.txt): portable build, worker proof, typecheck and saved V1 checks passed. Its 5 files / 82 tests include 42 active checks and 40 unintended replays of archived tests.
- [Combined V1 gate](validation/integration-v1/integration-validation.txt): 19 steps passed, including 58 files / 1,126 tests, all builds/typechecks, real workers, strict documentation checks and installed Node/Bun/TypeScript package consumers.
- [Combined V2 gate](validation/integration-v2/integration-validation.txt): the same 19-step gate passed the exact final runtime source. Its 60 files / 1,167 tests include the same 40 archival replays.
- [Final discovery and documentation follow-up](validation/integration-final-03/integration-followup-validation.txt): 58 active files / 1,127 tests passed in 41.42 seconds, list saved evidence verified, and strict docs passed (75 Markdown files, 72 historical rows, no changed historical evidence). Its runtime hashes exactly match the successful V2 full gate.

The final packaging follow-up also retains a [preflight failure](validation/integration-final/preflight-failed-01.txt) and [exact duplicate cleanup record](validation/integration-final/duplicate-cleanup.json) from the separate integration checkout. A subsequent [interrupted run](validation/integration-final-02/integration-followup-validation.txt) emitted only the Vitest startup banner and no test results; its [interruption record](validation/integration-final-02/interruption.json) is preserved. A retry after clearing that checkout's private Vitest caches passed. The cause of the interruption was not established, and it is not presented as a failing test or a proven cache defect.

The archive discovery issue was packaging only: saved `.test.ts` artifacts were renamed to `.test.ts.txt` without changing a byte, and their manifest paths were updated. The original logs remain intact and are not presented as unique active test counts. The dedicated CI step runs the real worker proof and verifies all three saved studies' hashes and arithmetic without rerunning benchmarks.

Combined integration covers current main 7759933 plus pending search/list changes and all accepted round-three runtime changes. Its exact source manifests and runner scripts are retained beside the logs. **Performance measurements here compare this ordered-map change alone against the fixed baseline; they are not combined-build benchmarks.**

## Source and artifact identity

- Fixed baseline: `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`.
- Local measured V1 identity: `4e2455527ec3b18b5e8b05e7e1860e65964bd250`.
- Local measured V2 identity, both screen and formal: `b96a0fd4212a2a57a080aa3a599e10ea91e9192e`.
- Baseline `shared-ordered-map.ts` SHA-256: `84c510a228983837d35490617c1cde7a31e07b0afb409731032e404a7e068966`.
- V2 `shared-ordered-map.ts` SHA-256: `67d337fcd58b05a0f179e99a48a6a21e14ba6697ad5e5d54062ab71509eefed7`.

The local measured commit names identify the original workspaces and are not necessarily fetchable GitHub objects: publication may create a new commit containing the same final files. Reproduction can use the published PR revision with the matching V2 production and driver hashes.

Every root production/test file, build-support file, root WASM module, complete imported portable JavaScript bundle and driver file was hashed before and checked after each study. Only `shared-ordered-map.ts` differed in production. Later commits add report/evidence verification, CI commands and archive filename cleanup only; the measured runtime and harness remain unchanged.

The [artifact manifest](evidence-manifest.json) records compressed and original byte counts and SHA-256 values. Raw recordings are losslessly gzipped and round-trip verified:

- [V1 screen](results/pilot-v1.json.gz), with [console output](results/pilot-v1.txt).
- [V2 screen](results/pilot-v2.json.gz), with [console output](results/pilot-v2.txt).
- [V2 formal study](results/formal-v2.json.gz), with [console output](results/formal-v2.txt).

The formal JSON is 1,993,895 bytes before compression, SHA-256 `91969ef9b4d2c9ea62b89ca1f2184f2c567843b1f715ce74e86b344ca8e3112b`. It contains all 136 paired observations, 24 summary rows and original warm-up, calibration-plan and timed batches. Neither CI nor the verifier treats batch counts as independent process counts.

## Reproduce

From the repository root, verify the committed evidence without benchmarking:

```sh
node proofs/ordered-map-projections-20261105/verify.mjs \
  proofs/ordered-map-projections-20261105/results/pilot-v1.json.gz \
  proofs/ordered-map-projections-20261105/results/pilot-v2.json.gz \
  proofs/ordered-map-projections-20261105/results/formal-v2.json.gz
```

For a new run, create a worktree at the fixed baseline and a separate checkout of the published PR revision containing this report. Confirm that its `shared-ordered-map.ts` SHA-256 matches the V2 hash above and that the driver files match the saved manifest. Install the pinned dependencies with Bun 1.4.2 and build WASM, portable JavaScript and declarations in each worktree. Use Node 24.22.1 as the controller, provide the full Bun executable path, and keep both worktrees unchanged throughout calibration and measurement. Run the following from that candidate checkout, with fresh output paths:

```sh
flock /tmp/zerocopy-perf.lock taskset -c 2 node \
  proofs/ordered-map-projections-20261105/benchmark.mjs pilot \
  ../zerocopy-before . /absolute/path/to/bun /tmp/ordered-pilot-new.json

flock /tmp/zerocopy-perf.lock taskset -c 2 node \
  proofs/ordered-map-projections-20261105/benchmark.mjs formal \
  ../zerocopy-before . /absolute/path/to/bun \
  /tmp/ordered-formal-new.json /tmp/ordered-pilot-new.json
```

Use one shared lock for all local builds, tests and benchmarks, and choose an allowed CPU consistently if CPU 2 is unavailable. The driver enforces baseline identity, one build per process, complete output checks, common work and source guards. New recordings must keep new paths and their own identities; the saved-evidence verifier intentionally checks the committed recordings against their manifest.
