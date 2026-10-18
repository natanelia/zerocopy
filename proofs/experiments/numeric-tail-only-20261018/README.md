# Tail-only entry experiment — 18 October 2026

**Not an accepted optimization. No production PR for this experiment.**

Stage 7 adds an early SIMD return for lists of at most 32 values. This avoids
computing the tree mask and tree dispatch on tail-only snapshots. It keeps the
original invalid-bound checks and span kernel. The scalar build is byte-identical
to the fixed historical baseline. The candidate extends Stage 5 in PR #41; it is
not applied to that PR or main by this evidence branch.

## Fixed local screen

Node 22.16.0, Linux x64. One A/A phase followed by one A/B phase, with all 63
PLAN-2 endpoints, four balanced ABBA/BAAB blocks, seven warm-up batches, 21
measured batches, and every original threshold. All 352 processes completed.
All 42,336 measured batches and 14,112 warm-up batches were retained. No retry,
removed endpoint, discarded sample, or adjusted acceptance threshold.

| Phase | Point checks / 63 | Confidence checks / 63 | Full gate |
| --- | ---: | ---: | --- |
| Identical Stage 7 builds (A/A) | 61 | 28 | FAIL |
| Historical baseline vs Stage 7 (A/B) | 63 | 51 | FAIL |

`stage7-screen.csv` retains every endpoint estimate and pass decision. These
ratios are baseline/candidate time, not accepted general speedup claims. The
complete raw child records, journals, plans and logs are in the attached local
archive identified in `receipt.json`. That local raw archive has **not** been
copied into Git history. The separate official GitHub input artifact remains
available only until its stated expiry unless copied elsewhere.

The new candidate passed six safety tests with 37,855 numerical oracle checks,
the real Node worker proof, and all 28 inherited harness tests. Public API tests
used the archived portable JavaScript bundle with one checked SIMD literal
replacement. This was not a native Bun bundle, a local full-suite run, a browser
run, or an ARM64 run. The parent source inventory is preserved as historical;
it does not describe Stage 7. Exact variant tree and byte hashes identify this
experiment independently.

## Reproduce the exact bytes without running new timings

Download original GitHub artifact 12121084431 from run 39088420210:
https://github.com/natanelia/zerocopy/actions/runs/39088420210

The ZIP SHA-256 is
`de53ce15b38b7406ea4a79e4250cc1aa6deb66dcf14fef2fd23ee8c49d7d69c4`.
It contains the exact baseline, Stage 5 source, portable builds, pinned compiler,
transitive dependencies and licenses. Its recorded expiry is 17 November 2026
at 02:10:48 UTC. No dependency install or version change is needed.

```sh
python3 reproduce-stage7.py --artifact numeric-dual-x64-run11.zip --output new-check
```

This command was tested. It rebuilt identical scalar/SIMD bytes, recovered the
exact Stage 7 tree, and passed the safety, worker and inherited harness checks.
It refuses to overwrite an existing output directory. Add `--benchmark` only
for a new labelled reproduction. A later result must not replace or clear the
original failed cohort. The source tree has no invented upstream commit ID.

## Compiler-mode diagnostic

A separate fixed 16-process diagnostic used the same Stage 5 build at size
32,768, with default flags versus eager optimizing-only Wasm compilation. Each
mode had eight children in a balanced schedule. All original endpoint calls,
seven warm-ups and 21 measured batches were retained for that size.

One default-mode public-scan process was much slower than the other seven;
none of the eight eager-mode processes showed that outlier. Control-operation
variation remained. This small local experiment does not establish the cause,
remove the failed A/A controls, or justify changing production runtime flags.
Its raw records and exact command lines are retained in the local archive.

## Related validator repairs

PR #40 now rejects swapped Node/Bun runtime evidence and wrong architectures.
It also accepts last-bit cached-estimate differences while keeping raw samples,
paired ratios, pass flags and all performance thresholds exact. PR #41 includes
those repairs without a kernel change. All 34 repaired harness tests pass.

The official run 39088420210 and later run 39091163324 each failed all eight
x64/ARM64 Node/Bun phase gates. Both sets were rechecked from their raw records;
no later run was selected to replace an unfavorable one.
