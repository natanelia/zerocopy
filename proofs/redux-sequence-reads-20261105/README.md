# Redux numeric stack and queue encoding: measured evidence

The five declared target operations used **60.8–77.8% less time in Node and
35.4–67.5% less time in Bun** in the six-pair confirmation. Every target improved
in every pair: **60 of 60 target comparisons**. All ten target/runtime intervals
exclude parity.

This result is specific to the listed numeric/boolean workloads. The controls
do not establish universal improvement or equivalence: Node's JSON-stack and
string-queue controls estimated **7.5% and 11.1% slower**, respectively, with
four of six pairs slower in each case. Their intervals cross parity and also
permit material regressions. Every result, including these observations, appears
below and remains in the raw evidence.

A separate 32/33-element diagnostic also found improvements in all twelve
case/runtime combinations, including the 32-element activation threshold.
Those results and their own same-build controls appear separately below;
they are not pooled with the original large-sequence confirmation.

## What changed and what remains in scope

Portable Redux encoding previously read stacks with repeated
`peek()/pop()` calls and queues with `peek()/dequeue()`. Each advance creates
and freezes another immutable snapshot solely to reach the following value.
The new internal reader avoids those per-element wrappers for sequences with
**at least 32 numeric or boolean elements remaining**.

The stack reader follows the existing immutable links. It preserves the
constructor's explicitly cached initial top and the same reads after the final
element. The queue reader keeps the current vector lookup and tail layout,
including partially dequeued queues. The work is still linear in the number
of values, with existing queue vector lookups; no asymptotic improvement is
claimed.

Before taking this path, the codec checks native reader descriptors without
invoking overridden getters. The original identities are captured in the
modules that define Arena, SharedStack and SharedQueue, so replacing methods
before a later optional Redux import still selects the public-method fallback.
Custom decoders, custom Arena subclasses, small/empty sequences, strings, JSON
objects and nested collections keep that fallback. The eligibility check runs
before creating the encoder closure for small and nonprimitive sequences.

Public entrypoints and signatures, wire data, dependency versions, collection
writers and WASM are unchanged. The implementation assumes the Arena's native
internal WASM kernels; arbitrary replacement of those internal kernel exports
is not a supported extension point. No JS heap-size, startup-time, universal
no-regression, ARM performance or browser performance claim is made.

## Baseline and environment

