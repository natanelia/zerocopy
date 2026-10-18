# Numeric tree comparison: retained run 39000214606

Date: 17 October 2026.
PR: https://github.com/natanelia/zerocopy/pull/39
Run: https://github.com/natanelia/zerocopy/actions/runs/39000214606
Production head: `9ae7fd04e2f5cc5944a5a36ebadb2bb9a250a980`.
Baseline: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.

## Archive verification

Both archives were downloaded again and their SHA-256 digests matched
GitHub's recorded values. No samples were removed.

| Architecture | Artifact | SHA-256 |
| --- | --- | --- |
| x64 | 12089135849 | c024ae315f22d7f91456f016110e43c5c21ecad10ca8fd970f3d0295dc67ac5d |
| ARM64 | 12088987124 | 91b1c12bbea0893e2e3a1cbaf5d6099f2f36304891c28bec7fa5aeac2facc05c |

## Results

Both Node A/B runs passed the existing point thresholds. Bun A/B failed
five rows on x64 and three on ARM64. The failed ratios were:

- x64: range-simd/1 0.943741, range-scalar/1 0.924593,
  range-public/1 0.949442, range-public/2 0.918200,
  range-simd/33 0.894230.
- ARM64: point-simd-control/2 0.904301, range-public/32 0.872664,
  range-public/33 0.925718.

The identical-build A/A cohort also failed on both hosts. These results
cannot clear the production change. The observed large-input gains do
not override failed controls.

## Recovery

The CI evidence artifact 12088872245 was recovered. Its ZIP SHA-256 is
`ed8b325bb29ba87b5b475f2514fa894eaf2a5c493e27b6324fa7e64f581c7b50`.
The recovered source produces Git tree
`9c208516c8386bb5eb7580532022e88702d7a8cc`, which matches this PR head.
This recovery does not establish new correctness or performance results.

## Next diagnostic

Use balanced fresh-process comparisons to test the persistent shifts
seen in identical-build samples. Record the schedule before timing.
Keep the existing A/A and A/B thresholds, all prior failures, and all new
raw samples. Do not rerun an unchanged cohort to select passing results.
Keep PR #39 as a draft until the method and all required checks pass.
