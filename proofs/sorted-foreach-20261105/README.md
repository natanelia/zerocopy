# Sorted-map `forEach` without entry generators

## Final change and measured scope

`SharedSortedMap.forEach()` in its natural UTF-8 order now visits radix leaves directly. It decodes each key before its value and calls the supplied callback, while reusing a memory view that covers the immutable root. This avoids forwarding every element through `naturalEntries()` and `entries()` and constructing their entry pairs. Traversal state remains local to the existing radix iterator.

Custom comparators and `entries()` overrides use the original iterator path. The method reads `this.entries` once and compares it with the original method captured when the module loads; the fallback uses `Reflect.apply` to preserve the receiver and getter side effects. It detects subclass overrides and later prototype replacement, including an empty underlying root whose override yields entries.

In the final V2 confirmation, the five nonempty natural-order cases took **45–68% less time on Node and 39–59% less time on Bun**, using the paired estimates below. Every one of the 60 nonempty target pairs was faster; the ten corresponding unadjusted 95% intervals exclude parity. This is evidence for these repeated scan workloads on this machine, not a universal performance or no-regression guarantee.

The string and JSON fixtures are **warm-decoded/cache-warm scans**. They are fully collected before timing. The 4,096-key fixtures exceed the 2,048-entry string cache, so their later keys still need decoding during repeated scans. The worker proof checks cold decoding for correctness; it does not measure cold-read performance.

## Final V2 results

Times are microseconds per complete public scan, including the callback. Before/after columns are marginal medians of six process medians; the ratio is the geometric mean of the six **paired** after/before process-median ratios. These two summaries can differ, particularly in noisy controls. Each process median summarizes nine measured batches.

| Runtime | Case | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | number-4096 | 967.962 | 510.263 | 0.524 (0.476–0.575) | 6/6 |
| node | number-64 | 12.343 | 5.346 | 0.422 (0.366–0.486) | 6/6 |
| node | boolean-4096 | 964.403 | 490.377 | 0.517 (0.479–0.558) | 6/6 |
| node | string-1024 | 232.107 | 131.039 | 0.549 (0.500–0.602) | 6/6 |
| node | json-256 | 41.490 | 13.904 | 0.316 (0.241–0.415) | 6/6 |
| node | empty | 0.130 | 0.005 | 0.038 (0.030–0.047) | 6/6 |
| node | custom-1024 | 271.884 | 258.265 | 0.926 (0.830–1.033) | 5/6 |
| node | entries-4096 | 969.888 | 985.383 | 0.995 (0.903–1.097) | 3/6 |
| bun | number-4096 | 566.232 | 322.744 | 0.535 (0.479–0.597) | 6/6 |
| bun | number-64 | 6.273 | 3.339 | 0.523 (0.404–0.678) | 6/6 |
| bun | boolean-4096 | 527.259 | 240.992 | 0.459 (0.337–0.625) | 6/6 |
| bun | string-1024 | 119.842 | 71.953 | 0.612 (0.445–0.843) | 6/6 |
| bun | json-256 | 21.318 | 7.753 | 0.408 (0.299–0.557) | 6/6 |
| bun | empty | 0.071 | 0.004 | 0.057 (0.048–0.068) | 6/6 |
| bun | custom-1024 | 183.873 | 143.614 | 0.845 (0.649–1.100) | 5/6 |
| bun | entries-4096 | 651.359 | 641.735 | 1.062 (0.649–1.736) | 3/6 |

`number-4096`, `number-64`, `boolean-4096`, `string-1024` and `json-256` are the declared nonempty targets. `empty` is the degenerate case; its few-nanosecond optimized result is sensitive to inlining and is not used in the main claim. `custom-1024` exercises the comparator fallback. `entries-4096` exercises the unchanged public entry iterator with the same callback work. The control estimates are not counted as feature benefits.

**Control limitation:** all four final custom-comparator/entry control intervals include parity, so they establish neither a regression nor equivalence. Bun's unchanged entry scan estimates 6.2% slower, with a wide 0.649–1.736 interval. Do not infer a no-regression guarantee from these controls.

## Identical-build A/A check and uncertainty

This separate study copied the same frozen baseline build into both labeled positions. It ran four fresh process pairs per case/runtime, with alternating A/B order and the same timing protocol. It is a baseline noise check, not a final-V2 performance comparison.

