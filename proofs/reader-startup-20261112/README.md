# Object-map construction and first reader query

The final candidate improves larger object-map construction. **It does not establish a reliable first-query speedup:** every one of the nine catalog cold-query intervals crosses 1. The earlier first-edit slowdown is substantially resolved. Remaining publication and secondary-workload regressions are disclosed below.

## Implementation

The changes live in [arena.ts](../../arena.ts) and [utf8.ts](../../utf8.ts); applications use the existing APIs and stored format.

- Object/nested-value Map batches with at least 64 surviving entries serialize once per value and pack existing-format records into a private 64 KiB–1 MiB byte stage. Flushing allocates a block, copies its records, and rebases their pointers. This reduces per-record WASM allocations and arena-view updates and batches the final arena copy, without retaining the whole catalog as serialized strings. Smaller batches and primitive writers retain their existing paths. Oversized values, Unicode keys, duplicate ordering, allocator hooks, and reentrant serialization preserve their semantics.
- Object Map reads use a bounded key-to-decoded-value cache for their first stable root, independently of the primitive cache. It only references values already admitted by the existing address cache. Key storage is limited to 2,048 entries and 131,072 UTF-16 characters. The existing object cache admits at most 2,048 entries and 2 MiB of **serialized JSON bytes**; that is not a limit on decoded JavaScript heap size. Historical roots and sorted maps retain their fallback paths and object identity behavior.
- A hash prefix is resolved into the reusable directory on its second use, avoiding an extra WASM traversal for one-off prefixes. Root changes, directory width changes, misses and collisions retain their correctness checks.
- Native browser decoders that reject shared input reuse one lazy 64 KiB ordinary byte buffer. Inputs over that limit and reentrant calls use independent copies. Instance/later method overrides receive owned bytes, and errors release the borrowed buffer. Node/Bun engines that accept shared input keep the direct path. The supported-runtime assumption is that the captured `TextDecoder.prototype.decode` is native at import.

## Exact revisions and method

| Item | Value |
| --- | --- |
| Baseline | `6ee24d20e6be91e1d757995770654a249b489d0f` |
| Measured candidate | `105e6c775021f95594f861a718f23883f650eb2d` |
| Host | Linux x64, AMD EPYC 9V74; shared host; CPU affinity 0–3 |
| Runtimes | Node 24.22.1, Bun 1.4.2, Chromium 153.0.8010.0 |
| Final cohort | 12 alternating process pairs per workload/size in Node and Bun; 14 browser pairs per size, plus two retained warmup pairs |
| Sizes | 1,000 / 10,000 / 100,000 records |
| Controls | Same-build A/A: six Node/Bun pairs and seven browser pairs at 10k/100k; object List and numeric Map secondary workloads in Node/Bun |
| Browser competitors | Native Map, Immutable.js and Immer, 14 samples each at 10k; execution groups rotated |
| Preserved final records | 576, including browser warmups and competitors; all 162 phase summaries independently checked |

The fixed final cohort was chosen before running this materially changed candidate. All timed runs were sequential; no samples or outliers were dropped. [The run plan](plan.json), compressed raw records, exact source/build/fixture hashes, and an independent audit are retained. Later commits that add this report do not change the measured runtime sources. The candidate worktree was clean; the baseline had an untracked generated `geometry-kernels.wat`. Tracked production-source and built-distribution hashes remained fixed throughout each cohort.

Each sample uses a fresh owner and two fresh reader workers. Module imports, worker preparation, deterministic input generation and result checking are outside the timers. Construction includes the same input-freezing pass and arena creation as the website. **There is no query warmup:** the first query starts with empty reader value caches. The repeated query is separate. Browser samples reuse one browser process while creating fresh owner/reader workers; host, file and engine caches are not reset between samples.

The primary workload uses the website's unchanged product catalog: 1,000 requested IDs, 910 hits, 90 misses, nested records, one lookup reader and one validation reader. Full-field fingerprint generation is inside the timed query; comparison with the independent reference is outside. Request/reply messaging and both acknowledgements are included. The object List adapter uses the same records and query functions; numeric Map is the primitive control. These secondary workloads are not additional website benchmarks.