- Frozen baseline: [`b07bffe073a7f7d60f1dd7731358c16d1075eb45`](https://github.com/natanelia/zerocopy/commit/b07bffe073a7f7d60f1dd7731358c16d1075eb45).
- Linux x64, AMD EPYC 9V74 80-Core Processor, kernel 6.18.57.
- Node **24.22.1** and Bun **1.4.2**, using the portable JS bundles in both runtimes.
- CPU affinity **2** and the shared `/tmp/zerocopy-performance.lock` timing lock.
- Identical WASM hashes for baseline and candidate.
- No production-source or original-workload changes between the pilot,
  confirmation and identical-baseline diagnostics.

The candidate source identities are recorded below. Each recording also embeds
the complete changed-source text and hashes all root runtime sources, build
scripts, WASM binaries and portable bundles. The baseline files are checked
against the declared Git commit before timing; both source/build identities
are checked again when the study finishes.

Both measurement worktrees reported the baseline as their Git HEAD: the
candidate implementation was an uncommitted change during measurement.
`source.after.commit` therefore identifies the checkout parent, not a distinct
candidate commit. The actual measured candidate is identified by the embedded
source text, source hashes and portable-bundle hashes. The publication step will
compare its runtime files against those frozen candidate hashes before opening
the PR.

## Complete confirmation results

Times are **microseconds per complete public operation**. Before and after are
the separate medians of six process medians. Each process median comes from
nine measured batches divided by the fixed operation count. The paired estimate
is the geometric mean of the six after/before ratios; it is intentionally not
calculated by dividing the two displayed marginal medians.

An interval entirely below 1 supports improvement for that case. An interval
crossing 1 does not establish equivalence or absence of a regression.
Intervals are unadjusted per-row 95% Student-t intervals on paired log ratios;
they are not simultaneous bounds over the whole matrix.

| Runtime | Complete public operation | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Node | encode: stack, 4,096 numbers | 747.311 | 150.897 | 0.222 (0.155–0.317) | 6/6 |
| Node | encode: stack, 65,537 numbers | 10500.228 | 2913.527 | 0.269 (0.206–0.352) | 6/6 |
| Node | encode: queue, 4,096 numbers; offset 37 | 430.683 | 147.216 | 0.365 (0.242–0.553) | 6/6 |
| Node | encode: queue, 4,096 booleans; offset 1,057 | 441.094 | 127.865 | 0.298 (0.257–0.344) | 6/6 |
| Node | stringify: stack, 4,096 numbers | 776.068 | 303.037 | 0.392 (0.355–0.433) | 6/6 |
| Node | encode: queue, 8 numbers (small control) | 1.342 | 1.125 | 0.924 (0.756–1.130) | 3/6 |
| Node | encode: empty stack (control) | 0.190 | 0.194 | 1.003 (0.867–1.160) | 3/6 |
| Node | encode: stack, 256 JSON objects (fallback) | 646.610 | 789.716 | 1.075 (0.890–1.299) | 2/6 |
| Node | encode: queue, 256 strings; offset 37 (fallback) | 25.091 | 28.275 | 1.111 (0.869–1.420) | 2/6 |
| Node | encode: map, 1,024 numbers (unchanged) | 291.673 | 269.554 | 0.956 (0.788–1.159) | 4/6 |
| Bun | encode: stack, 4,096 numbers | 237.713 | 89.289 | 0.371 (0.304–0.453) | 6/6 |
| Bun | encode: stack, 65,537 numbers | 3964.894 | 1365.154 | 0.325 (0.246–0.430) | 6/6 |
| Bun | encode: queue, 4,096 numbers; offset 37 | 231.443 | 102.972 | 0.425 (0.344–0.526) | 6/6 |
| Bun | encode: queue, 4,096 booleans; offset 1,057 | 233.844 | 121.313 | 0.502 (0.442–0.570) | 6/6 |
| Bun | stringify: stack, 4,096 numbers | 407.448 | 258.969 | 0.646 (0.565–0.739) | 6/6 |
| Bun | encode: queue, 8 numbers (small control) | 0.700 | 0.672 | 0.953 (0.718–1.264) | 3/6 |
| Bun | encode: empty stack (control) | 0.261 | 0.275 | 1.006 (0.857–1.180) | 3/6 |
| Bun | encode: stack, 256 JSON objects (fallback) | 694.857 | 600.370 | 0.916 (0.780–1.077) | 3/6 |
| Bun | encode: queue, 256 strings; offset 37 (fallback) | 17.986 | 16.567 | 0.955 (0.653–1.396) | 3/6 |
| Bun | encode: map, 1,024 numbers (unchanged) | 171.859 | 186.467 | 1.033 (0.845–1.264) | 3/6 |

The first five cases in each runtime are the targets. The other five are
explicit controls. Object/string caches warm through normal public operations;
the JSON control has 256 values, and the string control retains 256 values after
37 dequeues.

### Adverse and inconclusive observations

The Node JSON-stack estimate is 1.075 (0.890–1.299), with four of six pairs
slower; the Node string-queue estimate is 1.111 (0.869–1.420), also with four of
six slower. The Bun unchanged-map estimate is 1.033 (0.845–1.264), with three
of six pairs slower. Empty-stack point estimates are slightly adverse in both
runtimes. All ten control intervals span parity, including controls whose point
estimate appears faster.

These results are retained as uncertainty. A code path being unchanged or a
same-build diagnostic being noisy does not prove that its A/B observation is
irrelevant. The apparent improvements in controls are not counted as benefits
of this change.

## Measurement method

The frozen [workload module](workloads.mjs) declares all ten cases, fixture
sizes, operation counts, roles and the original same-build control subset
before measurement. The [driver](paired-benchmark.mjs) runs one case and one
build per fresh process. It alternates AB/BA by pair and reverses runtime and
case order on alternating pairs. Both variants import their public entrypoints
from the same neutral temporary path.

The confirmation has **240 processes**: ten cases × two runtimes × six pairs
× two variants. Every process performs at least **500 ms of actual timed
warm-up**, at least eight warm-up batches, then **nine measured batches**.
Uncertainty uses the six process pairs, not the 54 individual batches per
variant as independent experiments.

The timer includes the complete public `codec.encode()` or
`codec.stringify()` call, all result allocations, and assignment to a
preallocated retention array. Imports, fixture/oracle creation, allocation of
that outer retention array, and validation are outside the timer. Every output
is retained until it has been fully verified after its batch. Verification
between batches can affect later garbage collection; this cost is not
presented as allocation-free measurement.

The oracle explicitly produces the documented wire tags and does not call the
implementation's encoder. Numeric values, booleans, order, collection tags and
complete result structure are checked. For the unchanged map control, the
public key iterator supplies the deliberately unspecified map order; values
come independently from the native fixture map. Frozen envelopes, snapshot
descriptors, source size, published bytes and shared allocation are checked
after every batch. Every public result is checked, not just a checksum.

Warm-up and measurement samples, runtime versions, CPU affinity, fixture
digests, stderr, pair order, and batch-duration diagnostics are retained.
Short batches are neither deleted nor retried. No test/build jobs or other
task-owned performance studies ran concurrently.

## Retained pilot

The pilot used the same production source and complete ten-case matrix, two
pairs per runtime, at least 150 ms of timed warm-up, at least eight warm-up
batches and nine measured batches. It contains **80 processes** and remains
separate from the confirmation; no pilot timings are pooled into the final
estimates.

All target pilot pairs improved. Adverse pilot signals included Node's empty
stack at a 1.216 paired ratio, Node's string queue at 1.184 with both pairs
slower, and Bun's JSON stack at 1.097 with both pairs slower. The full
confirmation retained every case and the same source. The extra fallback A/A
diagnostic was declared to examine those fallback signals, without adjusting
the A/B result.

| Runtime | Complete public operation | Before µs | After µs | Paired after/before | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Node | encode: stack, 4,096 numbers | 628.012 | 191.979 | 0.288 | 2/2 |
| Node | encode: stack, 65,537 numbers | 10738.356 | 2947.419 | 0.277 | 2/2 |
| Node | encode: queue, 4,096 numbers; offset 37 | 423.015 | 252.827 | 0.590 | 2/2 |
| Node | encode: queue, 4,096 booleans; offset 1,057 | 371.198 | 164.824 | 0.444 | 2/2 |
| Node | stringify: stack, 4,096 numbers | 794.617 | 287.673 | 0.363 | 2/2 |
| Node | encode: queue, 8 numbers (small control) | 1.022 | 1.043 | 1.019 | 1/2 |
| Node | encode: empty stack (control) | 0.174 | 0.218 | 1.216 | 1/2 |
| Node | encode: stack, 256 JSON objects (fallback) | 811.807 | 671.074 | 0.828 | 2/2 |
| Node | encode: queue, 256 strings; offset 37 (fallback) | 24.321 | 29.405 | 1.184 | 0/2 |
| Node | encode: map, 1,024 numbers (unchanged) | 325.368 | 320.379 | 0.989 | 1/2 |
| Bun | encode: stack, 4,096 numbers | 251.980 | 97.354 | 0.378 | 2/2 |
| Bun | encode: stack, 65,537 numbers | 4606.133 | 1193.003 | 0.253 | 2/2 |
| Bun | encode: queue, 4,096 numbers; offset 37 | 239.300 | 104.126 | 0.437 | 2/2 |
| Bun | encode: queue, 4,096 booleans; offset 1,057 | 273.059 | 123.115 | 0.451 | 2/2 |
| Bun | stringify: stack, 4,096 numbers | 629.575 | 251.757 | 0.418 | 2/2 |
| Bun | encode: queue, 8 numbers (small control) | 0.669 | 0.673 | 0.996 | 1/2 |
| Bun | encode: empty stack (control) | 0.274 | 0.291 | 1.039 | 1/2 |
| Bun | encode: stack, 256 JSON objects (fallback) | 636.303 | 698.164 | 1.097 | 0/2 |
| Bun | encode: queue, 256 strings; offset 37 (fallback) | 20.211 | 18.135 | 0.900 | 2/2 |
| Bun | encode: map, 1,024 numbers (unchanged) | 204.564 | 168.736 | 0.828 | 1/2 |

## Identical-baseline diagnostics

In these studies both labels execute the exact baseline build. Each has four
pairs per runtime, the same 500 ms warm-up requirement and nine measured
batches. Their ratios are reported separately and are never pooled with,
subtracted from or used to correct the A/B ratios.

The original predeclared A/A subset has **32 processes**:

| Runtime | Complete public operation | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Node | encode: stack, 4,096 numbers | 661.320 | 656.589 | 1.076 (0.907–1.276) | 2/4 |
| Node | encode: map, 1,024 numbers (unchanged) | 242.797 | 259.388 | 0.984 (0.578–1.676) | 1/4 |
| Bun | encode: stack, 4,096 numbers | 259.366 | 225.948 | 0.856 (0.725–1.010) | 4/4 |
| Bun | encode: map, 1,024 numbers (unchanged) | 176.570 | 164.660 | 0.962 (0.730–1.268) | 2/4 |

A separately declared [fallback A/A module](workloads-aa-fallback.mjs) examines
the JSON-stack and string-queue controls and adds **32 processes**:

| Runtime | Complete public operation | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Node | encode: stack, 256 JSON objects (fallback) | 612.308 | 618.392 | 1.016 (0.619–1.667) | 3/4 |
| Node | encode: queue, 256 strings; offset 37 (fallback) | 25.333 | 26.735 | 1.057 (0.844–1.324) | 1/4 |
| Bun | encode: stack, 256 JSON objects (fallback) | 516.761 | 537.290 | 1.083 (0.813–1.443) | 1/4 |
| Bun | encode: queue, 256 strings; offset 37 (fallback) | 13.559 | 15.365 | 1.139 (0.997–1.300) | 0/4 |

All eight A/A intervals span parity. Nevertheless, identical code produced an
apparent **14.4% Bun stack improvement** in all four original A/A pairs and
an apparent **13.9% Bun string-queue slowdown** in all four fallback A/A pairs.
The latter interval is 0.997–1.300. Node's same-build string-queue estimate was
5.7% slower, with three of four pairs slower. These observations demonstrate
that the small/control measurements can move materially on this host. They
do not establish equivalence of the candidate fallback paths.

## Separately declared threshold diagnostic

The code becomes eligible at 32 elements, while the original performance
targets start at 4,096. A fixed descriptor-check cost could matter near the
threshold, especially in Bun. Correctness at 31/32/33 elements already passes,
but that alone does not resolve the performance risk.

Before any boundary timing, [a separate frozen module](workloads-boundary.mjs)
was declared with six cases: numeric stacks at 32 and 33; numeric queues at
32 and 33 after 37 dequeues; a 32-element boolean stack; and a 32-element
boolean queue after 1,057 dequeues. Each uses 4,096 repetitions per batch
and the same independent oracle. This is a separately identified diagnostic,
not a retrospective change to the original matrix.

The diagnostic uses six pairs per case/runtime, 144 processes and 1,296 measured
batches. Every one of its 72 comparisons improved, and all twelve unadjusted
95% intervals exclude parity. Paired time reductions are 41.0–74.0% on Node and
32.8–48.2% on Bun. These observations resolve the specific activation-threshold
concern for the tested cases; they are additional results, not additions to the
original five-target headline.

| Runtime | Complete public operation | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Node | encode: stack, 32 numbers | 5.415 | 1.510 | 0.260 (0.230–0.295) | 6/6 |
| Node | encode: stack, 33 numbers | 5.850 | 1.773 | 0.322 (0.230–0.450) | 6/6 |
| Node | encode: queue, 32 numbers; offset 37 | 3.167 | 1.658 | 0.542 (0.436–0.673) | 6/6 |
| Node | encode: queue, 33 numbers; offset 37 | 3.411 | 1.610 | 0.452 (0.370–0.552) | 6/6 |
| Node | encode: stack, 32 booleans | 5.433 | 1.417 | 0.274 (0.230–0.326) | 6/6 |
| Node | encode: queue, 32 booleans; offset 1,057 | 3.063 | 1.681 | 0.590 (0.436–0.799) | 6/6 |
| Bun | encode: stack, 32 numbers | 2.693 | 1.420 | 0.539 (0.426–0.683) | 6/6 |
| Bun | encode: stack, 33 numbers | 3.064 | 1.498 | 0.518 (0.410–0.654) | 6/6 |
| Bun | encode: queue, 32 numbers; offset 37 | 2.802 | 1.808 | 0.623 (0.514–0.756) | 6/6 |
| Bun | encode: queue, 33 numbers; offset 37 | 2.997 | 1.826 | 0.661 (0.520–0.839) | 6/6 |
| Bun | encode: stack, 32 booleans | 2.655 | 1.782 | 0.672 (0.580–0.780) | 6/6 |
| Bun | encode: queue, 32 booleans; offset 1,057 | 2.773 | 1.566 | 0.527 (0.409–0.679) | 6/6 |

The boundary module also predeclared the 32-number stack and offset queue as
an identical-baseline subset. This four-pair A/A diagnostic adds 32 processes
and 288 measured batches:

| Runtime | Complete public operation | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | ---: | ---: |
| Node | encode: stack, 32 numbers | 5.853 | 4.908 | 0.851 (0.547–1.324) | 3/4 |
| Node | encode: queue, 32 numbers; offset 37 | 4.155 | 3.888 | 0.975 (0.840–1.133) | 2/4 |
| Bun | encode: stack, 32 numbers | 2.691 | 2.563 | 1.005 (0.848–1.191) | 2/4 |
| Bun | encode: queue, 32 numbers; offset 37 | 2.531 | 2.739 | 1.033 (0.835–1.277) | 2/4 |

All four boundary A/A intervals cross parity. The Node stack same-build point
estimate nevertheless looks 14.9% faster, with three of four pairs faster.
As with the other A/A studies, these measurements are retained separately
and do not adjust the A/B ratios or establish candidate equivalence.

## Correctness and portability

[Validation details and captured command output](validation.md) record:

- Node and Bun Redux suites: **9 files / 169 tests passed in each runtime**,
  including 28 new focused regressions.
- Final full default Bun discovery: **56 files / 1,136 tests passed**; see
  [full-suite output](validation/full-suite-bun.txt).
- Portable build, declarations, main type checking and Redux type checking.
- Typed-value, geometry and public worker TypeScript checks, plus installed
  package checks for Node/Bun exports, real Node workers and a TypeScript
  consumer; see [installed-package output](validation/installed-package.txt).
- Real Node shared/copy workers, retained snapshots across owner writes and
  memory growth, complete outputs and read-only enforcement.
- Fresh-process late optional imports in Node portable, Bun portable and Bun
  source mode, each with reader-getter and decoder overrides.
- Chromium **153.0.8010.0** page checks and actual shared/copy worker attachments;
  [browser results](browser-result.json) explicitly record that no browser
  timings were collected.

Coverage includes block/tree boundaries and dequeued offsets, booleans, signed
zero, NaN/infinities, explicit cached stack tops, all codec limits, Unicode and
frozen/nested values, exact errors, getter receiver/call counts, changing
prototype readers, decoder recursion, custom Arena subclasses and memory
growth. The [dedicated CI workflow](../../.github/workflows/redux-sequence-reads.yml)
runs correctness checks and verifies the saved evidence; it does not rerun
performance timings.

## Evidence and identities

The following losslessly compressed recordings are the publication artifacts.
They preserve all original JSON bytes; the [manifest](manifest.json) records
compressed and original hashes and lengths.

| Recording | Purpose | Processes | Measured batches |
| --- | --- | ---: | ---: |
| [pilot.json.gz](results/pilot.json.gz) | Two-pair screen, all ten original cases | 80 | 720 |
| [formal.json.gz](results/formal.json.gz) | Six-pair confirmation, all ten original cases | 240 | 2,160 |
| [aa.json.gz](results/aa.json.gz) | Original identical-baseline subset | 32 | 288 |
| [aa-fallback.json.gz](results/aa-fallback.json.gz) | Separately declared fallback identical-baseline check | 32 | 288 |
| [boundary.json.gz](results/boundary.json.gz) | Separately declared six-pair threshold diagnostic | 144 | 1,296 |
| [boundary-aa.json.gz](results/boundary-aa.json.gz) | Predeclared identical-baseline subset of threshold diagnostic | 32 | 288 |
| **Total** | Six discrete retained studies | **560** | **5,040** |

The [independent verifier](verify.py) recomputes process medians, paired ratios,
intervals and every summary row from the raw batch samples. It checks process
order, common fixtures/runtimes, warm-up requirements, source snapshots,
driver/workload identities and identical WASM. An independent review verified
all six studies: 560 subjects, 5,040 measured batches, every summary row and
the frozen source/build identities. The pilot, confirmation, boundary study
and three A/A studies remain separately analyzed.

| Frozen file | SHA-256 |
| --- | --- |
| `arena.ts` | `a4a5fc53a66baf943688ccf357095afab02b0ff538711542e384d2b01004243f` |
| `shared-stack.ts` | `8ef42efe1135edeb85293e1d26b237150582472ea4e48ac454d772ffd9f3dca8` |
| `shared-queue.ts` | `e3995a791f9a0e1a90c4cd19270b17a31a6fa117171b7e30bf14dd59d7366125` |
| `redux-codec.ts` | `aa0034c6bba39edabc04eb48e985f78be3e8cfb7d3ad7b273bb2a39edf9180a6` |
| `redux-sequence-codec.ts` | `151fc89fb1d57f79ebaa33b1b324d5f6449a283c4fc24805bce6e51660860362` |
| `workloads.mjs` | `872240d433c14df83d7701844b72dd1a30ab2756e0e99f671985401517d0f4d1` |
| `workloads-boundary.mjs` | `6d54903adc50be656b731b0af9d8c55eb1992b8be6142bb1eb8a9ddafa3c69ab` |
| `paired-benchmark.mjs` | `3c4dcd009d214fccde46b1a07e24324d9c6770ca1b3993455ee1b246d5edbb61` |

All runtime sources, build products and diagnostic workload hashes are also
recorded in their own evidence files; the table above is a compact index.

## Reproduction

First verify the saved evidence without collecting new timings:

~~~sh
python3 proofs/redux-sequence-reads-20261105/verify.py \
  proofs/redux-sequence-reads-20261105/results/pilot.json.gz \
  proofs/redux-sequence-reads-20261105/results/formal.json.gz \
  proofs/redux-sequence-reads-20261105/results/aa.json.gz \
  proofs/redux-sequence-reads-20261105/results/aa-fallback.json.gz \
  proofs/redux-sequence-reads-20261105/results/boundary.json.gz \
  proofs/redux-sequence-reads-20261105/results/boundary-aa.json.gz
~~~

To collect a new comparison, build the candidate and the exact baseline with
the same installed dependencies. Use a fresh baseline worktree and fresh
output paths; the harness refuses to overwrite a recording.

~~~sh
git worktree add /tmp/zerocopy-sequence-before b07bffe073a7f7d60f1dd7731358c16d1075eb45
ln -s "$PWD/node_modules" /tmp/zerocopy-sequence-before/node_modules
(cd /tmp/zerocopy-sequence-before && bun run build:wasm && bun run build:browser)
bun run build:wasm
bun run build:browser

taskset -c 2 node proofs/redux-sequence-reads-20261105/paired-benchmark.mjs \
  proofs/redux-sequence-reads-20261105/workloads.mjs \
  /tmp/zerocopy-sequence-before "$PWD" "$(command -v bun)" \
  /tmp/zerocopy-sequence-new-pilot.json pilot

taskset -c 2 node proofs/redux-sequence-reads-20261105/paired-benchmark.mjs \
  proofs/redux-sequence-reads-20261105/workloads.mjs \
  /tmp/zerocopy-sequence-before "$PWD" "$(command -v bun)" \
  /tmp/zerocopy-sequence-new-formal.json formal

taskset -c 2 node proofs/redux-sequence-reads-20261105/paired-benchmark.mjs \
  proofs/redux-sequence-reads-20261105/workloads.mjs \
  /tmp/zerocopy-sequence-before "$PWD" "$(command -v bun)" \
  /tmp/zerocopy-sequence-new-aa.json aa

taskset -c 2 node proofs/redux-sequence-reads-20261105/paired-benchmark.mjs \
  proofs/redux-sequence-reads-20261105/workloads-aa-fallback.mjs \
  /tmp/zerocopy-sequence-before "$PWD" "$(command -v bun)" \
  /tmp/zerocopy-sequence-new-aa-fallback.json aa

taskset -c 2 node proofs/redux-sequence-reads-20261105/paired-benchmark.mjs \
  proofs/redux-sequence-reads-20261105/workloads-boundary.mjs \
  /tmp/zerocopy-sequence-before "$PWD" "$(command -v bun)" \
  /tmp/zerocopy-sequence-new-boundary.json formal

taskset -c 2 node proofs/redux-sequence-reads-20261105/paired-benchmark.mjs \
  proofs/redux-sequence-reads-20261105/workloads-boundary.mjs \
  /tmp/zerocopy-sequence-before "$PWD" "$(command -v bun)" \
  /tmp/zerocopy-sequence-new-boundary-aa.json aa
~~~

Select an allowed CPU if CPU 2 is unavailable. The driver acquires its lock
itself; do not wrap it in another lock on the same file. Keep the production
source, bundles and workload module unchanged throughout each study, and avoid
concurrent build/test/performance jobs. New runs are new evidence, not replacements
for unfavorable historical samples.
