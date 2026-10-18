# Paired numeric-tree timing diagnostic — 18 October 2026

**Evidence branch only. No performance clearance, no production change, and no new PR.**

This investigation tests whether adjacent A/B timing in one process reduces false
regressions from the independent-process timing in [PR #40](https://github.com/natanelia/zerocopy/pull/40).
The exact earlier accepted timing plan (version 2), its 63 endpoints, 0.95
regression floor, >1.05 large-range requirement and 1/0.95 A/A ceiling remain
unchanged. The published data are **diagnostic only**. No sampled failures were
removed, no thresholds changed and no version-2 failure was converted to PASS.

## Fixed inputs and method

- Current source PR #40: `d16d82c9ac8b4264870c8c3687b25b53a6e553bf`.
- Historical baseline: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.
- Original GitHub Actions input: [run 39092964974](https://github.com/natanelia/zerocopy/actions/runs/39092964974), x64 artifact 12123443213, ZIP SHA-256
  `c47098bfa2c34c916b058fd38b3178dc85289b68b69141c88afeeea90ef837fb`.
- Local Node 22.16.0 x64, process pinned to one allowed CPU, build inputs
  checked before and after each child. Two distinct module paths, independent
  snapshots and 64 MiB arena limits per arm. The plans contain complete
  SHA-256 inventories, runtime identity, fixed scheduling and controller hashes.
- Four independent blocks; each endpoint in a child had seven warm-up batches
  and 21 measured batches with balanced orders. A/A and A/B were interleaved;
  a deliberate two-call B control must fail the speed gate.
- Method 1 plan SHA-256:
  `7272d7d7142b3897f061821fdaeb2775f72c9478d6b302fe7bd3c798b53cc4b6`.
- Method 2 plan SHA-256:
  `79b13eb2fca592e3704112fbf26be65da384ddfebf04a2e908eb4fda0be381ba`.
  It was specified as a separate follow-up to the losing size-2 case, and
  increases batch iterations by four. It cannot be pooled with Method 1.

## Completed local findings

| Method | Size | A/A confidence | A/B confidence | Deliberately slow control |
| --- | ---: | ---: | ---: | ---: |
| 1, separate fresh process | 2 | 6/9 | — | — |
| 1, paired process | 2 | 5/9 | 9/9 | — |
| 1, separate fresh process | 1,024 | 6/9 | — | — |
| 1, paired process | 1,024 | 9/9 | 9/9 | 0/1 (rejected) |
| 1, separate fresh process | 32,768 | 3/9 | — | — |
| 1, paired process | 32,768 | 9/9 | 9/9 | — |
| 2, 4x-batch paired | 2 | 9/9 | 9/9 | — |
| 2, 4x-batch paired | 1,024 | — | — | 0/1 (rejected) |

Method 1 retained **76 processes, 18,312 measured batches and 6,104 warm-ups**.
Method 2 retained **12 processes, 3,192 measured batches and 1,064 warm-ups**.
Independent Python replay checked every raw journal and recomputed every
endpoint and confidence decision. Method 1 audit SHA-256:
`4285f6373c465d76da212fb41771d33a326edbf4f5881a9c3c34a876bf023cf6`.
Method 2 audit SHA-256:
`da3d7dd0deadea7f1877eb7616c5c1e9efb122f972d71c4d558fe198c6a052a8`.
The exact original compressed diagnostic archive SHA-256 is
`9e4826fd1f992c39e4202e0f8b8fe33419c01d66d3882265247e42ee835b5eb8`.

The *raw local archive is provided to the user in the originating conversation,
not stored on this Git branch*. The original full hosted comparisons and their
raw artifacts are available in GitHub Actions run 39092964974 and
[run 39093228871](https://github.com/natanelia/zerocopy/actions/runs/39093228871).
Those official x64 and ARM64 full gates **failed** and remain failed.
Do not treat this note, a successful control subset or the separately changed
workload as clearance for PR #39 or PR #41.

## Next independent checks

Freeze one prospective all-63-endpoint same-process plan **before** timing,
then test its A/A, A/B and injected slowdown controls on Node and Bun,
both x64 and ARM64. Preserve all raw samples and any failed gate.
Do not choose only favorable reruns of the same method. The 64 MiB limit
is for each arena, not process RSS. Startup, compilation, browser, process
memory and other workloads have not been measured.
