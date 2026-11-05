# Rejected large numeric list compaction study

**Evidence only; no optimization PR.** Large numeric lists improved convincingly, but repeated adverse fallback observations leave the conservative publication gate unmet. No additional timing run or source variant followed the final confirmation. The active production/test/CI files in this archive branch are restored to baseline; exact measured sources remain below.

## Decision

V3 reduced complete compaction latency for both measured large numeric-list sizes (131,073 and 65,537 elements) in all six process pairs on both engines. That does not settle the other workloads. Node’s unchanged 8,193-boolean list has a paired ratio of **1.2491**, with **5/6 slower pairs** and a wide 95% interval of **[0.8535, 1.8281]**. The same control direction appeared in V1 confirmation and V2 screening; those different source studies are kept separate, not pooled. Bun’s unchanged numeric queue is **1.0800 [0.9952, 1.1721]**, with **4/6 slower pairs**. An interval spanning parity does not establish equivalence or absence of a regression.

The V3 fallback vector method is byte-for-byte equal to baseline, but that is insufficient evidence for unchanged complete-operation timing. We retain the real numeric gains and the adverse/uncertain controls, and do not label this a validated general performance improvement.

## Scope and source identities

- Public operation: `compact(source)`, including a fresh Arena/WebAssembly instance, allocation, copying/relocation, vector index construction and frozen result.
- Baseline: `77599337867dbf785a5f0311d34637d0b36678fc`.
- V3 measured local commit: `4eb226aefdbfcba0179ecd9d55496532e5b24999` (local provenance, not presumed remotely fetchable).
- V3 production SHA-256: `71fe5ab9f39c531f5696ebb00e8e8eb9e7389aaf15023bc5797b12b0650d49ed`.
- [Exact V3 source](measured-source/compaction.ts), [focused tests](measured-source/primitive-compaction.test.ts.txt), [recorded CI snapshot](measured-source/ci.yml), [driver](benchmark.mjs), [plan](PLAN.md), [final confirmation decision](CONFIRMATION-PLAN.md).

V1 copied all number/boolean list and queue spans and failed the Node boolean-list control; an unchanged Bun JSON control also slowed. [Its complete report/source/pilot/formal evidence](rejected-v1/README.md) remains. V2 limited copying to numeric lists of at least 65,536 elements, but kept the dispatch inside the generic vector method and retained an adverse Node boolean pilot. [The complete V2 screen](rejected-v2/README.md) remains. V3 moved dispatch outside the unchanged generic method and used exact-length byte views to preserve invalid-tail bounds failures. The 65,536 threshold was a conservative scope limit, not an empirically optimized crossover.

## Final confirmation: every case

Times are milliseconds per complete operation. Before/after columns are medians of the six process medians; the effect estimate is the geometric mean of paired process ratios. Ratios below one are faster. Intervals are unadjusted Student-t intervals on log ratios (six independent pairs, df 5; recorded critical value 2.570582).