Publication includes descriptor/payload creation, transport and reader attachment. Updating 100 products and querying both current and retained revisions checks the update path and snapshot behavior. `readyMs` is the sum of **construction + publication + first query in each sample**. It prevents hiding work shifted between these phases, but excludes preparation and verification gaps and is not launch-to-ready wall time.

## Catalog construction

Times are medians in milliseconds. The paired estimate is the geometric mean of after/before ratios, followed by its exploratory 95% interval; below 1 means faster. Median times and paired estimates answer different questions and need not move together.

| Runtime | Records | Construction, before → after | Paired ratio (95% interval) | Faster pairs |
| --- | ---: | ---: | ---: | ---: |
| Node 24.22.1 | 1,000 | 10.965 → 8.854 | 0.827 (0.676–1.011) | 11/12 |
| Node 24.22.1 | 10,000 | 50.464 → 46.539 | 0.952 (0.730–1.241) | 9/12 |
| Node 24.22.1 | 100,000 | 373.636 → 321.265 | 0.855 (0.737–0.993) | 10/12 |
| Bun 1.4.2 | 1,000 | 7.817 → 7.403 | 0.937 (0.849–1.034) | 9/12 |
| Bun 1.4.2 | 10,000 | 51.005 → 46.343 | 0.868 (0.775–0.973) | 9/12 |
| Bun 1.4.2 | 100,000 | 682.535 → 336.267 | 0.514 (0.471–0.560) | 12/12 |
| Chromium 153 | 1,000 | 9.130 → 8.923 | 1.104 (0.849–1.435) | 7/14 |
| Chromium 153 | 10,000 | 46.692 → 40.822 | 0.897 (0.815–0.987) | 11/14 |
| Chromium 153 | 100,000 | 400.528 → 338.180 | 0.851 (0.782–0.926) | 12/14 |

The strongest repeated signal is the 100k construction improvement, particularly Bun. Browser 10k construction also improves in both the prior bounded cohort and this final cohort. Small-dataset and Node 10k effects remain uncertain.

## Cold first queries

| Runtime | Records | First query, before → after | Paired ratio (95% interval) | Faster pairs |
| --- | ---: | ---: | ---: | ---: |
| Node 24.22.1 | 1,000 | 15.516 → 15.901 | 1.051 (0.906–1.220) | 6/12 |
| Node 24.22.1 | 10,000 | 21.971 → 20.671 | 1.056 (0.851–1.310) | 8/12 |
| Node 24.22.1 | 100,000 | 18.416 → 17.632 | 0.983 (0.799–1.209) | 8/12 |
| Bun 1.4.2 | 1,000 | 15.467 → 14.824 | 0.893 (0.760–1.050) | 7/12 |
| Bun 1.4.2 | 10,000 | 18.378 → 16.428 | 0.893 (0.758–1.052) | 8/12 |
| Bun 1.4.2 | 100,000 | 19.569 → 17.264 | 0.805 (0.637–1.016) | 8/12 |
| Chromium 153 | 1,000 | 16.635 → 18.777 | 1.023 (0.835–1.253) | 5/14 |
| Chromium 153 | 10,000 | 17.752 → 15.133 | 0.932 (0.773–1.124) | 9/14 |
| Chromium 153 | 100,000 | 17.457 → 16.280 | 0.926 (0.783–1.095) | 8/14 |

**None of these nine intervals establishes a cold-query win.** Chromium 10k's median improves, while Chromium 1k's median worsens. The scratch-buffer change demonstrably removes repeated byte-buffer allocation on the native browser fallback, and Node repeated object-map queries improve, but those facts do not prove a broad first-query latency improvement.

## First-edit guard and remaining adverse results

The first bounded prototype left 100-product edits on a separate small-batch writer path. The final helper and 64-entry threshold address that suspected cause without changing serialization semantics. Final median edit times improve at all nine catalog points; favorable intervals occur at Node 1k/10k, Bun 100k and Chromium 1k/100k. Attribution to JIT/cold-path effects is a hypothesis, not an isolated causal measurement.

