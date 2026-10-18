# Runtime coverage and portable evidence checks — 18 October 2026

No production source, timing driver, workload, warm-up count, sample count,
endpoint, estimator or performance threshold changes in this repair.

## Runtime labels were not enforced

The old cross-phase block checked that each A/A and A/B pair used matching
runtime metadata and binary hashes. It did not require Node evidence in the
Node phases, Bun evidence in the Bun phases, or the current job architecture.
Replacing both Bun phase reports with the corresponding Node reports passed
that old block. This was reproduced with both downloaded architecture archives.
It is a coverage defect, not evidence that these failed runs became passes.

The gate now requires all four named phases, the correct A/A or A/B kind,
Node without a Bun version, Bun with its version, and the job architecture.
It preserves the existing cross-phase source and binary identity checks.
Offline audits can specify the source artifact architecture explicitly.
The CI entry point uses its own process architecture, not a report's label.

## Derived estimates are not bitwise portable

The unmodified verifier rejected the ARM64 Node A/B size-32801 report when
recomputed with local Node 22.16.0 on x64. A speedup was
1.5320804226962677 in the archive and 1.5320804226962674 locally.
This last-bit difference is in a derived estimate, not a changed raw sample.
The first failed audit log is retained; it was not overwritten.

Cached speedup, interval and block-ratio estimates now use the existing near()
tolerance, 1e-12 * max(1, abs(expected)). Raw samples, journals, paired ratios,
endpoint identity and all pass flags still require exact equality. All timing
floors remain unchanged. Returned rows come from the newly recomputed samples,
not the cached values. A test confirms a result below 0.95 cannot become PASS
through this estimate tolerance.

## Completed verification

All 34 local Node harness tests pass, including runtime swaps, wrong architecture,
missing versions, missing phases, source/runtime changes, one-bit estimate
differences, changed paired ratios and a forged near-floor pass.

All eight phases from run 39088420210 were then recomputed from all 1,408 child
records and journals. The genuine runtime coverage passes on x64 and ARM64.
All eight original performance failures remain failures:

| Architecture | Phase | Point checks / 63 | Confidence checks / 63 |
| --- | --- | ---: | ---: |
| x64 | Node A/A | 58 | 47 |
| x64 | Node A/B | 63 | 61 |
| x64 | Bun A/A | 46 | 37 |
| x64 | Bun A/B | 59 | 46 |
| ARM64 | Node A/A | 63 | 56 |
| ARM64 | Node A/B | 63 | 62 |
| ARM64 | Bun A/A | 59 | 57 |
| ARM64 | Bun A/B | 63 | 61 |

Run: https://github.com/natanelia/zerocopy/actions/runs/39088420210
Measured head: b94a923990e09fa9e97f6e4f20519f63f5a640d2.

Original artifact identities, both SHA-256 digests checked against GitHub:

- x64: artifact 12121084431; SHA-256
  de53ce15b38b7406ea4a79e4250cc1aa6deb66dcf14fef2fd23ee8c49d7d69c4.
  Expires 17 November 2026 at 02:10:48 UTC.
- ARM64: artifact 12122370847; SHA-256
  236ae198a91348ffd89e26af02a80a7bea2c8bdbe40ec3810c84f40eaa5d9576.
  Expires 17 November 2026 at 02:14:26 UTC.

Reproduce tests:

```sh
node --test proofs/numeric-tree-process.node.mjs \
  proofs/numeric-tree-manifest.node.mjs proofs/numeric-tree-gate.node.mjs
```

For an offline audit, call verifyEvidence(directory, kind) for each unpacked
phase, then validateRuntimeCoverage(theFourReportMap, 'x64' or 'arm64').
validatePhase remains the separate performance acceptance check. Do not infer
speed clearance from successful evidence verification. No new timing run is
needed to reproduce this audit. The earlier failed evidence remains unchanged.
