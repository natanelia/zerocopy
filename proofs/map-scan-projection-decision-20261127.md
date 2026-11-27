# Full-map JSON projection decision — 2026-11-27

Baseline runtime `84ad23a76ee197f45cbc7316017f28b5bbe93d6c`; proof `020b6d0cb8d4af71ecbe196b1299e18b793fed1a`; [run 45939597155](https://github.com/natanelia/zerocopy/actions/runs/45939597155). All six jobs succeeded; each ran eight measured rounds across four modes plus one warm-up round (192 measured fresh-process executions, two workers each). The oracle checked sorted result IDs, stable shared iteration order, both entire retained snapshots and point reads.

| Records / shape | Full vs keyed view, five repeat scans (ms) | Paired view/full latency | Paired A/A |
|---|---:|---:|---:|
| 1k flat | 6.34 → 15.99 | 2.589 | 1.085 |
| 1k nested | 8.46 → 22.70 | 2.647 | 0.909 |
| 10k flat | 80.57 → 49.74 | 0.619 | 0.997 |
| 10k nested | 255.51 → 47.92 | 0.190 | 0.996 |
| 100k flat | 470.26 → 324.77 | 0.690 | 0.981 |
| 100k nested | 1465.36 → 281.16 | 0.190 | 1.003 |

100k nested first publication/scan 347.20 → 119.95 ms (paired ratio .340), updated 1452.84 → 312.17 (.217), retained 1431.48 → 290.69 (.200); peak process RSS 399672 → 394020 KiB (includes verification). Native Map first 1187.56 ms, repeat 21.93 ms, peak RSS 1070920 KiB. No default behavior change: small cached maps favor ordinary reads; large nested records benefit from explicit projection.

Next bounded hypothesis: keyed projection enumerates every key, decodes it, then searches the HAMT again. A direct value-view iterator can skip both costs without caching records or changing existing APIs or format. Temporary candidate only on this proof workflow: construct independent JsonViews directly from the same published leaf range in stable traversal order. Benchmark against original keyed projection, identical baseline A/A and full object control; both snapshots and point reads verified, direct iteration also compares every full materialized view and key order. Measure peak RSS before extra correctness checks (not directly comparable with previous peak). No merge or promotion on this screen alone; if positive, test retained views across growth, forks, copied/shared attachment and browser/Bun controls, plus public API design before any focused PR.
