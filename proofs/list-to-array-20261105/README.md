# List array materialization

This comparison changes only `SharedList.toArray()`. Numeric and boolean lists
read their stored values directly. Each call captures one existing `DataView`
for its immutable snapshot, instead of refreshing that view for every 32-value
leaf. String, JSON and nested values continue through the existing decoder.
The result is still a fresh, ordinary mutable JavaScript array.

There are no new caches, WebAssembly changes, binary-format changes or package
dependencies. The change does not accelerate `get`, `values`, `forEach`, writes,
worker transfer, JSON parsing or the allocation of the returned array itself.

## Recorded results — 5 November 2026 (Singapore)

The retained runs used Linux x64 on an AMD EPYC 9V74 host, Node 24.22.1 and Bun 1.4.2. Both engines imported the same portable-build variants. These are local warm materialization measurements, not a promise for every runtime, device or application.

Numeric materialization improved in both runtimes: the six paired comparisons give 25–58% lower latency on Node and 19–29% on Bun for the three nonempty numeric sizes. Boolean materialization improved 36–57% on Node; the Bun boolean intervals include parity, so this recording does **not** establish a Bun boolean speedup.

In the primary Node/Bun runs, the empty, string, JSON, nested-map and unchanged-callback controls did not show a statistically detected slowdown. Several intervals are wide; that is not proof of a small universal no-regression margin. All measured controls and short-batch flags are retained below.

### Node v24.22.1

| Workload | Baseline µs | Candidate µs | Paired latency ratio | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| number array, 0 | 0.00681696 | 0.00634645 | 0.940 | 0.745–1.187 |
| number array, 16 | 0.114882 | 0.0851369 | 0.749 | 0.719–0.781 |
| number array, 1057 | 6.32356 | 2.52761 | 0.419 | 0.331–0.530 |
| number array, 65537 | 508.537 | 269.762 | 0.566 | 0.438–0.730 |
| boolean array, 16 | 0.11921 | 0.0737074 | 0.641 | 0.500–0.822 |
| boolean array, 1057 | 7.20012 | 3.08551 | 0.429 | 0.371–0.497 |
| boolean array, 65537 | 610.281 | 362.257 | 0.603 | 0.510–0.713 |
| string array, 1057 | 13.1833 | 14.1921 | 1.034 | 0.842–1.271 |
| string array, 4097 | 596.944 | 590.945 | 0.991 | 0.737–1.334 |
| object array, 1057 | 17.0728 | 11.7081 | 0.769 | 0.573–1.034 |
| object array, 4097 | 2599.8 | 2510.83 | 0.974 | 0.896–1.059 |
| nested array, 65 | 0.957076 | 0.923218 | 0.941 | 0.744–1.191 |
| number forEach, 65537 | 450.585 | 440.491 | 0.954 | 0.864–1.053 |

Identical-baseline A/A control: ratio **0.989**, 95% interval **0.765–1.278**. A/B ratios are not normalized by this control.

Batches below the 6 ms calibration target: `number/toArray/0`: 17/132; `boolean/toArray/16`: 31/132; `boolean/toArray/1057`: 12/132. They remain in the medians and confidence calculation; no sample was excluded. The timing target is a calibration aim, not an acceptance gate.

### Bun 1.4.2

| Workload | Baseline µs | Candidate µs | Paired latency ratio | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| number array, 0 | 0.0157686 | 0.0147945 | 0.950 | 0.798–1.130 |
| number array, 16 | 0.0895276 | 0.0644445 | 0.753 | 0.707–0.803 |
| number array, 1057 | 6.26937 | 4.91412 | 0.706 | 0.520–0.960 |
| number array, 65537 | 467.256 | 390.237 | 0.806 | 0.742–0.875 |
| boolean array, 16 | 0.0748189 | 0.0716334 | 0.965 | 0.865–1.077 |
| boolean array, 1057 | 6.04905 | 5.8238 | 0.999 | 0.745–1.340 |
| boolean array, 65537 | 452.932 | 441.173 | 0.957 | 0.812–1.127 |
| string array, 1057 | 11.9175 | 11.1725 | 0.942 | 0.823–1.079 |
| string array, 4097 | 593.98 | 555.12 | 0.999 | 0.852–1.170 |
| object array, 1057 | 15.4003 | 15.0644 | 0.973 | 0.813–1.164 |
| object array, 4097 | 3388.1 | 3366.98 | 0.970 | 0.863–1.090 |
| nested array, 65 | 0.710506 | 0.641082 | 0.894 | 0.790–1.011 |
| number forEach, 65537 | 297.388 | 298.321 | 0.997 | 0.939–1.058 |

Identical-baseline A/A control: ratio **0.998**, 95% interval **0.881–1.132**. A/B ratios are not normalized by this control.

