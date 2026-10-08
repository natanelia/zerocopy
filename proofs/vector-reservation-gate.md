# Frozen vector path reservation latency gate

This gate is prepared for the immutable published runtime commit
`7ba6cf75fbe3b4453f7dfc25dd2b930d2f260300`, tree
`49b4343dbc156ad35ecb39761e59db51334e2791`. That tree is exactly the reviewed
reservation candidate. Preparing these proof files is not a latency result,
performance acceptance, or permission to broaden the workload matrix.

The baseline remains main `3773c6e519c7c0958da13727ed1082f449f3ee25`.
The historical vector-only comparison is the published
`1bf473e03803b1ca15e8e87d0100f3c62055fdcb`. The raw correctness proof now
uses that published SHA rather than its unpublished local counterpart; every
source and frozen-protocol blob it reads is identical between those references.
No runtime, compiler flags, package configuration, layout, or test timeout is
changed by this gate.

## Exact-source and artifact binding

`vector-reservation-source.mjs` pins the runtime source to SHA256
`2b1f9638c229862618d4b0afbe4ef9b02b438c4b3bf4bf5fbe35fc23ca7359df` and
root/alias/embedded/actually compiled core WASM to
`44d1fbd14dd4c4dcc53979d0c2aef0a7ce2e9c3671bcbf1e04c7cecf6a3720f6`.
Baseline core remains
`b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4`.
The build records AssemblyScript 0.28.20, its exact existing flags, Bun 1.4.2,
actual Node version, build scripts and all generated kernel hashes. The source
guard checks all production/build/package/configuration sources against Git
and the published runtime pin. Only `vecSetAt` and `vecSet` differ from main.
All non-core generated WASM, all ABI imports/exports, and all portable JavaScript
must match baseline, allowing only the expected embedded core substitution and
bijective content-addressed import renaming.

Both baseline and candidate get fresh root WASM, portable JavaScript and type
declarations. Each is packed with `npm pack --ignore-scripts`, extracted outside
the project, and checked against the root and complete portable manifests.
AssemblyScript sources are intentionally excluded from the npm package; their
binding is checked in the source checkout against the published Git commit.
Separate Node and Bun processes actually import the extracted package's
`dist/shared.js`; the exact bytes supplied to `WebAssembly.Module` must match
the expected role hash before the 16 fixture checks run. The installed-package
prerequisite also covers the actual package exports, including Bun's source
condition. Every neutral timing subprocess checks the actual compiled portable
WASM before invoking the unchanged historical subject. These checks occur
outside all timing regions.

## Correctness comes first

A build receipt alone cannot start timing. The performance driver also requires
an intact completed prerequisite receipt, exact command list, matching build
and proof manifests, unchanged extracted packages and archive hashes, and
hash-verified logs with every command successful. No isolated rerun overrides a
failed full run. The final source and proof manifests are rechecked afterward.

The fixed prerequisite plan includes:

- Full existing unit/integration suites on both baseline and candidate through
  the repository-supported Bun 1.4.2 runner, using repository defaults and the
  unchanged 5000ms timeout. Node 22 correctness uses the built portable modules,
  deterministic protocol tests and actual Node worker/task probes below.
- All eight type configurations, including both optional-property modes for
  typed values and worker declarations. `build:types` precedes every type check.
- Protocol tests, the complete raw reservation correctness/mechanism/failure
  matrix, detailed Node/Bun public and extracted-package checks, and supplemental
  partially missing paths and caller-depth boundary checks.
- Baseline and candidate allocation/identity invariants and real shared/copy
  worker probes on Node and Bun; existing standalone worker lifecycle, query,
  startup, Redux and typed JSON Node checks; the installed npm package checker.
- The complete configured Chromium browser suite and documented browser-worker
  checks. No browser performance inference follows from correctness success.

The baseline worktree and all extracted tarballs/results live under
`RUNNER_TEMP`, outside project test discovery. CI installs Chromium before the
prerequisite runner. Any failed, incomplete or missing prerequisite blocks all
subsequent timing steps; the artifact upload retains failure logs and partial
receipts. Full correctness is required prospectively; the prior focused local
runs and isolated Bun retry are not represented as a full-suite pass.

A separate baseline check established that bare Node execution of the source
Vitest suite fails nine legacy `workers.test.ts` cases because their direct
extensionless TypeScript worker imports cannot resolve `shared-list` to `arena`.
The standard Bun suite passes all 753 baseline tests. That baseline failure is
retained as unsupported-runner evidence; this gate does not claim a full
Node-source Vitest pass or drop those tests from the supported Bun full suite.

## Unchanged prospective screen

The historical workload definitions, timed subject, statistics, old driver,
source helper, invariant checker, and worker checker remain byte-identical and
are verified against explicit SHA256 values and published 1bf blobs. The new
outer driver preserves the old scheduling/calibration/inference logic. Only
source/artifact/prerequisite binding and result provenance are added.

