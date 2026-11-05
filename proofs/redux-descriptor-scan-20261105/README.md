# Stream Redux property-descriptor validation

## Result

On 2026-11-05, replacing the temporary descriptor map with a streaming descriptor scan reduced complete public codec serialization time in the declared workloads. All six Node target cases improved in every process pair, with paired time reductions of **34–63%** and each unadjusted 95% interval below parity. Five Bun encode cases also have intervals below parity, with paired reductions of **16–45%**. Bun mixed-state `stringify` remains **inconclusive**.

These are standalone comparisons against main commit `77599337867dbf785a5f0311d34637d0b36678fc`. No existing benchmark row or historical evidence was changed.

## Change and behavior

[`redux-codec.ts`](../../redux-codec.ts) formerly built `Object.getOwnPropertyDescriptors(input)`, then enumerated that temporary object solely to reject enumerable symbols and accessors. The new loop reads each descriptor directly from the input and discards it after validation. It still checks every own string and symbol key, skips validation for nonenumerable descriptors, and skips descriptors that disappear during proxy enumeration. It removes the temporary descriptor map; heap allocation bytes were not measured.

Array holes, undefined values, null prototypes, special property names, node/depth/collection limits, and collection encoding keep their existing handling. Validation now rejects an invalid enumerable descriptor as soon as it is encountered. On an invalid proxy, later descriptor traps that the old eager collection would execute may therefore be skipped. Neither version invokes an enumerable accessor while validating it.

## Complete confirmation results

All times are **microseconds per complete public operation**, lower is better. Before/after columns are medians of six process medians. Ratios are the geometric mean of six **paired** after/before ratios, so a ratio need not equal the quotient of the displayed marginal medians. Intervals are unadjusted 95% Student-t intervals on log ratios with five degrees of freedom. They are per-row intervals, not simultaneous bounds across the whole matrix.

### Node.js 24.22.1

| Operation | Before µs | After µs | Paired ratio (95% interval) | Faster pairs |
| --- | ---: | ---: | ---: | ---: |
| Encode 4-field record | 1.835 | 0.567 | 0.375 (0.282–0.498) | 6/6 |
| Encode 8,192-number array | 3407.371 | 2152.356 | 0.622 (0.525–0.738) | 6/6 |
| Encode frozen 8,192-number array | 3387.274 | 2095.238 | 0.621 (0.439–0.877) | 6/6 |
| Encode 4,096-field record | 2583.709 | 1177.666 | 0.432 (0.378–0.494) | 6/6 |
| Encode frozen 4,096-field record | 2810.688 | 1172.021 | 0.389 (0.277–0.546) | 6/6 |
| Stringify frozen state with 256 records | 1494.668 | 1018.198 | 0.656 (0.462–0.931) | 6/6 |
| Encode 1,024-entry SharedMap (control) | 216.195 | 233.254 | 1.059 (0.884–1.270) | 2/6 |
| Decode 4,096-field record (control) | 1660.537 | 1453.528 | 0.924 (0.787–1.083) | 4/6 |

### Bun 1.4.2

| Operation | Before µs | After µs | Paired ratio (95% interval) | Faster pairs |
| --- | ---: | ---: | ---: | ---: |
| Encode 4-field record | 0.356 | 0.281 | 0.741 (0.567–0.968) | 6/6 |
| Encode 8,192-number array | 6176.052 | 4375.421 | 0.712 (0.671–0.755) | 6/6 |
| Encode frozen 8,192-number array | 9169.687 | 7674.853 | 0.841 (0.720–0.982) | 5/6 |
| Encode 4,096-field record | 1508.272 | 871.296 | 0.654 (0.465–0.919) | 5/6 |
| Encode frozen 4,096-field record | 1504.252 | 717.716 | 0.555 (0.388–0.793) | 5/6 |
| Stringify frozen state with 256 records | 844.147 | 786.078 | 0.901 (0.564–1.439) | 3/6 |
| Encode 1,024-entry SharedMap (control) | 134.964 | 120.456 | 0.867 (0.734–1.025) | 5/6 |
| Decode 4,096-field record (control) | 381.084 | 371.117 | 1.004 (0.771–1.309) | 2/6 |

### Controls and uncertainty

Bun mixed-state `stringify` estimated 9.9% less time, but only three of six pairs improved and its ratio interval spans **0.564–1.439**. It is not counted as a confirmed Bun improvement. One frozen-array pair and one pair for each large-record target also ran slower on Bun; all pairs are retained.

Node shared-collection encoding estimated **5.9% slower**, with four of six slower pairs and an interval of **0.884–1.270**. Its code branch was not edited, but that does not establish performance equivalence. The Node decode control and both Bun controls also have intervals spanning parity. Apparent improvements in those controls are not counted as benefits. This experiment does not establish a universal speedup or a no-regression guarantee.

## Method

