# Batched immutable List point edits

This proof measures the opt-in `SharedList.setMany(entries)` API against a loop of existing `SharedList.set(index, value)` calls. It does not claim to make existing scalar calls faster. Both versions retain the original List and return the same final values; the batch API does not publish intermediate snapshots.

## Why add a batch operation?

Repeated scalar edits copy the root-to-leaf path for each edit, including shared paths copied by the previous edit. The new operation groups final edits by index and copies each affected branch and leaf once. It copies a changed tail at its actual length. Unaffected nodes remain shared with the original snapshot.

The JavaScript preparation also removes overwritten edits. Only the final value for each valid index is encoded, in the order those indexes first appeared in the input. User serialization finishes before staging records in writer scratch. A native `Uint32Array` sort then places the encoded edits in tree order. See the [implementation](../../shared-list.ts), [WASM kernels](../../persistent-core.as.ts), and [API contract](../../docs/api.md).

This final-value contract matters for JSON serialization and invalid values. `setMany([[0, badValue], [0, goodValue]])` encodes only `goodValue`; a scalar loop would try to encode both. Use scalar calls when intermediate versions or intermediate serialization effects are required. Empty and entirely invalid batches return the original List. Valid edits require a writable owner.

## Evidence status

The first pilot is retained in [results/pilot.json](results/pilot.json). It showed a useful clustered/repeated-index signal and an adverse sparse Bun result, so that preparation was revised before formal measurement. The second pilot is retained in [results/pilot-v2.json](results/pilot-v2.json). The current preparation removes tuple allocation and comparator sorting. Formal paired measurements, same-build controls, and the supplementary comparison are pending a hosted CI run; no final speed claim is made yet. Exact allocation records are complete below.

The first pilot's exact workload and List source remain available as [workloads-pilot-v1.mjs](workloads-pilot-v1.mjs) and [shared-list-pilot-v1.ts.txt](shared-list-pilot-v1.ts.txt). The [V2 pilot workload](workloads-pilot-v2.mjs) is archived too. Source snapshots and SHA-256 hashes are also inside the primary records. No pilot observation was removed. The repetition counts for clustered numeric/boolean edits and repeated-index edits increased after V1 because their measured batches were too short. Before formal measurement, string, tree/tail, and four-edit cases received higher repetition counts to reduce the risk of short measured batches. These changes affect timing repetitions, not fixture values, logical batch sizes, or allocation totals. The allocation records retain their original V2-workload hash.

### Results to report

Final results belong here with all ten cases, both runtimes, complete-operation times, paired after/before ratios, confidence intervals, and same-build controls. Small or scattered batches can trade preparation work for fewer copied paths. A favorable clustered result does not establish a benefit for every batch shape.

### Pilot history and rejected preparation

These two-pair pilots selected the implementation; they are not the final evidence. Values are paired after/before ratios, so values above 1 mean the new batch API was slower. The unchanged scalar control is retained because it exposes process/runtime variation.

| Pilot case | V1 Node | V1 Bun | V2 Node | V2 Bun |
| --- | ---: | ---: | ---: | ---: |
| 256 clustered edits | 0.490 | 0.477 | 0.234 | 0.273 |
| 256 scattered edits | 0.914 | 1.524 | 0.728 | 1.342 |
| 256 submitted edits at 16 indexes | 0.065 | 0.057 | 0.077 | 0.057 |
| Unchanged scalar control | 0.807 | 0.942 | 0.883 | 0.960 |

V1's array-of-tuples preparation with a JavaScript comparator was rejected for formal measurement. V2 uses native integer sorting and replaces values in its private Map with encoded numbers. This improved the clustered pilot but did not eliminate the scattered Bun tradeoff: that case was still about 34% slower in V2. The formal report must keep that workload and the four-edit workload visible. Their allocation reduction does not guarantee lower latency.

## Primary measurement

