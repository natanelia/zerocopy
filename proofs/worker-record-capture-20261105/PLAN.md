# Worker record capture study

## Frozen change

Baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.
Only runtime source `worker-protocol.ts` changes. `recordOf()` reads descriptors
directly into its private output record, removing the intermediate descriptor
object and `Object.entries()` tuples. It still reads all descriptors before
rejecting accessors, including hidden symbol descriptors, in the original order.
It does not cache snapshots or skip metadata/arena capture.

The benchmark records exact source text and source, WASM, bundle, workload and
driver SHA-256 hashes, then checks those identities again at completion. The
candidate is measured with its source edits on the same baseline commit; source
and build hashes, rather than the worktree HEAD alone, identify the candidate.

## Workloads and decision

`workloads.mjs` declares ten complete-operation cases before timing: changed
512- and 128-name records, an unchanged 128-name record, a frozen changed
128-name record, complete state creation, keyed update, a four-name record,
an empty record, single-collection publication and direct `getWorkerData()`.
Named fixtures alternate maps and lists with distinct immutable handles. Only
the first collection changes between two retained snapshots. Source writes and
fixture preparation are outside timing; publication still captures every name.

The primary targets are the two ordinary changed-record publication sizes.
Advance only for repeatable reductions in both Node and Bun, with paired final
intervals below parity. Preserve every additional case and adverse sample. A
material, unresolved slowdown in the declared boundaries or controls blocks a
claim of a validated improvement. A/A results diagnose host variation, remain
separate and are not subtracted from A/B.

The ten-case pilot has two process pairs. If the pilot supports the change,
freeze source and workload and run one confirmation with six pairs. A separate
four-pair A/A study uses the predeclared changed 128-name and single-collection
cases. A failed or interrupted run remains in the evidence with its failure.

## Method

The copied `paired-benchmark.mjs` holds `/tmp/zerocopy-performance.lock` for an
entire study. The coordinator and subjects inherit one CPU affinity. Every
subject imports one portable build through the same neutral path and runs one
case in a fresh process. AB/BA order alternates per pair; runtime and case order
also reverse per pair. Baseline and candidate use equal repetition counts.

Each subject has at least eight warm-up batches and 150 ms of actual timed
warm-up in the pilot, 500 ms in confirmation/A/A, followed by nine measured
batches. Estimates use process medians and geometric means of paired ratios;
95% intervals use a Student-t interval on log ratios across process pairs.
These are per-case, unadjusted intervals. Short batches are retained and flagged.

The timer includes the entire public call and output retention. `publish()` and
`update()` cases also read `state.current` so every produced record is retained
for complete validation. State creation includes its complete constructor; the
returned state's verification and disposal occur outside timing. Imports,
source construction, verification and the outer retention array are excluded.
Verification happens between batches and can affect subsequent garbage
collection. Ordinary allocations and GC during the public calls remain timed.

Every returned record is checked for complete key order, null prototype,
frozen state and exact retained collection identities. Source records, complete
source-arena bytes, allocation counts and version counters are checked between
batches. The direct worker-data control verifies the whole payload. These are
local publication/capture timings, not worker-message delivery latency.

## Correctness checks

All 14 new focused cases pass unchanged main. They cover retained inputs and
arena bytes, special names and ordering, empty/single shape distinctions,
hidden fields and symbols, noninvoked getters/setters, enumerable symbol
rejection, exact Proxy descriptor order, later failures before earlier accessor
errors, disappearing/added fields and values mutated by later descriptor traps.
Candidate Node and Bun focused suites each pass 53 cases across three files.

The strict worker TypeScript check has 12 failures in unchanged `arena.ts` and
`redux-jsan.ts`, reproduced on baseline. These are recorded separately and are
not hidden or folded into this performance change.