| Runtime | Case | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | number-4096 | 1001.347 | 1001.827 | 1.051 (0.825–1.340) | 2/4 |
| node | custom-1024 | 253.618 | 295.839 | 1.113 (0.869–1.427) | 2/4 |
| node | entries-4096 | 947.340 | 1169.404 | 1.222 (1.117–1.336) | 0/4 |
| bun | number-4096 | 534.737 | 548.970 | 1.089 (0.572–2.076) | 2/4 |
| bun | custom-1024 | 173.518 | 159.051 | 0.960 (0.581–1.586) | 2/4 |
| bun | entries-4096 | 562.522 | 482.261 | 0.791 (0.525–1.192) | 4/4 |

The Node entry control produced an apparent **22.2% slowdown even though both builds were identical**; its unadjusted interval excludes parity. Bun's numeric A/A interval is also wide. These results expose process/host/runtime variability and the limits of small-sample intervals on this machine. They are retained rather than corrected away. The final target evidence includes large directional gains repeated in every pair on both runtimes; the intervals alone are not treated as proof of certainty, and small gains are not claimed. There is no browser, ARM64 or cross-machine timing claim.

## Method

- Date: 5 November 2026. Hardware: AMD EPYC 9V74 80-Core Processor, Linux 6.18.57, x64. Runtimes: Node 24.22.1 and Bun 1.4.2.
- Baseline: `77599337867dbf785a5f0311d34637d0b36678fc`. Final source SHA-256: `936c2d5d4e299f56e24e583a18f8653c9cc6dc308a7fc9d37c1fc1c7c40db08b` for `shared-sorted-map.ts`.
- The only differing root runtime source is `shared-sorted-map.ts`; all compiled WASM hashes match. Full source and portable-bundle hash manifests are in each confirmation/A/A recording. The small baseline, V1 and V2 source files are archived separately.
- Each subject starts a fresh process, imports exactly one build, and runs one case. Before and after use the same neutral module path. A shared exclusive timing lock prevents cooperating benchmark jobs from running concurrently, and every subject is pinned to CPU 2. This does not eliminate host noise.
- Six A/B pairs per case/runtime; order alternates AB/BA by pair. Repetition counts are fixed and equal within every comparison. Actual timed warm-up is at least 250 ms and at least eight batches, followed by nine measured batches. There are no outlier removals or selected reruns.
- The fixture inserts a deterministic permutation of ASCII keys into a sorted map. Values are numbers, booleans, strings or small JSON objects. The timed callback counts entries and adds the value (or string length / object ID) and key length. Assertions check these complete callback results after every batch. Full key/value arrays and their order are checked against an independent native `Map`/UTF-8-order oracle before and after timing.
- Initialization, native-oracle construction, full-output validation and assertions are outside the timer. Garbage collection caused by the public scan is part of the measurement; no explicit GC is forced between samples. The study does not measure heap-allocation bytes.
- Confidence intervals use Student's t on log paired ratios, with five degrees of freedom for A/B and three for A/A. They are unadjusted for multiple comparisons and depend on assumptions that the noisy A/A results caution against treating as guarantees.

## Retained development evidence

| Recording | Subjects | Purpose |
| --- | ---: | --- |
| [pilot-v1.json.gz](results/pilot-v1.json.gz) | 64 | Two alternating A/B pairs for the complete initial matrix; all observations retained. |
| [confirm-v1.json.gz](results/confirm-v1.json.gz) | 192 | Initial six-pair confirmation; not the final implementation. |
| [aa-v1.json.gz](results/aa-v1.json.gz) | 48 | Four-pair identical-baseline control study; not pooled with A/B. |
| [confirm-v2.json.gz](results/confirm-v2.json.gz) | 192 | Final six-pair confirmation after the override compatibility repair. |

V1 bypassed an overridden public `entries()` method. Review found that compatibility issue after V1 timing, so V2 adds the once-per-call guard. V1 source, pilot and confirmation remain unchanged. V2 was rebuilt and the entire unchanged A/B matrix was repeated once. Its final confirmation is not pooled with V1. The benchmark file and its internal `v1` study identifier name the unchanged measurement protocol; the recording filename and source hashes distinguish the V2 implementation.

The V1 pilot's unchanged Node entry control had one 44% slower pair, and its full marginal median was slower. Both the pilot and later A/A control anomalies are preserved. The [pilot manifest](pilot-manifest.json) records build hashes from untouched build snapshots after the pilot; source hashes were recorded before its timings. The original pilot harness is archived verbatim.

### Initial V1 confirmation (retained, not the final result)

