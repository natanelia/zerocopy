# Long literal text search: 5 November 2026

This change accelerates **long case-sensitive misses and matches that start late in a string**. For queries longer than 32 UTF-8 bytes, it rejects rows shorter than the query and uses a bounded native `Uint8Array.indexOf` call to skip an impossible initial prefix. The existing KMP loop then handles the remaining bytes and overlapping prefixes.

Across the five fixed target workloads, the paired estimates improved **6.28–7.11× in Node** and **3.34–17.33× in Bun**. The Chromium supplement improved **3.97–7.33×** by its median paired estimate; every target improved in all four browser pairs. These are workload-specific results from one Linux x64 host.

## Tradeoffs beside the gains

All timings below include compiling the predicate and scanning 2,048 rows. The following slower results are retained:

- **Immediate matches in Bun:** 0.3045 → 0.3486 ms, an increase of 0.0441 ms per scan. The paired after/before estimate is 1.205, with a 95% bootstrap interval of 1.045–1.392.
- **Overlapping prefixes in Node:** 14.8949 → 16.3180 ms, an increase of 1.4231 ms per scan. The paired after/before estimate is 1.132, with a 95% interval of 1.009–1.282.
- **Short-query browser control:** 0.04959 → 0.05281 ms (6.5% higher by the displayed medians; 0.00322 ms absolute). Two of four paired runs were slower; the paired speedups ranged from 0.857× to 1.085×. This small, noisy control result is part of the evidence.

Other Node/Bun control intervals include parity. The change should be judged as a targeted scan optimization, with the slower cases above included in any adoption decision. It does not establish a speedup for every search.

The native search creates one small temporary typed-array view when the first byte needs searching. That view references the original shared bytes; it does not copy the string. There is no dataset-wide answer cache or retained decoded dataset. Heap allocation rates and peak RSS were not measured.

## Node and Bun: all measured cases

Times are milliseconds per compilation plus 2,048-row scan. The displayed times are medians of the six process medians. Speedups use the geometric mean of the six paired ratios, so they need not equal the quotient of the two displayed aggregate medians. An after/before interval below 1 favors the change; an interval above 1 favors the baseline.

### Node 24.22.1

| Case | Role | Before (ms) | After (ms) | Paired speedup | 95% after/before interval |
| --- | --- | ---: | ---: | ---: | --- |
| Missing first byte | target | 6.06329 | 0.90153 | 6.28× | 0.140–0.180 |
| Match late in string | target | 6.41126 | 1.07237 | 6.45× | 0.135–0.177 |
| First byte only near end | target | 6.61719 | 0.90861 | 7.09× | 0.122–0.159 |
| Long UTF-8 query | target | 6.39534 | 1.07661 | 6.40× | 0.136–0.175 |
| Query longer than row | target | 0.19021 | 0.02650 | 7.11× | 0.119–0.166 |
| Common first byte | control | 6.21070 | 6.09271 | 1.06× | 0.843–1.049 |
| Immediate match | control | 0.49795 | 0.52545 | 0.95× | 0.955–1.126 |
| Overlapping prefix | control | 14.89489 | 16.31804 | 0.88× | 1.009–1.282 |
| Case insensitive ASCII | control | 7.14856 | 6.64809 | 1.10× | 0.757–1.072 |
| Case insensitive Unicode | control | 10.09701 | 8.81740 | 1.11× | 0.818–1.003 |
| Short query | control | 0.05702 | 0.05430 | 1.08× | 0.851–1.008 |

### Bun 1.4.2

| Case | Role | Before (ms) | After (ms) | Paired speedup | 95% after/before interval |
| --- | --- | ---: | ---: | ---: | --- |
| Missing first byte | target | 4.29112 | 0.27947 | 16.14× | 0.048–0.079 |
| Match late in string | target | 5.37498 | 0.33583 | 15.28× | 0.059–0.072 |
| First byte only near end | target | 5.15727 | 0.31527 | 17.33× | 0.051–0.064 |
| Long UTF-8 query | target | 5.93607 | 0.32775 | 16.52× | 0.054–0.069 |
| Query longer than row | target | 0.19895 | 0.06150 | 3.34× | 0.254–0.350 |
| Common first byte | control | 6.15112 | 5.61411 | 1.09× | 0.806–1.044 |
| Immediate match | control | 0.30451 | 0.34859 | 0.83× | 1.045–1.392 |
| Overlapping prefix | control | 7.70694 | 8.07730 | 0.97× | 0.984–1.086 |
| Case insensitive ASCII | control | 6.83958 | 6.84037 | 1.04× | 0.783–1.193 |
| Case insensitive Unicode | control | 11.65944 | 11.06980 | 1.01× | 0.877–1.149 |
| Short query | control | 0.08321 | 0.08281 | 1.02× | 0.896–1.072 |

## Chromium supplement: all measured cases

Chromium 153.0.8010.0 ran four balanced pairs in eight fresh timing processes on the same host. This supplement reports medians and the observed paired range, rather than a confidence interval from only four pairs. Case order affects some baseline results: the missing-first-byte target, for example, improved between 1.84× and 6.45× across the four pairs. The complete raw samples preserve that variation.

| Case | Before (ms) | After (ms) | Median paired speedup | Observed paired range |
| --- | ---: | ---: | ---: | --- |
| Missing first byte | 3.42344 | 0.83031 | 3.97× | 1.84–6.45× |
| Match late in string | 4.37000 | 0.88344 | 4.81× | 3.31–6.19× |
| First byte only near end | 4.36156 | 0.80281 | 5.21× | 3.56–6.85× |
| Long UTF-8 query | 4.36406 | 0.88500 | 4.90× | 3.02–6.17× |
| Query longer than row | 0.18277 | 0.02480 | 7.33× | 6.46–11.46× |
| Common first byte | 5.95156 | 5.72344 | 1.06× | 1.00–1.17× |
| Immediate match | 0.55688 | 0.46289 | 1.12× | 1.03–1.39× |
| Overlapping prefix | 15.45375 | 14.35187 | 1.03× | 0.90–1.42× |
| Case insensitive ASCII | 6.65625 | 6.24813 | 1.09× | 0.97–1.21× |
| Case insensitive Unicode | 7.77125 | 8.34562 | 1.00× | 0.86–1.17× |
| Short query | 0.04959 | 0.05281 | 0.95× | 0.86–1.09× |

