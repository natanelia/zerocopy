# Long-search loop specialization

The compiler now chooses separate case-sensitive and case-insensitive predicates for needles longer than 32 UTF-8 bytes. This removes the case-mode branch from the byte-by-byte KMP loop. The existing length rejection, bounded native first-byte skip, prefix table, Unicode fallback, and snapshot ownership stay in place. The change adds no search cache, payload copy, or shared-memory allocation. The existing first-byte skip can still create a small zero-copy `Uint8Array` view.

## Result and limits

The fixed warmed comparison against main `09b1a385a7c2ac9b027a4055335ae2f9449abe6e` found repeatable gains on both target workloads:

- **Immediate hits:** paired speedups of **1.43× on Node** and **1.14× on Bun**. The displayed median times were 0.40243 → 0.32242 ms and 0.27361 → 0.24124 ms, respectively.
- **Overlapping prefixes:** **1.44× on Node** and **1.06× on Bun**. Median times were 11.88630 → 8.55070 ms and 6.00652 → 5.55646 ms.

These times include compilation and a complete 2,048-row scan. Both targets' after/before intervals are below 1 in both runtimes. Several longer-scan controls also improved. All five original native-skip controls have intervals crossing parity in both runtimes: this study establishes no regression there, but does not prove neutrality. Their Node paired point estimates are approximately 1–3% slower. The unchanged short-query control also has an interval crossing parity in both runtimes.

The earlier pilot recorded Bun slowdowns of approximately 4–20% on several preservation cases and 15% on insensitive ASCII. Those results are retained in full. Its unchanged short-query control varied from an after/before ratio of 1.288 to 0.789 between pairs. The source was kept unchanged for the predefined six-pair study with at least 500 ms of warm-up per case; the pilot slowdowns were not established by that study. No alternative source was selected by chasing the pilot's individual rows.

The evidence covers Node and Bun on one Linux x64 host. It does not establish browser, ARM, cold-start, or every-query performance, and the warm-up threshold is not proof of universal steady state.

## Complete primary comparison

Times are milliseconds per compilation plus 2,048-row scan. Before/after columns are medians of the six process medians. Speedup is the reciprocal of the geometric mean of six paired after/before ratios, so it need not equal the quotient of the displayed median times. Intervals are deterministic 95% percentile bootstrap intervals over whole process pairs; values below 1 favor the candidate. All fourteen fixed cases are shown for each runtime.

### Node.js 24.22.1

| Case | Role | Before ms | After ms | Paired speedup | After/before 95% interval |
|---|---|---:|---:|---:|---:|
| Missing first byte | preservation | 0.76283 | 0.75932 | 0.97× | 0.961–1.132 |
| Late-start hit | preservation | 0.85464 | 0.88178 | 0.98× | 0.944–1.123 |
| First byte near end | preservation | 0.76218 | 0.80182 | 0.99× | 0.921–1.070 |
| Multibyte needle | preservation | 0.84130 | 0.84632 | 0.97× | 0.918–1.167 |
| Needle longer than row | preservation | 0.02548 | 0.02535 | 0.97× | 0.933–1.141 |
| Common first byte | control | 5.21373 | 3.91940 | 1.34× | 0.720–0.775 |
| Immediate hit | target | 0.40243 | 0.32242 | 1.43× | 0.588–0.831 |
| Overlapping prefix | target | 11.88630 | 8.55070 | 1.44× | 0.622–0.772 |
| Insensitive ASCII | control | 5.69146 | 5.24852 | 1.07× | 0.887–0.989 |
| Insensitive Unicode | control | 8.69470 | 7.64308 | 1.13× | 0.835–0.923 |
| Short query | control | 0.05575 | 0.05473 | 1.03× | 0.906–1.015 |
| Immediate hit, 33 bytes | control | 0.31526 | 0.21008 | 1.49× | 0.580–0.759 |
| Common suffix, middle mismatch | control | 12.03818 | 9.46208 | 1.32× | 0.668–0.858 |
| Early false suffix candidates | control | 12.15391 | 9.45587 | 1.32× | 0.648–0.856 |

### Bun 1.4.2

| Case | Role | Before ms | After ms | Paired speedup | After/before 95% interval |
|---|---|---:|---:|---:|---:|
| Missing first byte | preservation | 0.23490 | 0.23061 | 1.01× | 0.877–1.111 |
| Late-start hit | preservation | 0.31029 | 0.29114 | 1.13× | 0.762–1.002 |
| First byte near end | preservation | 0.25870 | 0.25105 | 1.05× | 0.846–1.065 |
| Multibyte needle | preservation | 0.30447 | 0.28054 | 1.10× | 0.767–1.100 |
| Needle longer than row | preservation | 0.05567 | 0.05334 | 1.04× | 0.872–1.052 |
| Common first byte | control | 5.24782 | 4.08605 | 1.30× | 0.610–0.916 |
| Immediate hit | target | 0.27361 | 0.24124 | 1.14× | 0.818–0.939 |
| Overlapping prefix | target | 6.00652 | 5.55646 | 1.06× | 0.905–0.979 |
| Insensitive ASCII | control | 4.90760 | 4.43534 | 1.13× | 0.783–0.995 |
| Insensitive Unicode | control | 11.46301 | 9.77937 | 1.19× | 0.731–0.943 |
| Short query | control | 0.07180 | 0.06849 | 1.08× | 0.791–1.057 |
| Immediate hit, 33 bytes | control | 0.22023 | 0.19915 | 1.11× | 0.869–0.937 |
| Common suffix, middle mismatch | control | 5.93409 | 5.48617 | 1.07× | 0.892–0.989 |
| Early false suffix candidates | control | 8.17438 | 7.27015 | 1.15× | 0.813–0.923 |

