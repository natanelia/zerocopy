# Checkpoint validation without a discarded state tree

## Change and scope

`decodeZerocopyState()` first validates a checkpoint tree before attaching collection memory, then reconstructs the final frozen state. Previously, the first traversal also built and froze a complete temporary state tree whose result was discarded.

The final V3 candidate uses a separate validation walk. It checks the same shapes, references, cycles, budgets, sparse holes and duplicate keys without materializing the temporary arrays or retaining child values. Only recursive array/object containers enter the active WeakSet. The ancestor check remains before input getters, so a cyclic node cannot evade detection by changing its apparent tag. The reconstruction function remains byte-for-byte equal to the baseline.

Public signatures, checkpoint format, shared-memory layout, dependencies and the existing reconstruction path are unchanged. The tradeoff is a second implementation of tag validation; the regression corpus checks accepted tags, malformed shapes and exact getter/error behavior on both baseline and candidate.

## Measured outcome and limits

The final comparison measured **22.3–34.8% less time across all five Node target cases**; each corresponding unadjusted 95% interval is below parity. Bun showed **37.6% less time for the numeric array and 30.6% for deserialization**. Bun's wide-record, nested-record and mixed-state cases remain **inconclusive**: their intervals cross parity. No improvement is claimed for those three Bun targets.

**The identical-build control exposes a limitation:** Node's A/A array comparison reported an apparent **8.6% slowdown despite identical baseline builds**, with all four pairs slower and an interval of **1.0277–1.1485**. The final Node snapshot-only control also estimated **10.2% slower**, with four of six slower pairs and a wide **0.9334–1.3016** interval. These results prevent an all-controls-pass or no-regression claim and caution against treating the observed percentages as exact transferable effects. No A/A correction is subtracted from A/B results. All observations are retained below.

## Final V3 comparison

| Runtime | Case | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| Node | decode · 8,192 numbers | 1,710.659 | 1,285.934 | 0.7496 (0.6926–0.8112) | 6/6 |
| Node | decode · 4,096-field record | 4,343.622 | 2,801.724 | 0.6522 (0.5858–0.7260) | 6/6 |
| Node | decode · 512 nested rows | 2,581.644 | 1,893.743 | 0.7590 (0.5907–0.9751) | 5/6 |
| Node | decode · 256 UI rows + shared map | 2,234.312 | 1,811.602 | 0.7618 (0.6364–0.9119) | 6/6 |
| Node | deserialize · 512 nested rows | 3,813.622 | 2,943.697 | 0.7771 (0.7475–0.8078) | 6/6 |
| Node | small/empty trees (boundary) | 4.655 | 3.952 | 0.8795 (0.7872–0.9825) | 5/6 |
| Node | snapshot-only control | 1,000.109 | 1,032.892 | 1.1022 (0.9334–1.3016) | 2/6 |
| Node | primitive control | 0.591 | 0.542 | 0.8692 (0.7611–0.9926) | 6/6 |
| Bun | decode · 8,192 numbers | 7,106.280 | 4,350.173 | 0.6239 (0.5881–0.6619) | 6/6 |
| Bun | decode · 4,096-field record | 3,196.876 | 2,629.168 | 0.8118 (0.6422–1.0262) | 5/6 |
| Bun | decode · 512 nested rows | 4,525.546 | 3,925.288 | 0.8020 (0.6390–1.0065) | 5/6 |
| Bun | decode · 256 UI rows + shared map | 5,624.286 | 4,875.965 | 0.8407 (0.6543–1.0803) | 4/6 |
| Bun | deserialize · 512 nested rows | 3,058.085 | 2,046.421 | 0.6938 (0.5722–0.8412) | 6/6 |
| Bun | small/empty trees (boundary) | 9.894 | 6.542 | 0.7048 (0.5601–0.8870) | 6/6 |
| Bun | snapshot-only control | 2,999.949 | 3,078.758 | 0.9638 (0.8249–1.1260) | 3/6 |
| Bun | primitive control | 0.305 | 0.280 | 0.9057 (0.8020–1.0228) | 5/6 |

