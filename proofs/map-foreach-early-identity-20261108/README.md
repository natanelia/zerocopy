# SharedMap `forEach`: early traversal identity

This folder records fresh correctness and performance evidence for the complete `SharedMap.forEach` optimization after fixing when its native traversal identity is captured. The direct traversal algorithm is unchanged from the preceding Map candidate. The corrected guard preserves hooks installed before the public Map entry loads.

**Measured result:** numeric traversal of 4,096 entries took **24.9% less time in Node and 26.8% less in Bun**, based on six paired processes per runtime. Every pair favored the corrected implementation. Several other traversal cases also improved, while the Bun `entries` control has an unresolved **13.0% slower paired estimate** with a 95% interval of **0.890–1.435**. These results support the targeted traversal improvement; they do not establish that every Map workload is faster or unaffected.

## The import-order bug and repair

The earlier implementation captured `Arena.prototype.leaves` when `shared-map.ts` initialized. That could happen after an application had already obtained an Arena through another collection and replaced the prototype method. The Map guard then treated the replacement as the native traversal and bypassed it.

The [public Bun regression](regression/README.md) demonstrates this with the optional `fromFloat64` entry from PR #71. A fresh Bun process imports `zerocopy/numeric`, obtains the returned list's owner through its constructor's inherited public `owner()` method, installs a prototype `leaves` hook, and then imports `zerocopy`. The baseline calls the hook once and propagates its original exception before any callback. The original PR #68 implementation skipped the hook and invoked both callbacks. The original experiment and both outcomes remain preserved in `regression/`.

The repair exports `nativeMapLeaves` from `arena.ts`, immediately after the class definition, and imports that identity in `shared-map.ts`. The Arena module records the original method before an optional collection can expose an owner. Later prototype replacements therefore select the existing custom-iterator path. The traversal loop, custom iterator cleanup, legacy-journal handling, dynamic decoding calls, callback ordering, and immutable storage rules are unchanged from the preceding Map candidate.

The fixed [integration result](regression/fixed-map.json) records one hook invocation, the same exception, zero callbacks before the error, and two ordinary callbacks after restoring the native method. Its runner creates a disposable installed-package tree and overlays only the pinned, reviewed PR #71 numeric source. It uses the actual `zerocopy/numeric` and `zerocopy` exports, needs no network or second checkout, and records all copied sources and WASM hashes. It is a correctness check, not a timing result.

## What the performance comparison covers

The baseline is `0ac8a005268335a6116f025e75f670b5cee6843e`. Fresh A/B compares that baseline with the complete corrected Map implementation. Ratios describe the full traversal change relative to that baseline.

The declared changed runtime sources are exactly **`arena.ts` and `shared-map.ts`**. All 12 WASM files are byte-identical to baseline; the core representation and worker wire format remain unchanged. [source-identity.json](validation/source-identity.json) records both source hashes, every portable bundle and WASM hash, and the integration proof identities. [pre-benchmark-identities.json](pre-benchmark-identities.json) records the source, workload, runner, plan, and worker evidence frozen before timing.

The ten case specifications, repetitions, fixtures, timed operations, and output/invariant checks are copied unchanged from the earlier V2 workload. [source-adaptation.json](source-adaptation.json) records the original module hash, unchanged `createWorkload` body and fixture hashes, and the copied generic runner. [scaffold-check.json](scaffold-check.json) confirms the exact comparisons. Only the new study metadata differs in `workloads.mjs`.

Historical V1/V2 recordings remain in [the earlier proof folder](../map-foreach-20261108/README.md). They are separate evidence for their own source versions. Their samples are not pooled with this study, and their estimates do not stand in for measurements of the corrected guard.

## Frozen workload and timing method

The [predeclared plan](PRE-BENCHMARK.md) fixes all cases and settings before recording. There is no new pilot: the traversal algorithm and workload are retained, and this study confirms the corrected source directly.