## Method and provenance

- **Recorded:** 2026-11-04, 19:10:05–19:16:05 UTC. The folder name is the planned study label, not the measurement date.
- **Host:** Linux 6.18.57, x64, AMD EPYC 9V74; all timing processes pinned to CPU 2 and serialized through the shared performance lock. Runtime versions are recorded in every process result.
- **Processes:** six balanced AB/BA pairs per runtime, one build per fresh process: 24 processes total. Each process runs the same fourteen cases; case order alternates by pair and is identical within a pair.
- **Inputs:** the eleven datasets from the earlier long-search study, unchanged, plus the three controls declared before timing: a 33-byte immediate match, a common suffix with a middle mismatch, and early false suffix candidates. Roles and repetition counts were fixed before the pilot.
- **Warm-up:** at least eight batches and at least 500 ms per case/build. The smallest observed warm-up total was 500.024 ms. Counts and durations are retained, including the pilot's separate five-batch warm-up.
- **Measured batches:** twelve per case/process, 4,032 recorded batch durations. Both revisions use the same fixed repetitions. The shortest measured primary batch was 9.479 ms.
- **Timed work:** compile a fresh predicate and scan all 2,048 rows per repetition, accumulating an index-weighted checksum. The checksum is checked after timing.
- **Excluded work:** input construction, per-row native `includes` oracle checks before and after timing, and published-byte/allocation digests. Every process verifies exact results and unchanged published memory.
- **Uncertainty:** per-process medians followed by paired ratios and a geometric mean; 10,000 deterministic bootstrap resamples of whole pairs. Batches are not counted as independent processes. Intervals are per-case, without adjustment for multiple comparisons.
- **Integrity:** existing output paths are rejected. All runtime TypeScript, WASM, package/build inputs and every portable JavaScript bundle chunk are hashed; only `text-search.ts` may differ. Source, build, driver and fixtures are checked again at completion.

The baseline is the exact main commit above, including the earlier long-search optimization and the merged list materialization change. The candidate was **an uncommitted `text-search.ts` modification on top of that commit during timing**. Consequently `after.head` in the raw results is the base commit, not a claim that this commit contains the candidate. The frozen source SHA-256 and complete bundle hashes identify the measured candidate; subsequent local or remote packaging commits may have different IDs while retaining those same source bytes.

| Input | SHA-256 |
|---|---|
| Baseline text-search.ts | `180832bfe92b4a413510574aef20681076fb554e9d1b888b6223a6aef31a512f` |
| Measured candidate text-search.ts | `4af3b6c4a11d3f350dedaac52b2af4244356aa22bca79b90c6a52e1be020c04a` |
| Benchmark driver | `db18f79354230218574df9535276934595c75ec1bdba8d549540fb72018b625c` |
| Fixtures | `62ea7ce2e598b508a7deaf8e6245d94cd809fd6854f522948da5b94a5ebdad4c` |

The [primary raw results](results.json) contain all source and bundle hashes, environment details, per-process records, individual batches, and paired estimates. The [baseline manifest](validation/baseline-manifest.json) and [baseline validation log](validation/baseline-validation.log) preserve the independent fixed-main build and test result.

## Correctness and validation

The new private-arena tests cover mixed case modes, start/tail alignments, overlapping prefixes, valid multibyte needles, surrogate-half fallbacks, poisoned neighboring records, retained forks, shared/copied readers, and growth. Existing text proofs also exercise arbitrary UTF-16, Unicode lowercase expansion/context, invalid inputs, resets, and actual workers.

- WASM, portable JavaScript, declarations, and TypeScript checks passed.
- Targeted Vitest: eight tests passed across the existing long-search suite and three new case-mode tests.
- Existing Node text-search proofs: eight passed.
- Existing real Node worker proof: shared and copied compiled searches passed while the writer grew memory.
- Default complete Vitest suite: **54 files, 1,079 tests passed**, with the existing timeout settings, in 46.69 seconds.
- Strict documentation check: 72/72 historical benchmark rows unchanged, zero historical evidence files changed, and all 58 Markdown files passed.

Exact commands and log hashes are in the [validation manifest](validation/manifest.json). Logs are [builds, types, targeted tests and Node proofs](validation/specialized-checks.log), [the full default suite](validation/full-suite.log), and [strict documentation preservation](validation/docs-check.log).

## Retained pilot and reproduction

The [pilot raw results](experiments/specialized/pilot.json), [progress output](experiments/specialized/progress.txt), [exact driver](experiments/specialized/benchmark.mjs), [fixtures](experiments/specialized/fixtures.mjs), and [measured source](experiments/specialized/text-search.source.txt) are preserved with an [experiment manifest](experiments/manifest.json). The pilot has two balanced pairs per runtime, five warm-up batches and nine measured batches. It is preliminary evidence and is not pooled with the primary estimates. The same source was measured in both studies; no rejected source variant was run in this round.

Build the fixed baseline and candidate with the pinned repository dependencies. Use separate checkout/build directories, then choose a new output path:

```sh
flock /path/to/perf.lock taskset -c 2 node proofs/long-search-loops-20261105/benchmark.mjs \
  /path/to/baseline-09b /path/to/candidate /path/to/bun \
  /path/to/new-primary-results.json primary
```

The driver also supports `pilot` and an optional `control` mode comparing identical baseline builds. No A/A control study was run here. Neither a single-closure fallback nor a suffix-prefilter alternative was needed after the warmed comparison established useful gains.
