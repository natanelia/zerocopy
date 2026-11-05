# SharedMap.deleteMany: reuse private deletion paths

**Rejected: no production PR.** This experiment evaluates reusing branches created within a single public `SharedMap.deleteMany` call against main commit `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`. V3's large primary batches are faster in all 24 paired comparisons, but the full formal study fails the predeclared control gate. Node's empty-input control is 32.0% slower, and Bun's sixteen-key control is 29.4% slower; both intervals exclude parity. The eight-key case also allocates 64 additional bytes. Production files were restored to baseline; this branch contains evidence only.

The planned A/A study was **not run** because formal A/B already failed acceptance. It would not be used to subtract away control losses. There was no retuning, further timing or source/method change after the frozen V3 formal study. All pilots, complete formal rows, short batches, failed compatibility tests and source snapshots are preserved.

## Complete V3 formal results

The recording ran from `2026-11-05T15:36:30.789Z` to `2026-11-05T15:54:33.317Z`: 288 fresh processes and 2,592 measured batches. The independent verifier recomputes all 24 estimates and checks raw observations, warmup minima, call counts and source identities. The run checked 2,810,764,228 returned results, including the repeated identity checks in the empty-input workload. Of the measured batches, 1,932 were shorter than 2 ms; all are retained.

The primary paired time reductions are 24.5% and 29.3% in Node, and 22.2% and 38.5% in Bun. All 24 primary pair ratios favor the candidate. This does not rescue the controls: Node empty is slower in all six pairs, and Bun sixteen-key deletion in five of six. Node empty medians are approximately 10 to 13 ns; Bun sixteen-key medians are 1.376 to 1.831 microseconds. The eight-key and all-missing estimates also remain uncertain, with adverse estimates in some runtime/case combinations.

### Node 24.22.1

| Case | Before (us) | After (us) | Paired ratio | 95% interval | Faster pairs |
| --- | ---: | ---: | ---: | --- | ---: |
| `delete-1024-of-4096` | 258.149 | 203.489 | 0.755 | 0.661–0.863 | 6/6 |
| `delete-4096-of-16384` | 1191.193 | 819.021 | 0.707 | 0.665–0.751 | 6/6 |
| `unicode-256-of-2048` | 153.505 | 143.135 | 0.984 | 0.908–1.066 | 3/6 |
| `small-four-control` | 0.436 | 0.419 | 0.974 | 0.910–1.041 | 5/6 |
| `small-eight-control` | 1.509 | 1.671 | 1.074 | 0.740–1.559 | 3/6 |
| `small-sixteen-control` | 2.241 | 2.349 | 1.009 | 0.885–1.152 | 4/6 |
| `missing-control` | 7.783 | 8.777 | 1.099 | 0.922–1.309 | 2/6 |
| `hit-then-misses-control` | 67.338 | 72.684 | 1.058 | 0.877–1.276 | 3/6 |
| `empty-control` | 0.010 | 0.013 | 1.320 | 1.139–1.531 | 0/6 |
| `long-key-control` | 249.734 | 215.231 | 0.897 | 0.714–1.127 | 4/6 |
| `scalar-delete-control` | 0.149 | 0.149 | 0.995 | 0.982–1.008 | 4/6 |
| `bulk-set-control` | 83.506 | 91.750 | 1.070 | 0.954–1.199 | 2/6 |

### Bun 1.4.2

