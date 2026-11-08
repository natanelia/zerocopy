# SharedMap `forEach` traversal

> **Historical V1/V2 evidence.** These recordings describe the earlier source at
> PR head `5bf3e68167f15930f273c353cdcdb1e7db31cc7f`. A later public-entry Bun
> integration check with the optional numeric factory found that a traversal hook
> installed before Map-module initialization could be mistaken for the native
> method. The repair captures that identity when Arena initializes. The
> [corrected-source study](../map-foreach-early-identity-20261108/README.md) contains
> fresh measurements, the reproduced failure and the regression gate. None of the
> old timing samples below are pooled with that study. Audit this archive without
> `CHECK_CONFIRMED_SOURCE`; that extra check is only valid at its historical
> candidate. Current-source matching is enforced by the new study's verifier.

## Change

`SharedMap.forEach` now walks the immutable HAMT directly, keeping its stack and overlay reconstruction arrays local to the call. The traversal captures one memory view. This removes the per-leaf generator suspension and per-node view refreshes in `Arena.leaves`.

Each callback still receives the decoded value followed by its key. Value and key decoding use exactly the existing method calls and arguments. A decoder may be replaced during a callback. Custom `Arena.leaves` implementations and legacy journals retain the existing generator path, including duplicate suppression, traversal order and iterator cleanup.

The captured view only reads already published nodes. Shared-memory growth preserves those bytes, so a callback can grow the arena, recursively traverse a collection, or create a fork without changing the ongoing scan. The WASM engine, representation, public API, `entries`, `keys`, `values`, reads and writes are unchanged.

## Benchmark method

Baseline: `0ac8a005268335a6116f025e75f670b5cee6843e`.

The public workload calls `forEach` with a reusable callback that consumes every value and key length. This measures steady repeated scans of fixed snapshots; construction and first-call startup are outside timing. After every timed batch, all returned checksums, the complete key/value sequence, the unchanged `entries` sequence and every originally published arena byte are checked. The report does not claim that full oracle comparisons run inside the timed callback.

Both runtimes load portable browser bundles. Every subject uses a fresh process and the same neutral import path. The driver copies only one build at a time, pins execution to one CPU, alternates A/B and B/A by pair, reverses runtime and case order, and holds the shared benchmark lock. Node and Bun use identical fixtures and repetitions.

Confirmation uses six fresh process pairs per case/runtime, at least 500 ms of timed warmup, at least eight warmup batches and nine measured batches per process. Process medians are the independent input to paired estimates. The paired time ratio is the geometric mean of the six after/before ratios; 95% intervals use Student's t on those paired log ratios. Before/after times are medians of process estimates and need not divide to the paired ratio. No samples are removed or adjusted.

Separate A/A studies compare the unchanged baseline with itself. Their raw results are reported separately; they are never subtracted from A/B results. Untouched `entries` and `get` are negative controls. Measurements are specific to these Linux x64 Node/Bun workloads and are not browser or ARM performance claims.

## Results

The final recording establishes lower scan time for 4,096 numeric values, 64-value maps, booleans, strings and JSON on both runtimes. Node also shows established gains for the edited-map and Unicode-key cases. The 65,536-entry case remains inconclusive on both runtimes; Bun's edited-map and Unicode-key cases also remain inconclusive.

**Adverse controls remain unresolved.** The unchanged cached-`get` control estimates **9.6% more time on Node** and **23.1% more time on Bun**. Both intervals include no change and material slowdowns; each runtime is faster in only three of six pairs. The unchanged `entries` control estimates 0.4% and 5.0% more time, also inconclusively. These results do not support a universal gain or a no-regression claim.

The control verifier invokes the changed `forEach` outside the timed region after each batch, alongside the unchanged `entries` scan and byte check. That can affect allocation, garbage collection and JIT/cache state before the next timed control batch. The controls therefore exercise a mixed workload rather than isolating `get` from all scanning. The recordings do not establish which mechanism caused the adverse estimates, and no adjustment is made for this possible coupling.

Environment: Linux x64, AMD EPYC 9V74 80-Core Processor, CPU 2, Node 24.22.1 and Bun 1.4.2. No measured confirmation or A/A batch was shorter than 2 ms. The final A/B study contains 240 fresh processes; A/A contains 64. Including both pilots, the archive contains **400 processes and 3,600 measured batches**.

### Node confirmation

