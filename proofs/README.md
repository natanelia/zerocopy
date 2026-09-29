# Benchmark reports

The [README](../README.md#performance) compares zerocopy with Immutable.js and native collections. Reports in this directory preserve experiments against specific source versions. Do not apply their historical results or implementation descriptions to a different engine build.

| Report | Comparison |
| --- | --- |
| [Scalar map writes](map-set-performance.md) | Three libraries and a paired writer-index experiment, September 14, 2026 |
| [Revision performance](revision-performance.md) | Block-storage revision against earlier zerocopy versions, September 13, 2026 |
| [Recorded evidence](results/README.md) | Source hashes, raw rounds, summaries, and verification records |

## Initial persistent-engine experiment

This experiment replaced unsafe shared-node updates with persistent structures. The pinned baseline is `7aea44447177d37a303ab5c1b26d7c5e00e1c1f7`. In the tables below, **Candidate** refers only to the measured initial v0.2 implementation. The experiment recorded six faster workloads and eight regressions against the matched baseline.

### Measured results

Times are median milliseconds for the complete workload. The matched baseline uses the same AssemblyScript compiler and flags as the candidate. Ratios above 1 indicate faster candidate execution; ratios below 1 indicate a regression.

| Operation | Work units | Original base, ms | Matched base, ms | Candidate, ms | Matched base / candidate |
|---|---:|---:|---:|---:|---:|
| `list.pushMany` | build 4096 numbers | 0.734 | 0.867 | 0.085 | 10.24x |
| `list.toArray` | 20 scans of 4096 numbers | 0.861 | 0.822 | 0.278 | 2.96x |
| `list.push` | 4096 scalar pushes | 0.755 | 0.921 | 1.020 | 0.90x |
| `map.setMany` | build 1024 key/number entries | 0.288 | 0.187 | 0.316 | 0.59x |
| `map.get` | 4096 hits over 1024 keys written in setup | 0.357 | 0.369 | 0.481 | 0.77x |
| `linked.randomGet` | 4096 permuted indexed reads | 14.481 | 14.812 | 0.700 | 21.17x |
| `linked.append` | 4096 scalar appends | 0.326 | 0.319 | 1.241 | 0.26x |
| `doubly.randomGet` | 4096 permuted indexed reads | 7.978 | 7.518 | 0.725 | 10.38x |
| `doubly.append` | 4096 scalar appends | 0.293 | 0.305 | 1.327 | 0.23x |
| `ordered.set` | 1024 scalar writes | 0.224 | 0.235 | 0.737 | 0.32x |
| `sorted.set` | 1024 scalar writes | 0.338 | 0.313 | 0.554 | 0.57x |
| `priority.enqueue` | 1024 numeric enqueues | 0.533 | 0.568 | 0.321 | 1.77x |
| `queue.build` | 4096 numeric insertions | 0.325 | 0.363 | 1.214 | 0.30x |
| `stack.build` | 4096 numeric insertions | 0.318 | 0.322 | 0.194 | 1.66x |

The linked-list interfaces used indexed AVL trees at this stage, rather than physical links. That explains their indexed-read gains and append costs. Map lookup and `setMany` were slower than the matched old implementation in this experiment. These are workload results, not whole-application gains.

### Method and raw evidence

The run used Bun 1.4.2, AssemblyScript 0.28.20, Linux x64, and an Intel Xeon Platinum 8573C. Its timestamp is `2026-09-13T02:39:46.235Z`.

Each operation ran in its own process. There were three process rounds per variant, 20 warm-ups, and 15 measured runs per round: 45 samples per operation and variant. Variant order changed between rounds. Setup and full output validation were outside timing.

Three variants separated build effects from data-structure effects: original source with original flags, original source with candidate flags, and candidate source. Both baseline builds used the same compiler version as the candidate. The harness was copied unchanged into the baseline, whose production digest had to match the pinned source. The candidate was rebuilt before measurement.

Each sample used a fresh logical arena. Candidate reset created a new WASM instance outside timing; baseline reset reused its instance. The old map auto-GC mechanism was disabled because it could reclaim a reachable snapshot. The baseline did not meet the full persistence contract, so equal semantics for all uses are not implied.

These numeric, in-process microbenchmarks do not measure application latency, peak RSS, JavaScript heap use, browser performance, or worker-transfer latency. CPU affinity and frequency were not controlled. A median is not a confidence interval; CI does not use a wall-clock performance threshold on a shared runner.

| Record | Contents |
| --- | --- |
| [local.json](results/local.json) and [local-rounds](results/local-rounds) | Metadata, source hashes, summary rows, and every raw sample |
| [allocation.json](results/allocation.json) | Scalar-versus-batch allocation comparison |
| [node-worker.json](results/node-worker.json) | Real Node worker result |
| [baseline-regressions.json](results/baseline-regressions.json) | Original snapshot counterexamples |
| [candidate-regressions.json](results/candidate-regressions.json) | The same counterexamples on the candidate |

Exact identifiers:

```text
baseline engine SHA256: 8dfcd6c936b4875ebfcd6e13dd214d5b84d2d6301f1c5f6c68704a2f357352fa
candidate engine SHA256: c408c5a71c9a3e8fb57fd4c010e197d8b4856201e72a677f36dbf6cb8508fba6
candidate WASM SHA256: 7f042cfbb224e7021e98c26289dcfb166286a12127931d0f2ed5d51419d0375f
benchmark SHA256: c8609253121a9d181ff893f882ef9d7120312bdcb3ed814080471b9d7f7c3c93
```

The engine digest uses sorted source paths and NUL-delimited names and contents, as recorded in the raw report. It excludes documentation, tests, and build wrappers. Candidate compiler flags were:

```text
--importMemory --sharedMemory --initialMemory 2 --maximumMemory 65536
--enable threads --runtime stub --optimizeLevel 3 --shrinkLevel 0
```

### Allocation experiments

The prefix-fused HAMT batch removes duplicate encoded keys with last-write-wins semantics, builds fresh leaves, and partitions a private pointer array by five hash bits per level. It copies each affected old branch once per batch. No transient owner tag is written into a published node. This combines known trie and radix-partition techniques; it is not a claim of a new published algorithm.

The allocation comparison starts with 32,768 entries and changes 4,096 existing keys. Both paths use the candidate's immutable engine.

| Candidate update method | Allocated WASM bytes |
|---|---:|
| 4,096 persistent scalar updates | 1,841,408 |
| One prefix-fused batch | 347,240 |

The batch allocates 81.14% fewer arena bytes. All old and new values are checked, and the old allocated payload remains byte-for-byte unchanged. This is not a speed claim, total-memory comparison, or comparison with the old unsafe transient batch.

A dense vector leaf stores 32 numeric slots in 256 bytes. Building 4,096 values with `pushMany` allocates 66,176 arena bytes, including input staging, versus 2,052,112 bytes for the original vector: 96.78% fewer. Used prefixes including headers are 131,712 and 2,117,712 bytes respectively. Neither metric is peak RSS. Leaf-wise scans reduce repeated trie traversal and WASM calls.

Stable encoded-key tokens use append-only key addresses and a bounded cache. ASCII insertion can avoid a temporary UTF-8 array; pointer caches use full addresses. These mechanisms did not make the overall measured map lookup faster than the old engine. Frozen handles and safe lifetime rules also cost work.

Other storage choices at this stage included a vector plus read offset for queues, a persistent insertion-order index for ordered maps, inline numeric values in stacks and leftist heaps, and indexed AVL sequences for linked-list APIs. Later revisions changed some layouts; see the current [architecture](../docs/architecture.md).

### Correctness evidence

The same [counterexample program](snapshot-regressions.ts) fails six cases on the pinned original and passes them on the candidate: queue forks, singly linked-list forks, doubly linked-list forks, ordered-map forks, mutable stack input objects, and mutation of cached map objects. The records include expected and actual values.

The historical unit run passed 280 tests in 13 files: 246 existing tests and 34 new proof tests. Coverage includes all 12 public classes, frozen handles, unchanged old byte prefixes, retained forks, independent reference models, HAMT sizes/hash paths, AVL balance/sizes, and leftist-heap rank/priority invariants.

Boundary cases include vector depths through 32,769 elements; the FNV-1a collision `costarring` / `liquid`; empty keys; prefix deletion; 1,400 retained maps; keys and values above 64 KiB; arenas above 1 MiB; a 4,500-entry batch; Unicode surrogates; BOM preservation; nested values; JSON-cache isolation; and iteration during writes and memory growth.

The [Node worker check](node-worker.mjs) uses an actual `worker_threads` worker. It checks all 12 types, nested values, 10,000 old-snapshot reads during writer updates and memory growth, repeated attachment, reset, and rejected allocating writes through attached views. An atomic marker in reserved header scratch checks that both workers share backing memory. The historical local Node 22.16.0 run passed.

The historical local record does not establish a Chromium pass. The later browser compatibility fix and its completed browser run have separate source identifiers in the [evidence guide](results/README.md#source-versions-and-ci-results).

### Persistence argument and limits

Updates allocate fresh payload nodes. Published nodes do not change. Frozen handles keep fixed roots and sizes. Reset creates a new arena rather than rewinding old allocation. Iterators keep local continuation state, and decoded JSON values are deeply frozen before caching.

Under these invariants, a new version can reference older nodes without changing the older version's reachable data. Byte-level tests and logical models check the argument. This is not machine-checked verification of WASM, JavaScript, all inputs, or the dependency chain.

The contract covers collection values through supported APIs, not raw-memory attackers. Allocation scratch, caches, and unpublished construction remain mutable. Returned arrays and entry tuples are detached containers. Custom comparators must be pure and remain local.

The initial implementation had one allocating writer per arena, read-only attachments, an append-only ceiling below 2 GiB, and no per-node reclamation. A retained snapshot pinned its arena, including staging and unreachable nodes. Nested descriptors retained dependencies; queues and ordered maps could retain consumed entries. GC timing was not guaranteed.

At this stage, compaction was not implemented and the wire format was 2. The current library has explicit compaction and format 4. Reset still selects a new default lifetime; deprecated disposal methods remain no-ops. See [Migration](../docs/migration.md) for current guidance rather than using historical pointer layouts.

Node and supported browsers shared WebAssembly memory. Bun used a used-prefix copy by default, which was not zero-copy. Strings and JSON required decoding and JavaScript allocation. The browser bundle embedded WASM without Node filesystem imports. Legacy scratch exports and buffer snapshots were not a concurrent-reader API and could be stale after growth.

## Run the checks

Use the [contributor setup](../CONTRIBUTING.md#set-up-and-test), then run the allocation and snapshot checks:

```sh
bun proofs/allocation.ts
EXPECT_PASS=1 LABEL=candidate bun proofs/snapshot-regressions.ts
node proofs/restore-local-evidence.mjs
```

For the three-variant comparison, use a separate checkout. The driver writes generated WASM and a copy of the harness there; do not use a worktree with changes you need to keep.

```sh
git worktree add --detach ../zerocopy-base 7aea44447177d37a303ab5c1b26d7c5e00e1c1f7
ln -s "$PWD/node_modules" ../zerocopy-base/node_modules
node proofs/run-comparison.mjs ../zerocopy-base proofs/results/ci.json
```

The driver records raw samples and metadata and checks source hashes. `RESUME=1` resumes a checkpoint only when source and harness hashes match. New source builds produce new experiments; keep their results separate from the historical record. Correctness and deterministic allocation checks are gates, not noisy timing ratios.
