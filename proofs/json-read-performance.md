# JSON read performance

This revision reduces first-read work for JSON arrays and repeated-read work for cached JSON. On this local shared host, cached list, stack, and queue reads measured **2.31–4.95×** in Node and **2.57–3.75×** in Bun. First reads of feature JSON measured **1.23×** in Node and **1.27–1.37×** in Bun.

The run also contains neutral cases and measured slowdowns. All results are reported below, with the full sample data. Browser and ARM64 verification is pending.

## Change

JSON reads use two paths. A first read decodes UTF-8, parses JSON, and freezes the decoded tree. A repeated read can return a value from the Arena's existing bounded cache.

This PR reduces work on both paths:

- `freeze-json.ts` visits dense JSON arrays by index. It avoids the temporary array that `Object.values()` created for each decoded array. Object records keep the existing `Object.values()` traversal.
- `arena.ts` checks the sequence-value cache in `decode()` before reading the record length. It also checks the cache in `decodeAt()` before refreshing the memory view. A cache miss still refreshes the view before reading bytes.
- `codec.ts` uses the same freeze helper as the Arena. The `freezeJSON` export from `arena.ts` remains available.

The helper uses an explicit work list, so the traversal does not consume the JavaScript call stack. It freezes decoded data and internally constructed JSON trees. Caller input remains mutable.

The change applies through the existing JSON decoder in all nine JSON-capable collections and the direct object codec. It requires no application code changes. See [Arena](../arena.ts), [the shared freeze helper](../freeze-json.ts), and [the direct codecs](../codec.ts).

## Measured environment

| Item | Value |
| --- | --- |
| Completed | 2026-10-08T11:14:51.694Z |
| Runtime 1 | Node v22.23.2 |
| Runtime 2 | Bun 1.4.2 |
| CPU | AMD EPYC 9V74 80-Core Processor |
| System | linux, x64, kernel 6.18.44 |
| Host | Shared host; timing varied between rounds |
| Rounds | 3 |
| Warm-up runs per child process | 10 |
| Measured samples per round and revision | 12 |
| Samples per case and revision in each runtime | 36 |
| Completed child processes | 240 |

The comparison baseline is commit `1d7accd0b566818c9c0d332b533c3eb504fac685`. Both revisions use the same build tools and dependencies. The hashes below identify the exact source files, built JavaScript files, and measurement harness.

## Method

The runner starts one new process for each runtime, workload, revision, and round. Each child imports only one revision. The order of the two revisions alternates by workload and round.

The local run uses three rounds, ten warm-up runs, and twelve measured samples per round. Each table row therefore contains 36 measured samples per revision. Its median and p95 (95th percentile) are calculated from all 36 samples. The round range is the minimum and maximum of the three ratios between matched round medians. It is not a confidence interval.

For each warm-up run and measured sample:

1. Attach a new read-only reader outside the timer.
2. For warm cases, read each measured value once to fill the cache. For saturated cases, first read 2,048 earlier records.
3. Run an explicit full garbage collection outside the timer.
4. Time public `get()` or `peek()` calls and a scalar checksum.
5. Outside the timer, check exact values against native JSON semantics, deep freezing, caller ownership, descriptors, byte lengths, and SHA-256 hashes.

Construction, module loading, worker attachment, cache priming, explicit full garbage collection, and verification are outside the timed region. Automatic garbage collection can still occur during a timed read. These measurements concern collection reads.

### Workloads

| Case family | Data and measured work |
| --- | --- |
| Cold flat JSON | 512 objects, each with 32 scalar properties; one read per object |
| Cold feature JSON | 512 feature objects, each with 128 three-dimensional coordinates and nested properties; one read per object |
| Cold coordinate JSON | 512 arrays, each with 128 three-dimensional coordinates; one read per array |
| Cold numeric-array JSON | 512 JSON arrays, each with 512 numbers; one read per array |
| Warm JSON | 512 flat JSON values, primed before timing; 32 passes, or 16,384 reads |
| Saturated JSON cache | Read 2,048 flat JSON values before timing, then measure 512 later values that cannot enter the full cache |
| Cold primitive controls | 8,192 native number or string values; one read per value |
| Warm primitive controls | 512 native number or string values, primed before timing; 32 passes, or 16,384 reads |

