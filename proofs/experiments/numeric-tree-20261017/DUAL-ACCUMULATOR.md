# Two-counter SIMD candidate — 18 October 2026

Draft. No performance clearance. This is the earlier Stage 5 source candidate,
now published for review with the corrected gate and complete hosted checks.
It is not a new claim that the failed Stage 5 experiment succeeded.

## Change

In the depth-one sibling-leaf scan, process four numbers per loop with two
independent SIMD counters. Combine the counters once after the sibling group.
The span kernel, root-leaf dispatch, integer recursion and scalar code stay
unchanged. Each vector load stays inside a complete 32-number leaf. There is
no allocation, shared-memory write, new API, layout change or new dependency.

## Local validation of the published kernel

Rebuilt with the pinned compiler toolkit retained by workflow run 39079960526.
The toolkit files and input ZIP digest were checked before use. The rebuilt
SIMD binary exactly matches the retained Stage 5 binary. Scalar bytes exactly
match the historical baseline and current Stage 4 build.

SHA-256:
- Source: 76d0bbcbf5acea9106e6e3f9d89a2b41c3a60a612f4e8fd07dd1425ad649c5c5
- Scalar: 5a5114191016599a916768e6141babe2a3ec265ef00e28389e194177ad821d95
- SIMD: 302d98e7f6d6633d49b27d56f2303b9e8ce91b81922f6a384119a2c399deb3cf

All six safety tests passed with 37,855 numerical oracle checks. They cover
all sibling-group child counts, all tail lengths, memory-end loads, poisoned
unused pointers, raw binary64 values, invalid bounds, tree-depth boundaries,
read-only attachments, forks and complete snapshot bytes. The real Node worker
proof and all 28 benchmark-harness tests also passed.

The local public-API check reused the archived portable JavaScript bundle with
exactly one checked embedded SIMD literal replaced. It was not a fresh Bun
bundle or a local full-suite/browser/ARM64 run. Hosted CI builds the bundle
normally and runs the safety tests before any measurements on both architectures.

## Performance acceptance

The prior Stage 5 full comparison failed. Large-scan improvements in that failed
cohort do not override smaller-input regressions, confidence failures or failed
A/A controls. All prior raw data and both alternative source designs remain in
the earlier evidence archives. The failed fixed-priming experiment is excluded.

The timing method stays version 2: all 63 endpoints, the 0.95 regression floor,
the >1.05 large-range target, four balanced process blocks, seven warm-up batches,
21 measured batches and the A/A interval remain unchanged. Source inventory
version 3 is only the inherited inventory representation.

Require Node and Bun A/A and A/B on x64 and ARM64, all point and confidence
gates, full correctness/integration tests, worker proofs and browser checks.
Do not merge this draft until those results pass. Publish failed runs unchanged;
do not repeat an unchanged cohort merely to choose a passing result.