| Workload | Public operation | Repetitions per batch |
| --- | --- | ---: |
| `number-4096` | Numeric `forEach`, 4,096 entries | 64 |
| `number-65536` | Numeric `forEach`, 65,536 entries | 8 |
| `number-overlay-4096` | Numeric `forEach` after updates, deletion, and insertion | 64 |
| `number-64` | Numeric `forEach`, 64 entries | 2,048 |
| `boolean-4096` | Boolean `forEach`, 4,096 entries | 64 |
| `string-1024` | String `forEach`, 1,024 entries | 128 |
| `json-256` | JSON `forEach`, 256 entries | 256 |
| `unicode-4096` | Numeric `forEach` with Unicode keys, 4,096 entries | 64 |
| `entries-4096` | Existing `entries` scan, 4,096 entries | 64 |
| `get-4096` | Existing indexed `get` scan, 4,096 keys | 128 |

Each timed operation scans a fixed immutable map with a reusable callback that consumes every value and key length. It returns a checksum plus callback count. The runner retains and verifies every returned number. Construction, imports, oracle creation, retention-array allocation, and complete invariant checks are outside the timer. This measures warmed repeated scans, not construction or cold-start performance.

After every batch, the workload verifies the complete `forEach` key/value/order sequence, the complete `entries` sequence, the unchanged arena used-byte count, and every originally published byte. Initial membership and values are also checked against a native JavaScript Map. These full comparisons occur outside timing; they are not described as part of each timed callback.

The `entries` and `get` controls have unchanged implementation bodies, but their verification still calls the changed `forEach` outside the timer. That can affect the surrounding allocation, garbage-collection, JIT, or cache state before a later timed batch. The controls consequently describe mixed workloads. The study does not establish a particular mechanism for any difference, and no adjustment is applied for this coupling. Every adverse or inconclusive control remains visible.

Node 24.22.1 and Bun 1.4.2 ran serially on CPU 2 of the recorded Linux x64 host, an AMD EPYC 9V74, under the common benchmark lock. Each build, runtime, case, and pair uses a fresh process and the same neutral public import path. Pair order alternates AB/BA; runtime and case orders reverse on alternate pairs. Each process warms for at least 500 ms of timed work and at least eight batches, then records nine measured batches. Repetitions stay fixed. Batches below 2 ms remain included and are counted explicitly.

Confirmation completed six process pairs for each of the ten cases and both runtimes: 240 fresh subjects. A/A completed four pairs for the original four controls, `number-4096`, `string-1024`, `entries-4096`, and `get-4096`: 64 fresh subjects. The independent audit verified both complete schedules and all recorded results.

For each process, the estimate is the median of nine batch times divided by repetitions. Paired ratios are after/before; the reported ratio is their geometric mean. Unadjusted 95% Student-t intervals are calculated from paired log ratios. The process pair is the statistical unit, rather than individual callbacks, returned checksums, or within-process batches. Before/after summary medians need not divide to the reported paired ratio.

A/A repeats the identical baseline against itself to describe repeatability. It is never subtracted from A/B, used to normalize estimates, or used to cancel an unfavorable result. A wide interval indicates uncertainty, not proof of no regression. Measurements are specific to the recorded host and runtime versions; this study provides neither browser performance nor peak-memory results.

## Fresh results

The complete records are [confirmation.json.gz](results/confirmation.json.gz) and [aa.json.gz](results/aa.json.gz), with lossless archive hashes in [manifest.json](results/manifest.json). The independent [confirmation audit](review-confirmation-audit.json) and [A/A audit](review-aa-audit.json) recompute every displayed estimate and retain all individual pair ratios. No historical V1/V2 samples enter these tables.

Before and after values below are milliseconds per complete scan, summarized as the median of the process estimates. The paired ratio is the geometric mean of after/before ratios; below 1 means less elapsed time. Values are rounded for display, with full precision retained in the records. “Lower time” means that the unadjusted interval lies below 1 on this host; the intervals are not corrected for the number of cases. “Uncertain” means the interval includes both improvement and slowdown.

### Confirmation: Node 24.22.1

