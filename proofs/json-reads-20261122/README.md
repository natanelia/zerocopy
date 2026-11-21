# JSON field lookup and ordinary object reads

Readers now keep byte offsets for frequently requested field names. Another view of the same immutable record can jump to the field, including remembering a previous miss. A separate change speeds up ordinary `.get()` for wide, flat JSON records by freezing the parsed root directly when the source text proves it contains no nested arrays or objects. Quoted opening brackets and leading whitespace can send a record through the existing deep traversal.

Repeating the website’s selected-field query took 25–32% less time by the medians across 1,000, 10,000 and 100,000 products. The candidate finished sooner in 34 of 37 measured pairs. The first query instead took about 1 ms longer at 10,000 and 100,000 products. The website’s ordinary nested-object `.get()` had similar first-read times. For flat records, `.get()` took 47% less time with 256 numeric properties and 51% less with 4,096.

## Website catalog queries

Each cell gives the median baseline and candidate time, the median of the **paired** baseline/candidate ratios, and the number of pairs in which the candidate finished sooner. The middle ratio can differ from the ratio of the displayed medians. The website records the slower of two reader workers. These are query times. End-to-end round trips, worker start-up, and construction times are in the raw files.

| Selected fields via `getView()` | First read | Immediate repeat | First read after 100 edits | Read of retained original |
| --- | --- | --- | --- | --- |
| 1,000 products | 7.43 → 7.35 ms · 1.06× · 7/11 | 2.93 → 2.00 ms · 1.49× · 10/11 | 3.43 → 3.41 ms · 1.01× · 6/11 | 1.66 → 1.32 ms · 1.22× · 9/11 |
| 10,000 products | 6.78 → 7.79 ms · 0.88× · 4/15 | 2.48 → 1.86 ms · 1.60× · 14/15 | 3.19 → 3.66 ms · 0.93× · 4/15 | 1.60 → 1.30 ms · 1.38× · 10/15 |
| 100,000 products | 7.13 → 8.04 ms · 0.87× · 3/11 | 2.85 → 1.94 ms · 1.52× · 10/11 | 3.69 → 3.60 ms · 0.99× · 5/11 | 1.63 → 1.27 ms · 1.19× · 10/11 |

### Other website read paths at 10,000 products

| Query | First read | Immediate repeat | First read after 100 edits | Read of retained original |
| --- | --- | --- | --- | --- |
| Full objects via `.get()` | 7.96 → 7.97 ms · 1.04× · 9/15 | 0.35 → 0.35 ms · 0.94× · 6/15 | 3.36 → 3.29 ms · 0.99× · 6/15 | 0.42 → 0.42 ms · 1.01× · 8/15 |
| Selected fields via `.get()` | 7.62 → 7.54 ms · 0.99× · 7/15 | 0.39 → 0.35 ms · 0.97× · 6/15 | 3.06 → 3.15 ms · 1.01× · 8/15 | 0.30 → 0.30 ms · 0.94× · 5/15 |
| Materialize and deep-freeze | 7.89 → 8.35 ms · 0.96× · 5/15 | 3.24 → 3.59 ms · 0.95× · 4/15 | 5.69 → 6.18 ms · 0.88× · 3/15 | 3.47 → 3.48 ms · 1.00× · 7/15 |
| Materialize mutable values | 6.86 → 6.90 ms · 0.98× · 7/15 | 2.54 → 2.66 ms · 0.97× · 7/15 | 3.72 → 3.78 ms · 0.98× · 7/15 | 2.85 → 2.81 ms · 0.97× · 5/15 |
| Native Map control | 0.80 → 0.86 ms · 0.93× · 4/15 | 0.46 → 0.51 ms · 0.82× · 4/15 | 0.18 → 0.21 ms · 0.91× · 6/15 | 0.39 → 0.41 ms · 0.92× · 5/15 |

The catalog queries request the same 1,000 distinct IDs at each dataset size. Each reader finds 910 products and sees 90 misses. The selected-field query filters category and status, then reads name, nested price and revision. A fresh attachment after edits builds its own field offsets. The native Map runs the same code on both revisions and shows how much timings can vary.

## Ordinary reads and field placement

