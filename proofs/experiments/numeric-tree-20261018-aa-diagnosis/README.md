# Numeric A/A instability: independent evidence, 18 October 2026

**Diagnosis only. No performance clearance.** The archive is GitHub Actions [run 39091163324](https://github.com/natanelia/zerocopy/actions/runs/39091163324) at source head cc21d3674c6be4aad46b83a791125b1a354310c5. This proof is separate from the later head of PR #41. The four A/A phases each contain 176 child processes (11 sizes, 16 processes each). Each child retains all 7 warm-up and 21 measured batches. The independent script verifies all 704 child records and their raw NDJSON journals and checks original source/bundle identity. Original failed gate results are unchanged.

| Identical-build control | Point passes / 63 | Confidence passes / 63 |
| --- | ---: | ---: |
| x64 Node | 59 | 57 |
| x64 Bun | 56 | 39 |
| ARM64 Node | 63 | 61 |
| ARM64 Bun | 60 | 59 |

**x64 Node can change its direct SIMD speed within one child after warm-up.** Size 32,768, child 11 in the Node A/A phase has first-seven median approximately 2.079 ms and last-seven median approximately 3.610 ms (1.74x). The scalar control in that child stays near 7.9 ms. At size 1,057, x64 Node direct SIMD process medians differ by 1.922x across identical-build children. A CPU-wide slowdown by itself does not explain this contrast. Runtime compilation state is a hypothesis, not a proven cause.

**Bun has a second form of instability.** On x64 size 1, range-public identical-build process medians range from 10.897 ms to 24.776 ms, a 2.274x spread. Individual child measurements in that workload are comparatively stable. This is process-dependent variation and is not a real algorithmic speedup.

The audit reports every original phase count, hashes the unchanged phase plan and summary, verifies every raw child and journal, and describes the 12 largest transitions. Its early/late split and 25% reporting marker are NOT performance thresholds. All unsuccessful samples are retained. The original 0.95 regression floor, 1.05 large-range target, and 63 endpoint gates remain unchanged.

## Reproduction
1. Download and hash the x64 and ARM64 artifacts from GitHub Actions run 39091163324. Retain the official ZIP SHA-256 identifiers and the raw files.
2. Extract each archive intact.
3. Run: node --test proofs/experiments/numeric-tree-20261018-aa-diagnosis/audit.node.mjs
4. Run: node proofs/experiments/numeric-tree-20261018-aa-diagnosis/audit.mjs PATH_TO_EXTRACTED/node-aa x64
5. Repeat for bun-aa on x64, and both runtime A/A directories on arm64.
6. Independently use PR #40's full raw evidence gate. This script is only a complementary diagnostic.

## Additional performance experiment: failed scalar sibling-leaf grouping
I tested a depth-one group loop in scalar countPointsInBox (point-box tree). The source uses the previous Stage 5 code as its baseline. The experiment does not change any public contract, dependency, allocator, shared snapshot, or data layout. Six existing numerical safety tests passed and no snapshot byte was modified. The scalar and SIMD Wasm SHA-256 values of the candidate are:

- scalar: e9179f685107f4355887d1ad009643612b9cae8b38ec60349ace95bb58231874
- SIMD: b5ab88e019afb6fca9de13d59bf2559334774ac1662da0d7dfba39aed6d9c0c4
- edited AssemblyScript source: 5ff49cf1f1521c9362d63ec6f6759460ceae987860bc53d12bd5cee084f09f9d

An independent, **diagnostic-only** x64 Node screen used four balanced ABBA/BAAB process blocks, all seven warmups and 21 samples, both known-miss and mixed-hit point boxes at sizes 1,024 and 32,768, and 8 million elements per timing sample. The original control floors were retained. Original A/A confidence checks failed on all four point endpoints. A/B ratios for size 1,024 control/mixed and size 32,768 control/mixed were 0.9899, 1.0057, 1.0015, 1.0592. The size-32,768 control confidence lower bound was 0.9472, below 0.95. This is not a supported speed win. I did not open another performance PR.

The smaller screen does not replace the full Node/Bun × x64/ARM64, 63-endpoint gate. Its local raw diagnostic is retained separately. The first local full-size screen stopped before completing its A/A phase due to the local execution limit. The partial child records were retained; they have no performance acceptance status.

**Blocker:** identical-build controls remain unreliable. Do not approve an optimization using a favorable rerun or a modified acceptance threshold. Investigate JIT/tier transitions, and then validate a separately predeclared method with all original failures retained.