Remaining adverse endpoints are part of the result:

| Runtime/workload | Phase | Before → after (ms) | Paired ratio (95% interval) |
| --- | --- | ---: | ---: |
| Chromium 153, catalog-map, 100,000 | publicationMs | 1.800 → 5.683 | 2.815 (2.052–3.862) |
| Chromium 153, catalog-map, 10,000 | editPublicationMs | 0.433 → 0.517 | 1.546 (1.115–2.144) |
| Node 24.22.1, catalog-map, 100,000 | publicationMs | 1.833 → 2.025 | 1.162 (1.035–1.303) |
| Bun 1.4.2, object-list, 10,000 | editPublicationMs | 1.907 → 2.457 | 1.372 (1.034–1.820) |
| Bun 1.4.2, number-map, 10,000 | repeatQueryMs | 0.900 → 1.998 | 1.516 (1.000–2.297) |
| Bun 1.4.2, catalog-map, 10,000 | updatedQueryMs | 8.210 → 11.487 | 1.297 (0.966–1.740) |
| Node 24.22.1, catalog-map, 100,000 | updatedQueryMs | 12.250 → 12.486 | 1.212 (0.745–1.971) |

Chromium 100k publication is a consistent relative slowdown and adds about 3.88 ms at the median. Its combined measured stages still improve from 421.788 to 360.060 ms (paired ratio 0.864, interval 0.797–0.936). That combined result does not erase the publication regression. Bun numeric 10k repeated-query and object-List edited-publication results also prevent a claim that all controls are neutral. The numeric repeated-query interval is borderline: its exact lower bound is 1.000458, displayed as 1.000. Edited-query regressions with intervals crossing 1 remain unresolved, rather than being discarded.

[All phases and secondary workloads](RESULTS.md) are reported, including repeated queries, edits, publication, retained revisions, ranges and paired results in the raw data.

## Current browser comparison at 10k

| Implementation | Construction | Publication | First query | Repeated query | Combined measured stages |
| --- | ---: | ---: | ---: | ---: | ---: |
| ZeroCopy baseline | 46.692 | 1.470 | 17.752 | 2.770 | 65.343 |
| ZeroCopy candidate | 40.822 | 1.455 | 15.133 | 2.828 | 56.755 |
| Native Map | 3.605 | 62.193 | 6.130 | 2.705 | 71.085 |
| Immutable.js | 11.457 | 93.845 | 7.228 | 3.145 | 110.090 |
| Immer | 11.118 | 65.565 | 5.360 | 3.055 | 83.890 |

These are fresh local samples, not previously recorded website numbers. The combined column is the median of per-sample sums, so it need not equal the sum of the displayed phase medians.

ZeroCopy still has slower construction and cold queries than these alternatives in this workload. Its shared publication is much cheaper. The [storage implementation](../../website/assets/feature-storage.mjs) structured-clones and freezes native/Immer reader objects during publication; Immutable.js also reconstructs its map. ZeroCopy attaches shared arena/root handles and defers UTF-8 decoding, `JSON.parse` and deep freezing until the first hit, as shown in [Arena.decodeAt](../../arena.ts) and [freezeJSON](../../freeze-json.ts). This phase difference helps explain the remaining gap, but does not establish how much time each individual operation contributes. The extra materialization work belongs to the current object codec, not to every possible shared-memory representation. A larger potential follow-up is a shared record/view representation that can read fields directly, with explicit conversion when callers need ordinary frozen JavaScript objects. That requires separate format, nested-value, identity, snapshot and compatibility design; the present results do not establish its performance.

## Noise and statistical limits

Intervals use Student-t on paired log(after/before) ratios, then exponentiation: `exp(mean(log(r)) ± t * stdev(log(r)) / sqrt(n))`. They estimate geometric ratios, not median ratios. They are exploratory and unadjusted for the many endpoints; there is no hardware-independent speed guarantee.

The A/A controls demonstrate the limitation. Identical Chromium code appears 18% faster for the 100k first query by median paired ratio (5/7 pairs); its interval crosses 1. Identical Bun code appears 40% slower for that query. Eight of 108 unchanged-code intervals exclude 1, including Node 100k object-List construction. Small isolated changes, or an unadjusted interval alone, are not enough to identify a code effect. A/A records are kept separate: they do not normalize A/B numbers or justify removing slow samples.

