# Catalog reads across worker publications

After 100 sparse edits, an updated read-only attachment can reuse a previously decoded and deeply frozen JSON record. A new reader checks the arena ID, location and byte length. When the memory handles differ, it compares every stored byte at that location before reuse. Both views read native 32-bit words through the aligned middle and individual bytes at the edges. A weak reference lets a prior reader be collected. Each reader keeps the existing limits of 2,048 records and 2 MiB of serialized content. The run measured elapsed time. JavaScript heap and peak RSS were outside its scope.

## Full-object reads after editing

Each reader requests 1,000 distinct IDs, finds 910 products, and sees 100 edited values, 810 unchanged values and 90 misses. Every sample creates a new owner and two new reader workers. The website measures the slower worker’s local query. The round trip includes both replies and the cost of returning the values to the owner. The two columns of times use independent medians. The speedup is the median of the baseline time divided by the candidate time **within each pair**. A speedup below 1 means the candidate took longer. The final figure in each cell counts pairs in which the candidate finished sooner.

| Catalog | Firefox · old → new · paired speedup · faster pairs | Chromium · old → new · paired speedup · faster pairs |
| --- | ---: | ---: |
| 1,000 products | 9.00 → 3.90 ms · 2.13× · 7/7 | 5.80 → 4.57 ms · 1.22× · 6/7 |
| 10,000 products | 8.42 → 3.64 ms · 2.45× · 11/11 | 7.04 → 5.12 ms · 1.22× · 9/11 |
| 100,000 products | 8.12 → 3.92 ms · 2.10× · 11/11 | 7.09 → 5.45 ms · 1.24× · 9/11 |

## Query paths at 10,000 products

All rows time the query on the updated revision. The two ordinary `.get()` paths use the previous attachment. The view, explicit conversion and native Map controls exercise different read paths. Each case has its own workers.

| Updated query | Firefox · old → new · paired speedup · faster pairs | Chromium · old → new · paired speedup · faster pairs |
| --- | ---: | ---: |
| Full objects, ordinary `.get()` | 8.42 → 3.64 ms · 2.45× · 11/11 | 7.04 → 5.12 ms · 1.22× · 9/11 |
| Selected fields, ordinary `.get()` | 7.90 → 3.96 ms · 2.35× · 11/11 | 6.79 → 4.42 ms · 1.68× · 11/11 |
| Selected fields, `.getView()` | 4.32 → 4.46 ms · 1.00× · 5/11 | 5.52 → 5.54 ms · 0.92× · 5/11 |
| Frozen `.toObject({ freeze: true })` | 6.70 → 6.38 ms · 1.10× · 7/11 | 6.67 → 6.74 ms · 0.82× · 3/11 |
| Mutable `.toObject()` | 6.46 → 6.12 ms · 1.10× · 9/11 | 6.04 → 6.06 ms · 0.92× · 4/11 |
| Native Map, full objects | 0.38 → 0.32 ms · 0.91× · 5/11 | 0.32 → 0.29 ms · 0.96× · 5/11 |

## Other phases of the 10,000-product full-object query

| Phase | Firefox · old → new · paired speedup · faster pairs | Chromium · old → new · paired speedup · faster pairs |
| --- | ---: | ---: |
| First read on a fresh reader | 10.92 → 10.90 ms · 1.06× · 6/11 | 9.76 → 10.54 ms · 0.87× · 3/11 |
| Immediate repeat on the original revision | 0.86 → 0.80 ms · 0.94× · 5/11 | 0.42 → 0.43 ms · 1.14× · 6/11 |
| Build, initial publication and first round trip | 47.74 → 45.96 ms · 0.97× · 5/11 | 58.55 → 59.10 ms · 1.03× · 6/11 |
| Post-edit query including the worker round trip | 13.18 → 8.02 ms · 1.54× · 10/11 | 11.17 → 9.89 ms · 1.14× · 7/11 |
| Read the retained original revision after the update | 0.38 → 0.28 ms · 1.17× · 10/11 | 0.40 → 0.39 ms · 0.89× · 4/11 |

## Why the byte comparison uses aligned word views

An earlier implementation used a DataView to load four bytes at each step. Across three Chromium runs at 100,000 products, its median paired speedup was 0.96×, with 13 of 29 pairs faster. It prompted a second implementation that visits the unaligned edges separately and reads the middle through two Uint32Array views. The main tables above report that second implementation. [Earlier Chromium trials with build IDs](chromium-earlier-byte-check-100k.json.gz).

## Method and reproduction

Baseline [`4c69aef`](https://github.com/natanelia/zerocopy/commit/4c69aef6e37b6bc955fc708d671e33b5a066ac7a) and measured candidate [`07cef62`](https://github.com/natanelia/zerocopy/commit/07cef620306d365da122af4010428581830f2497). Linux x64 on an Intel Xeon Platinum 8573C. Firefox 155.0, Chromium Headless Shell 153.0.8010.12, Node 24.22.3, Bun 1.4.2 and Rust 1.100.0. One browser ran at a time. Both sites served clean, production builds. The driver rotates workload order and alternates baseline/candidate order per workload. Each block starts with two unreported warm-up pairs, included in the raw files. Build fingerprints cover library bundles, WASM, dependencies and workload source.

Both builds used the same generated fixtures, queries, inclusion rules and answer checks. The candidate’s shared storage adapter passes the preceding attachment only on replacement. The website verifies full values or projected fields, counts, misses, order, both revisions, and each read API’s freezing contract. Both readers passed every check in all 400 measured and warm-up samples.

Use separate checkouts at the two commits above and the same toolchain. Run these commands in each checkout.

```sh
bun install
bun run build:wasm
bun run build:browser
(cd website && npm install --ignore-scripts --no-package-lock)
node website/build.mjs
```

From the candidate checkout, run the following with `BASE` pointing to the built baseline. Playwright needs the Firefox and Chromium browsers installed. Set `BROWSER_EXECUTABLE` to use a matching external browser binary. Choose output filenames that do not already exist.

```sh
cases=full-shared-get,selective-shared-get,selective-shared-view,materialize-shared-frozen,materialize-shared-mutable,full-native-get
for engine in chromium firefox; do
  BROWSER="$engine" node proofs/catalog-perf-20261121/website.mjs "$BASE" . "/tmp/$engine-100k.json" 100000 11 full-shared-get
  BROWSER="$engine" node proofs/catalog-perf-20261121/website.mjs "$BASE" . "/tmp/$engine-10k.json" 10000 11 "$cases"
  BROWSER="$engine" node proofs/catalog-perf-20261121/website.mjs "$BASE" . "/tmp/$engine-1k.json" 1000 7 full-shared-get
done
```

| Raw paired samples | 1,000 products | 10,000 products | 100,000 products |
| --- | --- | --- | --- |
| Firefox | [JSON gzip](firefox-1k.json.gz) | [JSON gzip](firefox-10k.json.gz) | [JSON gzip](firefox-100k.json.gz) |
| Chromium | [JSON gzip](chromium-1k.json.gz) | [JSON gzip](chromium-10k.json.gz) | [JSON gzip](chromium-100k.json.gz) |
