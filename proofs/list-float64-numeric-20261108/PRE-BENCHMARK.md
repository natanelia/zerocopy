# Optional Float64 import: plan fixed before timing

This study compares baseline `0ac8a005268335a6116f025e75f670b5cee6843e`
against the new `fromFloat64` export in `zerocopy/numeric`. Its only changed
runtime source is `numeric.ts`; `tsconfig.numeric.json` adds the public type
fixture. The existing SharedList class and every WASM binary remain unchanged.
All JavaScript files reachable from the ordinary `shared.js` entry must have
exactly the same paths and bytes in both builds. The graph check rejects external
or unresolved dynamic dependencies and binds the result to recorded bundle hashes.

The candidate always snapshots the input before obtaining the writer or invoking
storage hooks. It reuses at most one MiB of private Float64 storage for non-nested
inputs of at most 131,072 elements. Nested and larger calls use uncached private
storage. The cache remains borrowed through all writes and tree linking and is
released in `finally`. This fixes a concrete pre-import allocator mutation case;
the failed pre-fix check and subsequent regression results remain in `validation`.
No performance samples were taken from that pre-fix optional implementation.

## Comparison and scope

Both builds receive the same genuine `Float64Array` directly. Before calls
`new SharedList('number').pushMany(input)`; after calls `fromFloat64(input)`.
The old JavaScript implementation accepts this input even though its TypeScript
signature accepts ordinary arrays. No conversion to an ordinary array is timed.
This is an explicit optional API for numeric buffers, not a claim that every
existing List operation becomes faster.

The measured operation includes the complete public call, arena allocation and
growth, any input copying, the returned handle, and its retention in a preallocated
array. Every result is kept until the batch is fully verified. Imports, input
creation, setup, independent expected results, and validation are outside timing.
There is no forced GC or GC subtraction. Warmed repeated calls can reuse the
bounded snapshot storage; this is not a cold-start or peak-memory study.

Two encoding histories remain separate. The ordinary cases create a small source
sentinel through the old `pushMany(number[])` outside each batch. The two
`float64-only-*` cases construct that same sentinel through the old
`pushMany(Float64Array)` in both builds. This controls the previous observation
that call history materially changes baseline speed. Both histories must be
reported; their difference alone does not establish a particular JIT mechanism.

## Cases fixed before collection

| Case | Complete operation | Repetitions per batch |
| --- | --- | ---: |
| `float64-32` | Import 32 typed values | 8,192 |
| `float64-4096` | Import 4,096 typed values | 1,024 |
| `float64-65536` | Import 65,536 typed values | 64 |
| `float64-1048576` | Import 1,048,576 typed values | 4 |
| `float64-subview-65536` | Import 65,536 values from a nonzero-offset view | 64 |
| `float64-shared-65536` | Import 65,536 values from shared backing storage | 64 |
| `float64-only-4096` | Import 4,096 typed values with typed-only encoding history | 1,024 |
| `float64-only-65536` | Import 65,536 typed values with typed-only encoding history | 64 |
| `array-build-control-32` | Existing constructor and ordinary-array `pushMany` | 8,192 |
| `scalar-append-control-2048` | 256 existing `push` calls, retaining the final list | 256 |
| `numeric-range-control-65569` | Existing `countInRange` over 65,569 values | 512 |
| `numeric-box-control-65538` | Existing `countPointsInBox` over 32,769 points | 512 |

The two root-only controls never import `numeric.js`, so their complete loaded
module graphs are identical across labels. They are same-code repeatability
controls. The two existing numeric readers import the changed optional entry in
both builds; they are real regression controls for that entry. Their input includes
special numbers and inclusive-boundary cases. They reuse one immutable source,
and the initial untimed operation primes the existing numeric kernel. They must
not allocate in the source arena.

The scalar control uses 256 repetitions per batch, chosen before this study to
reduce short batches seen with 64 repetitions in the held static-factory study.
Those older measurements must not be pooled with these.

- Pilot: the nine cases named in `study.pilotCases`, two pairs, two runtimes,
  two builds: 72 fresh processes. It includes tiny input, both setup histories,
  shared input, and all four controls.
- Confirmation, if the pilot supports proceeding: all 12 cases, six pairs,
  two runtimes, two builds: 288 fresh processes.
- Baseline-versus-baseline: the six cases named in `study.aaCases`, four pairs,
  two runtimes, two labels: 96 fresh processes.

Node 24.22.1 and Bun 1.4.2 run serially on CPU 2 under the common lock
`/tmp/zerocopy-perf-20261108.lock`. No builds, full test suites, or other benchmarks
overlap collection. Each case, build, runtime, and pair gets a fresh process and
the same neutral public import path. AB/BA alternates by pair; case and runtime
order reverse on odd pairs.

Each process warms for at least 500 ms of actual timed operation work and at
least eight batches, then records nine measured batches. Every sample remains
in the evidence. Batches below 2 ms are counted and retained. The per-process
estimate is the median batch time divided by the fixed repetition count.
Pair ratios are summarized by a geometric mean with unadjusted 95% Student-t
intervals on paired log ratios for confirmation and A/A. Pilot ratios are
exploratory. The process pair is the statistical unit. A/A is never subtracted,
used to normalize A/B, or used to cancel an adverse result. Wide intervals do
not prove no regression.

## Correctness and decision criteria

Every import output is checked for frozen numeric shape, size, depth, owner,
every input byte, every tree pointer and every unused branch slot. At least one
result per batch is fully materialized through the public API. Every scalar
control output is checked completely. Every numeric count is checked against an
independent full JavaScript predicate scan. Published source bytes, complete
source values, and the entire input buffer, including subview margins, must stay
unchanged after every batch.

Source, WASM, all bundles, workload, runner, fixture digests, runtime versions,
affinity, exact process order, warmup and measured times, and verified-output
counts are retained. Independent auditing must recompute all estimates and bind
the graph and real-worker evidence to the measured build. The unchanged source
and bundle identities are checked again when each study finishes.

Proceed only for repeatable, useful import gains with clear disclosure of tiny
inputs, shared inputs, both encoding histories, and every regression control.
The user's allowance for a small Bun cost does not justify hiding a large or
uncertain adverse effect in the changed numeric entry. Do not tune or discard
measurements to obtain a preferred result. A correctness fix requires a new
source identity and clearly separate measurements. No merging is authorized.
