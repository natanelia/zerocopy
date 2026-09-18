# Revision-to-revision performance

This experiment compares zerocopy revisions, not zerocopy with Immutable.js or native collections. The [README](../README.md#performance) contains the library comparison.

Results come from the [September 13, 2026 Actions run](https://github.com/natanelia/zerocopy/actions/runs/34764774485). The measured revision is [`6e0510c`](https://github.com/natanelia/zerocopy/commit/6e0510c66e3cee0dc7762d71256800c41207e161), which used worker format 3. These CI results are separate from the initial local experiment.

## Method and references

The runner used Bun 1.4.2, AssemblyScript 0.28.20, Linux x64, and an AMD EPYC 7763 processor. Each operation ran in a separate process. Variant order rotated across three rounds, with 20 warm-ups and 15 measured samples per process. Each entry is the median of 45 samples per operation and variant. Output checks ran outside timing.

The matched original is [`7aea444`](https://github.com/natanelia/zerocopy/commit/7aea44447177d37a303ab5c1b26d7c5e00e1c1f7), rebuilt with the revision's compiler and flags. The previous implementation, labeled `previous PR` in the recorded tables, is [`59bd5ad`](https://github.com/natanelia/zerocopy/commit/59bd5ad9f84358f828968910c66b9a2e80c0673d). The raw record also includes the original source with its original flags; the matched build was not always faster than that build.

Ratios are reference median divided by revision median. Above 1.00x is faster; below 1.00x is slower. Times cover full workloads, not individual calls. Differences near 1.00x are not established improvements; no confidence intervals or application-level guarantees are claimed.

| Workload | Revision time (ms) | vs matched original | vs previous PR |
|---|---:|---:|---:|
| Vector bulk build (4,096 numbers) | 0.0404 | 18.97x | 2.22x |
| Vector scan (20 scans of 4,096 numbers) | 0.2501 | 3.39x | 1.20x |
| Vector append (4,096 pushes) | 0.2787 | 2.77x | 4.27x |
| Map bulk build (1,024 entries) | 0.2417 | 1.25x | 1.36x |
| Map lookup (4,096 hits over 1,024 keys) | 0.2339 | 1.67x | 2.41x |
| Singly linked-list indexed reads (4,096) | 0.1437 | 74.07x | 4.50x |
| Singly linked-list append (4,096) | 0.2616 | 1.00x | 4.98x |
| Doubly linked-list indexed reads (4,096) | 0.1603 | 37.90x | 4.04x |
| Doubly linked-list append (4,096) | 0.2593 | 0.96x | 5.15x |
| Ordered-map writes (1,024) | 0.3076 | 0.80x | 2.62x |
| Sorted-map writes (1,024) | 0.2921 | 1.09x | 2.01x |
| Priority-queue insertion (1,024) | 0.3693 | 1.63x | 0.95x |
| Queue build (4,096 numbers) | 0.2813 | 1.02x | 4.30x |
| Stack build (4,096 numbers) | 0.2391 | 1.24x | 1.06x |

Linked-list indexed-read gains compare block trees with physical linked lists. They do not describe every sequence operation. Map lookup uses keys written during setup; the cold-read case below is a different workload.

## Complete write-and-read workloads

These cases include reads or iteration after writes, with the same compiler settings and sample counts.

| Workload | Revision time (ms) | vs matched original | vs previous PR |
|---|---:|---:|---:|
| Ordered-map writes and scan (1,024) | 0.5029 | 0.77x | 3.28x |
| Sorted-map writes and scan (1,024) | 0.5452 | 1.14x | 2.07x |
| Sorted long-prefix writes and scan (512) | 1.0122 | 2.95x | 1.35x |
| Cold map reads after bulk build (1,024) | 0.1204 | 0.97x | 1.03x |
| Object-map writes and reads (512) | 1.1767 | 0.79x | 0.92x |
| Complete queue fill and drain (4,096) | 0.4689 | 0.90x | 3.04x |

Ordered-map writes are about 25% slower than the matched original, writes plus scan about 30% slower, and object-map writes plus reads about 27% slower. Doubly linked-list append, cold map reads, and a full queue cycle also trail the matched original. Priority insertion and object writes plus reads trail the previous implementation.

The original has separate snapshot-correctness failures. Timings do not establish equivalent immutability. All four variants disable the original automatic-GC mechanism because it can invalidate retained snapshots; see the [counterexamples](snapshot-regressions.ts).

These small Bun workloads on one runner do not measure browser performance, main-thread latency, worker-transfer time, concurrent write throughput, or every key distribution. Re-run them on the target runtime and workload.

## Implementation at the measured revision

Tail blocks avoid a tree-path copy on most appends. A numeric append to a non-full tail at the allocation boundary needs eight new payload bytes. Old snapshots retain their visible lengths. A fork or intervening allocation copies the visible tail; a full tail still requires index work.

Bulk vector input becomes stored value blocks rather than a second staging copy. Linked-list interfaces use blocks of up to 32 values. Numeric map writes use a compact WASM command buffer, and the HAMT uses 16-way branches. Ordered maps use a persistent insertion log. Default sorted maps use a compressed radix index with a bounded journal of up to four pending updates. Encoding, decoding, handle allocation, and other update costs remain.

## Evidence and reproduction

The [CI summary](results/readme-ci-summary.json) records exact medians, ratios, allocations, environment details, and checksums. The [raw artifact](https://github.com/natanelia/zerocopy/actions/runs/34764774485/artifacts/10319983686) holds all timing samples, worker results, and allocation records. Its recorded retention end is October 13, 2026; the committed summary remains.

Use the [revision driver](run-revision.mjs) with the pinned source checkouts and the commands in the [revision workflow](../.github/workflows/performance-revision.yml). Build all compared engines with matching dependencies. Keep new output separate from the recorded summary.

The [initial performance report](README.md#initial-persistent-engine-experiment) and `results/local.json` describe the earlier implementation, not this revision.
