# Batched immutable List point edits

This proof measures the opt-in `SharedList.setMany(entries)` API against a loop of existing `SharedList.set(index, value)` calls. It does not claim to make existing scalar calls faster. Both versions retain the original List and return the same final values; the batch API does not publish intermediate snapshots.

For 256 clustered numeric edits in a 32,768-item List, the complete-batch median fell from **106.619 to 21.928 µs in Node** and **112.466 to 25.288 µs in Bun**. The paired after/before ratios were 0.207 (95% interval 0.201–0.214) and 0.238 (0.193–0.294). Repeated-index batches improved from 98.881 to 6.055 µs in Node and 110.734 to 6.109 µs in Bun. Both workloads were faster in all six process pairs on both runtimes. The complete [formal record](results/formal.json.gz) and tables below retain every workload.

**Bun tradeoffs remain:** 256 scattered edits took 9.7% more time by the paired estimate (ratio 1.097, interval 1.019–1.182), and four scattered edits took 94.0% more time (1.940, interval 1.785–2.109). The four-edit medians were 1.890 µs for the scalar loop and 3.736 µs for `setMany`. Use the new API for suitable batch patterns; this study does not support replacing every scalar loop.

## Why add a batch operation?

Repeated scalar edits copy the root-to-leaf path for each edit, including shared paths copied by the previous edit. The new operation groups final edits by index and copies each affected branch and leaf once. It copies a changed tail at its actual length. Unaffected nodes remain shared with the original snapshot.

The JavaScript preparation also removes overwritten edits. Only the final value for each valid index is encoded, in the order those indexes first appeared in the input. User serialization finishes before staging records in writer scratch. A native `Uint32Array` sort then places the encoded edits in tree order. See the [implementation](../../shared-list.ts), [WASM kernels](../../persistent-core.as.ts), and [API contract](../../docs/api.md).

This final-value contract matters for JSON serialization and invalid values. `setMany([[0, badValue], [0, goodValue]])` encodes only `goodValue`; a scalar loop would try to encode both. Use scalar calls when intermediate versions or intermediate serialization effects are required. Empty and entirely invalid batches return the original List. Valid edits require a writable owner.

## Formal results

