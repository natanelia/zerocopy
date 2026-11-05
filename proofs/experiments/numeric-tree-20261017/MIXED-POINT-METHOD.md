# Additional positive-hit point controls — 18 October 2026

This is a new benchmark method, not acceptance of the existing SIMD candidate.
It preserves all prior samples. No prior result is overwritten or discarded.

## Why this method exists

The original point query controls are all-miss on all five even sizes. Their
paired x/y residues cannot both fall inside [-1000, 1000]. A proof audit
confirmed zero hits on every original point-control fixture. Those controls
can detect overhead changes but cannot exercise the hit-count path.

The original 48 endpoints, warmups, measured batches, and numerical thresholds
remain intact. This method adds three read-only point queries for each of the
five even sizes: scalar, SIMD-build scalar point kernel, and public API. The
added box is fixed across all sizes:

- x in [-5000, -2500]; y in [2000, 5000].
- Matched point counts in size 2, 32, 1024, 32768 and 262144:
  1, 4, 108, 3408 and 27269.
- Size 2 has one hit (its only point); all larger sizes have both hits and
  misses. Counts are checked against an independent JavaScript oracle.

Each input list and saved snapshot stays identical. The new calls run *after*
all old calls for their size and do not add a new list or write any bytes. The
full gate now requires all 63 endpoints, with the original floor 0.95 and
confidence checks. The >1.05 large-range target still applies only to large
SIMD/public range calls. The A/A interval [0.95, 1/0.95] is unchanged.

The benchmark PLAN version becomes 2 to prevent accidental pooling with v1.
The new source and measured binary hashes are saved with each run.

## Fixed historical baseline

The main branch advanced beyond the originally measured baseline. The manifest
requires exact baseline commit `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`
and tree `eb3bd4217f132e13b01c42f9b9c6bdc5aa92afab`.

The GitHub workflow checks out that exact commit for PR and manual runs.
It also checks out the PR head commit rather than GitHub's synthetic merge
commit, so unrelated main changes cannot alter the measured candidate. The
artifact name uses the same head SHA. Otherwise new main changes would alter
the inventory or the comparison inputs. This pins historical inputs; it does
not certify a new main-branch baseline.

## Acceptance and limits

There is no accepted speed result. Stage 4, Stage 5 and Stage 6 previously
failed full gates. The new method is justified by a systematic coverage gap,
not by selecting a passing benchmark rerun. No performance threshold changes.
Require full Node and Bun A/A and A/B on both x64 and ARM64, full suites,
browsers, worker tests, and correct snapshots. Existing hosted failures and
experimental local runs remain part of the record. Do not merge this draft
unless every current gate passes.