| Case | Before ms | After ms | Paired ratio | 95% interval | Faster pairs | Interpretation |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| `number-4096` | 0.863491 | 0.642612 | 0.751 | 0.641–0.881 | 6/6 | Lower time |
| `number-65536` | 22.904958 | 18.699336 | 0.815 | 0.782–0.850 | 6/6 | Lower time |
| `number-overlay-4096` | 0.952224 | 0.700215 | 0.793 | 0.599–1.049 | 4/6 | Uncertain |
| `number-64` | 0.008646 | 0.005711 | 0.619 | 0.467–0.822 | 6/6 | Lower time |
| `boolean-4096` | 0.848148 | 0.613983 | 0.758 | 0.629–0.913 | 5/6 | Lower time |
| `string-1024` | 0.159738 | 0.109305 | 0.661 | 0.510–0.855 | 6/6 | Lower time |
| `json-256` | 0.041438 | 0.020863 | 0.510 | 0.376–0.691 | 6/6 | Lower time |
| `unicode-4096` | 1.109921 | 0.849642 | 0.764 | 0.723–0.806 | 6/6 | Lower time |
| `entries-4096` | 1.014849 | 1.011354 | 1.010 | 0.944–1.080 | 3/6 | Uncertain |
| `get-4096` | 0.165786 | 0.158471 | 0.870 | 0.604–1.253 | 4/6 | Uncertain |

### Confirmation: Bun 1.4.2

| Case | Before ms | After ms | Paired ratio | 95% interval | Faster pairs | Interpretation |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| `number-4096` | 0.383511 | 0.287555 | 0.732 | 0.664–0.807 | 6/6 | Lower time |
| `number-65536` | 11.716531 | 10.754765 | 0.929 | 0.816–1.058 | 5/6 | Uncertain |
| `number-overlay-4096` | 0.400617 | 0.313379 | 0.744 | 0.610–0.907 | 6/6 | Lower time |
| `number-64` | 0.002923 | 0.002282 | 0.763 | 0.554–1.051 | 4/6 | Uncertain |
| `boolean-4096` | 0.440355 | 0.303155 | 0.694 | 0.541–0.889 | 6/6 | Lower time |
| `string-1024` | 0.068176 | 0.039417 | 0.626 | 0.427–0.917 | 5/6 | Lower time |
| `json-256` | 0.022386 | 0.014443 | 0.693 | 0.627–0.766 | 6/6 | Lower time |
| `unicode-4096` | 0.588923 | 0.498482 | 0.887 | 0.791–0.995 | 5/6 | Lower time |
| `entries-4096` | 0.441613 | 0.591029 | 1.130 | 0.890–1.435 | 3/6 | Unresolved slower estimate |
| `get-4096` | 0.062566 | 0.059606 | 0.812 | 0.666–0.990 | 5/6 | Lower time in this control |

The primary numeric 4K result is consistent across all six pairs in both engines. Node also shows lower time for 65K numeric traversal, while the Bun 65K interval crosses 1. Node overlay traversal and Bun 64-entry traversal likewise have favorable point estimates without a resolved direction. Boolean, string, and JSON traversal have intervals below 1 in both runtimes. The Bun Unicode interval only narrowly excludes 1; it should be read with the unadjusted-interval and host-specific limits above.

**The unchanged-method controls do not establish absence of regressions.** Node `entries` is 1.010 with three of six pairs faster, and Node `get` is 0.870 with four of six faster; both intervals include slowdown. Bun `entries` is 1.130, with three pairs faster and three slower. Its interval permits anything from about 11.0% less time to 43.5% more time. The 13.0% slower point estimate is therefore an unresolved risk, not evidence of no regression or of a proven slight regression. The recorded Bun `get` control is faster, but its implementation did not change, and the verification coupling described above prevents attributing that result to an optimized `get` path.

### Baseline A/A repeatability

Both labels in this table load the same baseline build. “B faster” counts the pairs in which the second label had a lower process estimate; it is not evidence of an implementation improvement.

