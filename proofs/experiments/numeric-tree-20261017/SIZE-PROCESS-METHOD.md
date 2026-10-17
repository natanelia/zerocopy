# Size-isolated, CPU-pinned diagnostic — 17 October 2026

This is a fixed follow-up to the local process-method-1 cohort. It does not
replace or reinterpret that failed cohort. No production source changes.

Method 1 retained 32 fresh Node processes: 16 A/A and 16 A/B. A/A passed
47/48 point checks and 14/48 confidence checks. A/B passed 46/48 point
checks and 35/48 confidence checks. Large range speedups were 1.702–1.818,
but A/A failure prevents acceptance. Public range size 1048609 had an A/A
point estimate of 0.94045. Chronological child medians varied substantially.
These data do not prove a source regression or a cause of the host variation.

## Predeclared change

Keep the exact method-1 driver, workload, warm-up count, measured count,
four-block schedule, eight pair ratios, log-block estimator and confidence
gates. Instead of measuring all sizes in one child, run one complete
four-block cohort for each size. This shortens the elapsed interval between
paired measurements of the same endpoint and avoids cross-size JIT history.

Pin the controller and future children to the first CPU in the operating
system's allowed CPU list. Do not measure CPUs to select a faster one.
Record the original affinity, selected CPU, pin command result and cgroup
CPU statistics. Pinning prevents migration; it does not reserve a CPU or
remove host contention. Compilation helper threads inherit the restriction.

Each phase uses 11 sizes x 16 children = 176 fresh processes. It still uses
48 endpoints x 16 children x 21 measured batches = 16128 timing samples,
the same number as method 1. Each endpoint still has seven warm-up batches
per child. Both A/A and A/B run once. All files and all failures remain.

The wrapper requires all 48 endpoints, in order. A failed subcohort or
missing row cannot be reported as successful full coverage. The original
numerical thresholds and the additional method-1 confidence gates stay fixed.

The declared local cohort uses Node 22.16.0 on Linux x64 with the recovered,
digest-matched main and PR39 portable builds. It does not supply Bun or ARM64
clearance. Hosted checks must use the same declared method on both runtimes
and architectures before this production stage can be accepted.

```sh
BASE_DIR=../zerocopy-base CANDIDATE_DIR=. RUNTIME_BIN=node KIND=aa OUT_DIR=proofs/results/size-node-aa node proofs/numeric-tree-size-process.mjs
BASE_DIR=../zerocopy-base CANDIDATE_DIR=. RUNTIME_BIN=node KIND=ab OUT_DIR=proofs/results/size-node-ab node proofs/numeric-tree-size-process.mjs
```
