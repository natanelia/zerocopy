# Rejected set forEach pilot

**Decision: rejected. No PR, formal confirmation, A/A run, or retuned repeat.**

This exploratory pilot has two independent fresh-process pairs per runtime and case. Every subject retained nine measured batches after at least eight warmup batches and 150 ms of timed warmup. No confidence interval is asserted from two pairs. The table gives the median of process medians before/after; the paired ratio is the geometric mean of the two within-pair ratios, not the ratio of the two displayed medians. Lower is faster.

| Runtime | Public operation | Before (µs) | After (µs) | Paired ratio | Pair 1 | Pair 2 | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| node | set-mixed-8192 | 3666.303 | 3674.108 | 1.0041 | 0.9808 | 1.0279 | 1/2 |
| node | set-small-4 | 0.955 | 0.793 | 0.8309 | 0.9122 | 0.7568 | 2/2 |
| node | ordered-mixed-8192 | 2679.128 | 3230.975 | 1.2047 | 1.2461 | 1.1647 | 0/2 |
| node | ordered-override-1024 | 252.773 | 272.033 | 1.0682 | 1.1096 | 1.0284 | 0/2 |
| node | sorted-mixed-8192 | 3068.428 | 2796.289 | 0.9046 | 0.9629 | 0.8498 | 2/2 |
| node | sorted-values-1024 | 241.633 | 211.167 | 0.8751 | 0.8454 | 0.9059 | 2/2 |
| bun | set-mixed-8192 | 4545.844 | 3717.763 | 0.8285 | 0.7155 | 0.9594 | 2/2 |
| bun | set-small-4 | 0.774 | 0.520 | 0.6852 | 0.9435 | 0.4976 | 2/2 |
| bun | ordered-mixed-8192 | 3461.100 | 2730.939 | 0.8005 | 0.6415 | 0.9989 | 2/2 |
| bun | ordered-override-1024 | 144.968 | 153.107 | 1.0557 | 1.0678 | 1.0438 | 0/2 |
| bun | sorted-mixed-8192 | 3681.542 | 3431.228 | 0.9176 | 1.1636 | 0.7237 | 1/2 |
| bun | sorted-values-1024 | 135.961 | 126.594 | 0.9305 | 0.9519 | 0.9096 | 2/2 |

Node SharedOrderedSet was slower in both pairs (24.6% and 16.5%; paired estimate 20.5% slower). Node SharedSet was flat overall. The public override control was slower in both pairs on both runtimes (paired estimates 6.8% Node and 5.6% Bun). None of the three declared primary operations cleared the required 10% time reduction in both runtimes. Bun showed some promising individual rows, but these do not support accepting the three-class change.

The unchanged sorted-values control also moved (12.5% faster Node, 6.9% faster Bun). Individual process ratios vary; a two-pair pilot cannot establish durable speedup or causal attribution to unrelated controls. These observations were retained rather than canceled, filtered, or rerun.

Recorded 2026-11-05T15:29:18.314Z through 2026-11-05T15:29:46.793Z: 48 fresh processes and 432 measured batches, CPU 2, AMD EPYC 9V74 80-Core Processor. Every complete output and source/build identity check passed.

All six predeclared pilot rows were measured. The remaining 18 rows of the full 24-row matrix were checked for correctness only and were never timed.

| Runtime | Case | Measured batches below 2 ms / 36 |
| --- | --- | ---: |
| node | set-mixed-8192 | 0/36 |
| node | set-small-4 | 0/36 |
| node | ordered-mixed-8192 | 0/36 |
| node | ordered-override-1024 | 0/36 |
| node | sorted-mixed-8192 | 0/36 |
| node | sorted-values-1024 | 0/36 |
| bun | set-mixed-8192 | 0/36 |
| bun | set-small-4 | 10/36 |
| bun | ordered-mixed-8192 | 0/36 |
| bun | ordered-override-1024 | 0/36 |
| bun | sorted-mixed-8192 | 0/36 |
| bun | sorted-values-1024 | 0/36 |

Short batches remain in the raw recording without exclusion. The independent verifier passed; see pilot-verification.txt. The compressed JSON is a lossless copy of the complete recording and contains every warmup/sample, exact changed sources, build/native hashes, runtime identities, and workload metadata.