| Engine | Case | Before ms | After ms | Paired ratio | 95% interval | All six ratios |
| --- | --- | ---: | ---: | ---: | --- | --- |
| node | list-number-large | 3.876070 | 1.073285 | 0.2714 | [0.2542, 0.2898] | 0.2589, 0.2763, 0.2736, 0.2687, 0.3018, 0.2520 |
| node | list-number-boundary | 1.800316 | 0.694811 | 0.4060 | [0.3611, 0.4566] | 0.4386, 0.4213, 0.3624, 0.3505, 0.4688, 0.4071 |
| node | list-number-small | 0.057904 | 0.053074 | 0.9501 | [0.8380, 1.0772] | 0.9193, 1.0527, 0.9835, 0.7830, 0.9049, 1.0906 |
| node | list-boolean | 0.529564 | 0.653691 | 1.2491 | [0.8535, 1.8281] | 2.3227, 1.3171, 1.0757, 1.2257, 0.7590, 1.2409 |
| node | queue-number | 0.603813 | 0.577325 | 0.8900 | [0.5839, 1.3565] | 0.6795, 0.4937, 0.8398, 1.0490, 1.5692, 1.0715 |
| node | queue-boolean | 0.133841 | 0.141053 | 1.1023 | [0.8531, 1.4242] | 1.1090, 1.2055, 1.6727, 0.8196, 0.9415, 1.0392 |
| node | list-empty | 0.047168 | 0.041791 | 0.9563 | [0.7126, 1.2834] | 1.5564, 0.8221, 0.7476, 1.1502, 0.8212, 0.8467 |
| node | list-string | 0.850520 | 0.709630 | 0.8710 | [0.6015, 1.2613] | 0.5445, 1.0350, 1.1933, 0.7288, 0.6733, 1.3229 |
| node | list-object | 0.161852 | 0.162487 | 0.9567 | [0.6865, 1.3332] | 0.9955, 1.5178, 0.6108, 1.1891, 0.8248, 0.8468 |
| bun | list-number-large | 4.025726 | 2.142195 | 0.5396 | [0.4867, 0.5983] | 0.4902, 0.6052, 0.5645, 0.5409, 0.4704, 0.5793 |
| bun | list-number-boundary | 2.314553 | 1.499331 | 0.6479 | [0.5402, 0.7770] | 0.4954, 0.6797, 0.8331, 0.7014, 0.6127, 0.6137 |
| bun | list-number-small | 1.147060 | 1.104560 | 0.9901 | [0.8809, 1.1129] | 0.8240, 0.9852, 0.9795, 0.9587, 1.0976, 1.1259 |
| bun | list-boolean | 1.243181 | 1.133368 | 0.9634 | [0.8010, 1.1587] | 0.7634, 1.0072, 0.9672, 1.2705, 0.8373, 1.0107 |
| bun | queue-number | 1.238623 | 1.313128 | 1.0800 | [0.9952, 1.1721] | 1.1631, 1.1076, 1.1578, 0.9991, 0.9643, 1.1045 |
| bun | queue-boolean | 1.126821 | 1.196065 | 1.0294 | [0.9337, 1.1349] | 1.1031, 0.8794, 1.0587, 1.1093, 0.9625, 1.0850 |
| bun | list-empty | 1.043138 | 1.013958 | 1.0137 | [0.9024, 1.1387] | 0.9147, 1.1175, 0.8756, 1.0523, 1.1595, 0.9936 |
| bun | list-string | 1.687650 | 1.622572 | 0.9740 | [0.9238, 1.0268] | 0.9716, 0.9944, 0.9122, 0.9873, 0.9327, 1.0517 |
| bun | list-object | 1.347020 | 1.186198 | 0.9215 | [0.8290, 1.0244] | 0.8227, 0.9505, 0.8931, 1.0951, 0.8532, 0.9384 |

## Method and limits

Node 24.22.1 and Bun 1.4.2 on Linux x64, AMD EPYC 9V74. All heavy work used the shared performance lock; subjects inherited CPU 2 affinity. Each subject imported one portable build and one case through a common neutral path, with every JavaScript bundle chunk replaced before launch. Six AB/BA-balanced pairs per case/runtime, reversed case order on alternating pairs; nine measured batches after at least 500 ms actual timed warm-up and eight batches.

Final confirmation: **216 subjects, 108 pairs, 1,944 measured batches**. Minimum actual warm-up was 500.005 ms; the shortest measured batch was 0.501 ms. Small fixed-repeat batches and process/allocation/GC variation limit fallback precision. No equivalence or universal no-regression claim is made.

Fixtures, independent native-value oracles, reference layout and complete verification are outside timing. Every returned snapshot is retained until its complete values, descriptor, target-used bytes and payload hash are verified. Every batch also checks unchanged source bytes/allocation. Pair checks enforce identical native fixtures, source bytes, target allocation and complete result layout. Writable rebuilt results are checked after measurement. Imports, verification and the outer result-array allocation are excluded; normal allocation and GC inside compact remain timed.

## V3 pilot: complete screen, separate from confirmation

| Engine | Case | Before ms | After ms | Paired ratio | Both ratios |
| --- | --- | ---: | ---: | ---: | --- |
| node | list-number-large | 3.770747 | 0.952536 | 0.2537 | 0.2719, 0.2368 |
| node | list-number-boundary | 1.623185 | 0.605043 | 0.3727 | 0.3730, 0.3724 |
| node | list-number-small | 0.073060 | 0.048804 | 0.6718 | 0.5999, 0.7523 |
| node | list-boolean | 0.563191 | 0.485973 | 0.8075 | 0.5405, 1.2064 |
| node | queue-number | 0.557262 | 0.477123 | 0.8217 | 0.9575, 0.7052 |
| node | queue-boolean | 0.125085 | 0.142941 | 1.1453 | 1.2158, 1.0789 |
| node | list-empty | 0.038058 | 0.035303 | 0.9302 | 0.8768, 0.9869 |
| node | list-string | 0.813980 | 0.713656 | 0.8794 | 0.8529, 0.9067 |
| node | list-object | 0.126809 | 0.117763 | 0.9275 | 1.0178, 0.8452 |
| bun | list-number-large | 4.244309 | 2.240052 | 0.5229 | 0.4524, 0.6044 |
| bun | list-number-boundary | 2.317844 | 1.644766 | 0.7166 | 0.6362, 0.8071 |
| bun | list-number-small | 1.045332 | 1.097631 | 1.0512 | 1.0658, 1.0368 |
| bun | list-boolean | 1.288915 | 1.204222 | 0.9377 | 0.8544, 1.0291 |
| bun | queue-number | 1.439426 | 1.154278 | 0.7984 | 0.7234, 0.8812 |
| bun | queue-boolean | 1.156871 | 1.098438 | 0.9534 | 0.8627, 1.0537 |
| bun | list-empty | 1.060289 | 0.989852 | 0.9338 | 0.9227, 0.9451 |
| bun | list-string | 1.797156 | 1.958199 | 1.0793 | 0.9643, 1.2080 |
| bun | list-object | 1.184117 | 1.406246 | 1.1876 | 1.1885, 1.1868 |

