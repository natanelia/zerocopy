# Stage 4: bypass the tree helper for a single root leaf

Date: 17 October 2026. This is a new production candidate, not an accepted
performance improvement. Keep PR #39 as a draft. No threshold changes.

Baseline: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.
Previous stage: `906eaf1d9ca4751244631695900335d1f78f2017`.
The previous commit changes measurement code only; its production kernel
is the same Stage 3 kernel measured at `9ae7fd04e2f5cc5944a5a36ebadb2bb9a250a980`.

## Retained failure and hypothesis

[Run 39020005031](https://github.com/natanelia/zerocopy/actions/runs/39020005031)
completed all declared phases. All eight overall phase gates failed. The
step conclusion is not the command outcome when continue-on-error is used.
The final gate correctly failed both jobs. Earlier step-level success
messages must not be treated as acceptance.

| Host | Phase | Point passes | Confidence passes |
| --- | --- | ---: | ---: |
| x64 | Node A/A | 47/48 | 34/48 |
| x64 | Node A/B | 48/48 | 46/48 |
| x64 | Bun A/A | 45/48 | 27/48 |
| x64 | Bun A/B | 44/48 | 30/48 |
| ARM64 | Node A/A | 48/48 | 44/48 |
| ARM64 | Node A/B | 48/48 | 47/48 |
| ARM64 | Bun A/A | 45/48 | 43/48 |
| ARM64 | Bun A/B | 45/48 | 44/48 |

The x64 Bun direct SIMD range at size 33 had a baseline/candidate ratio
of 0.65164, with a 95% interval of 0.58922–0.72068. Its corresponding
identical-build endpoint cleared the A/A interval. The public size-33
range was also slower: 0.81059 (0.70634–0.93023). These are concrete
signals worth a source follow-up. Other controls and A/A failures remain;
this diagnosis does not dismiss them.

Lists with 33–64 values have one full root leaf and a tail. Their root
depth is zero. Stage 3 enters the enlarged tree helper for that one leaf.
Stage 4 calls the existing span helper directly for a SIMD depth-zero
root, and leaves deeper grouping intact. This avoids one unnecessary
helper path. A change in Bun inlining or native code placement is only a
hypothesis; no native compiler trace has established the cause.

The scalar feature branch is unchanged. CI must still compare its emitted
bytes against main. The change writes no memory and adds no allocation,
cache, dependency, public function, binary layout or exported signature.

Kernel source SHA-256:
`a28385fe2041023ae45d4e6acd82911545825e76c18040ac19085651f79fccc4`.

## Predeclared Stage 4 comparison

Build main and Stage 4 with the existing pinned compiler and production
flags. Run the fixed size-isolated, first-allowed-CPU, four-block method
once for each Node/Bun A/A and A/B phase on x64 and ARM64. Keep all 48
endpoints, all seven warm-up and 21 measured batches, the same workload,
iteration cap, paired log-block estimate and confidence rule. Keep the
0.95 regression floor, >1.05 large-range target and [0.95, 1/0.95] A/A
interval. Do not accept the stage unless every required gate passes.

Two integrity repairs do not change the timed loops or estimator. Lock
source and build inputs across all eleven sizes, not only within each
size. Also lock the resolved runtime binary and compare runtime metadata
across sizes. The old driver and wrapper remain byte-for-byte under
`process-method-v1.mjs.source` and `size-process-v1.mjs.source`.
The new method tag identifies these extra input guards. A changed input
prevents acceptance. The workflow records raw gate results separately
from continued-step conclusions.

## Correctness and review repairs

Two new tests exercise every tail length at root depth zero with a full
root leaf at the memory boundary. They check scalar and SIMD exports,
NaN, infinities, signed zero, subnormal values, invalid bounds, zero-size
no-load behavior, and the complete unchanged arena byte sequence.
The fixture passed 1,024 oracle checks against recovered main and Stage 3
binaries. This validates the fixture, not the unbuilt Stage 4 binary.
Local Stage 4 compilation and full integration have not run because the
pinned compiler is absent. Hosted build, test and worker gates remain
mandatory before timing. The workflow saves the installed pinned compiler,
its required dependencies and licenses for exact offline reproduction.
It does not install a different compiler or publish a package.

The independent CodeRabbit review of commit 906eaf1 found missing input
triggers and a stale manifest. The workflow now watches the measured
wrapper, spatial kernel, Wasm bridge, geometry test and build inputs.
The old manifest is preserved as `manifest-before-stage4.json`. A new
source inventory is verified against both Git indexes before timing.
It lists every changed file except itself. Historical generated-binary
hashes and test outcomes remain in their original records.

All 20 local Node proof tests passed. These include missing/extra sample
checks, failed-child retention, no overwrite, fixed thresholds, whole-run
input rejection, current-manifest verification, compiler snapshot checks
and explicit final-gate checks. They do not clear Stage 4 performance.

## Raw archive provenance

Both complete run-6 archives were downloaded and matched GitHub's recorded
SHA-256 digests. All raw samples, source archives and exact built inputs
remain in those artifacts. No observations were removed or replaced.

| Architecture | Artifact ID | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| x64 | 12096661157 | 7131455 | a2e5b550c2a907cc3775e8c435545eaf7fcbfaefa330d8ee0a04bec31183fc49 |
| ARM64 | 12096372201 | 7064477 | 473d4577e852d1c649ec0f90445174db921a60d44b17b6a2acde7e710c730d98 |

GitHub currently expires these artifacts on 16 November 2026 at 09:18:48
UTC and 09:20:37 UTC respectively. They are not permanent repository blobs.
Copies also remain with this conversation. The small derived
[run-6 summary](hosted-process-run6/summary.json) records the original
summary digests and all failed point rows; it is not a replacement for raw
samples. The earlier local process archive is documented in
[the recovery report](PROCESS-RECOVERY-RESULTS.md).
