# Rejected worker record capture study

**Evidence only; no optimization PR.** Wide changed-record publication improved,
but a repeatedly adverse Node single-collection control remains unresolved.
Active production is restored to baseline. Exact measured source, tests,
planned CI workflow, all raw samples and verification logs are retained.
No source variant or timing rerun followed the frozen confirmation.

## Decision

The candidate removed the intermediate descriptor object and entry-pair array
from worker record validation. It retained ordinary collection validation,
arena capture and snapshot identity comparison on every publication. No
snapshot caching was added.

| Runtime | 512-name publication before µs | After µs | Paired ratio | 95% interval | Faster pairs |
| --- | ---: | ---: | ---: | --- | ---: |
| Node 24.22.1 | 776.149 | 609.065 | 0.8290 | 0.7323–0.9384 | 6/6 |
| Bun 1.4.2 | 502.348 | 400.370 | 0.8141 | 0.6889–0.9619 | 5/6 |

These are 17.1% and 18.6% paired reductions for this workload. Before/after
columns are medians of process medians; their ratio need not equal the paired
estimate. These gains do not clear the remaining concern: Node single-collection
publication was **9.7% slower**, **five of six pairs slower**, with a wide ratio
interval of **0.9395–1.2809**. Its pilot estimate was **10.2% slower**. Its
baseline-only A/A estimate was **8.0% slower**, interval **0.8514–1.3711**.
A/A diagnoses variation; it does not cancel the A/B result. An interval spanning
parity neither establishes a slowdown nor establishes equivalence. This repeated
adverse observation blocks the declared acceptance rule. Bun changed 128-name
publication is also inconclusive: **0.9424 [0.6954–1.2770]**, two of six faster pairs.

All 20 final rows and all raw pair ratios are visible in [confirmation](formal.md),
[pilot](pilot.md) and [A/A](aa.md). No universal speedup or no-regression claim is made.

## Source and behavior

- Baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.
- Exact candidate: [worker-protocol.ts](measured-source/worker-protocol.ts.txt).
- Candidate SHA-256: `3695b49f8c0730d2f9172d63cb728da1bbdb1c0bf139fc324dc9054d6074ed77`.
- The measured worktree retained baseline HEAD with edited source; embedded
  source text and source/build hashes identify the candidate independently.

The proposed `recordOf()` preserved the original symbol pass and descriptor
read order, including nonenumerable symbols. It stored values in a private
null-prototype record, deferring accessor errors until all descriptors had been
read. Thus later throwing descriptor traps still precede earlier accessor
rejection. Public signatures, wire format, arena collection and identity
comparison were unchanged.

## Method

The [frozen plan](PLAN.md), [workload](workloads.mjs) and [driver](paired-benchmark.mjs)
declare ten complete-operation cases: wide, ordinary, unchanged, frozen, small
and empty record publication; state creation; keyed update; single-collection
publication; and direct worker-data capture. Map/list fixtures are prepared
before timing. Only the first collection changes; all names are captured.

Linux x64, AMD EPYC 9V74, Node 24.22.1 and Bun 1.4.2. Every subject imported one
portable build through the same neutral path in a fresh process, pinned to CPU 2
under `/tmp/zerocopy-performance.lock`. Other timed/heavy agent work was paused.
AB/BA, case order and runtime order reversed per pair. Counts were identical
for baseline/candidate and both runtimes.

Every subject had at least eight warm-up batches and 150 ms actual timed
warm-up in the pilot, 500 ms in confirmation/A/A, followed by nine measurements.
The timer included the complete public call and result retention. Publication
and update also read `current` for complete output verification. Imports,
fixtures, oracles, outer retention arrays, verification and construction disposal
were outside timing. Verification between batches can affect later GC; normal
allocations and GC inside public calls remain timed.

Each output was checked for complete key order, frozen state, null prototype and
exact retained collection identities. Invariants compared all source-arena
bytes, allocation sizes, input references and version counters. Worker-data
controls verified whole payloads. These are local-publication timings, not
worker-message delivery measurements.

Nine batches yield one process median, not nine independent experiments.
Confirmation uses six paired ratios with unadjusted 95% Student-t intervals on
their logarithms. A/A uses four baseline-only pairs. All warm-up times, short
batches and adverse observations remain recorded.

## Correctness and limits

All 14 [new regressions](measured-source/worker-record-capture.test.ts.txt) passed
unchanged main. Candidate Node and Bun each passed **53 tests in three files**.
They cover retained inputs/bytes, special names, ordering, hidden properties,
symbols, noninvoked accessors, exact proxy trap order, disappearing/added keys,
later mutations and error precedence.

The [real-worker proof](worker.mjs) passed for **132 names** in both shared/copy
transport, with retained snapshots, growth, unchanged reader identities, failed
validation and compaction. The existing all-type proof passed with two real
workers, all 12 types and actual Toolkit publication. [Logs](validation/) retain
both proofs. Correctness does not clear the performance concern.

The strict worker TypeScript check failed on 12 errors in unchanged `arena.ts`
and `redux-jsan.ts`, independently reproduced on baseline; the [log](validation/typecheck-worker.txt)
is retained. Browser checks were planned in the [archived workflow](measured-source/worker-record-capture.yml)
but not run for this rejected experiment. No CI workflow is activated here.

## Complete evidence

Three separate studies contain **352 fresh subjects and 3,168 measured batches**.
Pilot, confirmation and A/A are not pooled. Lossless compression preserves every
original byte; [manifest.json](manifest.json) records compressed/original hashes,
original sizes and archived-source hashes.

- [Pilot](pilot.json.gz): 80 subjects, 720 measured batches.
- [Confirmation](formal.json.gz): 240 subjects, 2,160 measured batches.
- [A/A](aa.json.gz): 32 subjects, 288 measured batches.

The independent verifier checks source snapshots, frozen harnesses, process
order, warm-ups, measurements, output-check counts and summary arithmetic:

```sh
python3 proofs/worker-record-capture-20261105/verify.py \
  proofs/worker-record-capture-20261105/pilot.json.gz \
  proofs/worker-record-capture-20261105/formal.json.gz \
  proofs/worker-record-capture-20261105/aa.json.gz
```

## Reproduction

Create two worktrees at the baseline and **restore the archived candidate source**
into the candidate worktree; active production in this archive equals baseline.
For example, from this archive checkout:

```sh
archive=$PWD
git worktree add --detach ../record-before 0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e
git worktree add --detach ../record-after 0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e
cp "$archive/proofs/worker-record-capture-20261105/measured-source/worker-protocol.ts.txt" \
  ../record-after/worker-protocol.ts
for build in ../record-before ../record-after; do
  (cd "$build" && bun install && bun run build:wasm && bun run build:browser)
done
taskset -c 2 node proofs/worker-record-capture-20261105/paired-benchmark.mjs \
  proofs/worker-record-capture-20261105/workloads.mjs \
  ../record-before ../record-after "$(command -v bun)" /tmp/new-worker-record-study.json formal
```

Choose an allowed CPU and fresh output path. The driver holds the common lock
itself; do not add another flock for that path. Other heavy work must use the same
lock or pause. The original studies shared one dependency tree and unchanged WASM.
No dependency lockfile exists at this baseline, so transitive versions can differ
when reproducing; record them and compare tool/source/build hashes. Exact source
and build identities are checked before and after the complete study.