Batches below the 6 ms calibration target: `number/toArray/0`: 5/132; `number/toArray/16`: 6/132; `number/toArray/1057`: 5/132. They remain in the medians and confidence calculation; no sample was excluded. The timing target is a calibration aim, not an acceptance gate.

Times are the median of six process medians per variant, in microseconds per materialization (or scan for the `forEach` control). Paired ratios use the geometric mean of six process-pair ratios, so a ratio need not equal the quotient of the displayed marginal medians.

Raw recordings: [Node](node-02.json), [Bun](bun-01.json). Both contain all 13 cases, six pairs per case, the extra A/A pairs, calibration and warm-up batches, content-check counts, source identities and timings.

## Supplementary Chromium diagnostic

Chromium **153.0.8010.0**, on the same Linux x64 host, also tested the frozen production code. This is a separate diagnostic: four alternating AB/BA pairs (eight fresh browser processes), with all six workloads grouped in each process. Each workload has six warm-up batches and nine measured batches. Repeats are fixed at `min(256, floor(1048576 / size))`, not calibrated to a duration. Full returned arrays are checked after timing.

The grouped workload history, fixed repeats, smaller sizes and short batches differ from the primary Node/Bun study. These ratios are not merged with its confidence intervals, and this browser run has no confidence or universal no-regression gate.

| Workload | Baseline µs | Candidate µs | Median paired speedup | Pair range | Minimum batch ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| number array, 1,024 | 12.9199 | 2.86133 | 4.478× | 3.278–5.376× | 0.560 |
| number array, 65,536 | 1626.56 | 268.281 | 6.365× | 4.942–6.499× | 1.895 |
| boolean array, 1,024 | 9.84375 | 5.80078 | 1.632× | 1.404–2.175× | 1.205 |
| boolean array, 65,536 | 574.531 | 345.469 | 1.594× | 1.471–2.989× | 4.090 |
| string array, 1,024 | 15.3223 | 17.0117 | 0.901× | 0.631–1.542× | 3.360 |
| object array, 1,024 | 20.752 | 15.5176 | 1.343× | 0.677–1.551× | 3.515 |

Every measured numeric and boolean pair was faster. The string control had an adverse median (**0.901× paired speedup**) and varied from 0.631× to 1.542× across pairs. Its direction is uncertain on this recording; the results do not establish that string materialization is free from regressions. The JSON control also had mixed pair directions. No samples or pairs were excluded.

A separate, disposable Chromium process passed all **24 correctness groups** and a real browser worker resuming its original snapshot after the writer grew memory. Constructor/prototype tracing did not run in any timing browser.

The [exact browser driver](browser.mjs) and [complete raw record](chromium-01.json) include source/build digests, every process and batch, and correctness results. Reproduce after both repositories are built and Playwright is available in the candidate:

```sh
BROWSER_BASE_ROOT=/path/to/baseline \
BROWSER_CANDIDATE_ROOT=/path/to/candidate \
BROWSER_CASE_KIND=list \
BROWSER_ROUNDS=4 \
BROWSER_OUTPUT=/tmp/list-chromium.json \
CHROMIUM_EXECUTABLE=/path/to/chromium \
node proofs/list-to-array-20261105/browser.mjs
```

Omit `CHROMIUM_EXECUTABLE` to use Playwright's installed Chromium. The driver supplies cross-origin isolation headers on loopback and uses the same URL for both variants.

## Source identity

Baseline: public commit `501b73819ed7e9bbf7adbb74b03df01045701973`.
Candidate: local tested code commit `8f91db6813af688510c45cf9efe59db39ee4a282`.
The candidate `shared-list.ts` SHA-256 is
`3f2cbcaadd70aa8d815a43a0d7d1acb845c9564246ef6d135b66a96071264811`.

The local commit ID is build provenance, not a promise that GitHub contains that
same commit object. Publication through GitHub's Git Data API can assign a new
commit ID. The source digest and the complete bundle digests in the raw records
identify the exact tested code independently of publication metadata. Only
`shared-list.ts` changes production behavior; proof and test files do not enter
the public bundle.

After the timing runs, the new regression-test fixtures were given private
arenas. The first full-suite attempt was stopped because its published-byte
comparison included unrelated storage from Vitest's shared default arena.
Production source and portable-bundle hashes did not change. Chromium's inventory
therefore contains the earlier test-file hash; that exact fixture is retained as
[an archived test source](exploration/default-arena-fixture.ts.txt).

## Method

`benchmark.mjs` accepts separate baseline and candidate repository directories
whose public portable bundles have already been built. Both variants must have
identical package metadata and core WebAssembly bytes. The script records the
commit, source and bundle SHA-256 digests, runtime version, architecture, CPU,
UTC timestamps, all calibration samples, warm-up work and measured batches.