| Runtime | Case | A ms | B ms | B/A ratio | 95% interval | B faster |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | `number-4096` | 0.954194 | 0.870549 | 0.944 | 0.740–1.204 | 2/4 |
| Node | `string-1024` | 0.155183 | 0.174476 | 1.039 | 0.896–1.206 | 2/4 |
| Node | `entries-4096` | 1.138604 | 0.990263 | 0.856 | 0.645–1.135 | 3/4 |
| Node | `get-4096` | 0.133731 | 0.157236 | 1.067 | 0.805–1.415 | 2/4 |
| Bun | `number-4096` | 0.376157 | 0.473963 | 1.210 | 0.847–1.729 | 1/4 |
| Bun | `string-1024` | 0.061972 | 0.063159 | 1.027 | 0.616–1.710 | 1/4 |
| Bun | `entries-4096` | 0.655392 | 0.554478 | 0.877 | 0.670–1.148 | 4/4 |
| Bun | `get-4096` | 0.064260 | 0.078985 | 1.137 | 0.498–2.597 | 2/4 |

All eight A/A intervals include 1, and some are wide. The Bun numeric point estimate is 21.0% slower despite identical code, while its `entries` point estimate is 12.3% faster and all four pairs favor B. These observations show substantial run-to-run variability. They do not establish its cause, invalidate an unfavorable A/B observation, or justify subtracting an A/A estimate from the confirmation. In particular, the Bun `entries` risk remains unresolved.

### Audited counts

| Record | Fresh processes | Warmup batches | Measured batches | Measured operation outputs | Verified warmup + measured outputs | Measured batches below 2 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Confirmation | 240 | 6,957 | 2,160 | 623,808 | 4,100,800 | 0 |
| A/A | 64 | 1,453 | 576 | 55,296 | 219,392 | 0 |
| Total | 304 | 8,410 | 2,736 | 679,104 | 4,320,192 | 0 |

Every recorded process completed successfully, and every retained batch output and post-batch invariant passed. Output counts refer to complete scan return values, not individual map entries. The verified-output total includes warmup and measurement batches; it excludes the two extra untimed single-operation checks performed in each subject. No short measured batch was removed: none occurred. Confirmation was recorded on 2026-11-08 from 17:22:25Z to 17:27:52Z, and A/A from 17:29:32Z to 17:30:39Z, after the source and worker freeze. The confirmation audit additionally checked that the current runtime sources still match the recorded candidate.

## Correctness and compatibility

All results in this section use the corrected source identified above. The detailed gate record is [validation/README.md](validation/README.md).

| Gate | Result | Evidence |
| --- | --- | --- |
| Portable build | 12 modules built | [build-browser.txt](validation/build-browser.txt) |
| Public numeric-first Bun regression | Hook called once; original error propagated; zero callbacks before error; ordinary traversal restored afterward | [fixed-map.json](regression/fixed-map.json) |
| Focused Node traversal tests | 60 tests in four matched files passed | [focused-node.txt](validation/focused-node.txt) |
| Focused Bun traversal tests | 60 tests in four matched files passed | [focused-bun.txt](validation/focused-bun.txt) |
| Full configured Bun suite | 1,199 tests in 61 files passed in 34.33 seconds | [full-bun-verbose.txt](validation/full-bun-verbose.txt) |
| Declarations and type checks | Seven commands passed, including main, Redux, typed values in both exact-optional modes, geometry, and worker types | [type-gates.json](validation/type-gates.json) |
| Installed package | Node/Bun exports, immutable snapshots, actual Node worker sharing, and TypeScript consumer passed | [package.txt](validation/package.txt) |
| Untimed workload comparison | All ten cases passed on both builds in Node and Bun | [Node](validation/workloads-node.json), [Bun](validation/workloads-bun.json) |
| Actual shared/copied Node workers | Both transports passed against the corrected source and bundles | [node-worker-result.json](node-worker-result.json) |

The traversal suite covers dense nodes, overlays, full-hash collisions, legacy/nested journals, empty maps, UTF-8 keys, special numeric values, strings, frozen JSON, nested collections, callback exceptions, custom traversal cleanup, dynamic value decoding, reentrancy, forks, memory growth, and read-only shared/copied attachments. The separate public-entry regression specifically covers the initialization order that the prior suite did not exercise.