Before/after values are the marginal medians of six process medians. Paired ratios are the geometric mean of six after/before process-median ratios, with unadjusted 95% Student-t intervals on their logarithms. These summaries answer different questions and need not equal the ratio of the displayed marginal medians. Every process median summarizes nine measured batches.

The five declared targets are numeric-array decode, wide-record decode, nested-record decode, mixed state with a shared map, and nested-state deserialization. Small/empty trees are a boundary case. Primitive and snapshot-only cases keep their declared control role; V3 also changes their scalar/snapshot validation, so they must not be called unchanged code paths. Any gains in those controls remain outside the target headline.

## Identical-build A/A controls

| Runtime | Case | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| Node | decode · 8,192 numbers | 1,676.690 | 1,821.120 | 1.0864 (1.0277–1.1485) | 0/4 |
| Node | snapshot-only control | 1,117.049 | 1,045.468 | 0.9392 (0.7621–1.1574) | 3/4 |
| Bun | decode · 8,192 numbers | 6,455.495 | 6,549.988 | 1.0010 (0.9477–1.0573) | 1/4 |
| Bun | snapshot-only control | 2,522.392 | 2,752.652 | 1.0190 (0.7684–1.3513) | 1/4 |

A/A compares the identical baseline build against itself. Its scope is the predeclared numeric-array and snapshot-only subset in each runtime. It is not a control for every target, and its estimates are not subtracted from A/B results. Intervals spanning parity establish neither a regression nor equivalence.

## Retained pilots and decisions

### V1: interrupted after 63 of 64 subjects

V1 placed validation and reconstruction in one recursive function and selected allocation behavior with per-element branches. Its pilot stopped without a completion record after 63 of 64 planned subjects; the cause is not recorded in the raw file. All completed subjects and the incomplete schedule remain retained. It is not a completed confirmation.

Node's small-tree case was slower in both complete pairs (estimate 1.3940). Bun's snapshot-only control was also slower in both (1.2173), and its record case estimated 1.0451 with one of two pairs slower. Node's array estimate below uses only one complete pair; the second candidate subject has no baseline counterpart. The missing subject and end-of-study source/build checks cannot be reconstructed. No pilot confidence intervals are calculated.

| Runtime | Case | Complete pairs | Paired after/before | Faster pairs |
| --- | --- | ---: | ---: | ---: |
| Node | decode · 8,192 numbers | 1/2 | 1.1307 | 0/1 |
| Node | decode · 4,096-field record | 2/2 | 0.6747 | 2/2 |
| Node | decode · 512 nested rows | 2/2 | 0.9060 | 1/2 |
| Node | decode · 256 UI rows + shared map | 2/2 | 0.9475 | 1/2 |
| Node | deserialize · 512 nested rows | 2/2 | 0.9551 | 2/2 |
| Node | small/empty trees (boundary) | 2/2 | 1.3940 | 0/2 |
| Node | snapshot-only control | 2/2 | 0.9897 | 1/2 |
| Node | primitive control | 2/2 | 0.9249 | 2/2 |
| Bun | decode · 8,192 numbers | 2/2 | 0.7560 | 2/2 |
| Bun | decode · 4,096-field record | 2/2 | 1.0451 | 1/2 |
| Bun | decode · 512 nested rows | 2/2 | 0.9058 | 1/2 |
| Bun | decode · 256 UI rows + shared map | 2/2 | 0.8040 | 2/2 |
| Bun | deserialize · 512 nested rows | 2/2 | 0.8717 | 1/2 |
| Bun | small/empty trees (boundary) | 2/2 | 1.0218 | 1/2 |
| Bun | snapshot-only control | 2/2 | 1.2173 | 0/2 |
| Bun | primitive control | 2/2 | 0.9888 | 1/2 |

The [partial-study audit](interrupted-pilot-audit.md) checks the recorded prefix, saved source/workload identities, completed measurements and recomputed paired estimates. It does not fill the missing subject or treat this run as complete. Archived V1 [production source](archive/redux-checkpoint-v1.ts.txt), [workload](archive/workloads-v1.mjs), [tests](archive/checkpoint-validation-pass-v1.test.ts.txt) and [validation record](archive/validation-v1.md) retain their original hashes.

