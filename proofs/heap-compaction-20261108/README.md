# Faster priority-queue compaction — 8 November 2026

The final change reduces complete public `compact()` / `compactMany()` time for
the tested large priority queues. All **36 of 36** primary process-pair comparisons
improved: **61.7–65.0% less time on Node** and **37.4–45.9% less time on Bun**.
All six primary target/runtime 95% intervals exclude parity. Object-valued heaps
also improved in every pair: 41.8% less time on Node and 21.7% on Bun.

The small and unrelated-map controls are **inconclusive**. Their intervals are
wide and do not establish equivalence or absence of a slowdown. The later
processes also show substantial absolute-time drift. Every observation, both
rejected-pilot histories, and the same-baseline A/A study are retained below.
This report makes no browser timing, ARM timing, memory-usage reduction, or
universal no-regression claim.

## What changed

Compaction previously constructed and hashed a string containing the arena ID,
value type, and address on every heap-node lookup. It also allocated short tuple
arrays for postorder traversal and visited null children. The final implementation
groups relocations by the exact arena/type identity once, uses numeric addresses
inside that group, and keeps traversal in a flat local stack.

The grouped tables are local to one compaction operation and remain available
across its forks and nested snapshots. A type-only `declare` field leaves the
non-heap compactor's emitted initial fields unchanged. The heap cache is created
only when a nonempty heap is visited. The change keeps the same copying order,
shared live nodes, value decoding, old snapshots, wire format and WASM bytes.

## Final V3 before / after

