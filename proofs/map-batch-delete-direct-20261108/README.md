# Rejected experiment: batched immutable Map deletion

**Decision: reject V3 and retain this branch as an experiment record. No performance PR is proposed for this implementation.** Grouping `SharedMap.deleteMany(keys)` requests inside WASM reduced arena allocation and improved some large deletions, but it introduced repeatable slowdowns in valid workloads. The hosted study also timed out before the formal matrix, A/A controls, and library comparison finished. The incomplete study is not a confirmed performance improvement.

The baseline is [`a4265a0608ec25eec5719496225212db6b251989`](https://github.com/natanelia/zerocopy/commit/a4265a0608ec25eec5719496225212db6b251989). The measured V3 candidate is [`1d6cadc134fdad3e9c80a448715af239491a91c5`](https://github.com/natanelia/zerocopy/commit/1d6cadc134fdad3e9c80a448715af239491a91c5). Both builds receive identical ordered requests, retain the original Map, and return the same immutable final Map.

## Why this candidate was rejected

In the available formal pairs, Bun's 512-key boundary had a **43.9% slower paired estimate**, with all four pairs slower. A dense 32-hit prefix followed by missing requests had a **35.7% slower estimate in Node** (all five pairs slower) and a **38.4% slower estimate in Bun** (all four slower). Bun's Unicode and sparse-hit requests had **10.2% and 8.2% slower estimates**, respectively, with all four pairs slower for each. Node's duplicate request had a **9.2% slower estimate**, with all five pairs slower. These are descriptive changes from the incomplete record, without final confidence intervals.

The complete two-pair V3 pilot independently showed the same problematic Bun boundary and dense-prefix/missing shapes. Large deletion and clear-all rows have favorable partial estimates, but those gains do not justify the current automatic dispatch for other inputs. Allocation reductions do not resolve latency regressions. The candidate will not be rerun or have its missing stages completed for acceptance.

## Evidence status and provenance

[Hosted run 42495937874](https://github.com/natanelia/zerocopy/actions/runs/42495937874) ran on Linux x64, Intel Xeon 6973P-C, with Node 24.22.1 and Bun 1.4.2. Timed processes were serial and pinned to allowed CPU 0. The job's published workflow had a 60-minute limit. The run began at `2026-11-08T15:39:48Z`; the job logged cancellation at `16:40:03.648Z`. All preceding correctness steps and the final artifact upload succeeded. The saved-evidence workflow step was skipped after cancellation; the independent archive audit below was performed after download.

| Stage | Saved processes | Planned processes | Status |
| --- | ---: | ---: | --- |
| V3 pilot | 64 | 64 | Complete, two pairs for eight cases in two runtimes |
| Formal before/after | 331 | 432 | Interrupted during round 5 of 6 |
| A/A same-build controls | 0 | 32 | Not started |
| Immutable/native comparison | 0 | 54 | Not started |

The pilot ran from `15:40:49.342Z` to `15:44:27.791Z`. Formal measurement began at `15:44:27.999Z`. Rounds 1–4 completed; round 5 completed all 36 Node processes and seven Bun processes. The last saved process was Bun baseline `delete-cold-1000-of-8192`, from `16:39:19.474Z` to `16:39:40.692Z`; its candidate counterpart was interrupted. The raw formal record correctly retains `status: "running"` and has no completion timestamp. It has not been relabeled complete, padded, resumed, or combined with another run.

Artifact `13625657254` was downloaded and its ZIP SHA-256 verified as `c37be353f9a48f2044bf4b925df2e93a26c7839fa0c3cb08eff6c30584f9630d`. Extraction rejected unsafe paths. Every retained gzip archive round-trips to the exact downloaded bytes, uses deterministic `mtime=0`, and preserves every sample and field. The original V2 pilot remains unchanged.

- [Attempt provenance and file digests](validation/attempt1/provenance.json)
- [ZIP member manifest](validation/attempt1/download-provenance.json)
- [Run, job, and artifact metadata](validation/attempt1/github-metadata.json)
- [Complete hosted job log](validation/attempt1/github-job.log.gz)
- [Complete V3 pilot](validation/attempt1/results/pilot-v3.json.gz)
- [Unmodified partial formal record](validation/attempt1/results/formal.json.gz)
- [Independent partial audit](validation/attempt1/independent-review.partial.json) and [reproducible Python audit](validation/attempt1/audit-partial.py)

The independent Python audit reconstructed UTF-8 FNV-1a hashes, low-nibble HAMT ordering, exact numeric special values, all input requests, and expected output digests. It checked source snapshots, exact source/WASM/bundle hashes, driver/workload hashes, the schedule prefix, warmup and output counts, every process median, every complete-pair ratio, and retained short batches. All available-record checks passed. This establishes integrity of the available evidence, not completion or acceptance of the experiment. A/A noise calibration and the supplementary library comparison are absent.

## Partial formal results: all 36 rows

Times are microseconds for one complete public call. Each time is the median of available complete-pair process estimates. The ratio is the geometric mean of paired after/before ratios, so it need not equal the ratio of the displayed time medians. Lower ratios are faster. There are **no confidence intervals**: the planned six-pair study was interrupted. The single unpaired Bun cold-source baseline remains in the raw record and process counts but does not enter the paired table.

| Runtime | Workload | Complete pairs | Before (µs) | After (µs) | After / before | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| node | `delete-100-of-4096` | 5 | 14.759 | 14.824 | 1.0213 | 1 / 5 |
| node | `delete-1000-of-8192` | 5 | 189.030 | 163.761 | 0.8588 | 5 / 5 |
| node | `delete-4096-of-8192` | 5 | 720.349 | 609.529 | 0.8467 | 5 / 5 |
| node | `delete-cold-1000-of-8192` | 5 | 409.652 | 252.859 | 0.6889 | 4 / 5 |
| node | `delete-unicode-1000-of-8192` | 5 | 433.702 | 382.978 | 0.8888 | 5 / 5 |
| node | `delete-32-control` | 5 | 4.956 | 5.134 | 1.0241 | 1 / 5 |
| node | `delete-511-boundary` | 5 | 81.952 | 87.082 | 1.0395 | 2 / 5 |
| node | `delete-512-boundary` | 5 | 85.680 | 78.360 | 0.9090 | 5 / 5 |
| node | `delete-1-control` | 5 | 0.154399 | 0.152356 | 0.9963 | 2 / 5 |
| node | `delete-empty-control` | 5 | 0.006489 | 0.006607 | 1.0921 | 1 / 5 |
| node | `delete-missing-1000` | 5 | 54.640 | 55.447 | 0.9977 | 1 / 5 |
| node | `delete-late-hits-1000` | 5 | 167.688 | 168.074 | 0.9972 | 2 / 5 |
| node | `delete-sparse-hits-1000` | 5 | 78.842 | 78.750 | 1.0110 | 3 / 5 |
| node | `delete-dense-prefix-missing-1000` | 5 | 72.403 | 99.754 | 1.3573 | 0 / 5 |
| node | `delete-duplicate-1000` | 5 | 45.789 | 47.683 | 1.0918 | 0 / 5 |
| node | `delete-all-4096` | 5 | 588.433 | 528.860 | 0.8955 | 4 / 5 |
| node | `get-many-control` | 5 | 1.157 | 1.171 | 1.0248 | 2 / 5 |
| node | `set-one-control` | 5 | 0.333442 | 0.351739 | 1.0344 | 2 / 5 |
| bun | `delete-100-of-4096` | 5 | 9.794 | 9.884 | 1.0095 | 1 / 5 |
| bun | `delete-1000-of-8192` | 5 | 125.741 | 126.313 | 0.9508 | 3 / 5 |
| bun | `delete-4096-of-8192` | 5 | 538.035 | 495.231 | 0.8965 | 5 / 5 |
| bun | `delete-cold-1000-of-8192` | 4 | 212.875 | 171.912 | 0.8323 | 4 / 4 |
| bun | `delete-unicode-1000-of-8192` | 4 | 176.922 | 197.178 | 1.1015 | 0 / 4 |
| bun | `delete-32-control` | 4 | 2.899 | 2.940 | 1.0164 | 1 / 4 |
| bun | `delete-511-boundary` | 4 | 61.363 | 62.404 | 1.0096 | 1 / 4 |
| bun | `delete-512-boundary` | 4 | 62.087 | 89.194 | 1.4387 | 0 / 4 |
| bun | `delete-1-control` | 4 | 0.106247 | 0.101316 | 0.9608 | 3 / 4 |
| bun | `delete-empty-control` | 4 | 0.000971 | 0.001095 | 1.7099 | 0 / 4 |
| bun | `delete-missing-1000` | 4 | 46.010 | 42.912 | 0.9531 | 2 / 4 |
| bun | `delete-late-hits-1000` | 4 | 124.038 | 123.439 | 0.9830 | 2 / 4 |
| bun | `delete-sparse-hits-1000` | 4 | 58.351 | 62.686 | 1.0816 | 0 / 4 |
| bun | `delete-dense-prefix-missing-1000` | 4 | 52.408 | 72.523 | 1.3842 | 0 / 4 |
| bun | `delete-duplicate-1000` | 4 | 36.306 | 37.836 | 1.0351 | 1 / 4 |
| bun | `delete-all-4096` | 4 | 444.397 | 388.736 | 0.8759 | 4 / 4 |
| bun | `get-many-control` | 4 | 0.692519 | 0.895693 | 1.1468 | 0 / 4 |
| bun | `set-one-control` | 4 | 0.174423 | 0.174057 | 0.9874 | 3 / 4 |

There are 2,979 saved measured batches, 58,597 warmup batches, and 3,304,908,080 recorded output validations. Empty and all-missing outputs are checked by exact source identity; the full source is checked once per batch. Other outputs receive full result checks. Of the measured batches, 423 are shorter than 2 ms, and the minimum is 0.250533 ms. All short observations remain in the record. The sub-microsecond empty-control ratios and other short controls should be read with particular caution; no A/A record is available to calibrate those changes.

| Runtime | Workload | Before batches <2 ms | After batches <2 ms | Minimum batch (ms) |
| --- | --- | ---: | ---: | ---: |
| node | `delete-32-control` | 4 | 0 | 1.911471 |
| node | `delete-empty-control` | 45 | 44 | 1.156319 |
| node | `set-one-control` | 43 | 44 | 1.304908 |
| bun | `delete-1000-of-8192` | 8 | 20 | 1.824289 |
| bun | `delete-32-control` | 36 | 35 | 1.462477 |
| bun | `delete-empty-control` | 36 | 36 | 0.250533 |
| bun | `set-one-control` | 36 | 36 | 0.656684 |

Unchanged `getMany` and `set` controls are retained without attributing their changes to grouped deletion. The Node cold-source pilot estimate was unfavorable while its later partial formal estimate was favorable; the two observations remain separate and do not support a completed cold-source claim.

## Complete V3 pilot: all 16 rows

The pilot uses two fresh process pairs, at least 150 ms of timed warmup, and nine measured batches per process. It contains 64 processes, 576 measured batches, and 111,184 recorded output validations. No measured batch is below 2 ms; the minimum is 2.514337 ms. Pilot ratios are descriptive and have no confidence intervals.

| Runtime | Workload | Complete pairs | Before (µs) | After (µs) | After / before | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| node | `delete-4096-of-8192` | 2 | 705.373 | 639.526 | 0.9066 | 2 / 2 |
| node | `delete-cold-1000-of-8192` | 2 | 236.797 | 272.608 | 1.1405 | 1 / 2 |
| node | `delete-511-boundary` | 2 | 76.978 | 77.562 | 1.0075 | 1 / 2 |
| node | `delete-512-boundary` | 2 | 78.577 | 76.151 | 0.9693 | 2 / 2 |
| node | `delete-missing-1000` | 2 | 54.673 | 55.380 | 1.0129 | 0 / 2 |
| node | `delete-late-hits-1000` | 2 | 155.281 | 156.550 | 1.0081 | 1 / 2 |
| node | `delete-sparse-hits-1000` | 2 | 75.974 | 77.259 | 1.0169 | 0 / 2 |
| node | `delete-dense-prefix-missing-1000` | 2 | 68.758 | 108.731 | 1.5761 | 0 / 2 |
| bun | `delete-4096-of-8192` | 2 | 591.633 | 544.670 | 0.9214 | 2 / 2 |
| bun | `delete-cold-1000-of-8192` | 2 | 212.831 | 167.374 | 0.7858 | 2 / 2 |
| bun | `delete-511-boundary` | 2 | 64.166 | 63.288 | 0.9862 | 1 / 2 |
| bun | `delete-512-boundary` | 2 | 61.828 | 89.161 | 1.4421 | 0 / 2 |
| bun | `delete-missing-1000` | 2 | 43.736 | 41.499 | 0.9497 | 2 / 2 |
| bun | `delete-late-hits-1000` | 2 | 123.258 | 124.359 | 1.0089 | 0 / 2 |
| bun | `delete-sparse-hits-1000` | 2 | 60.215 | 62.634 | 1.0396 | 0 / 2 |
| bun | `delete-dense-prefix-missing-1000` | 2 | 52.825 | 78.935 | 1.4921 | 0 / 2 |

## Earlier V2 pilot retained unchanged

The direct-key V2 implementation preceded the scalar-prefix dispatch gate. Its [original pilot record](results/pilot.json.gz), [measured workload](workloads-pilot-v2.mjs), [source snapshots](archive/v2/), and [candidate patch](archive/v2/candidate.patch) are preserved. It contains 48 processes and six cases in two runtimes, measured in the earlier local environment. These numbers must not be combined with the hosted V3 measurements. It showed slower small requests and missing-key requests despite useful large-batch results, motivating the now-rejected V3 gate.

| Runtime | Workload | Complete pairs | Before (µs) | After (µs) | After / before | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| node | `delete-100-of-4096` | 2 | 14.990 | 17.423 | 1.1503 | 0 / 2 |
| node | `delete-4096-of-8192` | 2 | 881.413 | 660.466 | 0.7372 | 2 / 2 |
| node | `delete-cold-1000-of-8192` | 2 | 446.597 | 312.705 | 0.7061 | 2 / 2 |
| node | `delete-32-boundary` | 2 | 5.120 | 6.099 | 1.1574 | 1 / 2 |
| node | `delete-1-control` | 2 | 0.199436 | 0.255303 | 1.2530 | 0 / 2 |
| node | `delete-missing-1000` | 2 | 83.630 | 107.434 | 1.2835 | 0 / 2 |
| bun | `delete-100-of-4096` | 2 | 11.751 | 12.932 | 1.0995 | 0 / 2 |
| bun | `delete-4096-of-8192` | 2 | 803.403 | 536.268 | 0.6696 | 2 / 2 |
| bun | `delete-cold-1000-of-8192` | 2 | 450.665 | 237.608 | 0.5273 | 2 / 2 |
| bun | `delete-32-boundary` | 2 | 4.049 | 4.274 | 1.0548 | 0 / 2 |
| bun | `delete-1-control` | 2 | 0.144317 | 0.152941 | 1.0605 | 0 / 2 |
| bun | `delete-missing-1000` | 2 | 52.816 | 73.101 | 1.3836 | 0 / 2 |

## Implementation and scope

Repeated scalar deletions copy a path through the hash trie for each matching key. The candidate groups requests by hash prefix inside WASM, walks affected subtrees together, and reduces repeated branch copying. Groups of four or fewer requests use the existing scalar WASM deletion to avoid partitioning overhead. Full key bytes are checked at leaves and collision buckets. Duplicate and missing requests do not count as removals.

The JavaScript wrapper stores compact key records in the existing 49,152-byte writer scratch range. Request staging does not allocate persistent arena storage. A request record uses 12 bytes plus its UTF-8 length rounded up to four bytes, including its pointer. Longer keys use the scalar path. Large arrays may require several chunks, and prefixes can be rebuilt once per chunk.

The current dispatch considers arrays with at least 512 requests. It first performs 32 ordinary scalar deletes. If at least 16 change the root, the remaining requests use grouped deletion; otherwise the same iterator continues through the scalar path. These first deletes are useful work, with no extra preliminary lookup. Small arrays, custom iterators, custom Arena instances, and replaced internal hooks retain scalar behavior.

The wrapper buffers only a bounded chunk of JavaScript keys and encoded bytes. No shared staging bytes survive an input getter. A reentrant getter can allocate or grow memory before the next flush. If a getter replaces `Arena.delete`, `Arena.find`, or the WASM exports, captured native code finishes earlier buffered requests, then the current and later requests use the replacement hooks. One iterator is used throughout, preserving input visitation and iterator closing on errors.

The scalar probe is a heuristic. A missing prefix followed by many hits stays scalar and may miss a useful optimization. A dense prefix followed by misses can pay batching overhead. Both shapes are explicit adverse workloads below. Allocation savings alone do not establish a latency improvement.


## Workloads and measurement

The [workload module](workloads.mjs) defines all inputs, expected public results, and repetitions. Numeric values include ordinary fractional numbers, `NaN`, negative zero, infinities, and numeric extremes. The Unicode case includes multibyte keys. Timing fixtures use distinct full hashes; collision buckets are covered by correctness tests, without a separate collision-heavy latency claim. The complete final Map is checked in independently computed hash-trie order, and the retained source is checked after every batch.

| Workload | Source entries | Requested keys | Purpose |
| --- | ---: | ---: | --- |
| Small deletion | 4,096 | 100 | Scalar dispatch control |
| Medium deletion | 8,192 | 1,000 | Repeated forks of the same source |
| Large deletion | 8,192 | 4,096 | Shared path copying across chunks |
| Independent-source deletion | 8,192 | 1,000 | A separate prebuilt source per operation |
| Unicode deletion | 8,192 | 1,000 | UTF-8 preparation |
| Small control | 512 | 32 | Scalar dispatch control |
| Dispatch boundaries | 8,192 | 511 / 512 | Below and at the grouping threshold |
| Single and empty controls | 64 | 1 / 0 | Unchanged small operations |
| All missing | 4,096 | 1,000 | No result or writer allocation |
| Missing prefix, later hits | 8,192 | 1,000 | Useful work after an unrepresentative probe |
| Sparse hits | 8,192 | 1,000 | One matching key in every 16 requests |
| Dense prefix, later misses | 8,192 | 1,000 | Misleading successful probe |
| Repeated key | 4,096 | 1,000 | One real deletion |
| Clear all | 4,096 | 4,096 | Empty result and branch collapse |
| `getMany` control | 128 | 64 reads | Unchanged populated read cache |
| `set` control | 64 | 1 update | Unchanged scalar update |

Every timed result remains in a preallocated output array until full validation finishes. Each timing batch starts from a newly built arena outside the timer. Normal workloads repeatedly fork that one source; the independent-source workload prepares a separate arena and Map for every repetition. Imports, fixture/source creation, output-array allocation, and correctness checks are excluded. The complete public call, internal key preparation, WASM work, arena growth and allocation, returned handle creation, and output retention are included.

The [paired driver](paired-benchmark.mjs) pins execution to one CPU, holds a common advisory lock, and launches separate processes for each build, runtime, and case. Both builds use the same neutral import path. Before/after order alternates by pair; runtime and case order reverse too. The prespecified formal plan uses six process pairs, at least 500 ms of timed warmup and eight warmup batches, and nine measured batches. Pilots use two pairs and 150 ms; same-build controls use four pairs and 500 ms.

Each process estimate is its median batch duration divided by the repetition count. A completed six-pair study would report the geometric mean of six after/before ratios and an unadjusted Student-t interval on paired log ratios. This attempt did not complete; the tables above report only descriptive geometric means of the available complete pairs, with no confidence intervals. Saved records retain all samples, versions, affinity, schedule, short-batch counts, source/build hashes, and changed source snapshots. [verify.mjs](verify.mjs) recomputes statistics and checks provenance without retiming.


## Exact writer allocation: all 20 fixtures

[allocation.mjs](allocation.mjs) records the exact change in the WASM allocation frontier for one complete public request on a fresh source. The hosted [baseline record](validation/attempt1/ci-logs/allocation-before.json) and [candidate record](validation/attempt1/ci-logs/allocation-after.json) have identical fixture digests for every paired row. They include source, WASM, imported bundle, workload, and harness hashes. Full results and published source bytes passed validation.

Counts include the scalar prefix, all chunks, unreachable intermediate path copies, and the 49,140/49,141-byte UTF-8 boundary cases. They exclude JavaScript allocation, garbage collection, total backing-buffer capacity, and RSS. They are exact writer-frontier deltas, not a total-memory or cross-library comparison.

| Workload | Before bytes | After bytes | Change |
| --- | ---: | ---: | ---: |
| `delete-100-of-4096` | 4,544 | 4,544 | +0.00% |
| `delete-1000-of-8192` | 76,048 | 27,256 | -64.16% |
| `delete-4096-of-8192` | 300,188 | 62,500 | -79.18% |
| `delete-cold-1000-of-8192` | 76,048 | 27,256 | -64.16% |
| `delete-unicode-1000-of-8192` | 78,876 | 34,972 | -55.66% |
| `delete-32-control` | 1,412 | 1,412 | +0.00% |
| `delete-511-boundary` | 38,268 | 38,268 | +0.00% |
| `delete-512-boundary` | 38,328 | 19,740 | -48.50% |
| `delete-1-control` | 24 | 24 | +0.00% |
| `delete-empty-control` | 0 | 0 | 0 bytes |
| `delete-missing-1000` | 0 | 0 | 0 bytes |
| `delete-late-hits-1000` | 74,420 | 74,420 | +0.00% |
| `delete-sparse-hits-1000` | 5,216 | 5,216 | +0.00% |
| `delete-dense-prefix-missing-1000` | 2,416 | 2,416 | +0.00% |
| `delete-duplicate-1000` | 76 | 76 | +0.00% |
| `delete-all-4096` | 234,940 | 18,728 | -92.03% |
| `fixed-width-request-count-2489` | 169,108 | 23,452 | -86.13% |
| `fixed-width-request-count-2490` | 169,184 | 23,528 | -86.09% |
| `fixed-width-request-count-4946` | 312,584 | 33,188 | -89.38% |
| `encoded-key-cutoff-49140-and-49141` | 1,848 | 1,848 | +0.00% |

Deleting 4,096 keys reduced these bytes by 79.18%; deleting all 4,096 reduced them by 92.03%. The dense-prefix/missing fixture allocated the same 2,416 bytes in both builds while getting slower. These facts illustrate why memory savings alone were insufficient for acceptance.

The [library comparison harness](compare.mjs) was prepared but **never reached in this hosted attempt**. It uses one `withMutations` session per Immutable.js request and one `new Map(source)` per native request, retains both versions, and validates the full result. No library comparison timings or conclusions are claimed for V3.

## Completed correctness and compatibility checks

The [regression tests](../../map-batch-delete.test.ts) cover threshold and chunk boundaries, missing and duplicate keys, Unicode replacement aliases, full-hash collisions, branch collapse, oversized keys, legacy journals, custom iterators and hooks, reentrant getters and memory growth, randomized sequences, nested values, retained forks, compaction, and both worker payload modes. The allocation-failure case forces the grouped remainder to fail after a successful scalar prefix, verifies the published source, and recovers through an allocation-free deletion without rewinding the allocator.

The hosted run completed the following checks before benchmarking:

- WASM and portable builds, declaration generation, and both TypeScript checks.
- **128 tests across six files in Node and 128 in Bun**, including all 39 new regression tests: [Node log](validation/attempt1/ci-logs/node-tests.log), [Bun log](validation/attempt1/ci-logs/bun-tests.log).
- Real workers with the [current reader](validation/attempt1/ci-logs/workers-current-reader.json) and the [pinned old reader](validation/attempt1/ci-logs/workers-old-reader.json), under shared and copied transport. Workers retained snapshots while the owner grew memory and deleted entries, then checked forks, compaction, boundaries, and adverse cases.
- Exact allocation and full-output/source verification for all 20 fixtures.
- Packed-package checks.
- [Chromium 153.0.8010.12 with real browser workers](validation/attempt1/ci-logs/chromium.json), in a cross-origin-isolated page, under shared and copied transport. Full expected values were derived independently from inputs.

The rejection is based on performance behavior and incomplete measurement, not a known correctness failure. Local pre-hosted validation also passed all 18 workload smoke cases; those checks are not additional timing evidence.

## Archive-only verification workflow

The [dedicated workflow](../../.github/workflows/map-batch-delete.yml) now performs correctness and archive validation only. It has no benchmark bootstrap, resume, retiming, or feature-branch push trigger. Its triggers are limited to this proof, its regression test, its workflow, and manual execution.

Current checkout code receives the build, Node/Bun test, package, worker, allocation, and browser checks. For archive validation, the workflow reads the complete V3 pilot's candidate commit and rebuilds that historical revision in a separate worktree. Both that candidate and the reader baseline install from their own pinned manifests; those historical revisions have no committed lockfile. This separates historical exact-build checks from later runtime changes.

[audit-rejected.mjs](audit-rejected.mjs) verifies lossless archive hashes, both complete pilots, the exact recorded candidate and optional baseline builds, all 331 saved formal processes and their schedule prefix, all 36 descriptive rows, the missing A/A/reference stages, the independent audit's provenance, and the allocation records. It requires the partial record to remain partial and reports `completeFormalStudy: false`. It does not invoke the benchmark driver or the library timing harness. The original full-study auditor remains strict and is not used to pretend the missing formal/A/A evidence exists.

The [saved archive-audit result](validation/rejected-archive-audit.json) passed against both the exact candidate and baseline source/WASM/bundle builds. The revised workflow itself has been checked as YAML and shell syntax; it is not represented as an additional completed hosted run.

To recheck the saved archive against already-built historical checkouts, without measuring performance:

```sh
node proofs/map-batch-delete-direct-20261108/audit-rejected.mjs \
  "$RECORDED_MAP_CANDIDATE_CHECKOUT" "$BASELINE_CHECKOUT"
```

The Python audit is also retained for independently reconstructing the available fixtures and statistics. It requires SciPy and writes a new audit output only when that destination does not already exist; the original saved audit should be preserved. No further timed study is planned for this rejected candidate.