The pinned baseline is [`a4265a0608ec25eec5719496225212db6b251989`](https://github.com/natanelia/zerocopy/commit/a4265a0608ec25eec5719496225212db6b251989). The runtime changes are limited to `shared-list.ts` and `persistent-core.as.ts`. The kernel exports are additive; the worker format and stored List layout stay unchanged. The old-reader worker check exercises compatibility with baseline code.

The [workload module](workloads.mjs) defines fixtures and the entire timed public operation. Numeric inputs are `i + 0.25`; replacements are negative fractional values. Boolean and Unicode-string cases use distinct replacements. Deterministic clustered, scattered, repeated-index, and tree/tail workloads use the same input values, edit order, and expected result in both variants.

| Case | Source size | Submitted edits | Purpose |
| --- | ---: | ---: | --- |
| Numeric clustered | 32,768 | 256 | Nearby indexes share branches and leaves |
| Numeric scattered | 32,768 | 256 | Edits spread through the tree |
| Numeric scattered | 65,536 | 1,024 | Larger batch and tree |
| Numeric repeated | 32,768 | 256, at 16 indexes | Last-value deduplication |
| Boolean clustered | 32,768 | 256 | Boolean encoding |
| String clustered | 4,096 | 128 | Unicode value encoding |
| Numeric tree and tail | 1,057 | 64 | Depth boundary and short tail |
| Numeric small batch | 32,768 | 4 | Preparation cost for sparse small batches |
| Scalar `set` control | 32,768 | 256 | Existing scalar method in both builds |
| `get` control | 32,768 | 4,096 reads | Consumed reads in both builds |

Every timed result remains reachable in a preallocated output array until verification finishes. Each timing batch starts with a newly built source arena outside the timer. The timer includes preparation inside the public operation, all serialization, every WASM call and allocation, constructing the returned List, and retaining the result. It excludes imports, fixture creation, source construction/reset, the output-array allocation, and correctness checks. Scalar intermediate List handles are not retained, matching the final-snapshot contract of the new API.

The [paired driver](paired-benchmark.mjs) uses one CPU, a shared advisory lock, separate fresh processes per build/case/runtime, and the same neutral import path for both builds. AB/BA order alternates by pair; runtime and case order reverse too. Formal runs use six independent process pairs, at least 500 ms of timed warmup and eight warmup batches per process, and nine measured batches. Pilot runs use two pairs and 150 ms; same-build controls use four pairs and 500 ms.

Each process reports its median measured duration divided by its repetition count. A table time is milliseconds per complete logical batch, or microseconds after multiplying by 1,000. A scalar-edit-equivalent time divides a complete batch by the submitted edit count; it is not single-call latency. The paired estimate is the geometric mean of after/before ratios. Its 95% interval uses a Student-t interval on the six paired log ratios and is not adjusted for multiple workloads. The same-build study measures the local noise context. All samples, short-batch counts, process versions, schedule, source/build hashes, and snapshots remain in the JSON records.

Correctness checks cover every final edited value through the public getter, every unchanged slot in copied leaves, untouched branch pointers, the complete source-byte hash, size, type, depth, and snapshot descriptor. This checks the final values and the retained original after every measured and warmup batch. It does not include validation time in the measurement.

## Supplementary comparisons

[reference-comparison.mjs](reference-comparison.mjs) compares four implementations on the same numeric fixtures: baseline scalar `set` calls, candidate `setMany`, Immutable.js `List.withMutations`, and a native `Array.slice()` followed by private assignments. The native arm copies once per complete batch. Every implementation retains the source and final snapshots; none retains intermediate scalar versions.

The comparison uses three fresh-process rounds, both runtimes, at least 250 ms and eight warmup batches, and nine measured batches. Repetitions are the same for every implementation and cap retained native numeric payload at about 32 MiB. Every final array and the original source are checked outside timing. These measurements provide library context; the primary paired study carries the optimization claim. Native arrays do not provide Zerocopy's worker transport.

## Writer allocation

[allocation.mjs](allocation.mjs) measures the exact increase in the append-only WASM writer frontier for one complete numeric batch. Its independent model counts every scalar path copy, each unique batch branch/leaf, the exact short-tail copy, and staging records above the 4,096-distinct-edit scratch limit. Both source bytes and complete results are checked.

This is a writer-allocation diagnostic. It excludes JavaScript objects, garbage collection, total backing-buffer capacity, and process RSS. It is not a total-memory or cross-library memory comparison. More than 4,096 distinct edits allocate `12 × distinct edits` staging bytes, rounded by the allocator, in the append-only arena; those bytes are included in the report.

The [before record](results/allocation-before.json) and [after record](results/allocation-after.json) were collected under Node v24.22.1 and agree exactly with the independent model for every case. These are deterministic allocated-byte counts, not timing samples.

| Numeric workload | Source size | Submitted / distinct edits | Scalar bytes | Batch bytes | Fewer bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clustered | 32,768 | 256 / 256 | 131,072 | 2,688 | 97.95% |
| Scattered | 32,768 | 256 / 256 | 131,072 | 62,848 | 52.05% |
| Scattered | 65,536 | 1,024 / 1,024 | 654,976 | 216,448 | 66.95% |
| Repeated indexes | 32,768 | 256 / 16 | 131,072 | 512 | 99.61% |
| Tree and tail | 1,057 | 64 / 64 | 32,264 | 7,816 | 75.77% |
| Small scattered batch | 32,768 | 4 / 4 | 2,048 | 1,664 | 18.75% |
| Short tail only | 17 | 17 / 17 | 2,312 | 136 | 94.12% |
| Scratch boundary | 8,193 | 4,096 / 4,096 | 2,097,152 | 33,792 | 98.39% |
| Above scratch boundary | 8,193 | 4,097 / 4,097 | 2,097,664 | 82,960 | 96.05% |

The final row includes 49,168 bytes of staging in its 82,960-byte total. The fixtures intentionally retain original and final snapshots; the allocation count also includes unreachable intermediate scalar paths because the writer arena is append-only.

## Correctness and compatibility

The [regression suite](../../list-set-many.test.ts) covers empty/invalid input, duplicate and signed-zero indexes, final-value serialization order, numeric special values, booleans, strings, JSON, nested Lists, tail lengths, depth boundaries, forks, read-only attachments, compaction, reentrant serialization and growth, the scratch boundary, and partial allocation failure. Old published bytes and recoverable writes are checked after failures.

The [dedicated workflow](../../.github/workflows/list-set-many.yml) builds WASM, portable modules, and declarations; runs focused tests under Node and Bun; checks the installed package and types; verifies the import/export surface; and exercises real workers with shared and copied transport. A candidate writer is checked with both candidate and baseline readers. The richer Chromium proof exercises the actual new API, paused iterators, old snapshots, concurrent reads, memory growth, multiple value types, forks, compaction, and read-only attachment. Local browser launch restrictions are not a passing browser result; the workflow must supply that result when local execution is unavailable.

Recorded local checks include the [complete Bun suite](validation/full-bun.txt), with 1,216 tests in 62 files; [112 focused Bun tests](validation/focused-bun-v2.txt); [46 focused Node tests](validation/focused-node-v2.txt); and actual worker checks with the [current reader](validation/worker-current.json) and [baseline reader](validation/worker-old-reader.json). The [WASM surface check](validation/abi.json) preserves all 55 existing export names/kinds and the memory import, adds only `vecSetMany` and `tailSetMany`, and verifies identical bytes for every legacy core alias. The packed package passes the new API under Node and Bun, including typed declarations, original snapshots, compaction, and both attachment modes.

The dedicated proof workflow runs when this study, its regression test, or its workflow changes, and on manual dispatch. A temporary push trigger on `perf/list-batched-edits-20261108` permits the initial evidence run before a pull request is opened; it can be removed when the reviewed records are committed. The project's main CI continues to run API regression tests for general runtime changes. This keeps a historical measurement from freezing unrelated future implementations.

When `results/formal.json` is absent, the proof workflow first runs the correctness checks and real Chromium worker proof, then collects formal, same-build, and supplementary comparison evidence sequentially on the fresh hosted runner. It pins each study to the first allowed CPU reported by `/proc/self/status`; each driver also holds the common advisory lock. The primary formal study uses six process pairs, the same-build study four pairs, and the library comparison three process rounds. The workflow uploads raw records, existing local validation/provenance, and CI logs even if a step fails. A held local benchmark lock prompted this hosted bootstrap; it is not a reason to run overlapping local studies.

The resulting records must be downloaded, reviewed, and committed before final performance claims are added. Once `results/formal.json` is committed, subsequent proof-workflow runs skip collection and audit the saved primary records. The audit requires complete formal and same-build records, recomputes all paired statistics and output counts, and checks the latest formal record against the exact current source and build. Worker compatibility and allocation checks remain separate from timing.

## Reproduction

Build two worktrees with the same dependencies: the pinned baseline and this change. Run `bun run build:wasm`, `bun run build:browser`, and `bun run build:types` in each. Use an available isolated CPU for `BENCHMARK_CPU` and a new output path for every recording. The driver owns the shared lock; do not wrap it in another lock on the same path.

```sh
proof=proofs/list-set-many-20261108
taskset -c "$BENCHMARK_CPU" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$BASELINE_CHECKOUT" . "$(command -v bun)" \
  "$proof/results/formal.json" formal
taskset -c "$BENCHMARK_CPU" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$BASELINE_CHECKOUT" . "$(command -v bun)" \
  "$proof/results/aa.json" aa
node "$proof/verify.mjs" "$proof/results/formal.json" .
node "$proof/verify.mjs" "$proof/results/aa.json"
taskset -c "$BENCHMARK_CPU" node "$proof/reference-comparison.mjs" \
  "$BASELINE_CHECKOUT" . "$(command -v bun)" "$proof/results/reference.json"
node "$proof/allocation.mjs" "$BASELINE_CHECKOUT" "$proof/results/allocation-before.json"
node "$proof/allocation.mjs" . "$proof/results/allocation-after.json"
node "$proof/abi.mjs" "$BASELINE_CHECKOUT" .
node "$proof/worker.mjs" list .
node "$proof/worker.mjs" list . "$BASELINE_CHECKOUT"
node "$proof/package.mjs" .
node "$proof/browser.mjs" . "$proof/validation/chromium.json"
```