| Public API and workload | Rows per batch | First read | Immediate repeat |
| --- | ---: | --- | --- |
| `.get()` · 8 numeric properties | 1,024 | 1.61 → 1.56 ms · 1.07× · 7/11 | — |
| `.get()` · 256 numeric properties | 256 | 16.51 → 8.83 ms · 1.87× · 11/11 | — |
| `.get()` · 4,096 numeric properties | 32 | 50.15 → 24.63 ms · 2.02× · 11/11 | — |
| `.get()` · small nested object and array | 1,024 | 2.37 → 2.47 ms · 0.95× · 4/11 | — |
| `.get()` · small row with `[row]` in a string | 1,024 | 1.34 → 1.35 ms · 0.98× · 4/11 | — |
| `getView().get()` · same field after 8 KiB of text | 256 | 1.48 → 1.51 ms · 1.01× · 6/11 | 1.32 → 0.09 ms · 14.57× · 11/11 |
| `getView().get()` · different field name in each row | 1,024 | 0.71 → 0.77 ms · 1.03× · 6/11 | 0.39 → 0.38 ms · 0.94× · 5/11 |

Every ordinary first read uses a fresh reader attachment and queries each row once. The late-field repeat obtains a new view for each key and reuses offsets in the same arena. The unique-field control has one small property per row. Complete answers, nested freezing and the scalar projections are checked outside the timed section.

## Bounds and compatibility

The index is allocated on first field lookup. It holds at most 64 field names, 2,048 locations per field and 8,192 total entries per arena. Names longer than 64 UTF-16 code units and spans over 65,535 bytes use scanning. A previously unseen name in a span shorter than 32 bytes is scanned directly. The cache checks the enclosing span length, including on misses. Each view retains a byte view covering its existing record when shared memory grows. The public read and write APIs use the existing JSON wire format. Peak heap usage was outside this measurement.

## Correctness checks

All 1,285 unit tests passed across 68 files with Node 24.22.3 and Vitest 4.1.10. The tests include missing, escaped and long field names, distinct views over the same address, cache capacity, the 32,768 and 65,536 byte boundaries, and deep freezing. The compiled worker, typed JSON and Redux integration checks also passed. The concurrency check ran 12 readers through 60 writer rounds, including memory growth and continued reads of old records. Package declarations, the ordinary, Redux, geometry and typed-value type checks, and 19 documentation examples passed with TypeScript 6.0.3.

## Reproduce

Baseline `2eb1bfda59f3e516ef174fafb08e1ae8b61d7bff`. Measured candidate `17aa2f79d871001948a70985acb5d5e52a393218`. The recorded runs used Node v24.22.3, Linux 6.18.57 x64, and an AMD EPYC 9V74 80-Core Processor. Both arms used esbuild 0.27.7, the same production WASM kernels, Immutable.js 5.1.9 and Immer 11.1.21. The build manifests contain the JS, WASM, vendor and workload SHA-256 hashes. The four distinct WASM binaries came from the deployed site and match its published manifest.

The website driver runs the existing catalog, owner, reader and verification modules unchanged. It adapts the Web Worker messaging interface to real Node worker threads. Each sample starts a new owner and two new readers, runs two revisions, and checks both workers against the website’s independent reference answers. Each workload has two warm-up pairs followed by the measured pairs. Arm order alternates between pairs and case order rotates. Browser speedups remain unverified. The records driver launches one new process per arm per pair, rotates record workloads and takes the median of seven measured batches after three warm-up batches per case.

Use two clean worktrees at the revisions above, set `BASE` and `CANDIDATE` to their absolute paths, and use new filenames for each run. Install the package and website dependencies in both worktrees and build the WASM with the pinned Rust toolchain as described in [CONTRIBUTING](../../CONTRIBUTING.md). For the bundler used here, install esbuild 0.27.7 in a temporary directory and point `ESBUILD_PATH` at the installed package. Run these commands from the checkout containing this proof.

```sh
proof=proofs/json-reads-20261122
node "$proof/build-esbuild.mjs" "$BASE"
node "$proof/build-esbuild.mjs" "$CANDIDATE"
cases=selective-shared-view,full-shared-get,selective-shared-get,materialize-shared-frozen,materialize-shared-mutable,full-native-get
node "$proof/website-node.mjs" "$BASE" "$CANDIDATE" /tmp/json-10k.json 10000 15 "$cases"
node "$proof/website-node.mjs" "$BASE" "$CANDIDATE" /tmp/json-1k.json 1000 11 selective-shared-view
node "$proof/website-node.mjs" "$BASE" "$CANDIDATE" /tmp/json-100k.json 100000 11 selective-shared-view
node "$proof/records.mjs" "$BASE" "$CANDIDATE" /tmp/json-records.json 11
```

Use the existing [browser driver](../catalog-perf-20261121/website.mjs) on these same builds for separate Chromium and Firefox comparisons.

Raw paired samples and build fingerprints are available for [1,000 products](website-1k.json.gz), [10,000 products](website-10k.json.gz), [100,000 products](website-100k.json.gz) and [public API records](records.json.gz).