| Case | Before (us) | After (us) | Paired ratio | 95% interval | Faster pairs |
| --- | ---: | ---: | ---: | --- | ---: |
| `delete-1024-of-4096` | 165.907 | 130.613 | 0.778 | 0.702–0.863 | 6/6 |
| `delete-4096-of-16384` | 995.396 | 625.870 | 0.615 | 0.534–0.707 | 6/6 |
| `unicode-256-of-2048` | 62.925 | 55.384 | 0.892 | 0.722–1.103 | 5/6 |
| `small-four-control` | 0.307 | 0.312 | 1.000 | 0.957–1.044 | 4/6 |
| `small-eight-control` | 0.670 | 0.727 | 1.132 | 0.931–1.377 | 1/6 |
| `small-sixteen-control` | 1.376 | 1.831 | 1.294 | 1.015–1.649 | 1/6 |
| `missing-control` | 10.734 | 6.051 | 0.617 | 0.357–1.067 | 5/6 |
| `hit-then-misses-control` | 56.309 | 58.903 | 1.005 | 0.813–1.244 | 2/6 |
| `empty-control` | 0.002 | 0.002 | 0.998 | 0.696–1.432 | 3/6 |
| `long-key-control` | 100.691 | 110.342 | 1.084 | 0.903–1.301 | 1/6 |
| `scalar-delete-control` | 0.125 | 0.126 | 0.987 | 0.851–1.146 | 4/6 |
| `bulk-set-control` | 85.914 | 96.715 | 1.108 | 0.793–1.549 | 2/6 |

## What changes

The existing implementation performs a persistent scalar deletion for every key, copying affected paths each time. The candidate continues to copy every path reachable from a published snapshot, then allows later deletions in the same call to reuse eligible dense branches allocated after an ownership boundary. It keeps the first four deletions on the scalar path and stays there for all-missing inputs.

A native changed flag propagates subtree size changes even when an owned child keeps its address. Long-key fallback lookups move the ownership boundary past all current allocations because those lookups can cache a root. Each key still observes the current `Arena.delete` method exactly once. A custom method receives the original receiver and arguments; ownership restarts after it returns, protecting any intermediate root the custom method retained. The original input iteration and validation order are preserved.

The `SharedMap.deleteMany` signature, snapshot format and worker transport remain unchanged. No published node is intentionally modified. The additional native export and Arena helper support only this operation.

## Evaluation plan and limits

The [V3 design](design-v3.md) and [freeze record](freeze-v3.json) were written before any V3 timing. The full matrix contains two primary large ASCII batches, a secondary Unicode batch, small batches of four/eight/sixteen keys, all-missing and hit-then-missing inputs, an empty input, long-key fallback, unchanged scalar deletion and unchanged bulk setting.

The benchmark times the complete public call and retaining every returned snapshot. Fixture construction, imports, independent expected results, allocation observations and complete output checking are outside the timer. Every returned non-identity result is checked for its complete key/value sequence against a JavaScript Map model and an independent FNV hash-order model. Identity results must be the exact source instance. Source bytes are checked after every batch. A fresh source is reconstructed outside timing between batches to bound append-only arena growth. Verification and reconstruction can still affect subsequent JIT and garbage collection behavior.

Node 24.22.1 and Bun 1.4.2 each run in fresh processes on Linux 6.18.57, x64, AMD EPYC 9V74 80-Core Processor, pinned to CPU 2. One common file lock excludes the other local performance studies. Pair order alternates AB/BA; runtime and case order reverse between pairs. Both builds are copied to the same neutral import path. Full source, WASM and bundle hashes are recorded and checked again when each study ends. The nine core/legacy WASM copies must match their own core exactly; the unrelated kernels must remain identical between builds.

Formal A/B uses six process pairs per case/runtime and nine measured batches per process. Every process performs at least eight warmup batches and at least 500 ms of actual timed warmup, except the four predeclared tiny controls (scalar and four/eight/sixteen keys), which use 150 ms. The unexecuted A/A plan called for four same-baseline process pairs for the 1,024-removal target, four/eight-key controls, all-missing input and unchanged scalar deletion. A/A was planned as a noise diagnostic, with no subtraction from A/B.

Paired ratios are after/before, with lower values indicating less elapsed time. Each pair uses the median of nine measured batches divided by the number of complete operations in a batch. The aggregate is the geometric mean of paired ratios. Descriptive 95% intervals use Student-t intervals on paired log ratios; they do not establish a universal speed guarantee or correct for every case in the matrix. Batches shorter than 2 ms are reported and retained. No warmup, measured sample, pair or unfavorable workload is removed.

