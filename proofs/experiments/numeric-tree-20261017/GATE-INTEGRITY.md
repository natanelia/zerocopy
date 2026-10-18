# Numeric evidence gate repair — 18 October 2026

This repairs result validation. It does not clear the SIMD optimization.
The production sources, measurement driver, version-2 plan, 63 endpoints,
workload, warm-up count, sample count, estimator and thresholds are unchanged.

## Confirmed defect

The previous final gate trusted `pointPass`, `confidencePass`, `pass`, and the
number of size cohorts. A constructed report with every ratio equal to 0.5
and every flag set to true passed. Duplicate size cohorts also passed.
This is a validator defect. It is not evidence that an actual failed hosted
run was accepted: the existing hosted final gates did reject those runs.

## Repair

The gate now reads every planned child JSON, exit-status record and raw NDJSON
journal. It checks the exact schedule, source/build identities, runtime metadata,
versioned plan, workload and fixture oracle results. It recomputes all estimates
and confidence intervals from the retained samples and compares the size and
phase summaries with those results. It independently checks the numerical
thresholds and requires every distinct size. It also checks source identities
across all four phases and the runtime identity between each A/A and A/B pair.
Missing, inconsistent, failed, wrong-build and wrong-oracle evidence fails closed.
No failed child, sample, phase or prior result is removed. Existing output files
are not overwritten. This is integrity checking, not cryptographic attestation.

## Validation

All 28 local Node harness tests passed. Tests reproduce the false-PASS defect and
cover invalid ratios, inconsistent summaries, duplicate sizes, failed children,
changed builds, wrong journals, missing files and changed raw observations.

The new verifier also read all four x64 phases of workflow run 39079960526 at
head 01814f2f79f625a453a142f2831c687b3331812a. All 63 endpoints per phase were
recomputed from every retained child and journal. The four original full-gate
failures remain failures. The ZIP SHA-256 was checked against GitHub metadata:
`a51524b0f3af6ca2c2d30998dfacaff1705a47a24c8063ed3ae4d5ddfc7e094a`.

## Separate rejected warm-up experiment

A local version-3 experiment added 64 fixed untimed priming calls, with a yield
after each group of eight. It kept the original seven warm-ups and 21 measured
batches. The predeclared A/A diagnostics at sizes 2, 33 and 1024 all failed their
full gates. All 48 children and their raw records were retained locally.
That experiment is NOT included in this PR. Version 2 remains unchanged.
Do not describe fixed priming as a proven fix for the observed timing variation.

PR #39 and the unroll candidates remain without performance clearance. Hosted
correctness, integration and performance outcomes must be reported separately.
