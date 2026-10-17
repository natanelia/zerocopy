# Numeric tree scan experiment — 17 October 2026

Baseline: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.

## Fixed measurement plan

Compare the old and new numeric kernels in the same process, with alternating
order. Compile both with the pinned AssemblyScript dependency and production
flags. Check every timed batch result outside its timed region. Save every raw
sample and source/Wasm SHA-256 digest. Keep failed stages in separate files.

The full comparison measures direct SIMD range calls, direct scalar range
calls, the public range API, both modules' point counts, and the public point
API. The latter paths are controls. It uses Node.js 22 and Bun 1.4.2. The local
initial screen can use fewer samples and omit the public wrappers. It does not
establish acceptance.

Before final acceptance, each measured case must achieve a baseline/candidate
elapsed-time ratio of at least 0.95. Range SIMD and public range cases with at
least 1,024 values must exceed 1.05. Use 7 warm-up and 21 measured rounds or
more. Keep every failed run. Use a fixed follow-up cohort to diagnose a
failure before another acceptance run. Do not change the thresholds. Require
x64 and ARM64 results and correctness checks for the scalar fallback, full
and partial leaves, tree depth changes, IEEE values, memory-end loads, old
snapshots, and actual workers. Browser correctness is a separate check.

The full comparison includes one-value, two-value, and 31-value tails as
well as the larger screen sizes. It caps each batch at one million calls
to avoid spending most of the run on JavaScript/Wasm boundary costs.

The timed region contains warm scans only. Input creation, input copying,
initial Wasm compilation, imports, worker transport, and checks are excluded.

## Run

Build both checkouts with their normal Wasm and browser build scripts. Run
from the candidate checkout:

```sh
BASE_DIR=../zerocopy-base CANDIDATE_DIR=. OUT_FILE=proofs/results/numeric-tree-20261017/node-full.json PERF_GATE=1 node proofs/numeric-tree-benchmark.mjs
BASE_DIR=../zerocopy-base CANDIDATE_DIR=. OUT_FILE=proofs/results/numeric-tree-20261017/bun-full.json PERF_GATE=1 bun proofs/numeric-tree-benchmark.mjs
```

`MODE=kernels` runs only the direct kernels. `SIZES`, `WARMUP`, `SAMPLES`, and
`WORK` can define separately labelled exploratory screens; record their
values in each output. They must not replace the full acceptance run.

## Fixed A/A diagnostic after stage 3

The first full stage-3 runs found a 0.937 ratio in the Node two-value scalar
control and a 0.500 ratio in the Bun one-value public case. Keep both runs.
Do not change the production source or repeat runs until one passes.

`proofs/numeric-tree-aa.mjs` copies the same built stage-3 module set into
two fresh neutral directories, `a` and `b`. It verifies every copied hash.
The mixed-case workload then runs this fixed order:

1. Node: `a` as baseline and `b` as candidate.
2. Bun: `a` as baseline and `b` as candidate.
3. Node: `b` as baseline and `a` as candidate.
4. Bun: `b` as baseline and `a` as candidate.

Every process uses sizes 1, 2, 32, and 1,024, all API/control rows, 25 warm-up
rounds, 31 measured rounds, and eight million values of requested work per
batch. The existing one-million-call cap remains. All four runs are retained.
An A/A ratio outside `[0.95, 1/0.95]` is evidence of a method or runtime
placement effect. This diagnostic threshold does not replace the A/B gate.
If A/A fails, first repair the measurement method; do not accept stage 3
from a later lucky A/B run.

The driver accepts `BASE_MODULE_DIR` and `CANDIDATE_MODULE_DIR` for these
neutral copies. Source hashes still come from the real source checkout.
The driver verifies that the copied Wasm files match that source checkout.
The module-path options changed the driver source hash. The timed loop
bodies and original acceptance thresholds did not change. The exact
driver used in the first full stage-3 run is saved as `stage3-benchmark.mjs`.

All four fixed A/A runs completed. Each run had at least one ratio outside
the diagnostic interval. The controller returned a failed result after
saving all four runs. The mixed-case method cannot establish acceptance.
See [the findings](REPORT.md#fixed-identical-source-diagnostic).

```sh
NODE_BIN=node BUN_BIN=bun bun proofs/numeric-tree-aa.mjs
```

## Stages

- `baseline.as.ts` is the pinned production source.
- `stage1.as.ts` carries vector bounds and vector sums through the tree.
  It performs the horizontal reduction once per range call.
- `stage2.as.ts` also scans sibling leaves in their parent call. It removes
  recursive vector argument passing for each full leaf.
- `stage3.as.ts` keeps each vector sum inside a depth-one group and restores
  the original scalar recursion arguments and exported range function.
  Tail scans use the original span kernel.
- `numeric-spatial.as.ts` is the unchanged point-count source, included to
  make the stored experiment sources compile without a missing import.

The experiment changes no storage format or exported function signature.
Vector sums stay in local values; the kernels do not write shared memory.
