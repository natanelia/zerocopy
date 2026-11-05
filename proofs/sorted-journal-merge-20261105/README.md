# Sorted journal merge comparison reuse

**Rejected after the fixed formal study. No improvement PR is proposed.** Long-prefix scans improved in all six pairs in both runtimes, but canonical and empty sorted-map scans regressed on Node. The final branch restores runtime, active tests and CI to the baseline; its net change contains only this evidence directory.

## Change and scope

`Arena.radixLeaves()` merges up to four recent sorted-map changes with the canonical radix tree. When a pending key is equal to or greater than the current base key, the original loop compares the same two immutable leaves twice. The candidate retains the comparison for the equality decision and recomputes it after every emitted pending leaf. It changes only `arena.ts` in production. Public APIs, binary format, WASM, journal sorting, value decoding and allocation are unchanged.

A legitimate trailing-key counter test establishes 31 comparisons for a 31-leaf base, where the previous loop performs 62. This is a mechanism check, not a claim that complete scans become twice as fast. The new local comparison initialization still runs after pending entries have been exhausted. The front-journal case measures that risk.

## Decision and complete formal results

The long-prefix target reduced paired geometric latency by **22.0% on Node** and **29.4% on Bun**. However, Node canonical values became **5.7% slower** and empty projections **19.1% slower**, each adverse in five of six independent pairs. Their nominal 95% intervals exclude equality. These broader costs make this particular source change unsuitable as a general optimization. There are no further tuned variants or selectively rerun cases.

The comparison-count test confirms removed work, but does not prove the cause of either timing gain or loss. In particular, the extra local initialization is a plausible cost after journal exhaustion, not an established explanation for all adverse results. The separate A/A measurements do not cancel A/B regressions.

Times are milliseconds per complete operation and are marginal medians of process medians. Ratios are the geometric mean of paired candidate/baseline latencies, with nominal 95% log-t intervals. Lower ratios are faster. “Slower” counts adverse independent pairs.

| Runtime | Case | Baseline ms | Candidate ms | Paired ratio [95% interval] | Slower |
|---|---|---:|---:|---:|---:|
| node | values-tail-4096 | 0.587441 | 0.604151 | 0.9777 [0.7863, 1.2158] | 4/6 |
| node | keys-tail-4096 | 1.010320 | 0.935223 | 0.9340 [0.7706, 1.1320] | 1/6 |
| node | values-long-prefix-4096 | 0.880365 | 0.653076 | 0.7802 [0.7206, 0.8447] | 0/6 |
| node | entries-mixed-4096 | 1.340604 | 1.306311 | 0.9575 [0.6783, 1.3518] | 3/6 |
| node | values-overwrite-4096 | 0.670861 | 0.574385 | 0.8836 [0.7042, 1.1087] | 2/6 |
| node | values-front-4096 | 0.571508 | 0.522630 | 0.9324 [0.7943, 1.0945] | 2/6 |
| node | values-small-32 | 0.005531 | 0.004948 | 0.9861 [0.8356, 1.1638] | 3/6 |
| node | values-canonical-control | 0.400011 | 0.418791 | 1.0573 [1.0069, 1.1103] | 5/6 |
| node | map-get-control | 0.242313 | 0.234035 | 0.9717 [0.8663, 1.0899] | 2/6 |
| node | empty-projections | 0.000840 | 0.001074 | 1.1914 [1.0384, 1.3669] | 5/6 |
| bun | values-tail-4096 | 0.354168 | 0.282747 | 0.8432 [0.7204, 0.9870] | 1/6 |
| bun | keys-tail-4096 | 1.042993 | 0.937701 | 0.9121 [0.7852, 1.0596] | 2/6 |
| bun | values-long-prefix-4096 | 0.538811 | 0.382929 | 0.7061 [0.6596, 0.7558] | 0/6 |
| bun | entries-mixed-4096 | 1.315472 | 1.186367 | 0.8324 [0.6680, 1.0373] | 1/6 |
| bun | values-overwrite-4096 | 0.332203 | 0.312293 | 0.9279 [0.8359, 1.0300] | 1/6 |
| bun | values-front-4096 | 0.290303 | 0.270215 | 0.9565 [0.8385, 1.0911] | 2/6 |
| bun | values-small-32 | 0.002866 | 0.002425 | 0.8299 [0.6786, 1.0150] | 1/6 |
| bun | values-canonical-control | 0.200629 | 0.202295 | 0.9907 [0.9613, 1.0210] | 2/6 |
| bun | map-get-control | 0.166022 | 0.169268 | 1.0152 [0.9149, 1.1265] | 4/6 |
| bun | empty-projections | 0.000574 | 0.000592 | 1.0519 [0.9040, 1.2241] | 3/6 |

