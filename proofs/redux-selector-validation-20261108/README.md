# Redux entry selector validation: Bun gains, Node uncertainty

**Status: draft performance candidate.** The fixed confirmation found lower
latency for two predeclared Bun workloads: repeated numeric and object reads
from the same immutable map. Each improved in all six process pairs, with
paired time reductions of **13.8%** and **14.3%**. The original goal of proving
improvement on both runtimes was **not met**. Node results and the other control
workloads remain inconclusive; some point estimates are slower. This is not a
universal speedup or a no-regression claim.

## Change and compatibility

`createSharedMapEntrySelector` accepts only exact frozen `SharedMap` snapshots.
Previously it called the generic collection classifier, which already reads
the private snapshot owner to validate the brand, and then read that owner
again. The candidate checks the single accepted prototype and returns the
validated owner in one pass.

Both input selectors still execute on every call, in their original order.
The selected-key lookup remains dynamic, as does the existing cache of one
result by arena, immutable leaf address, and value type. Invalid maps and keys,
custom lookup errors, retained snapshots, and read-only attachments retain
their behavior. There is no new map cache, weak map, public API, or binary
format change.

## Fixed confirmation

Measurements ran on 8 November 2026, Linux x64, an AMD EPYC 9V74 host, CPU 2,
Node **24.22.1** and Bun **1.4.2**. Both runtimes loaded the same portable build
entry points. The result does not establish browser, ARM, or Bun source-entry
performance.

Baseline: `0ac8a005268335a6116f025e75f670b5cee6843e`.

Candidate `redux.ts` SHA-256:
`a4907869509339ea98195153edb366c1d9e7f32e813517624bd5f24269f57167`.
Every other runtime source and every WASM binary matches the baseline in the
recording. Exact source snapshots, source/build hashes, runtime versions, CPU
metadata, and all samples are saved in [formal-v3.json.gz](formal-v3.json.gz).
The final source is also saved as [candidate-v3/redux.ts.txt](candidate-v3/redux.ts.txt).

The existing [paired runner](../redux-sequence-reads-20261105/paired-benchmark.mjs)
used six fresh process pairs per case and runtime, alternating A/B and B/A
order. Runtime and case order also reverse by pair. Every process had at least
500 ms of timed warm-up, at least eight warm-up batches, and nine measured
batches. The study held the common benchmark lock; other collaborating agents
confirmed they had stopped heavy work before it began.

Times below are medians of the six process estimates, in **microseconds per
complete operation**. A scalar operation calls one public selector; a component
operation calls 256 selectors and consumes their values. Each scalar measured
batch contains 131,072 operations; the component batch contains 512 operations.
The write control compacts a 32-entry map once, then performs 512 immutable
overwrites and first selections, retaining the final map, all inside the timer;
its measured batch contains 16 operations. This keeps compaction small while
exercising previously unseen snapshots.

The ratio is the geometric mean of the six paired after/before estimates.
Intervals are unadjusted 95% Student-t intervals on paired log ratios. The
ratio of the displayed medians can differ from the paired estimate. A ratio
below 1 means less time; an interval crossing 1 does not establish a change.

| Runtime | Complete public operation | Before (µs) | After (µs) | Paired after/before [95% interval] | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| Node | Repeated numeric entry | 0.0527 | 0.0503 | 0.954 [0.634, 1.435] | 5/6 |
| Node | Repeated object entry | 0.0541 | 0.0475 | 0.920 [0.764, 1.108] | 4/6 |
| Node | Repeated missing key | 0.2015 | 0.2108 | 1.016 [0.840, 1.228] | 4/6 |
| Node | Rotating 256 keys | 0.1014 | 0.0940 | 0.790 [0.599, 1.040] | 6/6 |
| Node | 256 component selectors | 21.938 | 23.705 | 1.058 [0.740, 1.513] | 4/6 |
| Node | Alternating map snapshots | 0.1055 | 0.0998 | 1.052 [0.854, 1.296] | 2/6 |
| Node | Alternating arenas | 0.0759 | 0.1009 | 1.152 [0.874, 1.518] | 3/6 |
| Node | Create and call a selector | 0.0962 | 0.0894 | 0.847 [0.697, 1.029] | 6/6 |
| Node | 512 writes and first selections | 356.530 | 366.854 | 0.994 [0.927, 1.066] | 4/6 |
| Bun | Repeated numeric entry | 0.0384 | 0.0324 | **0.862 [0.805, 0.923]** | **6/6** |
| Bun | Repeated object entry | 0.0398 | 0.0335 | **0.857 [0.776, 0.947]** | **6/6** |
| Bun | Repeated missing key | 0.0895 | 0.0762 | 0.890 [0.793, 1.000] | 5/6 |
| Bun | Rotating 256 keys | 0.0481 | 0.0582 | 1.086 [0.849, 1.391] | 3/6 |
| Bun | 256 component selectors | 9.947 | 9.329 | 0.886 [0.727, 1.080] | 6/6 |
| Bun | Alternating map snapshots | 0.0644 | 0.0627 | 0.980 [0.856, 1.122] | 5/6 |
| Bun | Alternating arenas | 0.0419 | 0.0298 | 0.774 [0.560, 1.068] | 5/6 |
| Bun | Create and call a selector | 0.0614 | 0.0601 | 1.062 [0.890, 1.267] | 2/6 |
| Bun | 512 writes and first selections | 1863.333 | 1808.967 | 0.987 [0.830, 1.174] | 4/6 |