| Runtime | Case | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | number-4096 | 977.523 | 559.348 | 0.584 (0.511–0.668) | 6/6 |
| node | number-64 | 12.410 | 5.744 | 0.458 (0.422–0.496) | 6/6 |
| node | boolean-4096 | 922.109 | 540.349 | 0.577 (0.515–0.645) | 6/6 |
| node | string-1024 | 240.129 | 123.229 | 0.552 (0.457–0.666) | 6/6 |
| node | json-256 | 42.385 | 12.023 | 0.273 (0.225–0.331) | 6/6 |
| node | empty | 0.106 | 0.006 | 0.059 (0.046–0.074) | 6/6 |
| node | custom-1024 | 272.409 | 282.446 | 0.984 (0.838–1.154) | 3/6 |
| node | entries-4096 | 972.357 | 991.013 | 0.948 (0.804–1.119) | 4/6 |
| bun | number-4096 | 524.558 | 312.561 | 0.556 (0.472–0.655) | 6/6 |
| bun | number-64 | 7.087 | 3.092 | 0.497 (0.412–0.600) | 6/6 |
| bun | boolean-4096 | 539.045 | 269.221 | 0.529 (0.410–0.683) | 6/6 |
| bun | string-1024 | 122.465 | 73.811 | 0.611 (0.523–0.715) | 6/6 |
| bun | json-256 | 19.804 | 7.624 | 0.407 (0.355–0.466) | 6/6 |
| bun | empty | 0.084 | 0.004 | 0.053 (0.044–0.063) | 6/6 |
| bun | custom-1024 | 150.023 | 152.751 | 0.978 (0.744–1.286) | 2/6 |
| bun | entries-4096 | 546.988 | 531.090 | 1.023 (0.740–1.413) | 3/6 |

## Correctness and verification

The [targeted regression suite](../../sorted-map-foreach.test.ts), existing sorted-map suite and trie-view suite passed **42 tests** on final V2. Coverage includes UTF-8 key order, normalized duplicate keys, `NaN`/signed zero, all value categories, immutable decoded JSON, snapshots/forks, source bytes, legacy nested journals, custom comparator ties/reentry, callback binding/throws, reset, memory growth, recursive reads, exact key-before-value decode order, subclass/prototype overrides and an entries getter that returns different functions on successive reads.

The [actual Node worker proof](worker.mjs) pauses inside a cold shared/copy-attached scan. The owner changes entries and grows memory, then the worker resumes the old snapshot and subsequently reads the new snapshot. Complete ordered outputs and read-only restrictions are checked in both transport modes. Type checking and declaration generation also passed. Commands, source hash and output are preserved in [validation-v2.json](validation-v2.json) and [validation-v2.txt](validation-v2.txt).

[verify.mjs](verify.mjs) checks compressed and uncompressed hashes, archived source/harness hashes, final validation logs, all 432 confirmation/A/A process medians, 216 pair ratios and 38 intervals, plus the 64 pilot subjects. CI runs that deterministic verification and the worker proof without rerunning timings. This report covers the scoped validation above; the PR reports repository-wide checks separately.

## Reproduce

Use isolated checkouts for the baseline commit and this PR, install the pinned dependencies, and build both with `bun run build:wasm` and `bun run build:browser`. `BEFORE_DIR` and `AFTER_DIR` below are those checkouts; `BUN` is the absolute path to Bun 1.4.2. Use a new output filename for every run. The driver refuses to overwrite an existing recording.

```sh
node proofs/sorted-foreach-20261105/verify.mjs
node proofs/sorted-foreach-20261105/summarize.mjs proofs/sorted-foreach-20261105/results/confirm-v2.json.gz
node proofs/sorted-foreach-20261105/worker.mjs
flock /tmp/zerocopy-perf.lock node proofs/sorted-foreach-20261105/benchmark.mjs "$BEFORE_DIR" "$AFTER_DIR" "$BUN" /tmp/sorted-foreach-reproduction.json confirm
```

The driver uses `taskset -c 2`; run it on a Linux host where that CPU is allowed, or deliberately version any portability change. The timing lock must be shared with other benchmark jobs on that host. Exact fixture definitions, repetition counts and timing boundaries are in [benchmark.mjs](benchmark.mjs); arithmetic is in [summarize.mjs](summarize.mjs). Every original measurement is stored losslessly as gzip with original/compressed hashes in [evidence.json](evidence.json). No historical benchmark rows or evidence files were edited.