### Separate baseline A/A observations

Both sides below use the baseline. The ratio is second-side/first-side latency; these are not candidate effects and are not pooled with A/B.

| Runtime | Case | First side ms | Second side ms | Paired ratio [95% interval] | Higher second side |
|---|---|---:|---:|---:|---:|
| node | values-canonical-control | 0.438693 | 0.373894 | 0.8986 [0.7253, 1.1133] | 1/4 |
| node | map-get-control | 0.237087 | 0.236247 | 0.9631 [0.8555, 1.0841] | 1/4 |
| bun | values-canonical-control | 0.210325 | 0.220103 | 1.0649 [0.9265, 1.2239] | 3/4 |
| bun | map-get-control | 0.157831 | 0.168983 | 1.0911 [0.9181, 1.2968] | 3/4 |

All **272 measured subjects, 136 process pairs and 2,992 batches** completed, with source/driver guards intact. Actual timed warm-up ranged from **500.278 to 673.981 ms**, across **8–18 batches**. There were **58 measured batches below the 20 ms target**, with a minimum of **12.720 ms**; none reached a repeat cap. They remain in the estimates. The subjects verified **33,589,407 complete calls** and **2,355,829,766 counted output elements** outside timing; the empty case counts its two returned empty arrays as two bookkeeping elements. Counts exclude the initial one-shot checks.

Both independent read-only source reviews found no semantic blocker. An independent Python recomputation matched every process median, pair ratio, summary interval, sample count and source identity before packaging. Statistical validity does not make the rejected performance tradeoff acceptable.

## Complete exploratory pilot

Ratios are candidate/baseline latency; lower is faster. The number outside parentheses is the geometric mean of two independent process-pair ratios; parentheses retain both ratios. These two-pair screen estimates do not have confidence intervals.

| Case | Node ratio (both pairs) | Bun ratio (both pairs) |
|---|---:|---:|
| values-tail-4096 | 0.950 (0.866, 1.043) | 1.020 (0.959, 1.085) |
| keys-tail-4096 | 0.806 (0.833, 0.780) | 0.881 (0.929, 0.836) |
| values-long-prefix-4096 | 0.717 (0.750, 0.686) | 0.736 (0.786, 0.690) |
| entries-mixed-4096 | 1.326 (1.111, 1.584) | 0.915 (0.540, 1.549) |
| values-overwrite-4096 | 1.009 (1.104, 0.922) | 0.691 (0.630, 0.758) |
| values-front-4096 | 1.178 (1.038, 1.337) | 0.988 (0.952, 1.024) |
| values-small-32 | 0.816 (0.850, 0.783) | 0.966 (0.969, 0.964) |
| values-canonical-control | 1.034 (0.941, 1.136) | 0.863 (1.053, 0.707) |
| map-get-control | 1.094 (1.178, 1.017) | 1.042 (1.054, 1.031) |
| empty-projections | 1.236 (1.133, 1.348) | 0.746 (0.733, 0.759) |

The Node mixed-entry, front-journal and empty cases are adverse in both pilot pairs. The unrelated get control is also adverse in both runtimes. Bun mixed entries vary widely between pairs. All outcomes are retained. The complete formal study above determined rejection; the pilot is exploratory history and is not pooled into formal confidence intervals.

