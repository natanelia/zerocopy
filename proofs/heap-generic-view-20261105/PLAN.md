# Final scoped heap-view candidate: fixed plan before measurements

Baseline: `77599337867dbf785a5f0311d34637d0b36678fc` in the immutable
`zerocopy-r4-base` checkout. This is a new worktree and new recording path.
The rejected broad candidate remains intact in `zerocopy-r4-heap`, including
its source, both pilots, both six-pair confirmations and its rejection report.
Its timings are not measurements of this scoped version.

## Scope and hypothesis

The broad candidate retained one view for every value type. Its confirmation
showed repeatable boolean/JSON gains in both engines but an unresolved adverse
large-numeric Bun result. This final candidate captures one view only inside a
branch for `boolean` or `object`. All other types retain the original per-node
view loop verbatim. Empty takes that original empty loop and requests no view.

Keep `entries` a generator method. Ordinary function dispatch to separate
generators would change the explicitly tested method kind, iterator prototype
and lazy receiver/error timing. There is no extra `yield*` layer. The extra
loop is scoped to the two selected types, followed by `return`; the original
fallback loop remains at its original method indentation and is byte-identical
to baseline. The existing numeric per-node view tests remain unchanged.

Different generator-state/liveness behavior is a possible explanation for the
broad fallback cost, not an established cause. This branch may still affect
fallback compilation or add dispatch cost. Only fresh before/after measurements
can justify it; preserving the original loop is not a performance guarantee.

## Fixed eleven cases

Retain every case from the broad candidate and add JSON cache overflow:

| Case | Input | Timed operation | Role |
| --- | --- | --- | --- |
| empty-full | Empty numeric heap | Consume entries | Empty fallback |
| singleton-close | One number | First next plus return | Early-close fallback |
| number-small | 32 numbers | Full entries | Small numeric fallback |
| number-large | 65,537 numbers | Full entries | Adverse large numeric fallback |
| max-ties | 4,097 numbers, max heap, 17 tied priorities | Full entries | Numeric shape/ties fallback |
| boolean-full | 4,097 booleans, max heap | Full entries | Primary scoped target |
| string-overflow | 4,097 Unicode strings | Full entries | String/cache-overflow fallback |
| object-warm | 1,057 nested JSON values | Full entries | Primary scoped target |
| object-overflow | 4,097 nested JSON values | Full entries | Added generic cache-overflow control |
| materialize | 4,097 numbers | Array spread of entries | Numeric allocation/consumer fallback |
| unchanged-peek | 4,097 numbers | 256 peek/peekPriority pairs | Unchanged-method control |

All values, priorities and the independent native-input/stored-tree oracle are
the same as the broad study for the retained cases. JSON overflow uses the same
record generator at 4,097 values, exceeding the 2,048-entry decode cache. It
mixes existing cache hits and repeated misses after warm-up; it is not a claim
about wholly cold attachment or first reads.

Every operation's actual output count and every value/priority are checked.
Reuse caller buffers, reset counts outside timing, and retain full materialized
arrays inside timing. Include all generator/tuple work, caller writes and
natural GC; exclude fixture/oracle creation and complete verification. Each
batch must allocate zero shared bytes. No cache clearing or forced GC.

## Screening and confirmation

The new pilot uses two balanced fresh-process pairs per engine/case and seven
measured batches. Unlike the broad exploratory pilot, each nonempty measured
subject now has at least **500 ms of actual timed warm-up plus eight batches**,
matching the broad confirmation protocol before any new timing is observed.
Empty retains the 256-batch cap, recorded explicitly if hit. Coarse/fixed probes
remain 100/150 ms, targeting 8 ms with a common repetition count per case and
side. Retain the 524,288 output-value cap, or 131,072 for JSON/materialization.
Calibration is a target, not a guaranteed batch-duration minimum.

One workload/build per fresh process, the same neutral import path for both
sides, CPU 2 and the shared `perf.lock`. Preserve all source/bundle/driver
hashes, calibration and warm-up samples, measured batches and negative results.
Acquire the lock separately for each engine. No source/workload tuning after
the pilot; if credible, confirm the same eleven cases with six balanced pairs
and nine batches per process at the same warm-up settings. Report every case
and all process-pair ratios, with per-case log-t intervals for confirmation.

This is the final variant. A material recurring adverse fallback result means
rejecting it, not another source variant or selective case removal. Intervals
crossing parity do not establish equivalence. There is no performance claim
until both engines complete the fixed study.

## Correctness gates

Run the unchanged generator-shape/lazy/numeric-view tests and the normal heap
tests. New tests check the scoped view count separately from cold generic
decoder view requests; owner/shared/copy contents; unchanged fallback views
for numbers, strings and nested snapshots; frozen JSON; decoder receiver,
reentry, growth, throws and old bytes. The real-worker proof pauses all value
types and forks through owner/dependency growth, fresh attachment and resets,
then checks full output and read-only behavior. All fixtures use private Arenas.