## Correctness and independent review

V3 portable browser/declaration builds, 83 focused tests and two actual shared/copy Node worker scenarios passed. Coverage includes tree/tail/65,536 boundaries, edits and retained forks, exact IEEE-754 bits, nested aliases/relocation, growth, read-only sources, writable results, invalid large tails and destination allocation failure above the optimized threshold. Focused/build/worker logs remain in [results](results/). These correctness checks do not clear the performance gate.

[Independent Python audit](review/independent-audit.py) and its [recorded output](review/independent-audit.txt) reproduce every V3 median, paired ratio, table row and interval, 1,944 measured batches, verification counters and 177 original live source/bundle/driver checks. A second reviewer agreed the remaining fallback risk blocks readiness. All failed early fixture/test attempts and each exact measured source variant remain archived.

## Complete retained evidence

All five studies survive lossless gzip compression, with exact original hashes. Total across separate studies: 616 measured subjects, 308 process pairs, 5,544 measured batches. They are not pooled into an effect estimate.

| Study | Original bytes | Original SHA-256 | Record |
| --- | ---: | --- | --- |
| v1 pilot | 486,846 | `a0fe8661dc2ada191a918a4b408ac086ac7c87f30d8f1e4614b7c1361fdb2aac` | [pilot-01.json.gz](rejected-v1/results/pilot-01.json.gz) |
| v1 formal | 1,428,673 | `839f370458e0ccb16717d72fc9c004b173d33929a845123b8fb701cebcd95dcd` | [formal-01.json.gz](rejected-v1/results/formal-01.json.gz) |
| v2 pilot | 491,519 | `f0c048082e3a32e8afbd62c9423c9c0aad929908413a8025ad490732863c23fd` | [pilot-v2.json.gz](rejected-v2/results/pilot-v2.json.gz) |
| v3 pilot | 500,768 | `3890255085f7e3ac1a30f6aeca14885e70db04639d861ce8ead0df6bdf63f8df` | [pilot-v3.json.gz](results/pilot-v3.json.gz) |
| v3 formal | 1,417,555 | `c910330262fd58dc266c6da33603176856eb1ba2f001bb534de66900ac079fcc` | [formal-v3.json.gz](results/formal-v3.json.gz) |

[Evidence manifest](evidence-manifest.json) hashes the stored files; [study metadata](studies.json) maps each record to its exact archived source and driver. The saved-evidence verifier checks compressed/original bytes, archived Git blobs, all process arithmetic, ordering, warm-up and complete-output counters without pinning later production files.

```sh
node proofs/primitive-compaction-20261105/verify.mjs
python3 proofs/primitive-compaction-20261105/review/independent-audit.py \
  proofs/primitive-compaction-20261105/results/formal-v3.json.gz
```

## Reproduction

From this evidence checkout, create separate worktrees at the public baseline, then overlay the archived V3 source into the candidate. The baseline has no committed dependency lockfile: use documented `bun install` with its pinned direct versions, note that transitive resolutions can differ, and compare the recorded tool/source/build hashes. The original runs shared one installed dependency tree; no dependency change was part of this experiment.

```sh
archive=$PWD
git worktree add --detach ../compaction-before 77599337867dbf785a5f0311d34637d0b36678fc
git worktree add --detach ../compaction-after 77599337867dbf785a5f0311d34637d0b36678fc
cp "$archive/proofs/primitive-compaction-20261105/measured-source/compaction.ts" \
  ../compaction-after/compaction.ts
for build in ../compaction-before ../compaction-after; do
  (cd "$build" && bun install && bun run build:wasm && bun run build:browser)
done
flock /tmp/zerocopy-performance.lock taskset -c 2 node \
  "$archive/proofs/primitive-compaction-20261105/benchmark.mjs" \
  ../compaction-before ../compaction-after "$(command -v bun)" \
  /tmp/compaction-new-formal.json formal
```

Use the same lock path as every concurrent performance job on your host; the `/tmp` path above is an example. The original runs used `/workspace/scratch/83f1d4baba1f/perf.lock`. Choose a new output filename; the driver refuses to overwrite an existing record. It records actual source/bundle hashes, so the candidate’s local Git commit may differ while the archived runtime source must match. For V1/V2, restore the corresponding archived source and use that variant’s archived driver; archived support files retain their original relative-import layout and original-path mappings.