## Method

The fixed ten workloads and acceptance scope were written in [plan.md](plan.md) before timing. Baseline is `77599337867dbf785a5f0311d34637d0b36678fc`; the measured candidate is local commit `7e7cb376b0559755780c88cd493a7f053b8585f3`. This local identity need not be fetchable from GitHub: publication may recreate the same tree under a new commit.

Node 24.22.1 and Bun 1.4.2 each run one build and one workload per fresh process. Both builds are installed at the same neutral pathname. Execution is serialized with `perf.lock` and pinned to CPU 2. Pair order alternates and case order rotates. Each build constructs the same public-API fixture, with actual journal arity and canonical base checked. The independent native Map oracle sorts encoded keys by UTF-8 bytes without invoking another library projection or lookup.

Each complete returned array escapes through a global blackbox, and every element and entry pair is verified outside timing. Timing includes creation of the outer result-retention array and all complete public materializations. Fixture construction, oracle work, shared-byte hashing and verification are excluded. Every subject verifies unchanged arena allocation, capacity and complete published bytes.

The pilot uses two fresh process pairs per case/runtime, seven measured batches and at least 150 ms actual timed warm-up. The formal study uses six fresh pairs, eleven measured batches, at least 500 ms actual timed warm-up and at least eight warm-up batches. It separately includes four baseline A/A pairs for canonical values and ordinary map gets in each runtime. A/A results are descriptive controls, not corrections subtracted from A/B results.

Common repeat counts are calibrated from both builds before the pilot and reused in confirmation. Repetitions are capped by 65,536 calls, 1,048,576 returned element slots and an estimated 32 MiB retained output per batch. This estimate is not heap, RSS or peak memory; the prior blackboxed batch can remain live while the next is built. Short and capped batches are retained. The 512-batch warm-up cap fails visibly if the elapsed floor cannot be met.

The independent observations are process medians. Formal estimates use paired geometric latency ratios with nominal 95% Student-t intervals on their logarithms: df 5 for six A/B pairs and df 3 for four A/A pairs. Batches are not treated as independent experiments. There is no multiple-comparison correction. Absolute times are marginal medians of process medians; their quotient need not equal the paired geometric ratio.

Before/after guards retain all root production and test files, build inputs, complete portable JavaScript bundles, WASM and the exact driver/workload/worker/plan hashes. Only `arena.ts` differs in production; the WASM and build-support hashes must agree.

## Correctness validation

[Focused validation](results/focused-validation-01.txt) passed the portable browser build, four active Vitest files / 62 tests, a real Node worker proof in shared and copy modes, and TypeScript checking. Tests cover zero through four pending leaves, all relative-key positions, overwritten values, journal exhaustion, UTF-8 and normalization, old roots/forks, frozen JSON and nested values, sorted sets, lazy/closed generators, interleaved suspended scans, read-only readers, growth and nested reconstruction reentry. Private Arenas avoid fixture-history coupling.

The real worker pauses keys, values and entries after a pending yield, then resumes all complete old outputs after writer growth, a fork and default-writer reset. It checks read-only enforcement and unchanged published bytes. The comparison-count test uses valid snapshots and restores its counter wrapper after the assertion.

## Saved evidence and verification

- [Formal raw data, lossless gzip](results/formal-01.json.gz) and [complete formal console output](results/formal-01.txt).
- [Pilot raw data, lossless gzip](results/pilot-01.json.gz) and [complete pilot console output](results/pilot-01.txt).
- [Measured source archive](archive-manifest.json): exact candidate Arena, active test and CI bytes. Test copies end in `.txt` and are not discovered by Vitest.
- [Evidence manifest](evidence-manifest.json): stored and decompressed lengths/SHA-256 plus immutable proof-file hashes.
- [Saved-evidence verifier](verify.mjs): validates archive/raw hashes, source identities, plans, process ordering, warm-up, verification counts, medians, paired estimates and intervals. It does not benchmark or pin current repository runtime files.

