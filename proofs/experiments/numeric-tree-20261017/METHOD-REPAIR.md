# Measurement-callsite repair — 17 October 2026

This is a new exploratory measurement method, not new production code.
Two hosted cohorts using the preceding method showed failed A/A tests even
when both variants had exactly the same built files. On x64 Bun, a one-value
public range comparison reported a twofold difference with identical code.
The fixed A/B comparisons also failed small controls.

The new method uses one loop source per operation for both baseline and
candidate. Both variants select a function before their timed loop. The
old method used separate source locations for public baseline/candidate
loops and dynamic role lookups for direct kernel loops.

The previous method source is retained as method-v1-benchmark.mjs.
Prior raw samples, failed gates and hosted archives are not changed.
The new driver produces a new SHA-256 digest in its raw records.

The same fixed thresholds, warm-ups, rounds, size set, workloads,
alternate call order and correctness checks apply. The existing A/A
controller will use the new method. Keep PR #39 as a draft until the
revised A/A and all A/B gates pass on both Node and Bun, x64 and ARM64.
