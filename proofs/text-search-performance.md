# Text-search audit and browser evidence

## The cost to remove

A text predicate needs a boolean. The old path called `get()`, decoded UTF-8 to a JavaScript string, lowercased it, and then searched it. Unique messages exceeded the existing bounded decoded-string cache. Enlarging that cache to hold the dataset would undermine the reason to share the bytes.

`SharedList<'string'>.compileTextSearch()` now compiles a query once and searches the stored bytes where the JavaScript matching contract permits it. This is an explicit API, not a change to `get()`. The website calls it once per scan. Native arrays and Immutable.js still use their normal JavaScript string operations.

Short needles (1–16 bytes) use a scratch-free WASM word scan. A query lazily evaluates at most 16 adjacent values per call and keeps two 16-bit masks for the last half-leaf: match and Unicode fallback. This avoids one JavaScript/WASM transition per row. It does not build a text index, keep a full result bitmap, copy the dataset, or write to the owner's memory. Sparse calls can read up to 15 extra values. Longer queries keep bounded byte-skip/KMP paths. Cases that require Unicode casing or isolated UTF-16 surrogate matching use the exact decoded-string operation.

The initial per-row WASM experiment improved unique ASCII messages but regressed repeated text in WebKit. It was not accepted as the final execution strategy. The small, lazy batch retains the byte search while reducing call overhead. A C wrapper was used only for local exploration; all results below use the normal AssemblyScript build, not that wrapper.

## Measured revision

