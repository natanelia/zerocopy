# Paired numeric measurement diagnostic — 18 October 2026

## Status

Evidence only. No production change and no performance clearance for #39, #40 or #41. Do not merge a performance PR on these results. The original numeric timing plan stays version 2, including all 63 endpoints and every acceptance threshold. No failed result is replaced.

Main was `501b73819ed7e9bbf7adbb74b03df01045701973`. The inspected open PRs were #38, #39, #40 and #41. No Actions comparison was active before this diagnostic. PR #40 already contained the oracle, runtime-coverage and portable-summary repairs at `d16d82c9ac8b4264870c8c3687b25b53a6e553bf`; this work does not duplicate them.

## Question and method

Can adjacent measurements in one process reduce the spread seen between identical builds, without hiding a real slowdown?

Method 1 interleaves the original separate-process A/A control with paired A/A and paired A/B at sizes 2, 1024 and 32768. Each paired child loads two distinct module paths and uses two distinct private arena memories. Construction and timed arm order reverse across blocks. It retains seven warm-up batches, 21 measured batches and four independent process blocks. No runtime compiler flags are changed. The original batch work and iteration clamp are used. Every result and raw journal is retained.

The paired estimator uses the median of the 21 adjacent A/B timing ratios in each process, then the four-block log Student interval. The original regression floor 0.95, improvement floor 1.05, A/A ceiling 1/0.95 and t critical value 3.182446305284263 are unchanged. This is a NEW diagnostic estimator, not an extra passing run of the original plan. Separate-process controls still use the original driver and estimator.

The negative control deliberately calls the public range operation twice in arm B at size 1024. It must report a loss, not a pass. Scalar, point-miss and positive-hit point operations remain controls. Full snapshot bytes must remain unchanged after each endpoint. Each arena is limited to 64 MiB; two arms can use 128 MiB of arena space. This is not a hard process-RSS limit.

## Completed local screen

Node 22.16.0, Linux x64, AMD EPYC 9V74. All child processes ran serially on CPU 0, the first allowed CPU. The controller recorded the runtime binary, source files, build files, plan, assignment, warm-up, measured samples, journals, exit status, memory and process resource data. Setup, imports, compilation, assertions and journaling stay outside timed calls.

| Method and control | Size | Point checks | Confidence checks |
| --- | ---: | ---: | ---: |
| Original separate A/A | 2 | 9/9 | 6/9 |
| Original separate A/A | 1024 | 9/9 | 6/9 |
| Original separate A/A | 32768 | 9/9 | 3/9 |
| Paired A/A, method 1 | 2 | 9/9 | 5/9 |
| Paired A/A, method 1 | 1024 | 9/9 | 9/9 |
| Paired A/A, method 1 | 32768 | 9/9 | 9/9 |

Method 1 therefore FAILED its complete A/A screen: 23/27 confidence checks passed, versus 15/27 for the separate-process control. Its A/B screen passed all 27 point and confidence checks, but that does not override the failed A/A control.

Method 1 public range estimates were 1.692378x at size 1024 (95% interval 1.627553–1.759784) and 1.754869x at size 32768 (1.697635–1.814033). These are diagnostic estimates for the existing Stage 4 candidate, not an accepted new optimization. The deliberate double-call control was 0.498779x (0.497051–0.500514) and was correctly rejected.

## Retained failed idea and fixed follow-up

Pairing alone did not resolve the tiny-input control failure. Method 2 increases iterations per batch by a fixed factor of four. Its pre-run plan seals the first plan and audit. It tests only size 2 A/A and A/B, plus the size-1024 double-call control. Seven warm-up batches, 21 measured batches, four blocks and all numerical thresholds remain unchanged.

Method 2 passed all nine size-2 A/A point and confidence checks, and all nine A/B checks. It still rejected the double-call control: 0.499794x (0.488936–0.510894). This is a promising local follow-up, not full method validation. Its workload differs from both the original plan and method 1. Do NOT join its size-2 results with method 1's larger sizes to claim one passing full cohort.

## Evidence and checks