All Node/Bun matched samples have identical arena used bytes and capacity between revisions, recorded after the edit for object workloads. This checks stored-data allocation, not total JavaScript heap use, peak RSS or GC pressure. No causal GC claim is made. Browser testing is Chromium on this x64 host; other browsers and architectures are not established by this cohort.

## Correctness and evidence

- 1,246 tests in 65 files pass with `vitest run --isolate --maxWorkers=2`.
- TypeScript, portable build, declarations and diff checks pass.
- Actual Chromium shared-input rejection and 37 decoder/collection checks pass: Unicode, BOM, fatal errors, subviews, 64 KiB boundary, oversized values, reentry, retained custom-method inputs, shared/copied readers and nested freezing.
- Node worker proofs pass for shared/copy transport, typed/nested JSON, retained snapshots, growth, compaction, 12 collection types and at least 10,000 concurrent reads.
- The final independent audit verifies 576 raw records, 162 phase summaries, source/build/fixture hashes, independent answers, per-sample sums and matching arena bytes. A/A independently verifies 180 records and 108 summaries.

See [validation](validation.txt), [browser checks](utf8-browser.json), [final audit](results/audit-final.json.gz), [A/A audit](results/audit-aa.json.gz) and the [evidence manifest](manifest.json). Raw records are losslessly gzip-compressed to keep this review manageable; `gzip -dc FILE.json.gz` recovers the original JSON exactly. The manifest records both compressed and original SHA-256 digests.

### Retained experiments

| Cohort | Source | Files / assessment |
| --- | --- | --- |
| Final | `105e6c7` | `results/final-{node,bun,chromium}.json.gz`; all results above |
| Same-build controls | baseline in both arms | `results/aa-{node,bun,chromium}.json.gz` |
| Superseded bounded writer | `5a21934` | `results/superseded-bounded-*.json.gz`; construction gains but first-edit regressions; not pooled with final |
| Rejected whole-batch writer | `3ba5fbb` | `results/rejected-whole-batch-*.json.gz`; Node 10k construction 50.199→61.666 ms, Chromium 100k 393.885→454.310 ms; rejected despite Bun gains |
| Reader-only diagnosis | dirty derivative of `3ba5fbb` | `results/diagnostic-reader-only-*` plus exact compressed patch; only three pairs, not final evidence |
| Early exploratory probes | working-tree experiments | `results/diagnostic-exploratory-chromium.json.gz` and `diagnostic-native-json.json.gz`; exploratory only, not pooled or used as final effect estimates |

## Reproduce

Build both revisions independently from source with the same lockfile/dependencies (`build:wasm` and `build:browser`). Run one timed job at a time and write outputs outside either measured checkout. The harness refuses to overwrite evidence and verifies source/build/fixture identities after each cohort.

```sh
node proofs/reader-startup-20261112/run.mjs /path/to/baseline /path/to/candidate /tmp/reader-node.json 12
bun proofs/reader-startup-20261112/run.mjs /path/to/baseline /path/to/candidate /tmp/reader-bun.json 12
CHROMIUM_EXECUTABLE=/path/to/chromium COMPETITORS=1 node proofs/reader-startup-20261112/browser.mjs /path/to/baseline /path/to/candidate /tmp/reader-browser.json 14
```

The recorded Linux runs prefixed these commands with `taskset -c 0-3`. Choose valid CPUs for your host. Node/Bun default to all three sizes and three workloads; `SIZES=10000,100000` selects sizes. Browser `COUNTS=10000,100000` selects sizes. For A/A, give the baseline path for both arms, use six Node/Bun or seven browser pairs, and omit competitors. Browser warmups still use fresh owners/readers and are retained in the raw file.

For actual browser UTF-8 checks, compile `utf8.ts` as an ES module and run [utf8-browser-check.mjs](utf8-browser-check.mjs) with the module path and an output JSON path. See its first two lines for the commands.