Every subject runs in a fresh process importing one variant at the same neutral
file path. A disposable pilot for each variant chooses common batch sizes and
common warm-up call counts before measured runs. The warm-up count targets at
least 180 ms at the faster pilot's speed. Each process records 11 timed batches.
Six process pairs alternate baseline/candidate and candidate/baseline order.
Automatic garbage collection stays inside the timed work; there is no explicit
collection or sample removal. A separate baseline/baseline comparison exercises
the 65,537-number array case with the same schedule and workload.

All arrays returned by a timed batch stay reachable until the timer stops.
Every array is then checked at every index, including value, order and own-index
presence. JSON checks cover both record fields, nested-array contents and
freezing; nested collection checks read every expected map value. The unchanged
`forEach` control consumes an order-sensitive checksum. Fixture construction,
validation, imports and explicit copies of the build are outside the timer.
Retained arrays are capped at approximately 64 MiB of element storage per batch,
plus headers. This is a batched array-consumer workload, not a memory benchmark.

The matrix contains numbers at 0, 16, 1,057 and 65,537 entries; booleans at 16,
1,057 and 65,537; strings and JSON records at 1,057 and 4,097; 65 nested maps; and
an unchanged numeric `forEach` control. Larger string/JSON fixtures exceed the
2,048-entry decoded-value cache. Each fixture uses a private arena.

Reported latency ratios are candidate/baseline. Confidence intervals use a
two-sided 95% Student-t interval on six paired log ratios, with each process
represented by its median batch time per array. They are individual,
exploratory intervals, not a simultaneous guarantee over all workloads.
Within-process batches are not treated as independent experiments. No timing
threshold is a CI pass/fail assertion. Machine sharing, engine tiering and
allocation behavior can still change results.

## Reproduce

Build the baseline at `501b73819ed7e9bbf7adbb74b03df01045701973` and this branch
with the same installed dependencies and build flags, then run:

```sh
node proofs/list-to-array-20261105/benchmark.mjs /path/to/baseline /path/to/candidate /tmp/list-node.json
bun proofs/list-to-array-20261105/benchmark.mjs /path/to/baseline /path/to/candidate /tmp/list-bun.json
```

The runner refuses to overwrite a completed recording. A failed or interrupted
run leaves a `.partial` checkpoint. Use a new output path for every attempt.
Avoid concurrent builds, tests and other benchmarks while recording.

## Correctness

The existing primitive-sequence tests check special binary64 values, leaf and
tree boundaries, explicit little-endian reads, lack of extra view construction,
retained snapshots, read-only shared/copy attachments and actual memory growth.
The existing Node worker proof resumes an original snapshot after a writer has
grown its arena and validates array materialization as well as other scans.

`shared-list-to-array.test.ts` adds a nested reconstruction case that grows the
same arena and creates a fork partway through decoding. The original array and
all previously published bytes must remain unchanged. A second case verifies
fresh, mutable output arrays, including the empty-list path, and retained
primitive snapshots after a returned array is edited.

## Validation completed

- The complete Vitest suite passed: **1,057 tests in 51 files**, including the two
  new array-materialization regressions. The final run took 37.46 seconds after
  the test-only private-arena repair.
- Declaration generation and source, Redux, typed-value (both optional-property
  settings), geometry and worker type checks passed. Emitted declarations are
  byte-for-byte identical to the baseline. The initial type-check attempt had
  missing generated declarations; emitting them before the consumer checks
  resolved that build-order issue.
- The built public bundle passed all **24 correctness groups** on Node and Bun.
  The real Node worker preserved its original snapshot after writer growth.
  Bun uses same-realm attachment checks; a real Bun worker is not claimed.
  Records: [Node checks](node-checks.json), [Bun checks](bun-checks.json).
- The supplementary Chromium run passed the same 24 groups plus a real browser
  worker check, in a separate process from timing.
- Documentation links and strict preservation of the 72 recorded benchmark rows
  and all historical evidence files passed. Every primary reported ratio and
  interval was independently recomputed from the retained process data.

The test-suite result and correctness checks do not turn diagnostic browser
measurements or uncertain controls into a performance guarantee.

## Development attempts retained

The `exploration` directory keeps the initial Node/Bun pilot data and source
patches. The first candidate also specialized `forEach`; its string/object
callback regressions caused that part to be removed. Those pilot timings are
not final-source evidence and have no confidence claims.

An intermediate implementation used `return []` for empty lists. The first
formal Node recording showed a repeated empty-list regression, so that run was
stopped and its completed pairs retained in `exploration/node-rejected-empty.json`.
The final implementation preserves the original `new Array(size)` allocation.
The rejected source and exact benchmark script are retained beside the raw
record; their measurements are not substituted for final-source results.
