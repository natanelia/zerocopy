# Ordered-map projection plan

Recorded before measurements: 2026-11-05T00:30:40.446407+00:00.

## Candidate

Fixed baseline: `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`. The candidate changes only production `shared-ordered-map.ts`. Direct `keys()` and `values()` loops avoid entry tuples, the intermediate `entries()` generator, and decoding the unrequested side. A module-private helper resolves the current leaf for an insertion-log entry by full key bytes and matching insertion ordinal. The existing stable-order shortcut is preserved. `entries()`, `forEach()`, lookup and writer paths stay unchanged. Captured views cover only already-published nodes; shared memory growth cannot detach those views.

No format, dependency, or public method signature changes are planned. New regression tests use private Arenas and cover cold decoding counters, stale insertion logs, replacements, deletions, reinsertion, Unicode normalization, exact hash collisions, old forks, suspended iterators, writer growth, read-only attachments, nested reconstruction reentry, and generator laziness/early completion. A real worker proof covers shared and copied snapshots.

## Fixed performance cases

All performance cases measure repeated complete public operations with retained, verified output arrays. The study does not estimate isolated first-read latency. Warm-up can leave uncached values in maps exceeding the bounded decoder cache; in particular the 4,096-object keys case continues decoding the uncached tail in the baseline. Cold JSON and nested decoding are covered separately by correctness counters with legitimate values.

| Case | Size | Operation and shape | Role |
|---|---:|---|---|
| keys-object-large | 4096 | Complete keys array, stable insertion order, object values beyond cache capacity | Target |
| keys-object-churn | 1024 | Complete keys array, replacements and four delete/reinsert rounds, stale log entries | Fallback target |
| keys-number-small | 32 | Complete keys array, numeric values | Small target |
| values-number-large | 4096 | Complete values array, long mixed Unicode/ASCII keys | Target |
| values-string-churn | 1024 | Complete values array, replacements and stale log entries | Fallback target |
| values-boolean-small | 32 | Complete values array, boolean payloads | Small target |
| ordered-set-churn | 1024 | Complete set values array, distinct number/string identities and stale log entries | Consumer target |
| entries-number-control | 4096 | Complete entry array, unchanged method | Control |
| lookup-number-control | 4096 | Full array of warmed get results, including misses | Control |
| empty-projections | 0 | Complete keys and values arrays from an empty ordered map | Empty edge case |

## Measurement design

Node 24.22.1 and Bun 1.4.2 use the complete portable builds. Every measured process imports exactly one build and runs one case. Independent process pairs alternate baseline/candidate order; case order rotates between pairs. Full operation results are retained in a blackbox and every output element is checked against a native Map/Set oracle outside timing. Fixture construction and verification never call another projection to prepare the oracle. Published arena bytes and exact outputs must remain unchanged.

All builds, tests and benchmarks use the shared `perf.lock`. Timings are pinned to CPU 2. A screening run uses two independent process pairs per runtime/case. If the full screen supports the candidate, freeze the production source and use six balanced fresh process pairs per runtime/case for confirmation, plus four baseline A/A pairs for the unchanged entries control and the empty edge case. No timing samples or adverse cases will be removed. Rejected variants, if any, get their own exact source and raw records.

Common repeat counts will be calibrated prospectively from both builds, targeting 20 ms batches with bounded output storage. Screening uses at least 150 ms timed warm-up and seven measured batches per process. Confirmation uses at least 500 ms of actual timed warm-up and 11 measured batches per process. Both require at least eight warm-up batches and 32,768 projected elements (or empty-call bookkeeping units). The 512-warm-up-batch cap is a failure condition, not permission to finish early. Empty projections use the same elapsed warm-up floor; their batch is capped at 65,536 complete calls. All cases also cap materialized element slots at 1,048,576 and estimated retained outputs at 32 MiB; this estimate is not a measurement of heap or RSS. Any storage or calibration caps remain visible in the raw data. Calibration data are retained. The confirmation plan may reuse the screening repeat counts while checking identical production and driver hashes.

Per-process medians are the independent observations. Pairwise candidate/baseline latency ratios are combined in log space; formal intervals use six process pairs (Student t, df 5), not the batches as replicates. A/A is reported separately and never used to adjust A/B. Small differences or unresolved controls will be disclosed, and any gain claim will name its operation, runtime, size and warm-up/cache scope.

Sources, support/build files, complete imported bundles, WASM, driver/workload code, commit identities, runtime versions and host metadata are recorded before and checked after each study. Results use new paths; raw observations may be losslessly gzipped with original byte counts and hashes.

## V2 amendment, before its measurements

The complete V1 screen is retained in `results/pilot-v1.json` with its exact source, driver and original plan in `rejected-v1/`. It improved the seven nonempty projection cases in both runtimes, but Node empty projections slowed in both pairs (candidate/baseline 1.180 and 1.195). V1 acquired the arena view even with an empty insertion log, whereas the prior implementation never read that view for an empty map. V2 adds only an early empty-log return to each projection and a regression test that neither fresh nor deleted-to-empty maps acquire a view. The ten workloads, calibration, warm-up, full-output checks, process pairing and controls remain identical. Run a complete V2 screen and, if worthwhile, the planned independent confirmation; no further variants are planned.

V1 also recorded adverse Bun unchanged controls (entries 1.282 geometric ratio; lookup 1.083). These are not explained by the empty guard and must remain visible in the report. The final study includes all unchanged controls and the predeclared A/A comparisons; neither the matrix nor timing method is adjusted to hide those observations.
