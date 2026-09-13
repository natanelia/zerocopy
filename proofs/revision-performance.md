# Revision-to-revision performance

This report preserves the previous README's revision-to-revision comparison.
It compares Zerocopy revisions, not Zerocopy against Immutable.js or native
collections. The main README uses the original library-comparison format.

These figures come from the completed [GitHub Actions run on September 13, 2026](https://github.com/natanelia/zerocopy/actions/runs/34764774485).
The measured code is commit [`6e0510c`](https://github.com/natanelia/zerocopy/commit/6e0510c66e3cee0dc7762d71256800c41207e161),
which uses worker format 3. These are CI results, not a mixture of the earlier
local measurements and new CI measurements.

The main improvements include **18.97x faster bulk vector creation**, **2.77x
faster scalar vector append**, and **1.67x faster map lookup** against the matched
original in this run. Indexed reads through the two linked-list interfaces are
**74.07x and 37.90x faster**. Those indexed-read gains compare block trees with
the original physical linked lists; they do not describe every sequence operation.

### Method and reference versions

The runner used **Bun 1.4.2**, **AssemblyScript 0.28.20**, Linux x64, and an
AMD EPYC 7763 processor. Each operation ran in a separate process. The driver
rotated the variant order across three rounds. Each process used 20 warm-ups
and 15 measured samples. Each table entry is the median of **45 samples per
operation per variant**. Output checks ran outside the timed sections.

The matched original is commit [`7aea444`](https://github.com/natanelia/zerocopy/commit/7aea44447177d37a303ab5c1b26d7c5e00e1c1f7),
rebuilt with the same AssemblyScript compiler and build flags as the revision.
The previous PR is commit [`59bd5ad`](https://github.com/natanelia/zerocopy/commit/59bd5ad9f84358f828968910c66b9a2e80c0673d).
The raw record also includes the original build with its original flags.
The matched build is not always faster than that original build.

**Ratio = reference median / revision median. Above 1.00x is faster; below
1.00x is slower.** Times are for the complete workload in each row, not one
operation. Differences near 1.00x are not established improvements. No confidence
intervals or application-level speed guarantees are claimed.

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

Map lookup in this table uses keys written during setup. The cold-read workload
below measures a different access pattern. Both results matter.

### Complete write-and-read workloads

These tests include iteration or reads after writes. They use the same compiler
settings and sample counts. They expose costs that write-only timing can miss.

| Workload | Revision time (ms) | vs matched original | vs previous PR |
|---|---:|---:|---:|
| Ordered-map writes and scan (1,024) | 0.5029 | 0.77x | 3.28x |
| Sorted-map writes and scan (1,024) | 0.5452 | 1.14x | 2.07x |
| Sorted long-prefix writes and scan (512) | 1.0122 | 2.95x | 1.35x |
| Cold map reads after bulk build (1,024) | 0.1204 | 0.97x | 1.03x |
| Object-map writes and reads (512) | 1.1767 | 0.79x | 0.92x |
| Complete queue fill and drain (4,096) | 0.4689 | 0.90x | 3.04x |

**Remaining regressions are not hidden.** In this CI run, ordered-map writes
are about 25% slower than the matched original. Ordered-map writes plus a scan
are about 30% slower. Object-map writes plus reads are about 27% slower.
Doubly linked-list append, cold map reads, and a full queue cycle also trail
the matched original. Priority insertion and object writes plus reads trail
the previous PR in this run. The original also has separate snapshot-correctness
failures; passing these timing checks does not establish equivalent immutability.

These are small Bun workloads on one runner. They do not measure browser
performance, main-thread latency, worker transfer time, concurrent write
throughput, or every key distribution. Re-run them on the target runtime and
workload. All four variants disable the original automatic-GC mechanism because
it can invalidate retained snapshots. See the [snapshot counterexamples](snapshot-regressions.ts).

### What reduces the work

Tail blocks avoid a tree-path copy on most appends. A numeric append to a
non-full tail at the allocation boundary needs eight new payload bytes.
Old snapshots keep their original visible lengths. A fork or an intervening
allocation copies the visible tail instead. A full tail still needs index work.

Bulk vector input becomes the stored value blocks instead of a second staging
copy. Linked-list interfaces use blocks of up to 32 values. Numeric map writes
use a compact WASM command buffer, and the HAMT has 16-way branches. Ordered
maps use a persistent insertion log. Default sorted maps use a compressed radix
index with a bounded journal of up to four pending updates. These changes do not
remove encoding, decoding, returned-object allocation, or all update costs.

### Evidence

The [recorded CI summary](results/readme-ci-summary.json) preserves exact
medians, ratios, allocation measurements, environment details, and checksums.
The [raw CI artifact](https://github.com/natanelia/zerocopy/actions/runs/34764774485/artifacts/10319983686)
contains all timing samples, worker results, and allocation records. GitHub's
artifact retention ends on October 13, 2026; the committed summary remains.
See the [reproduction commands](../README.md#reproduce-the-revision-to-revision-comparison).
The [earlier performance report](README.md)
and its `local.json` results describe the initial implementation, not this revision.