The stack and queue cases read 512 retained snapshots with distinct values. They do not repeat one constant top value. In the table, `cold-list-numbers` is the **JSON numeric-array** workload. The `*-number` cases use the native number codec and serve as controls.

The [workload definitions](json-read-workloads.mjs), [single-process case runner](json-read-case.mjs), and [comparison runner](run-json-read.mjs) contain the full method.

## Results

All times are milliseconds for the complete workload in one measured sample. **Ratio = before median / after median**: a value above 1 means faster; a value below 1 means slower. Both runtime tables include all 20 cases, including controls and slower cases.

### Node v22.23.2

| Case | Median before | Median after | Ratio | p95 before | p95 after | Round ratio range |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `cold-map-flat` | 2.083 | 2.070 | 1.01× | 3.151 | 2.970 | 0.85×–1.08× |
| `cold-list-flat` | 1.194 | 1.172 | 1.02× | 1.804 | 1.824 | 0.88×–1.13× |
| `cold-map-feature` | 39.030 | 31.786 | 1.23× | 46.852 | 34.929 | 1.18×–1.32× |
| `cold-list-feature` | 37.713 | 30.588 | 1.23× | 42.885 | 47.031 | 1.14×–1.23× |
| `cold-list-coordinates` | 37.183 | 31.490 | 1.18× | 47.692 | 34.384 | 1.17×–1.20× |
| `cold-list-numbers` | 17.181 | 11.905 | 1.44× | 21.533 | 15.272 | 1.32×–1.45× |
| `warm-map-json` | 1.877 | 1.484 | 1.27× | 2.213 | 1.798 | 1.12×–1.45× |
| `warm-list-json` | 1.225 | 0.369 | 3.32× | 2.038 | 0.420 | 3.33×–3.53× |
| `warm-stack-json` | 1.221 | 0.247 | 4.95× | 1.695 | 0.383 | 4.10×–5.56× |
| `warm-queue-json` | 1.853 | 0.803 | 2.31× | 2.370 | 1.126 | 2.27×–2.37× |
| `saturated-map-json` | 1.406 | 1.382 | 1.02× | 1.955 | 2.133 | 0.94×–1.11× |
| `saturated-list-json` | 1.127 | 1.090 | 1.03× | 1.408 | 1.422 | 0.99×–1.11× |
| `cold-map-number` | 6.004 | 5.982 | 1.00× | 7.485 | 7.804 | 0.93×–2.22× |
| `cold-list-number` | 0.097 | 0.054 | 1.80× | 0.121 | 0.107 | 1.74×–1.81× |
| `cold-map-string` | 7.959 | 7.316 | 1.09× | 9.847 | 9.847 | 1.05×–1.12× |
| `cold-list-string` | 3.464 | 3.798 | 0.91× | 5.410 | 6.379 | 0.79×–0.91× |
| `warm-map-number` | 0.435 | 0.391 | 1.11× | 0.538 | 0.511 | 0.86×–1.41× |
| `warm-list-number` | 0.102 | 0.149 | 0.68× | 0.182 | 0.212 | 0.55×–1.03× |
| `warm-map-string` | 0.465 | 0.491 | 0.95× | 0.564 | 0.814 | 0.62×–1.01× |
| `warm-list-string` | 0.334 | 0.220 | 1.52× | 0.398 | 0.366 | 0.95×–1.72× |

### Bun 1.4.2

