# Batched immutable Map deletion

This proof evaluates a faster implementation of the existing `SharedMap.deleteMany(keys)` operation. Both builds receive the same ordered request array, retain the original Map, and return the same immutable final Map. The baseline is [`a4265a0608ec25eec5719496225212db6b251989`](https://github.com/natanelia/zerocopy/commit/a4265a0608ec25eec5719496225212db6b251989).

## Implementation and scope

Repeated scalar deletions copy a path through the hash trie for each matching key. The candidate groups requests by hash prefix inside WASM, walks each affected subtree together, and copies a changed branch once per chunk. Full key bytes are checked at leaves and collision buckets. Duplicate and missing requests do not count as removals.

The JavaScript wrapper stores compact key records in the existing 49,152-byte writer scratch range. Request staging does not allocate persistent arena storage. A request record uses 12 bytes plus its UTF-8 length rounded up to four bytes, including its pointer. Longer keys use the scalar path. Large arrays may require several chunks, and prefixes can be rebuilt once per chunk.

The current dispatch considers arrays with at least 512 requests. It first performs 32 ordinary scalar deletes. If at least 16 change the root, the remaining requests use grouped deletion; otherwise the same iterator continues through the scalar path. These first deletes are useful work, with no extra preliminary lookup. Small arrays, custom iterators, custom Arena instances, and replaced internal hooks retain scalar behavior.

The wrapper buffers only a bounded chunk of JavaScript keys and encoded bytes. No shared staging bytes survive an input getter. A reentrant getter can allocate or grow memory before the next flush. If a getter replaces `Arena.delete`, `Arena.find`, or the WASM exports, captured native code finishes earlier buffered requests, then the current and later requests use the replacement hooks. One iterator is used throughout, preserving input visitation and iterator closing on errors.

The scalar probe is a heuristic. A missing prefix followed by many hits stays scalar and may miss a useful optimization. A dense prefix followed by misses can pay batching overhead. Both shapes are explicit adverse workloads below. Allocation savings alone do not establish a latency improvement.

## Evidence status

Formal V3 measurements, same-build controls, allocation records, and the supplementary library comparison are pending. Do not infer a final performance claim from this report until those records and the complete result table are added.

The direct-key V2 [pilot record](results/pilot.json) is preserved. It showed useful large-batch results but slower 32-key, 100-key, and all-missing requests, motivating the V3 dispatch gate. The exact measured [V2 workload](workloads-pilot-v2.mjs), [source snapshots](archive/v2/), and [candidate patch](archive/v2/candidate.patch) are retained. New V3 records use new paths; prior observations are not overwritten.

### Final results

Pending: report every case in the workload module for Node and Bun, with complete-operation time before and after, the paired after/before ratio, its interval, and the same-build noise check. Include unfavorable and inconclusive cases. Identify repeated-fork throughput separately from independent-source first deletions. The 511/512 boundary and all adverse hit patterns remain visible.

## Workloads and measurement

The [workload module](workloads.mjs) defines all inputs, expected public results, and repetitions. Numeric values include ordinary fractional numbers, `NaN`, negative zero, infinities, and numeric extremes. The Unicode case includes multibyte keys. The complete final Map is checked in independently computed hash-trie order, and the retained source is checked after every batch.

| Workload | Source entries | Requested keys | Purpose |
| --- | ---: | ---: | --- |
| Small deletion | 4,096 | 100 | Scalar dispatch control |
| Medium deletion | 8,192 | 1,000 | Repeated forks of the same source |
| Large deletion | 8,192 | 4,096 | Shared path copying across chunks |
| Independent-source deletion | 8,192 | 1,000 | A separate prebuilt source per operation |
| Unicode deletion | 8,192 | 1,000 | UTF-8 preparation |
| Small control | 512 | 32 | Scalar dispatch control |
| Dispatch boundaries | 8,192 | 511 / 512 | Below and at the grouping threshold |
| Single and empty controls | 64 | 1 / 0 | Unchanged small operations |
| All missing | 4,096 | 1,000 | No result or writer allocation |
| Missing prefix, later hits | 8,192 | 1,000 | Useful work after an unrepresentative probe |
| Sparse hits | 8,192 | 1,000 | One matching key in every 16 requests |
| Dense prefix, later misses | 8,192 | 1,000 | Misleading successful probe |
| Repeated key | 4,096 | 1,000 | One real deletion |
| Clear all | 4,096 | 4,096 | Empty result and branch collapse |
| `getMany` control | 128 | 64 reads | Unchanged populated read cache |
| `set` control | 64 | 1 update | Unchanged scalar update |

Every timed result remains in a preallocated output array until full validation finishes. Each timing batch starts from a newly built arena outside the timer. Normal workloads repeatedly fork that one source; the independent-source workload prepares a separate arena and Map for every repetition. Imports, fixture/source creation, output-array allocation, and correctness checks are excluded. The complete public call, internal key preparation, WASM work, arena growth and allocation, returned handle creation, and output retention are included.

The [paired driver](paired-benchmark.mjs) pins execution to one CPU, holds a common advisory lock, and launches separate processes for each build, runtime, and case. Both builds use the same neutral import path. Before/after order alternates by pair; runtime and case order reverse too. Formal measurement uses six process pairs, at least 500 ms of timed warmup and eight warmup batches, and nine measured batches. Pilots use two pairs and 150 ms; same-build controls use four pairs and 500 ms.

Each process estimate is its median batch duration divided by the repetition count. The paired ratio is the geometric mean of the six after/before ratios. Its 95% interval uses a Student-t interval on paired log ratios and is not adjusted for multiple workloads. Saved records retain all samples, versions, affinity, schedule, short-batch counts, source/build hashes, and changed source snapshots. [verify.mjs](verify.mjs) recomputes statistics and checks provenance without retiming.

## Writer allocation and library context

[allocation.mjs](allocation.mjs) records the exact change in the WASM allocation frontier for one complete public request on a fresh source. It uses the same primary fixtures and adds exact chunk boundaries and UTF-8 key sizes of 49,140 and 49,141 bytes. It validates the entire result, original descriptor, and published source bytes. Counts include the scalar probe, all chunk outputs, and unreachable intermediate path copies because the arena is append-only. They exclude JavaScript allocation, GC, total backing capacity, and RSS. This diagnostic is not a total-memory comparison.

Pending: add before/after allocation records and a table with identical fixture digests.

[compare.mjs](compare.mjs) supplements the primary comparison with Immutable.js and native Map for the same 100-, 1,000-, and 4,096-key requests. Immutable.js uses `withMutations` for the complete deletion request. Native Map performs one `new Map(source)` before the requested deletes. All arms retain the original and final versions and validate every final entry. Its three process rounds and nine samples per process provide context; the paired baseline study carries the optimization claim. Native Map does not provide Zerocopy's worker transport.

## Correctness and compatibility

The [regression tests](../../map-batch-delete.test.ts) cover threshold and chunk boundaries, missing and duplicate keys, Unicode replacement aliases, full-hash collisions, branch collapse, oversized keys, legacy journals, custom iterators and hooks, reentrant getters and memory growth, randomized sequences, nested values, retained forks, compaction, and both worker payload modes. The allocation-failure case forces the grouped remainder to fail after a successful scalar probe, verifies the published source, and recovers through an allocation-free deletion without rewinding the allocator.

Local V3 validation before the pilot passed 128 Node tests across six files, all 39 new tests under Bun, TypeScript checking, WASM and portable builds, and all 18 workload smoke cases. These are correctness checks; they are not performance measurements.

The [dedicated workflow](../../.github/workflows/map-batch-delete.yml) rebuilds modules and declarations, runs focused Node/Bun tests, checks the packed package, records before/after allocation, and runs real workers with both current and baseline readers. Worker proofs retain old snapshots while the owner deletes keys and grows memory, then verify forks, compaction, threshold/adverse cases, and read-only attachments under both shared and copied transport. A Chromium proof exercises the portable bundle and real browser workers. Browser execution and CI results are pending until recorded; a launch restriction is not a passing browser result.

The initial hosted run bootstraps measurements only when `results/formal.json` is absent. After all correctness and browser checks, it selects the runner's first allowed CPU and runs the V3 pilot, six-pair formal study, same-build control, and supplementary comparison serially. The existing V2 pilot is preserved. Raw records and correctness logs are uploaded even when a later step fails. Once the completed records are retained in the branch, later runs audit their statistics and current-build provenance without collecting new timings. The feature-branch push trigger is temporary until that first hosted evidence is reviewed.

## Reproduction

Build the pinned baseline and candidate with the same dependencies using `bun run build:wasm` and `bun run build:browser`. Select one available CPU and a new output path for every recording. The driver owns the advisory lock; do not acquire the same lock around it.

```sh
proof=proofs/map-batch-delete-direct-20261108
taskset -c "$BENCHMARK_CPU" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$BASELINE_CHECKOUT" . "$(command -v bun)" \
  "$proof/results/formal.json" formal
taskset -c "$BENCHMARK_CPU" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$BASELINE_CHECKOUT" . "$(command -v bun)" \
  "$proof/results/aa.json" aa
node "$proof/verify.mjs" "$proof/results/formal.json" .
node "$proof/verify.mjs" "$proof/results/aa.json"
taskset -c "$BENCHMARK_CPU" node "$proof/compare.mjs" \
  . "$(command -v bun)" "$proof/results/comparison.json" measure
node "$proof/allocation.mjs" "$BASELINE_CHECKOUT" "$proof/results/allocation-before.json"
node "$proof/allocation.mjs" . "$proof/results/allocation-after.json"
node "$proof/worker.mjs" map .
node "$proof/worker.mjs" map . "$BASELINE_CHECKOUT"
node "$proof/browser.mjs" map .
```