The predeclared acceptance gate requires at least 10% less paired time for both primary targets in both runtimes, with the interval excluding parity. A material unresolved control loss blocks acceptance. V3 received one full confirmation, with no source/method changes or repeated measurement until favorable. Earlier variants are not pooled into the formal estimates.

## Preserved pilot results

Each pilot has two fresh pairs per runtime and five complete public-operation workloads. These small samples have no reported confidence interval. V1/V2 use the original verifier with complete `entries` output checking; V3 uses complete `forEach` checking equally for both variants. The separately named drivers, workloads and verifiers preserve each method.

| Runtime and case | V1 ratio | V2 ratio | V3 ratio |
| --- | ---: | ---: | ---: |
| Node: remove 1,024 of 4,096 | 0.797 | 0.913 | 0.806 |
| Node: remove 4,096 of 16,384 | 0.653 | 0.714 | 0.699 |
| Node: four-key control | 1.146 | 1.004 | 0.842 |
| Node: all-missing control | 1.139 | 1.131 | 1.116 |
| Node: unchanged scalar delete | 1.079 | 0.889 | 1.061 |
| Bun: remove 1,024 of 4,096 | 0.746 | 0.694 | 0.604 |
| Bun: remove 4,096 of 16,384 | 0.484 | 0.669 | 0.814 |
| Bun: four-key control | 1.846 | 0.986 | 1.055 |
| Bun: all-missing control | 1.150 | 0.968 | 1.073 |
| Bun: unchanged scalar delete | 1.117 | 1.198 | 0.856 |

V1's control losses include both unchanged scalar controls, not just small bulk operations. V2 keeps the original scalar path for the first four keys and all misses, but its Node all-missing and Bun scalar controls remain slower in aggregate. Independent review also found that V2 bypassed custom deletion methods after its prefix; seven added regressions fail V2 and pass the baseline.

V3 fixes that compatibility defect. Its pilot improves both primary targets in every pair, but Node's all-missing and scalar estimates and Bun's four-key and all-missing estimates are still adverse. Bun's four-key control is slower in both V3 pilot pairs. Node's apparent four-key gain is mixed between pairs. These findings were retained as explicit risks for the formal decision.

The [native inspection](native-codegen.json) finds all 81 original native function bodies unchanged after normalizing function/call/global index renumbering, with consistent call graphs and all 54 prior exports matched. This is a structural diagnostic. It neither explains nor dismisses the timing differences in unchanged scalar controls.

## Native allocation observations

These values count append-only WASM bytes allocated by one complete public operation from a fresh fixture. They do not measure JavaScript allocation, backing-buffer capacity, peak memory or RSS. Node and Bun preflight observations agree.

| Case | Baseline bytes | V3 bytes |
| --- | ---: | ---: |
| Remove 1,024 of 4,096 | 64,856 | 30,272 |
| Remove 4,096 of 16,384 | 318,160 | 99,932 |
| Unicode: remove 256 of 2,048 | 14,076 | 7,672 |
| Four keys | 120 | 120 |
| Eight keys | 268 | 332 |
| Sixteen keys | 568 | 496 |
| All missing | 0 | 0 |
| Four hits then 1,020 misses | 164 | 164 |
| Empty input | 0 | 0 |
| Long-key fallback | 160 | 160 |
| Unchanged scalar delete | 48 | 48 |
| Unchanged bulk set | 15,468 | 15,468 |

The eight-key control allocates 64 additional bytes, a 23.9% increase. There is no blanket allocation-improvement claim.

## Correctness evidence

The new `map-delete-many.test.ts` suite passes 21 tests on candidate Node/Bun and unchanged-baseline Bun. It covers retained snapshots and forks, source bytes, collisions, UTF8 normalization, long-key cache fallbacks, source overlays, post-result writer updates, duplicate/missing/empty inputs, iterator failures/closing, read-only readers, nested values, memory growth and partial allocation failures. Dynamic deletion regressions cover subclass, own and prototype hooks; hooks installed by the iterator at keys five/eight; publishing an intermediate root before native deletion resumes; getter counts; and non-callable methods. An overridden `used` getter is not newly observed.