### V2: complete two-pair pilot

V2 split the validator from the unchanged reconstruction function. Before that pilot, the small-tree batch increased from 256 to 1,024 repetitions because the earlier batches were short. The matrix and every other repetition count remained the same. The [V2 rationale](design-v2.md) describes the source-informed hypothesis without claiming a proven JIT mechanism.

| Runtime | Case | Before µs | After µs | Paired after/before | Individual pair ratios |
| --- | --- | ---: | ---: | ---: | --- |
| Node | decode · 8,192 numbers | 1,855.716 | 1,986.135 | 1.0692 | 1.0854, 1.0531 |
| Node | decode · 4,096-field record | 4,497.664 | 3,279.992 | 0.7292 | 0.7294, 0.7290 |
| Node | decode · 512 nested rows | 2,821.798 | 2,346.565 | 0.8313 | 0.8445, 0.8183 |
| Node | decode · 256 UI rows + shared map | 2,561.062 | 2,440.939 | 0.9550 | 0.9252, 0.9857 |
| Node | deserialize · 512 nested rows | 4,411.190 | 3,474.675 | 0.7848 | 0.8336, 0.7388 |
| Node | small/empty trees (boundary) | 5.693 | 4.846 | 0.8527 | 0.9132, 0.7962 |
| Node | snapshot-only control | 989.843 | 980.083 | 0.9977 | 0.9289, 1.0716 |
| Node | primitive control | 0.643 | 0.657 | 1.0160 | 1.0966, 0.9414 |
| Bun | decode · 8,192 numbers | 6,741.924 | 5,179.269 | 0.7571 | 0.8772, 0.6535 |
| Bun | decode · 4,096-field record | 3,314.637 | 2,874.604 | 0.8736 | 0.8110, 0.9410 |
| Bun | decode · 512 nested rows | 5,403.597 | 3,786.540 | 0.7055 | 0.6346, 0.7843 |
| Bun | decode · 256 UI rows + shared map | 6,508.713 | 5,276.705 | 0.8231 | 0.7461, 0.9080 |
| Bun | deserialize · 512 nested rows | 2,933.608 | 2,392.601 | 0.8147 | 0.8453, 0.7852 |
| Bun | small/empty trees (boundary) | 8.574 | 6.318 | 0.7353 | 0.7090, 0.7625 |
| Bun | snapshot-only control | 3,283.772 | 2,959.014 | 0.9041 | 0.9596, 0.8518 |
| Bun | primitive control | 0.325 | 0.408 | 1.2265 | 1.0739, 1.4008 |

Node's array case was slower in both pairs (1.085 and 1.053; estimate 1.069). Bun's primitive control was also slower in both pairs (1.074 and 1.401; estimate 1.226). V3 removes redundant WeakSet writes for scalar/snapshot leaves while retaining the initial ancestor check. The [V3 rationale](design-v3.md) and [V2 source archive](archive/redux-checkpoint-v2.ts.txt) record that decision. V3 has no additional pilot: one fixed full confirmation and one separately analyzed A/A subset follow the source freeze. No pilot observations are pooled into final estimates.

## Method

- Frozen baseline: `b07bffe073a7f7d60f1dd7731358c16d1075eb45`.
- Final production SHA-256: `efe50d67389eac9463f43fc7c4fe1554511e65a4044940688d939d7ecabcd632`.
- Final workload SHA-256: `e17c138da14bdf35de0406da46980bb08ff0aa1873029c4998b2ea45f29724b4`.
- Final study: 192 fresh A/B subjects and 32 fresh A/A subjects, one build and case per process, alternating AB/BA order, reversed runtime/case order by pair, and the same neutral import path.
- Each subject uses at least 500 ms of actual timed warmup and at least eight warmup batches, then nine measured batches. Repetition counts are common to baseline/candidate and Node/Bun. All measurements, including batches below 2 ms, remain in the recording.
- The complete public operation and assignment into a preallocated retention array are timed. Deserialization includes JSON parsing. Imports, fixture creation, the retention array allocation and full-output verification are outside the timer.
- Native JavaScript oracles check complete values, ordering, special numbers, holes, prototypes, frozen outputs and snapshot aliases. Source packets and published source bytes remain unchanged. Verification happens between batches and can influence later garbage collection; it is not allocation-free measurement.
- The driver holds the common timing lock and pins the study to CPU 2 on Linux x64, AMD EPYC 9V74, with Node 24.22.1 and Bun 1.4.2. No builds, test suites, browsers or other benchmark jobs were intentionally run concurrently.
- Source, WASM and portable-build hashes, exact changed source, runtime identities, warmups, raw batches and verification counts are retained. The WASM builds are identical. A separate Python verifier recomputes medians, paired ratios and intervals.