Method 1 completed 76 processes, 18,312 measured arm-batches and 6,104 warm-up arm-batches. Method 2 completed 12 processes, 3,192 measured arm-batches and 1,064 warm-up arm-batches. Combined: 88 processes, 21,504 measured arm-batches and 7,168 warm-up arm-batches. No sample was removed. There were no child retries.

The Node replay and a separate Python implementation agree on all 101 endpoint summaries. Each method passed its six fail-closed unit tests. All 34 existing PR #40 harness tests also passed. Offline preparation recreates all five measured files for each method byte for byte. No autonomous subagent tool was available in this session; these are independent implementation checks, not a claim of independent agent review.

The complete LOCAL raw archive is the conversation attachment `zerocopy-pairing-diagnostic-20261018.tar.xz`, SHA-256 `420f76cc0fc08b5d5a73a7c8cdbb26ef9179492d455dbefe6e899d2cb28e3475`. Its raw records are not claimed to be in this initial Git commit. The workflow performs one separately identified hosted reproduction, retains failures, and saves that run's full raw records and fixed input in this evidence branch. Hosted results are not pooled with the local screen. Check the actual run before claiming it completed.

Local method-1 plan SHA-256: `7272d7d7142b3897f061821fdaeb2775f72c9478d6b302fe7bd3c798b53cc4b6`.
Local method-1 audit SHA-256: `4285f6373c465d76da212fb41771d33a326edbf4f5881a9c3c34a876bf023cf6`.
Local method-2 plan SHA-256: `79b13eb2fca592e3704112fbf26be65da384ddfebf04a2e908eb4fda0be381ba`.
Local method-2 audit SHA-256: `da3d7dd0deadea7f1877eb7616c5c1e9efb122f972d71c4d558fe198c6a052a8`.
Local Node binary SHA-256: `8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d`.

## Frozen input and reproduction

The input is artifact 12123443213 from run 39092964974, `numeric-tree-X64-d16d82c9.zip`, SHA-256 `c47098bfa2c34c916b058fd38b3178dc85289b68b69141c88afeeea90ef837fb`. Its original artifact expires on 17 November 2026. The evidence workflow also attempts to retain this exact ZIP under `inputs/` in Git, so inspect that path before depending on the expiring artifact.

Baseline source: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`, tree `eb3bd4217f132e13b01c42f9b9c6bdc5aa92afab`.
Candidate source: `d16d82c9ac8b4264870c8c3687b25b53a6e553bf`, tree `604615ef9afbb574ebde5719b07ba075af98721c`.
The extracted source trees matched these Git trees. Local recovery did not contain upstream commit objects and does not claim to recreate signed commit history.
Original driver SHA-256: `77842c9459547c616ea4f90ade8bb32118d2f4175408aecf2269e2d8d7d5d033`.
Scalar Wasm was identical in both builds: `5a5114191016599a916768e6141babe2a3ec265ef00e28389e194177ad821d95`.

On Linux x64 with Node 22.16.0 and Python 3.12, extract the sealed source and run against the exact ZIP. Use a NEW output directory. No package installation or compilation is needed.

```sh
sha256sum -c diagnostic-source.sha256
mkdir diagnostic-source
tar -xJf diagnostic-source.tar.xz -C diagnostic-source
python3 diagnostic-source/reproduce.py /absolute/path/numeric-tree-X64-d16d82c9.zip /absolute/path/new-output
```

The archive holds the measured method-1 source, tests, controller, both auditors and the tested deterministic transformation to method 2. `--prepare-only` reconstructs both sources without measurement. The hosted workflow copies the readable source beside this archive when it saves evidence.

## Remaining limits

Only 27 of the original 63 endpoints were screened with method 1; method 2 covers nine. New method results are local Node x64 only until a named hosted run completes. Bun, ARM64, browser and the full endpoint set are not cleared by this work. Builds are the exact archived portable JS/Wasm inputs, not a new local native build. Process pairing changes runtime and cache interaction. The data does not prove a specific JIT cause. The double-call check detects a large loss; it does not establish sensitivity to every small regression. No startup or memory-speed claim is made. The original PR failures remain blockers.
