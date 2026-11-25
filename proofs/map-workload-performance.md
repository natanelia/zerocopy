# Map compaction and application reads

Compaction copies complete leaf records for primitive and JSON-valued maps into one allocation per snapshot. When a group includes several revisions, the compactor reuses the copied address of each shared live leaf. Map iterators reuse a view of the published memory while they visit nodes and decode keys.

`JsonView` can resume a field search near the last successful lookup. After a lookup at least 128 bytes into an object, a short ASCII field search probes up to 64 bytes from the previous value before falling back to the full search. This helps a query read several fields after a large message or coordinate array.

## Map workloads

The catalog starts with 100,000 products from the website fixture and undergoes five rounds of 100 sparse edits. The single-revision case compacts the current catalog. The two-revision case compacts the original and current catalog together. The service aggregate visits all 100,000 numeric records and groups them by the service ID in each key. The numeric sum consumes the same values through `values()`.

| Workload | Node | Bun | Chromium |
| --- | ---: | ---: | ---: |
| Compact current catalog | 230.73 → 116.09 · 1.93× · 11/11 | 704.61 → 194.31 · 3.75× · 11/11 | 184.10 → 97.68 · 1.77× · 11/11 |
| Compact two catalog revisions | 332.79 → 159.92 · 2.12× · 11/11 | 922.58 → 271.63 · 3.45× · 11/11 | 282.68 → 137.79 · 2.16× · 11/11 |
| Aggregate metrics by service | 86.13 → 81.08 · 1.10× · 9/11 | 78.82 → 71.42 · 1.05× · 6/11 | 83.21 → 61.71 · 1.41× · 10/11 |
| Sum numeric metrics | 37.91 → 36.16 · 1.10× · 8/11 | 17.41 → 18.47 · 1.10× · 7/11 | 24.55 → 22.05 · 1.18× · 7/11 |
| Initial catalog import | 282.14 → 273.74 · 1.04× · 7/11 | 430.67 → 402.45 · 1.07× · 8/11 | 327.82 → 343.97 · 0.97× · 5/11 |

Both builds used 26,722,632 arena bytes for the compacted current catalog and 28,220,952 bytes for both compacted revisions. Allocated arena capacity also matched in every pair. These figures describe the shared arena footprint. Timed compaction includes creating the fresh arena, copying the live records and rebuilding the indexes.

## Selective JSON queries

Each trace query examines 10,000 records through `SharedMap.getView()`, filters on duration and status, and aggregates timestamps from 1,000 matching events. The catalog control uses the website's two-reader projection over 1,000 requested IDs from a 10,000-product catalog.

| Workload | Node | Bun | Chromium |
| --- | ---: | ---: | ---: |
| Long multilingual message | 10.45 → 8.10 · 1.33× · 11/11 | 11.43 → 8.41 · 1.33× · 11/11 | 12.32 → 8.35 · 1.35× · 11/11 |
| Nested message | 11.63 → 8.49 · 1.36× · 11/11 | 12.14 → 9.12 · 1.34× · 11/11 | 12.17 → 9.22 · 1.25× · 10/11 |
| 128 coordinate pairs | 66.61 → 45.90 · 1.48× · 11/11 | 69.14 → 46.71 · 1.46× · 11/11 | 67.09 → 47.30 · 1.43× · 11/11 |
| Densely escaped message | 21.25 → 14.64 · 1.42× · 11/11 | 37.57 → 26.81 · 1.42× · 11/11 | 22.09 → 15.66 · 1.42× · 11/11 |
| Short record | 4.98 → 4.73 · 1.09× · 10/11 | 5.48 → 5.30 · 0.98× · 5/11 | 5.20 → 4.67 · 1.11× · 10/11 |
| Catalog, first selective query | — | — | 14.34 → 13.97 · 1.15× · 8/11 |

## Method and reproduction

Each cell shows baseline and candidate medians in milliseconds, the median of the 11 within-pair speedups, and the number of pairs the candidate won. Each case used three warm-up pairs. Workload and build order were rotated. The reference build was `614fa6d663d2f4e70e1e48d2444c916741c8c176`. The raw data records the measured source and bundle fingerprints.

Measured November 25, 2026 on Linux x64 with AMD EPYC Milan, Rust 1.100.0, Node 26.13.1, Bun 1.4.2 and Chromium 156.0.8078.4. Node and Bun queried read-only attachments in the same process, pinned to one logical CPU. Chromium ran on two logical CPUs and measured queries in dedicated workers and map compaction in the owning page. Timed query phases cover local computation after attaching to the writer's arena. Verification ran outside the timers. The map benchmark checked every catalog record on its first warm-up, checked selected records and arena sizes on each following sample, and verified the count and totals of every scan.

Build the baseline and candidate in separate checkouts with `bun run build:wasm` and `bun run build:browser`. Set `BASE` to the baseline directory. Set `CHROMIUM_PATH` to a Chromium executable if Playwright needs an explicit path. Run from the candidate checkout with fresh output filenames.

```sh
for proof in map-lifecycle json-skip-projection; do
  node --expose-gc "proofs/$proof.mjs" "$BASE" . "/tmp/$proof-node.json"
  bun "proofs/$proof.mjs" "$BASE" . "/tmp/$proof-bun.json"
  BROWSER=chromium node "proofs/$proof.mjs" "$BASE" . "/tmp/$proof-chromium.json"
done
```

Map timings and arena sizes. [Node](results/map-workloads-20261125/map-node.json.gz) · [Bun](results/map-workloads-20261125/map-bun.json.gz) · [Chromium](results/map-workloads-20261125/map-chromium.json.gz)

JSON queries and catalog control. [Node](results/map-workloads-20261125/projection-node.json.gz) · [Bun](results/map-workloads-20261125/projection-bun.json.gz) · [Chromium](results/map-workloads-20261125/projection-chromium.json.gz)