Measured from `2026-11-08T09:54:15.671Z` to `2026-11-08T09:58:22.654Z` on
Linux x64, AMD EPYC 9V74, with the process pinned to CPU 2. Runtimes were
Node 24.22.1 and Bun 1.4.2. Baseline:
`0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.

The time columns are medians of process estimates. Ratios and intervals use
matched process pairs, so the ratio need not equal the ratio of the two displayed
medians. Values below one mean less time. These are unadjusted pointwise intervals.

| Runtime | Complete operation / input | Before ms | After ms | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | 4,096 numbers, mixed priorities | 6.340 | 2.118 | 0.350 (0.320–0.382) | 6/6 |
| node | 4,096 numbers, left spine | 6.595 | 2.049 | 0.367 (0.282–0.478) | 6/6 |
| node | 4,096-number heap + two forks + alias | 6.113 | 3.135 | 0.383 (0.283–0.519) | 6/6 |
| node | 1,024 objects (generic-value control) | 2.477 | 1.398 | 0.582 (0.509–0.664) | 6/6 |
| node | One node (small control) | 0.050 | 0.047 | 1.115 (0.637–1.953) | 3/6 |
| node | Empty heap (control) | 0.039 | 0.053 | 1.318 (0.731–2.376) | 2/6 |
| node | 1,024-entry map (unmodified-path control) | 0.829 | 1.218 | 1.100 (0.834–1.451) | 2/6 |
| bun | 4,096 numbers, mixed priorities | 5.814 | 2.893 | 0.557 (0.395–0.787) | 6/6 |
| bun | 4,096 numbers, left spine | 3.676 | 2.084 | 0.541 (0.470–0.622) | 6/6 |
| bun | 4,096-number heap + two forks + alias | 5.227 | 2.654 | 0.626 (0.496–0.790) | 6/6 |
| bun | 1,024 objects (generic-value control) | 3.069 | 2.301 | 0.783 (0.663–0.926) | 6/6 |
| bun | One node (small control) | 1.274 | 1.376 | 1.051 (0.939–1.176) | 2/6 |
| bun | Empty heap (control) | 1.430 | 1.282 | 0.986 (0.807–1.205) | 2/6 |
| bun | 1,024-entry map (unmodified-path control) | 1.773 | 2.083 | 1.127 (0.944–1.345) | 2/6 |

Source files were uncommitted edits atop the pinned baseline while measured.
The embedded source text and hashes, rather than that unchanged Git HEAD, identify
the tested candidate. The exact final `compaction.ts` SHA-256 is
`4b5beaecac677a2e551e9ce148183435232062e08304286a0baaf33cb6efe294`. The final source is also retained in
[source-snapshots/v3-compaction.ts](source-snapshots/v3-compaction.ts).

### Control limitations and observed drift

Node's single-node, empty-heap and map controls estimate 11.5%, 31.8% and 10.0%
more time, respectively; all three intervals span parity. Bun's single-node and
map controls estimate 5.1% and 12.7% more time, also with intervals spanning
parity. These observations remain unresolved; they are not presented as wins.

Absolute process estimates increased later in the study. For example, the Bun
single-node control reached approximately 4–5 ms in the last A/B pairs, compared
with roughly 1–2 ms earlier. The subsequent same-baseline A/A study below also
varied substantially. No observation was discarded, corrected by A/A, pooled
with another study, or replaced by a new run. All target comparisons still
improved in every final pair despite this observed instability.

The final study retains **72 of 1512 measured batches shorter than 2 ms**.
They occur in small Node controls and limit those controls' precision. All raw
batch durations and warmup durations remain in the recordings.

## Same-baseline A/A

Four fresh process pairs per runtime and case, using the unchanged baseline on
both sides. All six intervals include parity. These describe instability in
this measurement environment; they are not a correction factor or evidence that
the uncertain A/B controls are harmless.

| Runtime | Complete operation / input | Before ms | After ms | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | 4,096 numbers, mixed priorities | 14.664 | 14.111 | 0.962 (0.673–1.375) | 3/4 |
| node | One node (small control) | 0.128 | 0.147 | 1.049 (0.469–2.350) | 2/4 |
| node | 1,024-entry map (unmodified-path control) | 2.456 | 1.792 | 0.733 (0.474–1.135) | 4/4 |
| bun | 4,096 numbers, mixed priorities | 14.315 | 13.644 | 0.877 (0.667–1.153) | 3/4 |
| bun | One node (small control) | 6.597 | 5.939 | 0.957 (0.537–1.703) | 1/4 |
| bun | 1,024-entry map (unmodified-path control) | 8.154 | 8.631 | 1.193 (0.749–1.901) | 1/4 |

The A/A study retained 2 of 432 measured batches shorter than 2 ms.

## Exploratory history

### V1: flat traversal only — rejected

This version only removed tuple allocations and null-child visits. Node's
long-spine target did not improve consistently, and controls were unstable.
Its pilot is kept separately and is not pooled with the final confirmation.

| Runtime | Complete operation / input | Before ms | After ms | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | 4,096 numbers, mixed priorities | 5.527 | 5.196 | 0.940 (pilot; no interval) | 2/2 |
| node | 4,096 numbers, left spine | 5.130 | 5.348 | 1.044 (pilot; no interval) | 1/2 |
| node | One node (small control) | 0.050 | 0.060 | 1.194 (pilot; no interval) | 1/2 |
| node | 1,024-entry map (unmodified-path control) | 0.818 | 1.127 | 1.314 (pilot; no interval) | 0/2 |
| bun | 4,096 numbers, mixed priorities | 4.744 | 3.764 | 0.797 (pilot; no interval) | 2/2 |
| bun | 4,096 numbers, left spine | 4.185 | 3.943 | 0.933 (pilot; no interval) | 1/2 |
| bun | One node (small control) | 1.228 | 1.253 | 1.020 (pilot; no interval) | 0/2 |
| bun | 1,024-entry map (unmodified-path control) | 2.127 | 1.724 | 0.809 (pilot; no interval) | 2/2 |

### V2: numeric relocation tables

Adding the grouped numeric-address cache produced large gains in both target
cases and both runtimes. The Node map control still estimated a slowdown. Before
final confirmation, V3 removed the emitted own undefined `heapPointers` field
from all compactors with a TypeScript `declare` field. This made the ordinary
non-heap compactor's initial fields exactly the original three fields. No extra
V3 pilot was run.

| Runtime | Complete operation / input | Before ms | After ms | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | 4,096 numbers, mixed priorities | 7.601 | 2.674 | 0.349 (pilot; no interval) | 2/2 |
| node | 4,096 numbers, left spine | 5.130 | 1.939 | 0.378 (pilot; no interval) | 2/2 |
| node | One node (small control) | 0.055 | 0.047 | 0.866 (pilot; no interval) | 2/2 |
| node | 1,024-entry map (unmodified-path control) | 0.835 | 1.067 | 1.229 (pilot; no interval) | 1/2 |
| bun | 4,096 numbers, mixed priorities | 3.923 | 2.109 | 0.535 (pilot; no interval) | 2/2 |
| bun | 4,096 numbers, left spine | 3.504 | 1.928 | 0.548 (pilot; no interval) | 2/2 |
| bun | One node (small control) | 1.465 | 1.414 | 0.961 (pilot; no interval) | 2/2 |
| bun | 1,024-entry map (unmodified-path control) | 2.015 | 1.619 | 0.819 (pilot; no interval) | 1/2 |

Both pilots used two pairs, 150 ms minimum timed warmup, at least eight warmup
batches, and nine measured batches. Pilot V1 retained 4 short measured
batches; V2 retained 1. All full source snapshots are embedded in
those recordings and copied into [source-snapshots](source-snapshots/).

## Method and correctness

The [frozen plan](PLAN.md), [runner](paired-benchmark.mjs), and
[workloads](workloads.mjs) are included. The final study has six A/B pairs per
runtime/case, and the separate A/A study has four. AB/BA order alternates by
pair; runtime and case order reverse by pair. Each fresh process imports one
build through the same neutral package path and runs one workload. A common
exclusive lock keeps these studies from overlapping other coordinated timings.

Each final/A/A process performs at least eight warmup batches and 500 ms of
actual timed warmup, followed by nine measured batches. Complete public
`compact()` or `compactMany()` calls and output retention are inside the timer.
Imports, fixture creation and full output validation are outside it. The unit of
inference is an independent process pair; measured batches are not treated as
independent observations.

After each batch, every returned collection is checked completely: entries,
sizes, heap mode, frozen state, copied memory independence, heap topology,
shared live-node counts and group aliases. Numeric results must allocate exactly
one 32-byte node for each unique live node. Every source byte and every retained
source snapshot is checked unchanged. Source, build, WASM, workload and driver
identities are recorded and checked again when the study completes.

Local validation of V3 passed:

- Main TypeScript check and the portable build.
- Node and Bun focused suites: **29 tests across two files in each runtime**,
  including eight new tests for long spines, special numeric values, shared
  forks, identical addresses in distinct arenas, nested heap types, string/JSON
  values, memory growth and read-only shared/copied attachments.
- All seven complete public workload oracles on Node and Bun, without timing.
- Actual Node workers compacting object heaps, forks and aliases with both
  shared and copied input transports, then updating the independent result.
- Independent verification of all four recordings: **280 processes and
  2,520 measured batches**.

[Validation metadata](validation.json) records the observed local checks. The
[dedicated workflow](../../.github/workflows/heap-compaction.yml) repeats focused
correctness, real workers, workload oracles and saved-evidence verification. It
does not collect new timings. Full-suite, package and broader type checks remain
in the repository's main CI workflow and are not claimed here as local results.

## Evidence and reproduction

- [V1 pilot](results/pilot-v1.json.gz),
  [V2 pilot](results/pilot-v2.json.gz),
  [final V3 A/B](results/formal-v3.json.gz),
  [same-baseline A/A](results/aa-v3.json.gz).
- [Archive and source manifest](manifest.json).
- [Independent verifier](verify.py), [untimed workload smoke](smoke.mjs),
  [real worker proof](worker.mjs).

Each `.json.gz` decompresses to the original unmodified JSON recording. The
manifest records both compressed and uncompressed hashes. To verify saved
evidence without running timings:

```sh
python3 proofs/heap-compaction-20261108/verify.py proofs/heap-compaction-20261108/results/*.json.gz
```

To reproduce timings, create clean baseline and candidate checkouts at the pinned
baseline commit. In the candidate, overlay the appropriate exact source from
`source-snapshots`: V1, V2, or V3 as `compaction.ts`. Install the pinned dependencies
and build both with `node scripts/build-wasm.mjs` and `bun scripts/build-browser.ts`.
Use Node 24.22.1 and Bun 1.4.2. Keep other heavy work off the timing CPU.

From a checkout containing these proof files, choose new output filenames:

```sh
taskset -c 2 node proofs/heap-compaction-20261108/paired-benchmark.mjs   proofs/heap-compaction-20261108/workloads.mjs   /absolute/baseline /absolute/candidate /absolute/bun /absolute/new-formal.json formal

taskset -c 2 node proofs/heap-compaction-20261108/paired-benchmark.mjs   proofs/heap-compaction-20261108/workloads.mjs   /absolute/baseline /absolute/candidate /absolute/bun /absolute/new-aa.json aa
```

The runner refuses to overwrite a recording, checks the exact baseline, verifies
that only the declared production source differs, and requires identical WASM.
Use mode `pilot` and its corresponding archived source to reproduce either pilot.
A host without CPU 2 can choose a different available CPU, but the results then
need their own host/affinity record and must remain separate.
