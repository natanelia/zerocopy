# Bulk map deletion: first candidate (rejected for latency)

- Baseline runtime: `fd6195bce969423cd5257a5a17be3733502f13e1`
- Candidate runtime: `4fb6cd25fb02ce381bac9ea13ecd1f90b3524de5`
- Harness: `58de8d731872a263d630504973e0de9546dfd3e6`
- [Successful hosted run](https://github.com/natanelia/zerocopy/actions/runs/45511732808)
- [Raw ZIP artifact](https://github.com/natanelia/zerocopy/actions/runs/45511732808/artifacts/14976577114) (expires 2026-12-24 unless retained separately)
- ZIP SHA-256: `ddbd77c1cd41cfb6c81a64807d9982b73063f77e9bc27a32ae70804ceab7a5c2`
- Intel Xeon 6975P-C, Linux x64, Rust 1.100.0, Node 22.23.5, Bun 1.4.2, Chromium 153.0.8010.12, Firefox 155.0.

## Decision

Do not ship the first candidate as a general-purpose optimization. It cuts retained arena allocation substantially but partial deletion slows down across all four engines. These are eight workloads, 11 alternating measured pairs per workload and runtime, plus three warmup pairs and independent identical-build controls. The 64-operation and 8-operation controls are totals rather than individual latencies.

| Workload | Node paired speedup | Bun | Chromium | Firefox | Baseline arena bytes | Candidate arena bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Single delete (64 repeats) | 0.988x | 0.942x | 1.000x | 1.000x | 6144 | 6144 |
| Sparse random (8 repeats) | 0.652x | 0.615x | 0.365x | 0.283x | 133544 | 111536 |
| Unload 10k tile features | 0.672x | 0.760x | 0.526x | 0.777x | 1222956 | 448868 |
| Filter 50k of 100k | 0.691x | 0.753x | 0.572x | 0.825x | 5583364 | 624120 |
| Replace 99k of 100k | 0.662x | 0.797x | 0.491x | 0.846x | 9767800 | 412612 |
| Remove all 10k | 0.801x | 1.170x | 0.513x | 1.196x | 675464 | 0 |
| Duplicates and misses | 0.721x | 0.791x | 0.478x | 0.857x | 381336 | 50088 |
| Missing only (4 repeats) | 0.674x | 0.550x | 0.509x | 0.875x | 0 | 0 |

Speedup is median of paired baseline/candidate durations, not the ratio of separately reported medians. Greater than 1 is faster. The arena byte medians are identical across the four engines. These are allocation deltas, not total resident memory.

All eight JSON cohorts were downloaded and independently checked: 1,408 measured variant records plus 384 warmup records; pairing, alternating order, all reported medians, maximum (descriptive p95 with n=11), arena medians and faster-pair counts were recomputed. A/A bundles were identical to one another and the A/B baseline bundle hashes, and candidate bundle hashes differed. All eight driver exit codes were zero, and stderr was empty. The Rust build audit (7 tests), typecheck, focused deletion suite (10 tests), and existing real Node worker proof passed.

A/A paired speedup ranges across workloads: Node 0.994–1.016x, Bun 0.954–1.001x, Chromium 0.953–1.043x, Firefox 0.965–1.013x. These do not explain the large partial-delete regressions. All-miss controls regressed despite performing no grouped trie mutation. This isolates the lookup/dedup path as a contributor, not proof that any specific function dominates the CPU profile.

## Follow-up

Candidate V2 `bfb7334ac88cbdefe288f209252d5088f955b1c2` preserves the exact grouped kernel but uses a writer-staged native WASM key lookup for keys fitting the existing 48 KiB staging area; oversized keys retain the old lookup. The hypothesis is less JavaScript-side hashing, matching and prefix-cache bookkeeping. This is unverified until the new same-run A/A and A/B cohort finishes. Additional boundary tests cover empty, BOM, unpaired surrogates, exactly 48 KiB, oversized ASCII and oversized UTF-8 keys.

Both revisions remain on the experimental branch; no competing runtime PR was opened. Any useful result must be reconciled with current main and revalidated. Worker round-trip timing, churn/compaction, failure safety, native Map snapshot-copy controls and peak memory remain unmeasured.
