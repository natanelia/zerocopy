# Heap entries: one view per immutable traversal

Fixed baseline: `77599337867dbf785a5f0311d34637d0b36678fc` in `zerocopy-r4-base`.
This independent fallback follows the rejected queue front-cache experiment.
The queue change is absent from this worktree. Its complete negative evidence
is preserved separately on branch `perf/queue-front-cache-20261105`, local
commit `a22ccaa721193a5f63b4fc90258468fb3ba5e753`.

The earlier heap-entry change already reduces four DataView getter requests to
one per node. This new candidate captures one existing view for the whole
nonempty immutable traversal. Published nodes fit that view, and shared growth
cannot detach it. Empty and unstarted generators still request no view. Generic
decoding, preorder, child-read timing, tuple construction and yields stay the
same. The live view-count assertion changes from N to one; historical reports
and raw evidence remain untouched.

## Fixed ten-case screen

| Case | Fixture | Timed public operation | Role |
| --- | --- | --- | --- |
| empty-full | Empty numeric min heap | Consume entries | Empty control |
| singleton-close | One numeric item | First next, then return | Early-close control |
| number-small | 32 numeric items | Consume all entries | Small traversal |
| number-large | 65,537 numeric items | Consume all entries | Main large target |
| max-ties | 4,097 numbers, max heap, 17 tied priorities | Consume all entries | Shape/order target |
| boolean-full | 4,097 booleans, max heap | Consume all entries | Primitive fallback |
| string-overflow | 4,097 unique Unicode strings | Consume all entries | Decode-cache overflow |
| object-warm | 1,057 nested JSON values | Consume all entries | Generic warm decode |
| materialize | 4,097 numbers | Full array spread of entries | Retained tuple/array consumer |
| unchanged-peek | 4,097 numbers | 256 peek plus peekPriority pairs | Unchanged method control |

Priorities use a deterministic permutation except the explicit ties case.
Expected values/priorities come from native input records. An independent walk
of the unchanged stored tree establishes traversal order; unique priorities
identify generic input values, and unique numeric values identify tied entries.
The benchmark never calls candidate entries to manufacture its oracle. Verify
all input identities appear once and both variants have identical oracle hashes.

Each full consumption stores every value and priority in caller-prepared buffers;
every operation's actual entry count and complete content are checked afterward.
Buffers and expected arrays are reused between batches. Full materialization
retains and verifies every returned tuple array; its library/caller allocations
remain timed. Fixture construction and verification are outside timing, while
all public iterator work, tuple production, normal GC and result writes remain
inside. Shared arena usage must not change. Ordinary bounded decode caches stay
active; JSON fits the cache and strings exceed it.

Use two balanced fresh-process pairs per runtime/case, seven measured batches,
common before/after repetitions, and at least 150 ms of timed warm-up plus eight
batches. Empty has a 256-batch warm-up cap. Disposable coarse and fixed-count
calibration target 8 ms per batch, capped at 524,288 retained values (131,072 for
JSON or full materialization). Record actual durations/cap hits rather than
claiming a guaranteed batch floor. A process loads one build and one workload at
the same neutral import path; replace all bundle chunks between subjects.

All heavy work holds perf.lock and timings inherit CPU 2 affinity. Commit source
before timing, retain all driver/source/bundle identities and all outcomes. If
the screen supports meaningful gains without a clear adverse control, confirm
the same matrix with six balanced pairs, nine batches and at least 500 ms timed
warm-up. Do not combine the prior queue results with this separate candidate.