The real Node worker proof pauses an old iterator in a worker, changes the owner map, creates a fork, forces memory growth and resumes the worker. Both shared-memory and copied-memory transports pass on baseline and candidate. It verifies old/new/fork contents, read-only behavior and no reader allocation. Relevant pre-existing collection/allocation suites also passed during candidate development.

## Evidence and reproduction

Raw recordings are preserved losslessly as [V1 pilot](pilot-v1.json.gz), [V2 pilot](pilot-v2.json.gz), [V3 pilot](pilot-v3.json.gz) and eight ordered chunks of the original V3 formal gzip: [00](final-v3.json.gz.parts/part-000.bin), [01](final-v3.json.gz.parts/part-001.bin), [02](final-v3.json.gz.parts/part-002.bin), [03](final-v3.json.gz.parts/part-003.bin), [04](final-v3.json.gz.parts/part-004.bin), [05](final-v3.json.gz.parts/part-005.bin), [06](final-v3.json.gz.parts/part-006.bin), [07](final-v3.json.gz.parts/part-007.bin). The [manifest](manifest.json) records each chunk's order, size and SHA256, plus the exact original gzip and uncompressed hashes. Complete source snapshots are also embedded in every recording. The [V2 compatibility failure log](validation-v2-override-failures.txt), V3 validation logs, smoke/allocation observations and [native inspection script](inspect-native-codegen.py) remain alongside them.

The chunking is a packaging-only follow-up to accommodate delivery limits. Only the 1,532,914-byte formal gzip is split, into chunks no larger than 192 KiB. Concatenation reconstructs it byte-for-byte; no recording, timing, statistical result, frozen driver, verifier or source snapshot changed. The original gzip SHA256 remains `26b30f79b1bb5a598ffa9acbd05f426b1573457d9b9bd71d6bb6deafa140a027`; its 31,691,917-byte uncompressed JSON remains `5de90d15d2e53e22cb4dc7ac4f744cd9e098319c50486dbf2c671e41810c7790`.

The [archive verification wrapper](verify-archive.py) checks all artifact/chunk hashes, reconstructs the formal gzip in a temporary directory, verifies both original hashes, then invokes the unchanged verifiers for all four recordings. It preserves the original manifest filename lookup and resolves frozen driver/workload files beside the existing verifiers. It runs no measurements and removes its temporary reconstruction afterward:

```sh
python proofs/map-delete-many-20261105/verify-archive.py
```

To reproduce V3, create two separate checkouts of the baseline commit. Overlay only the candidate checkout's three production files from these archives before building: [arena.ts](archive/arena-v3.ts.txt), [persistent-core.as.ts](archive/persistent-core.as-v3.ts.txt) and [shared-map.ts](archive/shared-map-v3.ts.txt). The archived [regression suite](archive/map-delete-many.test-v3.ts.txt) can be copied to `map-delete-many.test.ts` for correctness checks. No production changes or root-level tests remain in this evidence branch.

Build both checkouts with the repository's pinned dependencies and normal WASM/browser build scripts. Run the commands below from this evidence checkout, replacing directory and Bun placeholders with absolute paths. The driver acquires the common lock itself; do not wrap it in another `flock` for the same file. Output paths must be new. These are reproduction instructions, not further measurements performed after rejection.

```sh
node proofs/map-delete-many-20261105/smoke-v3.mjs BASELINE_DIR CANDIDATE_DIR
taskset -c 2 node proofs/map-delete-many-20261105/paired-benchmark-v3.mjs proofs/map-delete-many-20261105/workloads-v3.mjs BASELINE_DIR CANDIDATE_DIR BUN_PATH NEW_FORMAL_JSON formal
python proofs/map-delete-many-20261105/verify-v3.py NEW_FORMAL_JSON
node proofs/map-delete-many-20261105/worker.mjs CANDIDATE_DIR/dist/shared.js
```

The verifier independently checks the raw durations, call counts, full verification counts, per-case effective warmups, alternating process order, allocation observations, source snapshots and all reported paired estimates. It runs no timings. V1/V2 use `verify.py`; V3 uses `verify-v3.py`.