| Case | Median before | Median after | Ratio | p95 before | p95 after | Round ratio range |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `cold-map-flat` | 1.017 | 1.047 | 0.97× | 1.689 | 1.299 | 0.91×–1.01× |
| `cold-list-flat` | 0.886 | 0.881 | 1.01× | 2.094 | 1.155 | 0.98×–1.02× |
| `cold-map-feature` | 60.505 | 47.680 | 1.27× | 73.895 | 56.794 | 1.15×–1.39× |
| `cold-list-feature` | 60.236 | 44.006 | 1.37× | 68.855 | 52.433 | 1.32×–1.39× |
| `cold-list-coordinates` | 62.330 | 42.841 | 1.45× | 75.444 | 55.516 | 1.28×–1.53× |
| `cold-list-numbers` | 49.964 | 34.956 | 1.43× | 70.129 | 40.062 | 1.41×–1.54× |
| `warm-map-json` | 0.864 | 0.756 | 1.14× | 1.434 | 1.090 | 0.98×–1.48× |
| `warm-list-json` | 0.668 | 0.207 | 3.23× | 1.077 | 0.319 | 2.63×–3.11× |
| `warm-stack-json` | 0.717 | 0.191 | 3.75× | 0.935 | 0.426 | 2.91×–4.15× |
| `warm-queue-json` | 0.837 | 0.326 | 2.57× | 1.451 | 0.532 | 2.26×–3.65× |
| `saturated-map-json` | 1.121 | 1.103 | 1.02× | 1.687 | 1.774 | 1.02×–1.07× |
| `saturated-list-json` | 0.883 | 0.902 | 0.98× | 1.259 | 1.131 | 0.95×–1.03× |
| `cold-map-number` | 1.343 | 1.385 | 0.97× | 1.898 | 1.899 | 0.90×–1.11× |
| `cold-list-number` | 0.063 | 0.064 | 0.98× | 0.160 | 0.088 | 0.87×–1.03× |
| `cold-map-string` | 2.595 | 2.750 | 0.94× | 4.072 | 4.162 | 0.91×–0.98× |
| `cold-list-string` | 3.236 | 3.294 | 0.98× | 3.950 | 4.563 | 0.71×–1.04× |
| `warm-map-number` | 0.168 | 0.191 | 0.88× | 0.437 | 0.337 | 0.58×–1.88× |
| `warm-list-number` | 0.086 | 0.084 | 1.02× | 0.162 | 0.221 | 0.69×–1.13× |
| `warm-map-string` | 0.175 | 0.216 | 0.81× | 0.360 | 0.330 | 0.76×–0.96× |
| `warm-list-string` | 0.230 | 0.206 | 1.12× | 0.373 | 0.338 | 0.96×–1.29× |

Displayed times are rounded to three decimal places and ratios to two decimal places. The raw files retain the full recorded precision.

## Interpretation and limits

The largest measured gains are repeated reads of cached JSON. The list, stack, and queue cases improved in all three rounds in both runtimes. These paths avoid memory-view and record-length work when the decoded value is already cached. Warm map reads show a smaller pooled gain: **1.27×** in Node and **1.14×** in Bun. Map reads still locate the value through the leaf metadata.

The cold coordinate and numeric-array cases improved in every round in both runtimes. The numeric-array case measured **1.44×** in Node and **1.43×** in Bun. Cold flat JSON and the full-cache cases stayed close to 1× in the pooled medians. This is consistent with the change targeting array traversal and cache hits.

Tail timing did not improve in every case. For example, Node `cold-list-feature` improved in median time, but its p95 rose from **42.885 ms** to **47.031 ms**.

The controls include substantial slowdowns: Node `warm-list-number` measured **0.68×**, and Bun `warm-map-string` measured **0.81×**. They also include apparent gains, such as Node `cold-list-number` at **1.80×**. These control results remain part of the assessment. A/A results are provided below.

This run used a shared host, and timing varied between rounds. The primitive controls also show material changes even though their read algorithms were not changed. Those results do not isolate the cause of every change. They can include host variance and runtime code generation effects. The tables retain every measured slowdown. This report does not establish that all other reads are free from regressions.