The formal uncompressed artifact is **2,049,656 bytes**, SHA-256 `8d628dd9bf5d10f64f042917657b5bf2acd1b06ac6c1ac60e6c452a2e1dd5ff2`. The pilot is **727,409 bytes**, SHA-256 `44093e864ce4d9b5bf9be27ad86bdf88239968ea319ca81a28c712f63bed104b`. Both compressed files were round-trip checked byte for byte. A [packaging preflight](results/packaging-cleanup.json) found exact physical duplicates after the initial archive/removal operations; only byte-verified copies were removed, and no active archived test path remains. The reason for their persistence was not established.

From the published evidence checkout, validate saved data without rerunning timings:

```sh
node proofs/sorted-journal-merge-20261105/verify.mjs   proofs/sorted-journal-merge-20261105/results/pilot-01.json.gz   proofs/sorted-journal-merge-20261105/results/formal-01.json.gz
```

This rejected evidence-only branch adds no CI step. The archived candidate did run the focused checks and real workers before measurements; that historical CI addition was restored with the runtime change.

The [packaging validation log](results/packaging-validation.txt) records successful saved-data checks and the documentation gate: all 72 historical benchmark rows were preserved, with zero historical evidence changes.

## Reproduction

Use the fixed baseline commit and the exact archived candidate bytes. The local measured commit `7e7cb376b0559755780c88cd493a7f053b8585f3` is a provenance identity, not a required fetchable GitHub revision. The archive is sufficient to reconstruct its changed runtime and tests from the published evidence branch.

From a published evidence checkout, create separate worktrees, copy the proof folder to the candidate, and restore its archived source/test/CI files. Install the baseline’s declared dependencies with its documented `bun install` command and build both with Bun 1.4.2. The baseline commits no lockfile; a fresh install may resolve different transitive versions. Recorded WASM/bundle hashes identify the measured artifacts, and a fresh confirmation requires the same inputs as its fresh pilot. In the shared execution environment, wrap all builds, tests and timings in the shared `perf.lock`; do not run competing benchmarks.

```sh
SORTED_ARCHIVE="$PWD/proofs/sorted-journal-merge-20261105"
git worktree add --detach ../sorted-journal-before 77599337867dbf785a5f0311d34637d0b36678fc
git worktree add --detach ../sorted-journal-after 77599337867dbf785a5f0311d34637d0b36678fc
cp -R "$SORTED_ARCHIVE" ../sorted-journal-after/proofs/
cp "$SORTED_ARCHIVE/source/arena.ts.txt" ../sorted-journal-after/arena.ts
cp "$SORTED_ARCHIVE/source/sorted-journal-merge.test.ts.txt" ../sorted-journal-after/sorted-journal-merge.test.ts
cp "$SORTED_ARCHIVE/source/ci.yml.txt" ../sorted-journal-after/.github/workflows/ci.yml
(cd ../sorted-journal-before && bun install && bun run build:wasm && bun run build:browser)
(cd ../sorted-journal-after && bun install && bun run build:wasm && bun run build:browser)
```

Then run the fixed driver with **new output paths**. It refuses to overwrite either raw or compressed prior results. Use Node 24.22.1 and the Bun executable path. On Linux, pin controller and children to CPU 2 as in the saved run:

```sh
taskset -c 2 node proofs/sorted-journal-merge-20261105/benchmark.mjs pilot   ../sorted-journal-before ../sorted-journal-after /absolute/path/to/bun /tmp/sorted-new-pilot.json
taskset -c 2 node proofs/sorted-journal-merge-20261105/benchmark.mjs formal   ../sorted-journal-before ../sorted-journal-after /absolute/path/to/bun /tmp/sorted-new-formal.json /tmp/sorted-new-pilot.json
```

The fresh formal run reuses that fresh pilot’s common repeat plans and requires unchanged source/build/driver identities. Its candidate commit may differ from the local measured identity; this is recorded rather than silently rewritten. Results are specific to the captured Linux x64 machine, engines and workloads. No claim is made for cold readers, other key distributions, devices or browsers.