The measured candidate worktree still had the baseline Git HEAD with uncommitted V3 edits. Its exact source text embedded in each final recording, the source SHA-256 above, and the portable-build hashes identify the measured implementation independently of the later publication commit.

The independent verifier reproduced all 224 final/A/A subjects, 2,016 measured batches and 20 paired estimates. The separate V2 pilot contains 64 subjects and 576 measured batches. The V1 partial audit preserves 63 subjects and 567 measured batches.

These observations concern the declared repeated operations on the measured Linux x64 machine. They do not establish universal speedups, absence of regressions, browser timing, ARM timing or peak-memory savings. Per-row intervals are unadjusted and do not provide simultaneous confidence over the full matrix.

## Correctness and reproduction

Before final timing, Node and Bun each passed **157 tests across three checkpoint suites**. All 11 new tests also passed against unchanged main. Portable build/type checks and all eight full-output workload checks passed. Chromium 153.0.8010.0 verified the complete state tree and actual shared/copy worker attachments; writable imports and retained aliases were checked. See [validation commands and identities](validation.md) and [browser output](browser-result.json).

With this checkpoint change and the numeric/boolean sequence optimization applied together, the full Bun suite passed **57 files / 1,147 tests**. Portable/declaration builds, main/Redux/typed-value/geometry/worker type checks, Node worker and Redux proofs, late-import checks, actual Chromium shared/copy workers, and installed-package Node/Bun/TypeScript consumers also passed. The [combined validation manifest](combined-validation.json) records the exact source/WASM hashes and all 16 successful command results; the [captured log](combined-validation.txt) contains the test totals and outputs. This run checks compatibility of both optimizations. The performance figures above remain standalone comparisons; combined timings were not measured.

Build each checkout using the repository's existing commands, then run the [driver](paired-benchmark.mjs) from a shell pinned to an available CPU. It manages its own lock; do not add a second flock for the same lock file.

```sh
taskset -c 2 node proofs/checkpoint-validation-20261105/paired-benchmark.mjs \
  proofs/checkpoint-validation-20261105/workloads.mjs \
  /path/to/baseline /path/to/candidate /path/to/bun /tmp/final-v3.json formal
taskset -c 2 node proofs/checkpoint-validation-20261105/paired-benchmark.mjs \
  proofs/checkpoint-validation-20261105/workloads.mjs \
  /path/to/baseline /path/to/candidate /path/to/bun /tmp/aa-v3.json aa
```

Deterministic checks and evidence verification do not rerun timing:

```sh
node proofs/checkpoint-validation-20261105/smoke.mjs
bun proofs/checkpoint-validation-20261105/smoke.mjs
node proofs/checkpoint-validation-20261105/browser-check.mjs . checkpoint
python3 proofs/checkpoint-validation-20261105/verify.py \
  proofs/checkpoint-validation-20261105/results/pilot-v2.json.gz \
  proofs/checkpoint-validation-20261105/results/final-v3.json.gz \
  proofs/checkpoint-validation-20261105/results/aa-v3.json.gz
python3 proofs/checkpoint-validation-20261105/audit-interrupted-pilot.py
```

The dedicated workflow rebuilds the package, runs Node/Bun regressions and full-output checks, exercises Chromium workers, and verifies saved evidence. It does not rerun timing measurements.