This is a read benchmark on synthetic data. It does not measure a complete Map Creator task, map-tile loading, worker startup, worker transport, or application latency. It also does not measure total JavaScript heap use, peak RSS, or garbage-collection pressure. The removed temporary arrays follow directly from the code change; the memory assertions below concern the stored snapshot bytes and backing memory.

## A/A control

A separate A/A run compared the baseline build with itself for six cases in each runtime. It completed **72 child processes and 864 measured samples**. It used the same host, workload definitions, new read-only readers, alternating comparison order, ten warm-up runs, twelve measured samples, and three rounds. Each label has 36 measured samples per case. Explicit full garbage collection ran outside the timer; automatic garbage collection could still occur during reads.

Both comparison labels have identical source and build hashes. The build SHA-256 for both is `b5e659960929c13d5f145b0a6b20eae344a0e6c9b901c1d1c88ffb93e2d46e5f`. The harness hash is also identical to the main comparison.

Times below are milliseconds. The ratio compares the two labels of the same baseline build.

| Runtime | Case | A median | A repeat median | Ratio | Round ratio range |
| --- | --- | ---: | ---: | ---: | ---: |
| Node 22.23.2 | `cold-map-flat` | 2.480 | 2.304 | 1.077× | 0.908×–1.436× |
| Node 22.23.2 | `cold-list-flat` | 1.221 | 1.265 | 0.966× | 0.960×–1.033× |
| Node 22.23.2 | `saturated-map-json` | 1.503 | 1.445 | 1.040× | 0.860×–1.209× |
| Node 22.23.2 | `cold-list-number` | 0.096 | 0.096 | 1.000× | 0.982×–1.003× |
| Node 22.23.2 | `cold-list-string` | 4.965 | 3.818 | 1.300× | 0.691×–1.429× |
| Node 22.23.2 | `warm-list-number` | 0.184 | 0.184 | 1.001× | 0.651×–1.720× |
| Bun 1.4.2 | `cold-map-flat` | 1.258 | 1.154 | 1.091× | 0.952×–1.101× |
| Bun 1.4.2 | `cold-list-flat` | 0.934 | 0.916 | 1.020× | 0.934×–1.045× |
| Bun 1.4.2 | `saturated-map-json` | 1.175 | 1.186 | 0.990× | 0.907×–1.091× |
| Bun 1.4.2 | `cold-list-number` | 0.071 | 0.071 | 1.008× | 0.951×–1.093× |
| Bun 1.4.2 | `cold-list-string` | 3.501 | 3.538 | 0.989× | 0.877×–1.131× |
| Bun 1.4.2 | `warm-list-number` | 0.088 | 0.098 | 0.901× | 0.794×–1.283× |

Node warm numeric-list reads have a pooled A/A ratio of **1.001×**, but the round ratios range from **0.651× to 1.720×**. Node cold string-list reads range from **0.691× to 1.429×**. Bun warm numeric-list reads have a pooled ratio of **0.901×** and a round range of **0.794× to 1.283×**. Thus, the same build can produce substantial apparent changes on this host.

The A/A run is a separate variance check. It is not a correction factor for the main results, and it does not rule out real regressions. The main measurements remain unchanged. Browser and architecture CI results are still needed for platform conclusions.

A/A evidence:

- [Summary and hashes](json-read-results/aa/summary.json)
- Node raw samples: [round 1](json-read-results/aa/node-1.json), [round 2](json-read-results/aa/node-2.json), [round 3](json-read-results/aa/node-3.json)
- Bun raw samples: [round 1](json-read-results/aa/bun-1.json), [round 2](json-read-results/aa/bun-2.json), [round 3](json-read-results/aa/bun-3.json)

## Storage and correctness

Every matched before/after case must have identical allocated payload bytes, snapshot descriptors, used length, and backing-memory length. The runner rejects a mismatch. It checks the same invariants after every warm-up run and measured sample.