- Linux x64, AMD EPYC 9V74 80-Core Processor, Linux 6.18.57. Timings held an exclusive shared-runner lock and pinned the runner and child processes to CPU 2.
- One frozen source variant and one fixed eight-case matrix. Six independent A/B process pairs for each case and runtime: **192 subjects, 96 paired ratios, and 1,728 measured batches**. The prior two-pair pilot is saved separately and is not pooled with confirmation.
- AB and BA alternate by pair; case order also reverses. Every subject starts a fresh runtime process and imports exactly one portable build from the same neutral filesystem path. Baseline and candidate run sequentially.
- At least **500 ms of actual timed warm-up** and at least eight warm-up batches per subject, followed by nine measured batches. Repetitions are fixed and equal across variants: 256 for the tiny record, 16 for the SharedMap control, and four for each other case. No explicit garbage collection is forced.
- The timer includes the entire public `codec.encode`, `codec.stringify`, or `codec.decode` call and assignment of each result into a preallocated retention array. `.stringify` includes encoding and `JSON.stringify`; `.encode` does not include final JSON text generation.
- Imports, codec construction, input construction/freezing, expected-output construction, the retention-array allocation, and full output verification are outside the timer. Fixtures are stable and repeatedly serialized within each subject. Every returned result in warm-up and measurement is retained and fully checked before the next batch. Plain-value envelopes use an independent reference encoder; the shared-map control compares its complete entry sequence. Decode outputs are checked against the original native record.
- Numeric arrays contain 8,192 distinct values; records contain 4,096 short keys and numeric values. The mixed frozen state contains 256 nested records, coordinate arrays, metadata, and a selection field. The tiny record contains four scalar fields. Frozen and mutable fixture cases are separate.
- This is one machine with Node and Bun portable bundles. Browser engines, ARM64, cold first-call latency, changing-shape streams, peak memory, and end-user application latency were not benchmarked.

## Validation

[`redux-descriptor-scan.test.ts`](../../redux-descriptor-scan.test.ts) covers frozen and mutable inputs, retained source values, noninvoked getters, enumerable symbols, ignored nonenumerable fields, null prototypes, special names, inherited properties, disappearing descriptors, thrown descriptor traps, sparse arrays, and extra array properties. The focused Redux suites passed in both Node and Bun: **8 files / 141 tests in each runtime**. Portable builds, generated declarations, Redux type checks, and diff checks passed.

Independent arithmetic verification recomputes every process median, paired ratio, and interval from the raw samples. Source and build digests were checked at both ends of each timing run. An independent review separately reproduced all 192 confirmation medians, 96 ratios, and 16 intervals and checked source/WASM/bundle hashes.

## Evidence and reproduction

- [Frozen benchmark driver](benchmark.mjs)
- [Independent verifier](verify.py)
- [Full confirmation measurements](formal.json.gz)
- [Complete earlier pilot](pilot.json.gz)
- [Compressed and original byte hashes](manifest.json)

Both recordings preserve their original JSON bytes through lossless compression. The pilot used 150 ms of timed warm-up, two process pairs, and the same eight cases. It included a 6.5% slower Node decode-control estimate; that result remains in the pilot. No timing observation was removed, and no source, matrix, or driver change followed the pilot.

Runtime source files, WASM binaries, package/build inputs, portable bundles, runtime versions, warm-up batches, measured batches, checksums, and per-pair results are recorded in each JSON file. The measured candidate was a working tree based on the baseline commit; its source hash fixes the actual variant independently of the later documentation commit.

| Identity | SHA-256 |
| --- | --- |
| Baseline `redux-codec.ts` | `6677302e6c0d6199d2170c7f6c7d611e5ba3936fb90c3b05957a4b50f1f61ff6` |
| Candidate `redux-codec.ts` | `c8b11817dda513321d111f7d618381c6e2851f86cfdc2ebf96ca04c383afc241` |
| Benchmark driver | `5e20c46dfa001abd2e8b2b2db6aef7040ea1e78e106a6316a9d2d44f62606b4e` |

Check the saved evidence without running timings:

```sh
python proofs/redux-descriptor-scan-20261105/verify.py
```

To run a new comparison, prepare an untouched checkout of the stated baseline and this candidate, install the pinned development dependencies, and build both with `bun run build:wasm`, `bun run build:browser`, and `bun run build:types`. Use a new output path and a CPU available to your host:

```sh
flock /tmp/zerocopy-performance.lock taskset -c 2 node \
  proofs/redux-descriptor-scan-20261105/benchmark.mjs \
  ../zerocopy-before . "$(command -v bun)" \
  /tmp/redux-descriptors-new.json formal
python proofs/redux-descriptor-scan-20261105/verify.py /tmp/redux-descriptors-new.json
```

The runner requires the exact baseline commit and a single changed runtime source file, `redux-codec.ts`. It rejects an existing output path and verifies that source and build identities remain fixed throughout the study.
