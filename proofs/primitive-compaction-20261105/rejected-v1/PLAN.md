# Primitive vector compaction experiment

Baseline: `77599337867dbf785a5f0311d34637d0b36678fc`.

Hypothesis: copying the raw live byte spans of number/boolean SharedList and
SharedQueue snapshots avoids one JS/WASM lookup and a temporary JavaScript value
per slot. This is safe only for primitive slots, which contain no arena-relative
addresses. String, JSON, nested collection and linked-sequence paths remain on
the existing relocation algorithm. Each source span is at most 32 slots; queue
prefixes can begin in the middle of a span. Binary layout and result allocation
size must remain unchanged.

Before seeing measurements, the fixed matrix is:

| Case | Size | Role |
| --- | ---: | --- |
| list-number-large | 131,073 | large vector target, edited branches |
| list-number-small | 33 | small target / instance overhead |
| list-boolean | 8,193 | boolean target |
| queue-number | 8,193 live after 47 dequeues | unaligned queue target |
| queue-boolean | 4,097 live after 31 dequeues | boolean queue target |
| list-empty | 0 | empty overhead control |
| list-string | 1,025 | unchanged relocation control |
| list-object | 129 | unchanged JSON relocation control |

Measure the complete public `compact(source)` operation, including fresh Arena
construction, allocations, copies, result construction and freezing. Source
creation and complete output verification are outside timing. Every returned
snapshot stays reachable through verification; do not substitute a checksum-only
microbenchmark. Verify all values, source bytes, target used bytes and writable
results. Keep the same repetitions within each before/after pair.

Use Node 24.22.1 and Bun 1.4.2, portable production bundles, CPU 2 and the shared
performance lock. Use one build and one case per fresh process through a neutral
import path, replacing all bundle chunks before every process. Run two balanced
pilot pairs, preserve all results, then freeze any revised method/source before
six balanced confirmation pairs. Each process has at least 500 ms actual timed
warm-up and eight warm-up batches followed by nine measured batches. Estimate
the geometric mean of process-median after/before ratios; report all pair ratios
and an unadjusted 95% Student-t interval on log ratios. Include adverse controls
and do not claim general neutrality from an interval that includes parity.

Acceptance requires consistent material improvement on substantive targets in
both runtimes, complete correctness and preserved allocation/layout. A failed
candidate or material regression remains recorded and is not published as an
accepted optimization. Timing evidence is separate from correctness checks on
the combined pending PRs.
