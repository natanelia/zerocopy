# Retained object-map compaction

This change preserves shared HAMT branch and collision records when compacting multiple closely related object-map snapshots. The existing packed rebuild remains the fallback for other inputs. The conservative gate requires 4–64 snapshots, at least four distinct roots in the same native arena, at least 50,000 entries per root, and a bounded lower bound of 90% shared live leaves between adjacent distinct roots. It declines customized traversal/descriptor behavior and journal roots. The stored format, API and snapshot semantics are unchanged.

## Evidence for the exact runtime source

Baseline: [76ab6b5](https://github.com/natanelia/zerocopy/commit/76ab6b53aa0d3b40202720ca12d9fcc904716cf2). Candidate runtime: [6cf0dee](https://github.com/natanelia/zerocopy/commit/6cf0dee378f3225ec9934638fcc3056e79b7cabb). The three runtime files in this change are the same tested blobs. [Full investigation, reproducing scripts and limitations](https://github.com/natanelia/zerocopy/blob/bd61a5a67a9d840063154b647a4ab424917b7992/proofs/retained-map-compaction-20261125.md).

[Exact corrected-runtime qualification](https://github.com/natanelia/zerocopy/actions/runs/45704688724): paired timings on 100,000 catalog records, eight sparse retained revisions. Independent baseline and identical-build control, alternating sample order, exact result checks and worker transport checks. Ratios are medians of paired baseline/candidate times, not necessarily ratios of arm medians.

| Runtime | Baseline median | Candidate median | Paired speedup |
| --- | ---: | ---: | ---: |
| Node | 292.57 ms | 104.07 ms | 2.849x |
| Bun | 289.86 ms | 101.33 ms | 2.787x |
| Chromium | 222.03 ms | 79.09 ms | 2.807x |
| Firefox | 344.74 ms | 99.14 ms | 3.463x |

Node/Bun time compaction; browser time includes compaction and the first useful switched-worker probe, with a separate reader retaining the original snapshot. All seven CLI and five browser measured pairs in this sparse case improved. Packed used arena bytes: 37,211,352 to 26,434,456 (29.0% lower). Combined distinct tracked old and new arena bytes during handoff: 64,186,508 to 53,409,612 (16.8% lower). These are logical arena counts, not process RSS, peak memory or GC measurements.

The broader ungated implementation was rejected: dense histories regressed, particularly in Bun. Tile churn and dense histories generally fall back with no claimed improvement. The initial qualification flagged three fallback cases for targeted investigation. [Focused fallback run](https://github.com/natanelia/zerocopy/actions/runs/45712889594) uses 21 measured interleaved Node pairs per cohort, and 15 per browser. At the time this branch was prepared, Node 10k dense-four paired A/B ratio was 0.984x (A/A 0.996x), Chromium 100k dense-four handoff 1.027x (A/A 1.031x). Firefox churn remains pending; do not treat this as final regression clearance.

The corrected qualification also passed 1,293 existing tests, the built-package worker proof, type checks, and a dedicated edge exercise covering collisions, Unicode, forks, iteration, allocation failure, copy/shared transport and customized traversal/descriptor fallback. This production branch includes a permanent regression test based on that exercise. The final branch must pass normal repository CI and review before merging.

For reproduction, the exact baseline/candidate bundle setup, environment versions and raw artifacts are linked in the full investigation. The [qualification workflow](https://github.com/natanelia/zerocopy/blob/df86e84d907e06dbd481190a4cde7b1ba7cf5816/.github/workflows/retained-map-compaction-proof.yml) and [targeted fallback workflow](https://github.com/natanelia/zerocopy/blob/bd61a5a67a9d840063154b647a4ab424917b7992/.github/workflows/retained-map-compaction-proof.yml) are deliberately not included in the production diff.