| Workload | Before (µs) | After (µs) | After/before [95% interval] | Faster pairs | Result |
| --- | ---: | ---: | --- | ---: | --- |
| 4,096 numeric values | 866.096 | 728.588 | 0.832 [0.709–0.977] | 5/6 | Faster |
| 65,536 numeric values | 24,242.344 | 20,384.360 | 0.851 [0.680–1.064] | 5/6 | Inconclusive |
| 4,096 values after edits | 901.075 | 694.520 | 0.757 [0.637–0.901] | 6/6 | Faster |
| 64 numeric values | 8.585 | 5.199 | 0.591 [0.503–0.694] | 6/6 | Faster |
| 4,096 boolean values | 832.922 | 591.958 | 0.709 [0.647–0.778] | 6/6 | Faster |
| 1,024 string values | 139.661 | 94.500 | 0.743 [0.556–0.993] | 4/6 | Faster |
| 256 JSON values | 34.355 | 20.793 | 0.663 [0.551–0.797] | 6/6 | Faster |
| 4,096 values, Unicode keys | 1,128.503 | 858.936 | 0.776 [0.701–0.859] | 6/6 | Faster |
| `entries`, 4,096 values (control) | 964.306 | 957.374 | 1.004 [0.928–1.087] | 2/6 | Inconclusive |
| Cached `get`, 4,096 keys (control) | 139.740 | 159.928 | 1.096 [0.916–1.311] | 3/6 | Inconclusive |

### Bun confirmation

| Workload | Before (µs) | After (µs) | After/before [95% interval] | Faster pairs | Result |
| --- | ---: | ---: | --- | ---: | --- |
| 4,096 numeric values | 383.268 | 271.587 | 0.670 [0.522–0.859] | 6/6 | Faster |
| 65,536 numeric values | 11,384.679 | 11,033.449 | 0.980 [0.828–1.159] | 4/6 | Inconclusive |
| 4,096 values after edits | 389.273 | 295.722 | 0.802 [0.642–1.001] | 5/6 | Inconclusive |
| 64 numeric values | 3.061 | 2.298 | 0.721 [0.569–0.914] | 5/6 | Faster |
| 4,096 boolean values | 376.221 | 292.170 | 0.803 [0.714–0.903] | 6/6 | Faster |
| 1,024 string values | 59.370 | 41.470 | 0.717 [0.557–0.922] | 5/6 | Faster |
| 256 JSON values | 13.983 | 10.515 | 0.683 [0.565–0.825] | 6/6 | Faster |
| 4,096 values, Unicode keys | 630.145 | 502.960 | 0.883 [0.750–1.039] | 5/6 | Inconclusive |
| `entries`, 4,096 values (control) | 507.156 | 487.327 | 1.050 [0.940–1.173] | 3/6 | Inconclusive |
| Cached `get`, 4,096 keys (control) | 41.351 | 52.407 | 1.231 [0.769–1.973] | 3/6 | Inconclusive |

### Separate identical-baseline controls

All A/A intervals include one. Several are wide: identical-baseline Bun `get` estimates 41.9% more time with an interval of 0.568–3.541. This demonstrates substantial uncertainty; it does not cancel or clear the adverse A/B estimates. A/A and pilot results are never pooled with the final A/B results.

#### Node A/A

| Workload | Before (µs) | After (µs) | After/before [95% interval] | Faster pairs | Result |
| --- | ---: | ---: | --- | ---: | --- |
| 4,096 numeric values | 862.512 | 857.666 | 0.912 [0.701–1.186] | 3/4 | A/A uncertainty |
| 1,024 string values | 148.836 | 148.674 | 1.007 [0.961–1.055] | 2/4 | A/A uncertainty |
| `entries`, 4,096 values (control) | 1,011.988 | 1,013.788 | 0.940 [0.727–1.215] | 2/4 | A/A uncertainty |
| Cached `get`, 4,096 keys (control) | 199.923 | 155.864 | 0.838 [0.629–1.116] | 3/4 | A/A uncertainty |

#### Bun A/A

| Workload | Before (µs) | After (µs) | After/before [95% interval] | Faster pairs | Result |
| --- | ---: | ---: | --- | ---: | --- |
| 4,096 numeric values | 390.776 | 406.372 | 1.068 [0.750–1.522] | 1/4 | A/A uncertainty |
| 1,024 string values | 60.962 | 60.130 | 0.998 [0.901–1.106] | 2/4 | A/A uncertainty |
| `entries`, 4,096 values (control) | 429.785 | 461.919 | 0.995 [0.738–1.341] | 1/4 | A/A uncertainty |
| Cached `get`, 4,096 keys (control) | 60.849 | 101.364 | 1.419 [0.568–3.541] | 1/4 | A/A uncertainty |