Measurements were collected on November 8, 2026 in [GitHub Actions run 42495746269](https://github.com/natanelia/zerocopy/actions/runs/42495746269), using Node 24.22.1 and Bun 1.4.2 on Linux x64, an Intel Xeon Platinum 8370C at 2.80 GHz, pinned to CPU 0. The measured candidate was `dd07070298c3ce8fd9e0a665446a5ed46c8a1af2`; the [provenance record](validation/hosted-provenance.json) identifies the downloaded artifact and original record hashes. The [local audit at packaging time](validation/final-audit.txt) confirmed the recorded source and bundles matched this change. These historical timings remain tied to that recorded candidate when later changes are merged.

Times are **microseconds per complete batch**, not per edit. The value after the slash is the source List's item count. Edit rows compare a scalar loop with one `setMany` call; control rows use the same existing API in both builds. Times are medians of process medians. Ratios use paired process estimates and therefore need not equal the quotient of the displayed medians. Ratios below 1 favor the candidate.

| Runtime | Complete workload / source size | Before µs | After µs | Paired ratio | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | 256 numeric clustered / 32,768 | 106.619 | 21.928 | 0.207 | 0.201–0.214 | 6/6 |
| Node | 256 numeric scattered / 32,768 | 141.347 | 89.765 | 0.642 | 0.601–0.685 | 6/6 |
| Node | 1,024 numeric scattered / 65,536 | 553.472 | 304.777 | 0.554 | 0.541–0.568 | 6/6 |
| Node | 256 numeric at 16 indexes / 32,768 | 98.881 | 6.055 | 0.061 | 0.060–0.062 | 6/6 |
| Node | 256 boolean clustered / 32,768 | 107.795 | 21.542 | 0.199 | 0.196–0.202 | 6/6 |
| Node | 128 string clustered / 4,096 | 89.341 | 46.784 | 0.525 | 0.504–0.546 | 6/6 |
| Node | 64 numeric tree/tail / 1,057 | 29.609 | 13.488 | 0.469 | 0.443–0.497 | 6/6 |
| Node | 4 numeric scattered / 32,768 | 1.948 | 1.692 | 0.874 | 0.842–0.908 | 6/6 |
| Node | 256 scalar set control / 32,768 | 136.858 | 141.580 | 1.018 | 0.982–1.057 | 2/6 |
| Node | 4,096 get control / 32,768 | 115.876 | 116.635 | 1.012 | 0.993–1.031 | 1/6 |
| Bun | 256 numeric clustered / 32,768 | 112.466 | 25.288 | 0.238 | 0.193–0.294 | 6/6 |
| Bun | 256 numeric scattered / 32,768 | 129.311 | 140.288 | 1.097 | 1.019–1.182 | 1/6 |
| Bun | 1,024 numeric scattered / 65,536 | 546.569 | 335.878 | 0.610 | 0.580–0.642 | 6/6 |
| Bun | 256 numeric at 16 indexes / 32,768 | 110.734 | 6.109 | 0.055 | 0.044–0.068 | 6/6 |
| Bun | 256 boolean clustered / 32,768 | 84.574 | 22.821 | 0.268 | 0.257–0.280 | 6/6 |
| Bun | 128 string clustered / 4,096 | 161.695 | 47.503 | 0.294 | 0.284–0.304 | 6/6 |
| Bun | 64 numeric tree/tail / 1,057 | 34.502 | 19.688 | 0.591 | 0.539–0.648 | 6/6 |
| Bun | 4 numeric scattered / 32,768 | 1.890 | 3.736 | 1.940 | 1.785–2.109 | 0/6 |
| Bun | 256 scalar set control / 32,768 | 126.159 | 135.445 | 1.053 | 0.960–1.155 | 3/6 |
| Bun | 4,096 get control / 32,768 | 441.504 | 443.839 | 1.004 | 0.979–1.029 | 3/6 |

The [formal study](results/formal.json.gz) contains 240 independent processes and 2,160 measured timing batches, with 10,078,944 verified warmup/measured outputs. No measured timing batch was shorter than 2 ms. The scalar and read controls have intervals containing 1 on both runtimes; they do not establish a change to existing scalar operations. Gains in this report apply to the measured opt-in batch patterns on this host, not every runtime, device, or application workload.

### Same-build controls

The [AA record](results/aa.json.gz) compares the baseline build with itself using four fresh process pairs. Both columns use scalar loops, including cases named for batch shapes. Every interval includes 1. These measurements provide a noise check and are not subtracted from the formal result.

| Runtime | Complete workload / source size | First µs | Second µs | Paired ratio | 95% interval |
| --- | --- | ---: | ---: | ---: | --- |
| Node | 256 numeric clustered / 32,768 | 105.359 | 106.893 | 1.007 | 0.956–1.060 |
| Node | 256 numeric scattered / 32,768 | 139.804 | 134.324 | 0.964 | 0.909–1.023 |
| Node | 256 scalar set control / 32,768 | 138.842 | 136.988 | 0.983 | 0.896–1.078 |
| Bun | 256 numeric clustered / 32,768 | 116.667 | 111.959 | 0.972 | 0.815–1.158 |
| Bun | 256 numeric scattered / 32,768 | 122.309 | 122.607 | 0.983 | 0.901–1.072 |
| Bun | 256 scalar set control / 32,768 | 128.850 | 131.910 | 1.025 | 0.856–1.228 |

This control contains 48 processes, 432 measured timing batches, and 248,320 verified warmup/measured outputs. None of its measured batches was shorter than 2 ms.

### Pilot history and rejected preparation

These two-pair pilots selected the implementation; they are not the final evidence. Values are paired after/before ratios, so values above 1 mean the new batch API was slower. The unchanged scalar control is retained because it exposes process/runtime variation.

The [first pilot](results/pilot.json.gz) used an array of tuples and JavaScript comparator sorting. The [second pilot](results/pilot-v2.json.gz) used the current integer-sort preparation. Neither pilot observation was removed.

| Pilot case | V1 Node | V1 Bun | V2 Node | V2 Bun |
| --- | ---: | ---: | ---: | ---: |
| 256 clustered edits | 0.490 | 0.477 | 0.234 | 0.273 |
| 256 scattered edits | 0.914 | 1.524 | 0.728 | 1.342 |
| 256 submitted edits at 16 indexes | 0.065 | 0.057 | 0.077 | 0.057 |
| Unchanged scalar control | 0.807 | 0.942 | 0.883 | 0.960 |

V1's array-of-tuples preparation with a JavaScript comparator was rejected for formal measurement. V2 uses native integer sorting and replaces values in its private Map with encoded numbers. This improved the clustered pilot but did not eliminate the scattered Bun tradeoff: that case was still about 34% slower in V2. The formal study retained this case and the four-edit case. Their allocation reduction does not guarantee lower latency.

The first pilot's exact workload and List source remain available as [workloads-pilot-v1.mjs](workloads-pilot-v1.mjs) and [shared-list-pilot-v1.ts.txt](shared-list-pilot-v1.ts.txt). The [V2 pilot workload](workloads-pilot-v2.mjs) is archived too. Repetitions for clustered numeric/boolean edits and repeated-index edits increased after V1 because their measured batches were too short. Before formal measurement, string, tree/tail, and four-edit cases received higher repetition counts to reduce short-batch risk. These changes affected timing repetitions, not fixture values, logical batch sizes, or allocation totals. The local allocation records retain their original V2-workload hash.

Large saved records use lossless gzip with a zero modification-time header. The [pilot compression check](validation/compression-check.json), [pilot audit comparison](validation/compression-audit.json), and [hosted-record provenance](validation/hosted-provenance.json) retain byte counts and hashes. No fields or samples were discarded. Both verification tools accept plain and compressed records. `verify.mjs results/formal.json` also resolves `results/formal.json.gz` when only the compressed record exists. Small allocation records remain plain JSON.

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

The [complete comparison record](results/reference-comparison.json.gz) uses Immutable.js 5.1.9. Each cell is the median of three process medians, in **microseconds per complete batch**. This separate study uses its own repetition count and warmup duration, so its absolute times need not match the primary table.

| Runtime | Complete numeric workload / source size | Zerocopy scalar µs | Zerocopy batch µs | Immutable `withMutations` µs | Native one-copy batch µs |
| --- | --- | ---: | ---: | ---: | ---: |
| Node | 256 clustered / 32,768 | 95.682 | 22.930 | 13.609 | 140.042 |
| Node | 256 scattered / 32,768 | 96.242 | 54.917 | 30.725 | 159.758 |
| Node | 1,024 scattered / 65,536 | 466.594 | 235.699 | 462.659 | 281.202 |
| Node | 256 at 16 indexes / 32,768 | 100.595 | 6.724 | 12.914 | 140.896 |
| Bun | 256 clustered / 32,768 | 136.872 | 23.626 | 12.454 | 110.024 |
| Bun | 256 scattered / 32,768 | 137.054 | 139.776 | 58.985 | 114.305 |
| Bun | 1,024 scattered / 65,536 | 541.602 | 320.332 | 247.316 | 242.782 |
| Bun | 256 at 16 indexes / 32,768 | 137.832 | 4.766 | 11.962 | 108.176 |

Immutable.js remains faster for the clustered and 256-scattered cases on both runtimes; Zerocopy's deduplicated repeated-index batch is faster in this comparison. The 1,024-scattered ordering differs between Node and Bun. No general advantage over another library follows from this table.

The supplementary study contains 96 processes, 864 measured timing batches, and 676,800 verified final outputs. Its memory-bounded repetitions leave 150 measured batches below 2 ms: 54 for the Zerocopy batch arm and 96 for Immutable.js. These observations remain in the record without filtering. Treat small supplementary differences cautiously; they are not substitutes for the primary paired intervals.

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

The [dedicated workflow](../../.github/workflows/list-set-many.yml) builds WASM, portable modules, and declarations; runs focused tests under Node and Bun; checks the installed package and types; verifies the import/export surface; and exercises real workers with shared and copied transport. A candidate writer is checked with both candidate and baseline readers. The richer Chromium proof exercises the actual new API, paused iterators, old snapshots, concurrent reads, memory growth, multiple value types, forks, compaction, and read-only attachment.

Recorded local checks include the [complete Bun suite](validation/full-bun.txt), with 1,216 tests in 62 files; [112 focused Bun tests](validation/focused-bun-v2.txt); [46 focused Node tests](validation/focused-node-v2.txt); and actual worker checks with the [current reader](validation/worker-current.json) and [baseline reader](validation/worker-old-reader.json). The [WASM surface check](validation/abi.json) preserves all 55 existing export names/kinds and the memory import, adds only `vecSetMany` and `tailSetMany`, and verifies identical bytes for every legacy core alias. The packed package passes the new API under Node and Bun, including typed declarations, original snapshots, compaction, and both attachment modes.

The hosted run also passed [112 focused Node tests](validation/hosted/node-tests.txt), [112 focused Bun tests](validation/hosted/bun-tests.txt), [packed Node/Bun/type checks](validation/hosted/package-set-many.txt), and worker proofs with the [current reader](validation/hosted/workers-current-reader.txt) and [baseline reader](validation/hosted/workers-old-reader.txt). [Chromium 153.0.8010.12 passed](validation/hosted/chromium.json) with real module workers in both transport modes: 12 snapshots per mode, 54,652 concurrent shared reads and 38,318 copied-reader reads, retained iterators, and source bytes unchanged across memory growth from 393,216 to 2,162,688 bytes.

Post-review validation now explicitly rejects array/object mismatches in the browser oracle, derives Node fork and compaction expectations from the input, and reconstructs every recorded fixture digest from its case definition. The [review checks](validation/proof-review.json) pass for all 352 pilot/formal/A/A processes and reject a deliberately corrupted record even when both variants contain matching wrong digests. Updated worker proofs pass with both [current](validation/worker-review-current.json) and [baseline](validation/worker-review-baseline.json) readers. Runtime code, measured workloads, the timing driver and all measurement records remain unchanged; the dedicated workflow repeats the stricter browser and evidence checks.

The dedicated proof workflow runs when this study, its regression test, or its workflow changes, and on manual dispatch. It checks correctness and audits committed evidence; **it never collects benchmark timings**. The temporary branch trigger and initial evidence-collection step were removed after the hosted records were reviewed. Correctness, package, worker, and browser checks use the current checkout. For the timing audit, CI separately builds the candidate commit recorded inside the formal JSON and verifies its historical source and bundle hashes. The project's main CI also runs API regression tests for general runtime changes, so this historical measurement does not freeze unrelated future implementations.

CI fetches the recorded candidate by SHA if it is no longer in the fetched branch graph. The baseline and recorded candidate install dependencies from their own manifests rather than sharing the current checkout's dependencies. Neither historical revision contains a committed dependency lockfile; recorded source, WASM, and bundle hashes still have to match.

The initial formal, same-build, and supplementary studies ran sequentially on a fresh hosted runner, after correctness and browser checks, using the common advisory lock. The [saved-record audit](validation/final-audit.txt) requires complete formal and same-build records, recomputes paired statistics and output counts, and checks the latest formal record against the build supplied to the verifier. CI supplies the recorded historical build; the default local command can also check a current build. The [independent evidence review](validation/independent-review.json) separately checks primary/AA statistics, fixture digests, provenance, and the reference comparison. Worker compatibility and allocation checks are separate from timing.

## Reproduction

Build two worktrees with the same dependencies: the pinned baseline and measured candidate `dd07070298c3ce8fd9e0a665446a5ed46c8a1af2`. Run `bun run build:wasm`, `bun run build:browser`, and `bun run build:types` in each. Set `BASELINE_CHECKOUT` to the built baseline and `BENCHMARK_CPU` to an available isolated CPU. Run the commands below from the candidate checkout, using the proof scripts supplied with this report. They create a fresh temporary output directory, preserving all committed evidence. The driver owns the shared lock; do not wrap it in another lock on the same path.

```sh
proof=proofs/list-set-many-20261108
list_batch_results="$(mktemp -d /tmp/zerocopy-list-batch-reproduction.XXXXXX)"
taskset -c "$BENCHMARK_CPU" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$BASELINE_CHECKOUT" . "$(command -v bun)" \
  "$list_batch_results/formal.json" formal
taskset -c "$BENCHMARK_CPU" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$BASELINE_CHECKOUT" . "$(command -v bun)" \
  "$list_batch_results/aa.json" aa
node "$proof/verify.mjs" "$list_batch_results/formal.json" .
node "$proof/verify.mjs" "$list_batch_results/aa.json"
taskset -c "$BENCHMARK_CPU" node "$proof/reference-comparison.mjs" \
  "$BASELINE_CHECKOUT" . "$(command -v bun)" "$list_batch_results/reference-comparison.json"
node "$proof/allocation.mjs" "$BASELINE_CHECKOUT" "$list_batch_results/allocation-before.json"
node "$proof/allocation.mjs" . "$list_batch_results/allocation-after.json"
node "$proof/abi.mjs" "$BASELINE_CHECKOUT" .
node "$proof/worker.mjs" list .
node "$proof/worker.mjs" list . "$BASELINE_CHECKOUT"
node "$proof/package.mjs" .
node "$proof/browser.mjs" . "$list_batch_results/chromium.json"
printf 'Reproduction records: %s\n' "$list_batch_results"
```

To audit the committed measurements without timing, run `node proofs/list-set-many-20261108/audit-evidence.mjs "$RECORDED_CANDIDATE_CHECKOUT"` from the checkout containing this report after building the recorded candidate. Passing `.` instead performs an optional exact-current-build check and will correctly fail when current runtime source has diverged from the measured candidate.