| Contract | Result |
| --- | --- |
| Binary layout and transport format | Unchanged; format version 4 |
| Allocated payload and descriptor hashes | Equal between revisions in every measured pair |
| Arena used length and backing length | Equal between revisions and unchanged by reads |
| Existing decoded-value cache | Same 2,048-entry and 2 MiB limits; no additional cache |
| Cached values | Original immutable identity retained, including JSON scalar roots |
| Values outside the cache | Still fully decoded and deeply frozen |
| Shared memory growth | Cached snapshots remain valid; uncached byte reads refresh their views |
| Caller input | Not frozen or modified |
| Array and object semantics | Dense JSON arrays use indexed traversal; record traversal remains unchanged |

The [unit cache tests](../json-read-cache.test.ts), [freeze-helper tests](../freeze-json.test.ts), and [public read proof](json-read-correctness.mjs) cover these rules. The public proof exercises all nine JSON collections, retained snapshots, forks, resets, compaction, nested collection wrappers, and real workers.

### Local validation

- 746 distinct unit and integration tests passed: the full 739-test run and the seven new cache tests.
- The public JSON-read proof passed seven tests under Node. Under Bun, six tests passed and one shared-memory worker case was skipped; Bun's supported copy transport was tested.
- Type checks, public-export checks, real-worker checks, and installed-package checks passed.
- Local browser-engine runs were unavailable. The [GitHub workflow](../.github/workflows/json-read-performance.yml) checks Node and Bun on x64 and ARM64, and Chromium, Firefox, and WebKit on x64.

**GitHub CI status: pending.** The local results above do not establish browser or ARM64 performance.

## Evidence and hashes

The [machine-readable summary](json-read-results/local/summary.json) contains all per-case payload hashes, descriptor hashes, byte lengths, medians, p95 values, and round ratios.

Raw samples and verification records:

- [Node, round 1](json-read-results/local/node-1.json)
- [Node, round 2](json-read-results/local/node-2.json)
- [Node, round 3](json-read-results/local/node-3.json)
- [Bun, round 1](json-read-results/local/bun-1.json)
- [Bun, round 2](json-read-results/local/bun-2.json)
- [Bun, round 3](json-read-results/local/bun-3.json)

| Evidence | SHA-256 |
| --- | --- |
| Baseline sources | `6df52b15f79132b08d990625a5026e333fbad0f5368aa795e9c22b34a0515a77` |
| Candidate sources | `1f022d58f5ccb8dca2fc299dc8dde34e1c112923d3a0673df20b12b23619d9f4` |
| Baseline build | `b5e659960929c13d5f145b0a6b20eae344a0e6c9b901c1d1c88ffb93e2d46e5f` |
| Candidate build | `9020368e766ad430f4f7f76e3dd31d7928337bff8b6cd91165594d9fd38c49ed` |
| Measurement harness | `a41d07c960624cfe3f4fcb985aea5c62ec0d538f256e563d36e77f9665dd2733` |

Source hashes cover root TypeScript files except test files. Build hashes cover the built JavaScript files. The harness hash covers `json-read-case.mjs` and `json-read-workloads.mjs`. Per-file names participate in each hash.

## Reproduce the local method

Build the baseline commit and this revision with the same tools and dependencies. Then run:

```sh
JSON_READ_COUNT=512 \
JSON_READ_PASSES=32 \
JSON_READ_SAMPLES=12 \
JSON_READ_WARMUPS=10 \
JSON_READ_ROUNDS=3 \
node proofs/run-json-read.mjs \
  ../zerocopy-baseline/dist/shared.js \
  dist/shared.js \
  proofs/json-read-results/reproduction
```

Node must support `--expose-gc`, and Bun must be on `PATH`. The comparison runner starts the child processes with the required garbage-collection option. It records runtime versions and machine details, so results from other environments can be compared without treating them as the local measurements.