The complete records are [final A/B](results/confirmation-v2.json.gz), [A/A](results/aa-v2.json.gz), [V1 pilot](results/pilot-v1.json.gz), and [V2 pilot](results/pilot-v2.json.gz). Every row, warmup, timing sample and paired estimate is retained. The records are losslessly compressed; [manifest.json](results/manifest.json) records compressed and original SHA-256 hashes and byte lengths.

## Correctness and compatibility

- Thirteen new regression tests cover dense nodes, overlays, full-hash collisions, legacy and nested journals, empty maps, arbitrary UTF-8 keys, special numeric values, strings, frozen JSON, nested collections, callback exceptions, callback arguments/receiver, custom traversal cleanup, dynamic value decoding, reentrancy, forks, growth and shared/copied read-only attachments.
- The focused local selection passes 60 tests on Node and 60 on Bun.
- The final full Bun suite passes **1,199 tests in 61 files**. The baseline passes 1,186 tests in 60 files. See [final suite](validation/full-bun.txt) and [baseline suite](validation/baseline-full-bun.txt).
- Declaration builds, main/Redux/typed-values/geometry/worker TypeScript checks, and [installed-package Node/Bun exports, real Node workers and TypeScript consumers](validation/package.txt) pass.
- The real Node worker check pauses inside a worker callback while the owner edits and grows memory, then resumes and verifies both the retained snapshot and a newly attached root. Shared and copied transports pass, including all value types and unchanged published bytes.
- Chromium launch was attempted locally and blocked before any browser code ran: `socket() failed: Operation not permitted` in Chromium's process-singleton setup. The exact failure log is retained in `results/browser-v2-error.txt`; no local browser success is claimed. The dedicated workflow runs the same handshake in actual Chromium workers.
- An independent code/test review found no actionable correctness issues in the direct traversal, hook behavior, fallbacks or growth handling. A separate [independent numerical audit](review-audit.txt) recomputed every median, log ratio and confidence interval; verified schedule, warmup, source snapshots against Git and identical WASM; and checked all 400 processes, 3,600 measured batches and 5,650,496 returned-checksum validations. The repository verifier also passes with exact-current-source matching enabled.

## Reproduction and evidence

Build independent checkouts of the baseline and this candidate with the same dependencies:

```sh
bun run build:wasm
bun run build:browser
node node_modules/vitest/vitest.mjs run map-foreach.test.ts shared-map.test.ts map-values-view.test.ts
bun --bun node_modules/vitest/vitest.mjs run map-foreach.test.ts shared-map.test.ts map-values-view.test.ts
node proofs/map-foreach-20261108/node-worker.mjs
node proofs/map-foreach-20261108/browser-check.mjs
```

Use an allowed CPU number in place of `2` if needed. Use new output paths: the driver rejects overwriting existing measurements.

```sh
taskset -c 2 node proofs/compaction-vector-copy-20261108/paired-benchmark.mjs \
  proofs/map-foreach-20261108/workloads.mjs /path/to/baseline /path/to/candidate \
  /path/to/bun /tmp/map-foreach-confirmation.json formal
taskset -c 2 node proofs/compaction-vector-copy-20261108/paired-benchmark.mjs \
  proofs/map-foreach-20261108/workloads.mjs /path/to/baseline /path/to/candidate \
  /path/to/bun /tmp/map-foreach-aa.json aa
node proofs/map-foreach-20261108/verify.mjs
CHECK_CONFIRMED_SOURCE=1 node proofs/map-foreach-20261108/verify.mjs
```

`archive/` preserves the exact driver and workload bytes used for every recording. Each raw study includes exact before/after runtime source snapshots, source/WASM/bundle SHA-256 hashes, environment, process schedule, warmup and measured batches, complete paired estimates and all unfavorable controls. The verifier recomputes these calculations without retiming. Its optional current-source check confirms this candidate; ordinary archive verification remains usable after future code changes.

V1 also reused the captured view for value decoding. V2 deliberately preserves the original decoder's two-argument call and dynamic replacement behavior. V1 results remain archived and are excluded from V2's final claims.
