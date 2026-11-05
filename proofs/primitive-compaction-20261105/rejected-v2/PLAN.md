# Large numeric list compaction: revised scope

Baseline: `77599337867dbf785a5f0311d34637d0b36678fc`.

The broad first variant is **rejected**. It improved the 131,073-number list in
all six confirmation pairs on both engines, but the 8,193-boolean list regressed
in every Node pair: paired ratio 1.219, 95% interval [1.011, 1.469]. An unchanged
Bun JSON control also slowed in every pair: ratio 1.104, interval [1.036, 1.178].
Do not explain either result away. The exact V1 source, driver, plans, tests,
worker proof, all pilot/confirmation timings and validation attempts are retained
under `rejected-v1/`, with an archive manifest checked against local Git objects.

V2 copies raw spans only for numeric SharedList snapshots of at least 65,536
elements. Queues, booleans and all smaller lists use the existing relocation
loop. The copy loop is a separate helper so the fallback method retains its
original body plus one dispatch condition. The threshold is a conservative scope
limit for this change, not a measured optimal crossover. It must be tested at
65,535, 65,536 and 65,537, including retained edits and nested compaction.

Keep every original case. Add one large-list boundary case; do not drop the
boolean regression or adverse JSON control from the matrix:

| Case | Size | V2 role |
| --- | ---: | --- |
| list-number-large | 131,073 | edited numeric-list target |
| list-number-boundary | 65,537 | boundary target |
| list-number-small | 33 | fallback overhead control |
| list-boolean | 8,193 | unchanged fallback; V1 regression |
| queue-number | 8,193 live after 47 dequeues | unchanged queue fallback |
| queue-boolean | 4,097 live after 31 dequeues | unchanged queue fallback |
| list-empty | 0 | empty overhead control |
| list-string | 1,025 | unchanged relocation control |
| list-object | 129 | unchanged fallback; adverse V1 control |

Run a fresh complete two-pair pilot and then, if it supports the narrowed scope,
six balanced confirmation pairs per runtime/case. Keep the original repetitions
for all original cases and four repetitions for the new case. No new timing
method is introduced: Node 24.22.1/Bun 1.4.2, CPU 2, shared performance lock, one
build/case per process, a common neutral import path with every bundle chunk
replaced, >=500 ms actual timed warm-up and >=8 warm-up batches, nine measured
batches. Time the complete public `compact(source)` operation, including a fresh
Arena/instance, allocations and frozen result. Retain every output until its full
values, descriptor, target bytes/allocation and unchanged source bytes are checked.

Report pilots separately from confirmation, all pair ratios and an unadjusted
95% Student-t interval on log ratios. Do not claim fallback neutrality merely
because an interval includes parity. A clear fallback regression blocks
acceptance; do not select favorable reruns. This is independent of all other
pending PRs and does not measure their combined performance.
