# JSON array cursor: measured results

Repeated `JsonView.at(i)` calls now retain the last successful array position in reader-local state. Forward reads skip only the intervening values; repeated indexes reuse the position; backward reads use the original scanner. A full forward traversal therefore avoids repeatedly scanning its earlier elements.

## Results

Seven alternating baseline/candidate pairs per runtime, using separate processes and the same numeric JSON arrays. All four forward cases improved in **7/7 pairs**. Absolute times below are normalized from the timed batches to one complete traversal; paired speedups are computed separately from matched samples.

| Runtime | Array elements | Before, ms/traversal | After, ms/traversal | Median paired speedup | Faster pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node | 1,024 | 2.958 | 0.190 | 15.4× | 7/7 |
| Node | 4,096 | 45.908 | 0.818 | 55.3× | 7/7 |
| Bun | 1,024 | 3.915 | 0.180 | 22.3× | 7/7 |
| Bun | 4,096 | 65.359 | 0.699 | 93.5× | 7/7 |

These numbers measure `JsonView.at()` over already-created views. They do not describe ordinary full-object `.get()`, worker startup, transport, or overall application latency. Numeric array elements include decimal values; every timed result is captured and checked.

## Every measured case, including controls

A candidate/baseline ratio below 1 means less elapsed time. The time medians, all raw paired ratios and full process samples remain in the linked reports. No samples are removed or normalized.

| Runtime | Case | Median paired ratio | Faster pairs | Shortest timed batch, ms |
| --- | --- | ---: | ---: | ---: |
| Node | `json-array.sequential.1024` | 0.0650 | 7/7 | 90.6 |
| Node | `json-array.sequential.4096` | 0.0181 | 7/7 | 90.5 |
| Node | `json-array.stride.4096` | 0.0075 | 7/7 | 38.5 |
| Node | `json-array.reverse.4096` | 0.9024 | 6/7 | 163.6 |
| Node | `json-array.random.4096` | 0.6251 | 7/7 | 117.9 |
| Node | `json-array.repeated.4096` | 0.0356 | 7/7 | 94.9 |
| Node | `json-array.fields.control` | 1.1262 | 2/7 | 29.1 |
| Bun | `json-array.sequential.1024` | 0.0448 | 7/7 | 72.5 |
| Bun | `json-array.sequential.4096` | 0.0107 | 7/7 | 65.3 |
| Bun | `json-array.stride.4096` | 0.0076 | 7/7 | 33.5 |
| Bun | `json-array.reverse.4096` | 0.9983 | 4/7 | 236.8 |
| Bun | `json-array.random.4096` | 0.7079 | 7/7 | 167.8 |
| Bun | `json-array.repeated.4096` | 0.0181 | 7/7 | 62.5 |
| Bun | `json-array.fields.control` | 0.7708 | 5/7 | 16.0 |

The Node unrelated-field control has a **1.1262** paired ratio (2/7 faster). The identical-build control has a **1.1504** ratio for that same case (also 2/7 faster). That variation prevents confidently attributing this control difference to the cursor change; it does not erase the adverse before/after row. The control runs use larger batches, as specified in the protocol. The Bun field control's shortest formal batch is 16.0 ms and is explicitly flagged by the driver.

Bun reverse traversal has a **0.9983** paired ratio, versus **1.0243** in its identical-build control. Random access improves in this workload because some forward jumps can resume from the current position; backward/random access still has a linear scan in the worst case.

## Source, method and tradeoffs

- Baseline: `1242908762b554e3574365c486d5a6c52d5e568f`.
- Measured candidate: `75409acb6d9eab2b26b693c1d690568cd1cedb11`.
- Node 24.22.3 and Bun 1.4.2, Linux x64. The host reports an AMD EPYC 9V45 processor and nine CPU entries. Both revisions use the pinned Rust 1.100.0 and build dependencies.
- Eight warmups per case; seven independent pairs per runtime; batch scale 2 for the main matrix. Read [the full protocol](PLAN.md) for timing boundaries and reproduction.
- The private cursor adds one lazily allocated index/pointer record per used array view. It retains no materialized array. The core WASM grows by 215 bytes, from 54,845 to 55,060 bytes; total portable JavaScript grows by 704 bytes.
- These reports measure shared arena allocation and byte preservation. They do not measure JavaScript heap, peak memory or browser performance. Small effects on this host are not a general guarantee.

An initial pilot used a factored version of the original scanner and showed a slower Bun reverse result. The final implementation retains the original `jsonArrayAt` body; its optimized WASM body matches the baseline exactly. The initial pilot and the follow-up scanner control are retained separately and are not pooled with final results.

## Correctness

The full hosted CI passed on the measured runtime revision, including all unit/integration tests, types, WASM read-only audits, package consumers, real workers and Chromium browser checks. The website pipeline also passed. [Library CI](https://github.com/natanelia/zerocopy/actions/runs/44289503194) · [Website checks](https://github.com/natanelia/zerocopy/actions/runs/44289503251).

New cases cover forward/backward/repeated/missing indexes, nested array boundaries before siblings, escaped strings, numerical edge cases, deep containers, decoder reentry with memory growth, independent views and retained snapshots. The dedicated [Node worker proof](workers.mjs) and Chromium worker test retain cursors while the writer grows and replaces the current record. Byte checks confirm that readers leave shared storage unchanged.

## Evidence

- [Main raw samples](json-formal.json.gz): 28 verified process samples.
- [Identical-build control samples](json-identical-control.json.gz): 28 process samples.
- [Readable summary of both reports](summary.json).
- [Initial exploratory pilot](exploratory-initial.json.gz) and [restored-scanner control](exploratory-restored-scanner.json.gz). The latter records the then-uncommitted scanner restoration subsequently committed in the measured revision; its source hashes identify the exact code.
- [Lossless archive checksums](archive.json). Gzip archives preserve every original JSON byte.
- [Benchmark driver](../performance-20261118/benchmark.mjs), [workloads](../performance-20261118/workloads.mjs), and [independent verifier](../performance-20261118/verify.mjs).

Verify the archived samples and independently recompute every summary:

```sh
node proofs/performance-20261118/verify.mjs   proofs/json-array-cursor-20261118/json-formal.json.gz   proofs/json-array-cursor-20261118/json-identical-control.json.gz
```