- Candidate code: `96230b6041ed943b4858f3fc4db8fabfb4a2c46a`.
- Tested merge: `b84f3474a00512bd6f0ac675d0f78df2195c5f41`.
- Before: `4f092a3aa1a3bd9ec98a456091e72e33e6428999`, before the compiled search API.
- Run: [Text search performance, 36497739701](https://github.com/natanelia/zerocopy/actions/runs/36497739701), September 28, 2026 UTC.
- Artifact: `text-search-b84f3474a00512bd6f0ac675d0f78df2195c5f41` (ID `11004042972`). SHA-256: `1b61967c9779bd3cb66f6df2f8d0abe58a0d051c6446456539f7aef5fe1bd492`.

Linux CI runner, four reported logical processors; Chromium 153.0.8010.12 and Playwright WebKit 26.6; Immutable.js 5.1.9. These are not physical iPhone measurements. The tables below retain this measured revision even when later documentation or tests change.

## Broad text query

Times are milliseconds; lower is better. Each cell is a median of **nine matching-query samples** across three fresh contexts. Queries are grouped by their actual predicate, not pooled into a misleading mixed score. The update phase appends 2,000 events, publishes them, then executes the query over the updated 102,000-event snapshot.

| Browser | Dataset / query | Before query | New query | Immutable.js query | Before update | New update | Immutable.js update |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | Repeated / `request` | 16.960 | 8.760 | 14.590 | 14.430 | 8.590 | 20.430 |
| Chromium | Unique / `request` | 80.945 | 12.520 | 16.845 | 65.195 | 14.120 | 23.610 |
| Chromium | Unique / `not-present` | 79.260 | 8.920 | 12.695 | 59.320 | 9.635 | 19.435 |
| Chromium | 20% Unicode prefix / `request` | 92.405 | 35.675 | 17.045 | 76.325 | 32.660 | 20.735 |
| Webkit | Repeated / `request` | 14.020 | 10.560 | 13.560 | 13.420 | 11.320 | 18.840 |
| Webkit | Unique / `request` | 63.940 | 10.160 | 17.440 | 57.240 | 12.140 | 23.360 |
| Webkit | Unique / `not-present` | 59.280 | 8.880 | 15.400 | 52.460 | 9.920 | 18.740 |
| Webkit | 20% Unicode prefix / `request` | 64.460 | 25.960 | 20.180 | 63.920 | 24.600 | 24.220 |

Unique ASCII `request` queries improve by about 6.5x in Chromium and 6.3x in WebKit versus the prior implementation. In these runs, new query medians are about 1.35x and 1.72x faster than Immutable.js. Corresponding append/publish/query ratios are about 1.67x and 1.92x. These are ratios of observed medians, not universal speed or statistical-significance claims.

**The mixed-language diagnostic still loses broad text queries to Immutable.js.** A missing ASCII match on non-ASCII bytes can require full JavaScript Unicode lowercasing. That conservative fallback preserves correctness but has a cost. Do not advertise an across-the-board text-search win.

## Filtered queries and non-text controls

Six matching samples per cell. The service-only query does not invoke the text matcher. Small shifts there are a control for ordinary timing variation, not attributed to the text optimization. Some filtered cases remain slower than Immutable.js.

| Browser | Fixture | Query | Before query | New query | Immutable.js query | Before update | New update | Immutable.js update |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | repeated | Error + `timeout` | 5.675 | 4.662 | 7.438 | 6.085 | 5.952 | 11.930 |
| Chromium | repeated | Service only | 5.298 | 6.060 | 7.030 | 5.962 | 6.192 | 11.015 |
| Chromium | unique | Error + `timeout` | 21.145 | 7.030 | 9.260 | 20.057 | 10.278 | 13.702 |
| Chromium | unique | Service only | 6.918 | 5.755 | 7.175 | 8.295 | 8.455 | 11.645 |
| Chromium | unique-miss | Error + `timeout` | 22.267 | 6.618 | 6.083 | 19.257 | 8.827 | 11.005 |
| Chromium | unique-miss | Service only | 12.905 | 5.938 | 7.155 | 8.417 | 8.430 | 12.560 |
| Chromium | unicode | Error + `timeout` | 31.085 | 13.202 | 10.072 | 19.587 | 9.360 | 12.462 |
| Chromium | unicode | Service only | 21.143 | 5.710 | 7.780 | 8.845 | 8.125 | 11.898 |
| Webkit | repeated | Error + `timeout` | 4.420 | 5.640 | 5.820 | 6.230 | 6.410 | 8.350 |
| Webkit | repeated | Service only | 5.120 | 5.950 | 5.070 | 5.840 | 6.940 | 7.680 |
| Webkit | unique | Error + `timeout` | 12.620 | 5.490 | 7.110 | 9.810 | 8.810 | 10.630 |
| Webkit | unique | Service only | 8.830 | 4.880 | 5.600 | 8.100 | 7.320 | 9.850 |
| Webkit | unique-miss | Error + `timeout` | 13.650 | 7.630 | 6.490 | 10.340 | 8.920 | 9.930 |
| Webkit | unique-miss | Service only | 8.650 | 4.970 | 5.530 | 7.740 | 7.260 | 8.900 |
| Webkit | unicode | Error + `timeout` | 14.710 | 6.460 | 7.340 | 9.420 | 7.920 | 10.850 |
| Webkit | unicode | Service only | 7.210 | 6.220 | 6.230 | 7.000 | 8.960 | 8.950 |

## Fair comparison and reproduction

The proof uses the actual four-architecture worker benchmark: shared lists, Immutable.js incremental replicas, native incremental replicas, and one native-data-owning worker. All paths retain identical deterministic input, column layout, filters, visible-row limits, result checks, two-reader roles where applicable, and the same 4,096-index cancellation checkpoints. Immutable.js keeps `withMutations` and incremental deltas. No cloning penalty is added to a query. Compilation of the shared text predicate is inside the measured query.

Each variant uses two warm-up rounds and seven measured samples per path. There are three fresh-context runs, with before/after order alternated. Four fixtures run in both engines: repeated messages; unique IDs added to every message; a broad literal miss; and unique messages with a Chinese prefix on every fifth row. Each fixture change applies to all architectures. This produces **48 run files and 1,344 measured path records**, plus per-query groups. Native alternatives and losing cases stay in the raw evidence.

The query phase includes search, summaries, visible rows, cooperative task yields, and worker messages. Initial data generation and collection construction are separate; worker startup and DOM rendering are excluded. The construction report is not an equal-operation speed comparison: native includes input generation, Immutable.js converts that input, and shared construction also encodes it. This experiment makes no measured-memory or application-wide performance claim. Historical benchmark files are unchanged.

To reproduce, use `.github/workflows/text-search.yml`. It builds the baseline and candidate separately, runs `proofs/text-search-browser.mjs` in both engines, and then runs `proofs/text-search-performance.mjs`. Raw data is written to `proofs/results/text-search/`. `by-query.json` records every sample, and `manifest.json` records the method. Do not compare results from different machines as an engine-only speedup.

## Correctness coverage

`proofs/text-search.mjs` checks the public decoded-string contract, default and insensitive matching, malformed surrogates, contextual casing, NUL, punctuation, long needles, random data, invalid input, readonly attachments, retained snapshots, memory growth, and real concurrent readers. `proofs/text-kernel.mjs` checks strings ending at the final memory byte and verifies no shared writes.

`proofs/text-batch.mjs` compares batch flags to scalar results at every short-query and tail length. It also checks sparse, reverse, and interleaved calls, copied/shared attachments, and a seeded 184,428-comparison full-range Unicode stress test. Browser tests prevent TextDecoder from decoding an ASCII dataset during the predicate and check the same behavior with the real WASM module.
