# Corrected hosted failure propagation

[Numeric tree comparison run 38998487385](https://github.com/natanelia/zerocopy/actions/runs/38998487385)
failed on x64 and ARM64. Both final gate steps failed. The corrected shell
uses `pipefail`, so `tee` no longer hides a failed producer. The workflow
kept all performance records and continued through its correctness checks.
This result confirms failure propagation. It does not clear performance.

The PR head was `85eee3354b85f8d7d6121a72579ddc8e06a57112`. The tested merge
was `2ac1950417e6a9151eaa6b5fb48afc3cc4998399`. The comparison base remains
`afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. These measurements use the
original v1 method, Node.js 22.23.3, and Bun 1.4.2. The x64 CPU was an AMD
EPYC 9V45 96-Core Processor. The ARM64 report gives the CPU as unknown.

## Identical-source failures

There are eight failed rows across 168 A/A rows. The fixed interval is
`[0.95, 1/0.95]`. A ratio above the upper limit also fails this diagnostic.

| Architecture | Run | Case | Values | Speedup |
| --- | --- | --- | ---: | ---: |
| x64 | Node a/b | Range SIMD | 1 | 0.9217456651782567 |
| x64 | Bun a/b | Range public | 1 | 2.0845596323240696 |
| x64 | Bun b/a | Range public | 1 | 2.040952784721364 |
| x64 | Bun b/a | Point SIMD control | 2 | 0.9406043253838451 |
| x64 | Bun b/a | Range SIMD | 32 | 0.9456409847764564 |
| x64 | Bun b/a | Range scalar | 32 | 1.2547841668900621 |
| ARM64 | Node b/a | Range public | 1 | 0.8547634430266406 |
| ARM64 | Bun b/a | Range SIMD | 2 | 1.0583924500774597 |

All eight scheduled processes completed. Both A/A controllers then
reported failure. No failed cohort is omitted.

## Baseline/candidate failures

There are four failed rows across 192 full A/B rows. Both Node cohorts
pass all 48 original point-estimate gates. The following Bun rows fail:

| Architecture | Case | Values | Speedup | Required limit |
| --- | --- | ---: | ---: | --- |
| x64 | Range public | 33 | 0.8862456936026983 | At least 0.95 |
| x64 | Range public | 32,768 | 1.0393749767667657 | Above 1.05 |
| x64 | Range public | 32,801 | 0.9424272898724707 | Above 1.05; also below 0.95 |
| ARM64 | Range scalar | 33 | 0.9204535152602755 | At least 0.95 |

These ratios are baseline median elapsed time divided by candidate median
elapsed time. They were checked against the raw samples in each archive.
Passing Node point gates do not establish acceptance after failed method
controls and Bun gates. The original losses remain unresolved.

## Correctness checks in this run

Both architectures passed all 1,062 tests in 50 files. Both passed type
checks and the Node and Bun real-worker proofs. The x64 browser record
has 24 complete rows. Every row has `ok: true` and `growth: true`.

Chromium 153.0.8010.12, Firefox 155.0, and WebKit 26.6 each tested baseline
and candidate kernels and workers in automatic and forced-scalar modes.
The 12 kernel rows contain 7,236 checks. The 12 worker rows contain 36,864
scans. No WebKit baseline-limit exception was used. Browser results prove
correctness only. The numeric worker proof uses `copy: false`; it does not
establish explicit `copy: true` coverage.

This run is separate from the two geometry timeouts in Worker sessions
run 38998487324 and Numeric performance proof run 38998487320. Those raw
logs remain in [the assertion repair record](../hosted-second-ci/ASSERTION-REPAIR.md).

## Complete records

- [x64 archive](numeric-tree-x64-second.zip)
- [ARM64 archive](numeric-tree-arm64-second.zip)
- [Official archive IDs, sizes, and verified SHA-256 values](origin.json)
- [GitHub job and step status](job-status.json)
- [Derived row summary and source hashes](summary.json)

GitHub's step conclusion can be success after `continue-on-error`. The
workflow's final step checks each original step outcome. Both final steps
failed and both complete artifact uploads succeeded.
