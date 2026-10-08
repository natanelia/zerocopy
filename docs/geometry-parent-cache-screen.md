# Frozen geometry parent-cache public screen

Status: prospective protocol and proof-only preparation. No latency pilot,
throughput measurement, CI dispatch, publication or performance acceptance has
occurred. Reduced pointer loads are a mechanism hypothesis, not a speed claim.
The preceding [untimed experiment](geometry-parent-cache-experiment.md) remains
unchanged. This protocol supersedes its prospective Node version and fills in
its previously unfrozen batching, warmup, process and statistical rules.

## Fixed source and scope

- Baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`.
- Reviewed runtime: `c6db76c1363b6f7512a9919fe7f450ef801fd626`, tree
  `ad3c3cb8669b3cfe77943caa78bee89f38572c29`, directly based on that baseline.
- Only production difference: the reviewed parent cache inside AssemblyScript
  `bboxXY`. The production source, original geometry proof, original benchmark,
  fixtures and historical evidence are not edited by this proof patch.
- Linux x64 and ARM64; Node **22.23.3**, Bun **1.4.2**, AssemblyScript **0.28.20**.
  Runtime version mismatches invalidate the run. Default JIT and build settings
  only; no engine flags, alternate kernels, fixture tuning or layout tuning.

The initial study has eleven shapes, each reported separately:

| Points | Kind | Purpose |
| --- | --- | --- |
| 16 | random | Tail-only control |
| 17 | random | Depth-zero root and partial tail |
| 32 | random | Depth-zero root and full tail |
| 512 | random | Depth-one control with no pointer-load saving |
| 528 | random | Last depth-one shape |
| 529 | random | First depth-two shape |
| 16400 | random | Last depth-two shape |
| 16401 | random | First depth-three shape |
| 131072 | random | Documented deep case |
| 131072 | road | Existing coordinate/branch shape |
| 131072 | late-zero | Existing late signed-zero shape |

The original deterministic coordinate generator uses seed 913. The late-zero
array and its final coordinates are copied as an exact source slice from the
original benchmark. Setup and expected-result construction remain untimed.
The shape list, seed, schedule, statistical rules and time targets are fixed
before a pilot; no cell is selected using its eventual result.

## Exact operations and controls

`proofs/geometry-parent-screen-subject.mjs` verifies the full original
`proofs/geometry-bbox.mjs` hash and extracts its unmodified fixture construction,
raw kernel helper, function table and sink loop. `geometry-fixtures.mjs` is
copied unchanged. The measured methods are:

1. `public`: the complete exported `bboxXY(p)`, including validation, instance
   lookup, traversal and fresh result tuple. This is the primary result.
2. `scalar-kernel`: the original direct kernel call and all four result reads,
   separately labeled as a secondary control.
3. `js-flat`: the original full flat-array reference, separately labeled as a
   secondary control.

Each timed batch executes the original loop:
`for (let i = 0; i < iterations; i++) sink += functions[name]()[0];`
The sink and every batch duration/work count are retained. Allocation/setup,
complete-tuple equality, hashes, file receipts, serialization and shared-memory
checks are outside timing. All four tuple values are checked with `Object.is`
before and after each process's work; the timed result consumption remains the
original first-lane accumulation. No coordinate copy or abbreviated point loop
replaces the public operation.

The unmodified Turf and `SharedList.forEach` callables and their full original
target data remain in the original benchmark. The new neutral process checks
`shared-forEach` for exactness. Turf exactness remains part of the required
original untimed geometry proof. Neither adds a latency dimension to this
initial screen. No raw-kernel result substitutes for a public result.

## Independent processes and common work

Each runtime/architecture runs the same fixed seed-20261008 case order. For each
shape it has four AB quartets and four baseline-AA quartets. Each mode has two
LRRL and two RLLR quartets, with a frozen balanced mode/order schedule. A measured
process loads exactly one build and shape. AB assigns baseline to left and
candidate to right; AA assigns baseline to both labels. There are 352 measured
processes per runtime/architecture, each with all three separately sampled
methods. The methods alternate forward/reverse order by batch and by quartet
slot, so each label gets both starting orders. No process imports both builds.

Every subject uses the same physical neutral package directory, entry filenames
and package.json bytes. The controller replaces its contents with the frozen selected
build before spawning; it verifies the complete file manifest both before and
after. Node and Bun explicitly import the same portable `dist/shared.js` and
`dist/geometry.js` entrypoints. Node compile caching is disabled uniformly.

Before pilots, 22 fresh untimed subjects verify every shape on both builds.
Then both builds pilot every shape/method in separate processes. All 22 pilot
processes finish before **any** measured process starts. For each method:

- Prewarm to at least 500 ms and 1,024 calls; 15-second wall/100-million-call
  caps are explicit failures, never silent truncation.
- Calibrate until all three terminal probe batches reach 40 ms. Retain all
  probes. At most 16 calibration steps and 10 million calls per batch.
- Use the fastest observed post-warmup time per operation across both builds
  to prescribe a common integer batch count targeting 40 ms.
- Prescribe common fixed warmup work targeting 500 ms, rounded up to whole
  batches. Freeze every shape/method plan in `plans.json` before measurement.

A measured process performs that exact work count for warmup and then 21
samples, alternating method order. It does not extend warmup or batches after
seeing times. A measured batch below 10 ms, warmup below 150 ms, cap, equality
failure, changed shared bytes/allocator, missing result or changed receipt
invalidates the affected evidence. No dropped samples, within-run retries,
outlier removal or A/A normalization are allowed. Failures and partial stdout,
stderr, work counts, sinks, pilot/warmup batches and samples are retained.

## Analysis and decision rules

For each method/shape, take the median of 21 absolute batch times in each
process and divide by its fixed count. Pair adjacent opposite-role processes
within each quartet, compute right/left latency ratios, and average the two
log ratios within the quartet. The independent units are the **four quartets**,
not the eight pairs or 21 batches. Exponentiate their mean for the reported
geometric mean candidate/baseline latency ratio.

The pointwise 95% interval is the mean log ratio plus/minus
`3.182446305284263 * sqrt(sample_variance / 4)` (Student-t, df = 3), exponentiated.
The report includes all quartet log ratios, paired absolute times, process
means/medians/minima/maxima, sample variances and coefficients of variation.
These intervals are pointwise; no simultaneous-coverage or pooled claim is made.

The practical no-regression margin is 2%:

- Lower interval bound above 1.02: detected material loss.
- Upper bound at or below 1.02: evidence within the margin.
- Otherwise: inconclusive.

A baseline-AA control invalidates its method/shape if its point ratio is outside
`[1/1.02, 1.02]` **and** its interval excludes 1. The interval need not be wholly
outside the 2% band. Any invalid method or unresolved control holds the whole
runtime/architecture screen, including a secondary method. A primary method's
individual `inferenceUsable` field must not be read as a row or screen pass when
a secondary control is invalid. Secondary performance ratios never rescue a
public regression or determine a public gain. A flat-array AB difference is
descriptive; it is not an additional negative-control veto beyond that method’s
AA drift, floors and completeness checks.

All eleven public cells must establish the margin on all four required
runtime/architecture combinations. Missing, invalid, regressed or inconclusive
cells hold the combined screen. There is no averaging small controls against
large gains, no automatic runtime acceptance, and no stable speed guarantee.
The complete report retains secondary results even when slower or inconclusive.

## Prerequisites and provenance

The baseline worktree lives outside the candidate project. Both trees build
Wasm, portable browser modules and declarations in that order. Declarations
exist before the public worker consumer check. The required native receipts are:

- Full standard `bun run test` on each tree; source, geometry, Redux and both
  typed-value checks; public worker declarations via `tsconfig.worker.json`.
- Actual packed-package consumer checks (Node/Bun entrypoints, immutable
  snapshots, Node worker and strict types).
- Built Node worker, worker-task lifecycle, typed worker Markdown examples,
  Redux and typed-JSON worker proofs on each tree.
- The unmodified untimed geometry proof under Node and Bun: 4,309 read-only
  cases, all 4,096 original seeds, 123 structural traces, eight actual-worker
  cases and two deterministic mid-scan-growth probes per runtime.
- Deterministic protocol/negative tests with invented durations, then all 22
  neutral-package shape/build correctness checks before pilots.

This native screen does not replace all repository CI or add browser execution.
It does not run the original mixed correctness/timing benchmark as a prerequisite.
A failed prerequisite blocks pilots; it cannot be marked successful by a retry.

Receipts bind every original source/proof input to the immutable refs, the
complete transitive compiler-package file hashes, each root Wasm, every
portable bundle/declaration file, embedded Wasm bytes, and each actual neutral
package file. The new geometry module must have its reviewed hash; all eleven
unrelated root Wasm files must match. Embedded modules must match the root
module hashes. Source archives, actual versions/CPU/architecture, process
commands, physical paths, package bytes, raw outputs and all partial failures
are archived. Source identities are checked before prerequisites; fresh-build receipts are
checked after prerequisites and again before freezing. Actual subject receipts
are checked before and after every process.

## Bounded trigger and stopping condition

The workflow has only a scoped push trigger for
`perf/geometry-parent-cache-20261008`, restricted to these new proof files. Its
job and controller require the push's `before` SHA to equal the reviewed runtime
commit, the `after` SHA to equal the proof head, a non-forced/non-deletion push,
and run attempt 1. There is no pull-request or dispatch trigger. A rerun or later
push cannot silently create another study. Publication remains a separate
explicit action; committing these files does not authorize timing.

The four matrix jobs preserve artifacts with `always()` even on failure. The
combined report stops with a held status if any required result is unresolved;
otherwise it reports only that this prospective public screen is within the
margin. No adaptive follow-on measurements, PR or merge occurs.