## Method and source identity

- **Host:** AMD EPYC 9V74, Linux x64. Node/Bun timing processes were pinned to CPU 2. Timing and other CPU-heavy validation were serialized.
- **Fixed baseline:** `501b73819ed7e9bbf7adbb74b03df01045701973`.
- **Measured local runtime commit:** `1e66085b90c081398f3008188592a59dc8da3d70`. The subsequent evidence/test commit changes no production source.
- **Candidate `text-search.ts` SHA-256:** `180832bfe92b4a413510574aef20681076fb554e9d1b888b6223a6aef31a512f`.
- **Node/Bun:** six process pairs per runtime; AB/BA order alternates, as does case order. Each process runs five warm-up batches and nine measured batches for each of the 11 fixed cases. This retains 24 processes, 264 workload records, and 2,376 measured batch samples.
- **Repetitions:** eight scans per batch for most cases, 64 for shorter rows and immediate matches, four for overlapping prefixes, and 256 for the short-query control. Both revisions use the same counts.
- **Workload:** 2,048 rows per case, generally about 1 KiB per row. The shorter-row fixture uses short status strings. Long queries cover ASCII text, repeated prefixes, UTF-8 emoji, and Unicode casing; a short query serves as a control. Exact text generation and query sizes are retained in the fixture module and raw records.
- **Timed work:** compile a predicate for each repetition, visit every index, and accumulate an index-weighted checksum. Data generation, collection construction, and per-row comparison with native `includes` happen before timing. Each timed batch is checked against the independently derived checksum after the timer stops.
- **Uncertainty:** use per-process medians, then paired after/before ratios. The Node/Bun intervals come from 10,000 deterministic bootstrap resamples of whole process pairs. Individual batches are not treated as independent process observations.
- **Integrity:** both builds, their relevant sources, the driver, and fixtures are hashed before and after the run. Changes fail the run. The drivers refuse to overwrite an existing output. All WASM bytes and unrelated library sources used by the Node/Bun proof match the baseline.

The evidence was recorded on 4 November UTC / 5 November in Singapore. The results cover this host and these warmed read workloads; ARM64 and other browser engines were not measured.

## Correctness and validation

The [validation manifest and logs](validation/manifest.json) retain the exact commands and their output.

- Full Bun/Vitest suite: **51 test files and 1,060 tests passed**.
- Five new regressions cover byte alignment, valid multi-byte queries, lone-surrogate fallback, null bytes, repeated prefixes, exact string and memory-end bounds, read-only views, immutable snapshots, growth/reset, and real worker reads.
- All 12 existing Node text-search, scalar-kernel, and batched-kernel proofs passed.
- The new Node worker proof passed with both true shared-memory and copied transport, compiling the query before the owner grows and resets its arena. The Bun worker test uses its supported copied transport.
- TypeScript `tsc --noEmit` passed.
- The browser supplement checked **67,639 assertions** across the 11 fixtures, including writer, shared/copy attachments, retained predicates after allocation growth, and invalid indices.

## Reproduce

Build the fixed baseline and the PR revision with Bun 1.4.2. Use Node 24.22.1 to reproduce the recorded primary runtime. From the candidate checkout:

```sh
git worktree add --detach ../zerocopy-before 501b73819ed7e9bbf7adbb74b03df01045701973
(cd ../zerocopy-before && bun install && bun run build:wasm && bun run build:browser)
bun install
bun run build:wasm && bun run build:browser

# Choose a permitted CPU on Linux; the recorded run used CPU 2.
taskset -c 2 node proofs/long-text-search-20261105/benchmark.mjs \
  ../zerocopy-before . "$(command -v bun)" \
  proofs/long-text-search-20261105/new-run.json

bun --bun node_modules/vitest/vitest.mjs run
node --test proofs/text-search.mjs proofs/text-kernel.mjs proofs/text-batch.mjs \
  proofs/long-text-search-worker.node.mjs
node node_modules/typescript/bin/tsc --noEmit
```

The Chromium driver takes explicit paths and writes to a new output. `CHROMIUM_EXECUTABLE` may select a local Chromium installation; otherwise Playwright uses its configured browser:

```sh
BROWSER_BASE_ROOT=../zerocopy-before \
BROWSER_CANDIDATE_ROOT=. \
BROWSER_OUTPUT=proofs/long-text-search-20261105/new-browser-run.json \
  node proofs/long-text-search-20261105/browser-benchmark.mjs
```

## Retained evidence and explored alternatives

- [Node/Bun driver](benchmark.mjs), [fixed fixtures](fixtures.mjs), and [complete Node/Bun results](results.json).
- [Browser driver](browser-benchmark.mjs) and [complete browser results](browser-results.json).
- [Exploration manifest](exploration/manifest.json) retains all earlier unpaired measurements, the exploratory driver, and the source variants. These runs are excluded from the final paired estimates.

Four broader approaches were rejected during exploration: DataView word skipping caused large Bun slowdowns; byte unrolling and aligned word reads hurt controls; repeatedly calling native search between KMP candidates worsened overlapping-prefix performance. The selected change performs one initial candidate search and retains the original KMP loop afterward. The remaining measured tradeoffs are shown above.