**Adverse and uncertain results remain relevant.** Node's alternating-arena
point estimate is 15.2% slower, with an interval spanning 12.6% faster through
51.8% slower. Bun's rotating-key and newly created-selector point estimates
are 8.6% and 6.2% slower. The data does not clear those cases as regression-free.
The Bun missing-key interval ends at 0.999522 before rounding, too close to 1
to feature as a robust headline. No additional confirmation was run to seek
more favorable numbers.

## Same-build controls and host variability

The predeclared A/A study compared the identical baseline to itself in four
fresh pairs per case and runtime, with the same 500 ms minimum warm-up and
nine measured batches. These estimates are reported separately and are never
subtracted from the before/after study.

| Runtime | Same-build operation | Paired after/before [95% interval] |
| --- | --- | --- |
| Node | Repeated numeric entry | 1.111 [0.919, 1.343] |
| Node | Alternating map snapshots | 0.934 [0.633, 1.377] |
| Bun | Repeated numeric entry | 0.829 [0.554, 1.238] |
| Bun | Alternating map snapshots | 1.002 [0.961, 1.045] |

The wide intervals and the Bun numeric point difference despite identical
code demonstrate substantial process/host variability. The two Bun A/B
targets are consistent within the fixed confirmation, but these are local
measurements, not a stable deployment guarantee. The PR remains a draft for
review of the unresolved Node and control-workload uncertainty.

## Correctness and verification

The [workloads](workloads.mjs) use native input values as an independent oracle,
consume every timed result, and check every result after its batch. They also
check every retained input entry, snapshot descriptors, allocation extent,
and all backing bytes. Input creation and verification are outside the timer;
the full public operation and output retention are inside it. The write control
checks its complete resulting map and never preselects new snapshots.

Validation completed for the final source:

- Ten new semantic tests pass on Node and Bun. They cover invalid primitive
  inputs, frozen forged prototypes, proxy wrappers, invalid keys, callback
  ordering and reentry, dynamic lookup getters/errors, decoder failures,
  different arenas with equal addresses, value types, retained forks, growth,
  and shared/copied read-only attachments. The Node focused Redux run passed
  87 tests across four files.
- Declarations and Redux type checks pass.
- The built Node worker proof passes all 12 collection kinds, nested data,
  at least 10,000 concurrent reads, shared backing, growth, repeated attachment,
  and retention of old snapshots. The packaged Node Redux/Toolkit proof passes.
- A local full Node run passed 1,187/1,196 tests; nine existing raw-TypeScript
  worker fixtures fail because Node does not resolve their extensionless source
  imports. The documented full-suite command uses Bun. The built Node proof
  above exercises the published JavaScript entry points instead.
- A local full Bun run passed 1,195/1,196 tests; the existing geometry attachment
  test exceeded its five-second timeout. Its isolated rerun passed all four
  geometry tests. The failure and rerun are both retained. No test or timeout
  was changed, and a full CI pass is still required.
- [verify.mjs](verify.mjs) independently recomputes medians, ratios, intervals,
  sample counts, warm-up duration, case selection, complete A/B ordering, and
  source/workload identities. It verifies **408 processes and 3,672 measured
  batches** across all five saved studies without retiming.

Validation logs are in [validation](validation). Local full-suite failures are
not represented as passes. No browser performance or success is claimed here.

## Rejected pilots and evidence

The [plan](PLAN.md) and all three pilots are preserved. V1 cached validation
for the last map and regressed Bun's alternating-map/arena controls. Seven
Node processes in that pilot overlapped another agent's build/tests between
12:23:15 and 12:23:19 UTC; the adverse Bun controls did not. V2 used a weak map
of owners and regressed Node's first-seen write/select control by 30.5% in the
paired pilot estimate. V3 is the smaller implementation measured above, with
no new cache. Its initial pilot did not establish a Node benefit either.

| Study | Raw samples | Source archive | Disposition |
| --- | --- | --- | --- |
| V1 pilot | [pilot.json.gz](pilot.json.gz) | [V1 source](candidate-v1/redux.ts.txt) | Rejected |
| V2 pilot | [pilot-v2.json.gz](pilot-v2.json.gz) | [V2 source](candidate-v2/redux.ts.txt) | Rejected |
| V3 pilot | [pilot-v3.json.gz](pilot-v3.json.gz) | [V3 source](candidate-v3/redux.ts.txt) | Exploratory |
| V3 fixed confirmation | [formal-v3.json.gz](formal-v3.json.gz) | [V3 source](candidate-v3/redux.ts.txt) | Bun-scoped draft candidate |
| Baseline A/A | [aa-v3.json.gz](aa-v3.json.gz) | Baseline source embedded in recording | Variability control |

The archived V1 and V2 workload modules match their original recording hashes.
Raw JSON is compressed losslessly; original output logs are retained beside it.

## Reproduce

Build the baseline and candidate with the repository's pinned dependencies and
the same Bun version. Choose an available CPU instead of assuming CPU 2 exists.
Use a new output path for every recording; the driver refuses to overwrite one.

```sh
git worktree add --detach /tmp/zerocopy-selector-before 0ac8a005268335a6116f025e75f670b5cee6843e
# In each checkout: bun install && bun run build:wasm && bun run build:browser
# Run from the candidate checkout after both builds:
taskset -c 2 node proofs/redux-sequence-reads-20261105/paired-benchmark.mjs \
  proofs/redux-selector-validation-20261108/workloads.mjs \
  /tmp/zerocopy-selector-before . /absolute/path/to/bun \
  /tmp/selector-confirmation-new.json formal
# For a fresh same-build study, replace the output path and mode with "aa".
node proofs/redux-selector-validation-20261108/verify.mjs
```

The candidate's production source must match the archived V3 source for the
saved confirmation to verify. Public compatibility tests run through Vitest,
using the repository's documented Bun runner.
