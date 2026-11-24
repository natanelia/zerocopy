# Selective JSON reads over large records

`JsonView` uses eight-byte WebAssembly loads to skip unselected strings and scan for structural punctuation in nested values. A query can read event status, duration and timestamp while skipping a large log message or a route's coordinates. Existing view methods use this path directly.

## Paired results

Each trace query looks up 10,000 IDs through `SharedMap.getView()` and aggregates slow, failed events. Times are independent medians in milliseconds. The speedup is the median baseline-to-candidate ratio within each pair. Every long-message, nested-message and coordinates pair was faster in all three runtimes.

| Skipped value or workload | Node · ms · paired speedup | Bun · ms · paired speedup | Chromium worker · ms · paired speedup |
| --- | ---: | ---: | ---: |
| Long multilingual message | 31.82 → 10.93 · 2.92× | 59.12 → 11.06 · 5.63× | 32.38 → 11.09 · 3.08× |
| Message inside an object and array | 33.10 → 11.81 · 2.81× | 57.58 → 11.78 · 4.71× | 32.91 → 11.84 · 2.79× |
| Nested route with 128 coordinate pairs | 131.84 → 66.52 · 1.97× | 233.39 → 69.17 · 3.34× | 127.13 → 69.88 · 1.82× |
| Densely escaped message | 23.49 → 20.91 · 1.10× | 39.39 → 37.95 · 1.04× | 24.52 → 23.53 · 1.06× |
| Short trace record | 4.68 → 5.01 · 0.97× | 5.37 → 5.27 · 0.98× | 5.10 → 5.04 · 1.01× |
| Catalog, first selective query | — | — | 8.81 → 8.50 · 0.98× |

The catalog case queries 1,000 product IDs from a 10,000-product catalog. Its timing is the slower of two fresh readers, with the site's projection and snapshot checks. Short trace records and catalog reads were within 4% of baseline by paired median. The trace timings start after the worker attaches and cover lookup, field access and aggregation. Catalog timing covers the reader query phase. Initial construction, publication and peak memory are outside these results.

## Method and reproduction

Measured on November 25, 2026 local time on Linux x64 with an AMD EPYC Milan processor, Node 26.13.1, Bun 1.4.2, Chromium 156.0.8078.4 and Rust 1.100.0. Compared `abece65c0d8d52141ae6657d15636f9444de549f` with the scanner change using the same build tools and workload bytes. There were 11 alternating pairs and three warm-up pairs per case. The Chromium trace workers attach the owning page's shared-memory payload. Node and Bun use read-only attachments in the same process. Each trace sample verifies exactly 1,000 matches and an independently calculated timestamp sum after timing.

Build both checkouts with `bun run build:wasm` and `bun run build:browser`. Run the driver from the candidate checkout. Set `CHROMIUM_PATH` if using an external Chromium binary with Playwright.

```sh
node proofs/json-skip-projection.mjs "$BASE" . /tmp/json-skip-node.json
bun proofs/json-skip-projection.mjs "$BASE" . /tmp/json-skip-bun.json
BROWSER=chromium node proofs/json-skip-projection.mjs "$BASE" . /tmp/json-skip-chromium.json
```

The complete files include warm-ups, paired samples and SHA-256 fingerprints of the driver, fixture, Rust source and measured bundles. [Node](results/json-skip-projection/node.json.gz) · [Bun](results/json-skip-projection/bun.json.gz) · [Chromium](results/json-skip-projection/chromium.json.gz)