All 16 cases retain their exact original order, sizes, selected indexes, value
patterns, repeat caps and allocation rules:

1. Changed numbers: tail size 1, tail size 32, and tree depths 0, 1, 2 and 3.
2. Changed booleans and interned strings: tail size 32 and tree depth 2 each.
3. Unchanged number tail size 1; unchanged number tree depth 3; unchanged boolean
   tree depth 1; unchanged interned-string tail size 32.
4. Half-same numbers at tree depth 2 and nine-tenths-same interned strings at
   tree depth 1.

There are ten changed controls, two unchanged tail controls and four tree
targets. There is no case selection, layout tuning, extra target, pooled score,
compensation of ordinary-write loss by target gain, or inherited acceptance.
String fixtures pre-intern both values outside timing. Public fresh frozen
handles, retained source snapshots and exact allocation checks remain enforced.

Node 22.23.3 x64 and Bun 1.4.2 x64 run the same fixed screen separately. Each process
gets the selected complete portable bundle copied to the same neutral package
path, with unchanged nearest package context. Every batch starts with a fresh
fixture, releases old handles and explicitly collects outside the timed region.
The newest handle remains retained. WASM growth and automatic GC remain inside
elapsed time. The payload cap is 128 MiB, excluding arena metadata, JS heap and
backing reserve; the maximum is 1,000,000 writes rounded to pattern periods.

Each role's pilots are retained. The larger calibrated repeat count is shared,
and both roles receive identical frozen warm work and 11 measured batches per
process. Four independent balanced quartets alternate ABBA/BAAB. Matched
baseline A/A and candidate A/B quartets are interleaved in the unchanged order.
All raw pilots, warm batches, samples, plans, subjects and flags are preserved;
no sample dropping, favorable rerun selection or baseline A/A subtraction.

Inference uses the mean of the two paired log ratios in each quartet, then
four independent quartet means with a two-sided 95% Student-t interval,
df = 3, t = 3.182446305284263. Eight descriptive pairs and the within-process
batches are not treated as independent replicates. Intervals are per cell,
unadjusted for multiplicity. The prospective latency-loss margin remains 2%:
upper bound <= 1.02 is within-margin, lower bound > 1.02 is material loss,
and overlap is inconclusive. Batch < 10ms, total warm timed work < 100ms, or
pilot cap below the floor makes the result timing-inconclusive.

The A/A drift rule is unchanged: the A/A point ratio must be outside
[1/1.02, 1.02] and its interval must exclude 1 to invalidate the A/B conclusion
as control-drift-inconclusive. An imprecise A/A interval alone is not drift.
No timing flag or failed prerequisite can become acceptance. A successful CI
execution establishes complete observations, not that every cell passed the
prospective margin; the per-cell conclusions must be reviewed on both runtimes.

## Retained adverse history

The original b857 screen remains unaccepted:
https://github.com/natanelia/zerocopy/actions/runs/37833317184
Its raw ZIP SHA256 is
`ca93cc510e3f14864706aea95ea305daefdf08e396d3c6884ae133342739cd8a`.
Nine of twenty changed controls were inconclusive. The tiny changed-number
tail was slower in every quartet on Node (+2.74%, individual 95% CI +0.31% to
+5.23%) and Bun (+1.14%, +0.03% to +2.27%).

The vector-only 1bf screen also remains unaccepted:
https://github.com/natanelia/zerocopy/actions/runs/37837826481
Its raw ZIP SHA256 is
`3aa354607222fc3535a160ae73a2074fb86c907fd3160d0402b193d79e7a5ee9`.
Eleven of twenty changed controls were inconclusive. Node changed interned
strings at depth two were +2.74% (+0.43% to +5.11%); Bun changed numbers at depth
three were +2.74% (+1.46% to +4.03%). Both were slower in all four quartets.
These raw archives and their reports are preserved separately; this gate does
not edit them or transfer any favorable interval to the new candidate.

## Execution boundary

The new workflow triggers only on `perf/vector-path-reservation-gate-*` branches
or an explicit dispatch on one of those branches. Runtime-only publication
cannot trigger it. No local latency timings or publication are part of gate
preparation. Parent review and publication of the exact proof commit are
separate steps. The pinned runtime commit is already published; the gate's own
Git SHA is taken from its immutable checkout and all proof files must match it.

Workflow re-attempts are rejected before setup and again by the performance
driver. Concurrency has `cancel-in-progress: false`, so a later push cannot
silently cancel a study. Run identity and attempt are retained in the results.
CI and the driver pin Node exactly to 22.23.3, the version recorded by both
historical Node screens, and Bun exactly to 1.4.2. Preparing these stricter
execution guards does not recollect or change the historical observations.