**One local full-run attempt was interrupted and remains preserved.** It printed only the startup header and reported no individual test results before interruption after approximately 210 seconds, exiting 130. Its [complete output](validation/full-bun-interrupted.txt) and [attempt metadata](validation/full-bun-interrupted.json) are retained. The subsequent diagnostic added verbose reporting and an outer 180-second process bound, retaining the same four-worker configuration, source, and per-test timeouts; it passed the full suite. No specific cause was established for the startup-only stall, and that interrupted attempt is not counted as a passing run.

## Worker evidence and build binding

The current Node worker proof pauses inside a `forEach` callback while the owner edits and grows memory. It then resumes the old scan, verifies reentrant reads, and attaches the newly published roots. Both shared and copied transports verify the original 1,067-entry traversal, strings, frozen JSON, nested lists, special numeric values, read-only guards, and unchanged published bytes. A separate owner-side scenario checks callback growth, nested traversal, and forks.

The worker record binds **both runtime sources**, every WASM binary, every portable JavaScript bundle, its driver, and its fixture to exact SHA-256 hashes. The driver checks those identities again after completion. The final [Node record](node-worker-result.json) therefore identifies the exact corrected build it exercised, and explicitly states `timingMeasurements: false`.

A Chromium adapter performs the same real-worker handshake with cross-origin isolation. The [CI workflow](../../.github/workflows/map-foreach.yml) runs the public Bun regression, saved-data audit, and current Node/Chromium worker proofs, and publishes the current-head proof JSON as a workflow artifact. The PR's current-head CI run and artifact provide the browser outcome; this report does not infer a browser pass from the local Node record or from historical Map evidence.

## Reproduce and audit

Build separate baseline and candidate checkouts with the same dependencies and tool versions. In each checkout, build the WASM and portable modules; the baseline source must exactly match the pinned commit. From the candidate checkout, run correctness checks independently of timing:

```sh
bun run build:wasm
bun run build:browser
bun run build:types
node proofs/map-foreach-early-identity-20261108/integration-check.mjs
node proofs/map-foreach-early-identity-20261108/check-workloads.mjs \
  /path/to/baseline /path/to/candidate
bun proofs/map-foreach-early-identity-20261108/check-workloads.mjs \
  /path/to/baseline /path/to/candidate
node proofs/map-foreach-early-identity-20261108/node-worker.mjs
node proofs/map-foreach-early-identity-20261108/browser-check.mjs
```

The integration runner accepts `BUN_BINARY` when Bun is not on `PATH`. The browser proof requires an installed Playwright Chromium, or `CHROMIUM_EXECUTABLE` pointing to a compatible local Chromium.

Collect new measurements with new output paths and an available isolated CPU. The runner takes the common lock itself and refuses to overwrite records:

```sh
taskset -c 2 node proofs/map-foreach-early-identity-20261108/paired-benchmark.mjs \
  proofs/map-foreach-early-identity-20261108/workloads.mjs \
  /path/to/baseline /path/to/candidate /path/to/bun \
  proofs/map-foreach-early-identity-20261108/confirmation-local.json formal

taskset -c 2 node proofs/map-foreach-early-identity-20261108/paired-benchmark.mjs \
  proofs/map-foreach-early-identity-20261108/workloads.mjs \
  /path/to/baseline /path/to/candidate /path/to/bun \
  proofs/map-foreach-early-identity-20261108/aa-local.json aa
```

Keep builds, tests, and competing benchmark work out of the recording window. Keep new records inside this checkout so the auditor can locate its Git history. New runs remain separate evidence rather than replacing or being averaged into the archived studies.

Verify the records' lossless compression, source snapshots against Git, complete schedules, runtime/fixture identities, worker binding, medians, paired ratios, intervals, and counts without retiming:

```sh
node proofs/map-foreach-early-identity-20261108/verify.mjs
CHECK_CONFIRMED_SOURCE=1 node proofs/map-foreach-early-identity-20261108/verify.mjs
```

The optional environment flag also requires both current source files to match the recorded confirmation. The auditor accepts raw JSON or gzip records directly. Historical recordings have their own verifier and remain usable as historical evidence after the corrected source is published.
