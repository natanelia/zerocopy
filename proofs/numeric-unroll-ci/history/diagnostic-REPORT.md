# Retained-test phase diagnostic

**The observed multi-second wall time was inside the original full-Uint8Array equality assertions. Attachment and scan-plus-assertion phases completed in milliseconds in this one diagnostic pass. This explains where the time was observed in these diagnostic runs; it does not establish a CPU/GC cause, a candidate speed benefit, or clearance of the original focused test gate.**

Both commands ran once, baseline then candidate. Baseline's spatial test timed out again at its unchanged 5-second limit; the numeric test passed. The candidate's two selected tests passed. All original assertions in both selected test bodies completed, including the full-byte comparisons and numeric write rejection. No value mismatch was reported. Both child processes were reaped, both owned process groups were absent afterward, and neither command hit its 180-second external safety limit. There were no retries.

The original 45-test results remain exactly **baseline 44/45 and candidate 43/45**, with their original logs untouched. This diagnostic selected only the two relevant tests and skipped 43, so it cannot replace either historical gate outcome.

## Evidence and exact scope

The independent review was completed and sealed first: `/workspace/shared/zerocopy-numeric-unroll-review-20261009/SEALED.json`. New copies were materialized from the original sealed archive at:

- `/workspace/scratch/e7ec22ef2609/zerocopy-numeric-unroll-diagnostic-baseline-20261009`
- `/workspace/scratch/e7ec22ef2609/zerocopy-numeric-unroll-diagnostic-candidate-20261009`

[PLAN.md](PLAN.md), [prepare.py](prepare.py), [execute.py](execute.py), and the exact identical [instrumentation.patch](instrumentation.patch) were pinned before execution in [FROZEN.json](FROZEN.json), SHA-256 `9ca0ef6a0388ae621fbb96e3143bd4e3430dc11a1d1460942e8fb0deea616fe5`.

All original test source lines remain intact. Instrumentation only adds paired `performance.now()`/stderr markers before and after original statements, plus its helper. Removing those additions reproduces each original test file exactly; preparation asserts this. Tests, expectations, fixtures, beforeEach hooks, configuration, 5-second timeout, Bun/Vitest versions, and thread/file-parallelism settings were preserved. The command differs only by the exact two-test name filter. No production source or compiled binary was changed or rebuilt, and the two diagnostic test-file changes are identical across roles.

[verify.py](verify.py) reconciles the 518 materialized source/build inputs per role, pre-execution pins, original source/build/log bindings, review seal, and command logs. [VERIFIED.json](VERIFIED.json) preserves full-precision durations and confirms all 34 phase pairs completed across both arms. Full raw results and cleanup receipts are in [logs/](logs/). [COORDINATION.md](COORDINATION.md) documents the reserved local window and limited process visibility.

## Observed phases

Each cell is one instrumented wall-duration observation, in milliseconds. These are diagnostic regions, not isolated operation benchmark samples. The scan phases include the original assertion and any first-use work occurring there. Logging overhead and the original parallel test execution can affect them.

| Test and phase | Baseline ms | Candidate ms |
| --- | ---: | ---: |
| Numeric setup | 10.892 | 2.063 |
| Numeric byte snapshot, 131,072 bytes | 0.117 | 0.430 |
| Numeric attachment | 1.610 | 0.843 |
| Numeric count assertion | 2.738 | 1.601 |
| Numeric full-byte equality | 1,775.015 | 1,289.878 |
| Numeric write rejection | 5.158 | 3.248 |
| Numeric complete body | 1,797.679 | 1,309.761 |
| Spatial setup | 3.073 | 2.881 |
| Spatial attachment | 1.884 | 1.283 |
| Spatial owner append/edit | 10.841 | 8.802 |
| Spatial original count assertion | 5.347 | 2.480 |
| Spatial attached count assertion | 0.099 | 0.332 |
| Spatial changed count assertion | 0.379 | 0.527 |
| Spatial byte snapshot, 393,216 bytes | 2.352 | 0.428 |
| Spatial final attached count assertion | 0.104 | 0.266 |
| Spatial full-byte equality | 5,004.393 | 3,718.918 |
| Spatial complete body | 5,031.391 | 3,835.279 |

The baseline spatial equality assertion alone spans just over five seconds in its marker pair, and the entire body spans about 5.031 seconds. Vitest reports a 5-second timeout for that case even though the marker after the equality assertion and the body-complete marker are present. This demonstrates why a timeout need not identify an uncompleted assertion. The raw runner reports 5,061 ms for that test, a different boundary from the instrumented body.

The candidate-only numeric timeout from the original 45-test run did not reproduce in this diagnostic selection. Here both numeric byte-equality phases dominate their respective body duration; there is no retained phase record for the original timeout, so its exact attribution remains unproven. Likewise, the earlier baseline/candidate spatial failures are still historical failures; this new baseline observation supplies a concrete location for one new reproduced timeout, not a causal explanation for every previous run.

## Consequence and stopping point

The review found no numeric semantic or ABI defect, and this diagnostic found no incorrect numeric or spatial result. The appropriate next discussion concerns the expensive test equality path and the focused gate's acceptance contract. No production optimization or timeout relaxation follows from this evidence.

If a test-maintenance change is proposed, separately review its semantic equivalence, preserve complete-byte coverage and the existing 5-second limit, and freeze it before a fresh validation stage. Alternatively, investigate the current equality implementation or runner without claiming a settled cause. The diagnostic cannot authorize dropping byte checks, increasing timeouts, replacing the original outcomes, or rerunning until favorable. Any fresh 45-test gate should be planned independently and retain all failures. Performance timing, runtime variants, broad suite retries, merge, and publication remain outside this work. The one-pass diagnostic is complete and stopped.
