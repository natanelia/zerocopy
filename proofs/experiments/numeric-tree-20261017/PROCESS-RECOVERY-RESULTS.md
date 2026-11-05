# Process-method recovery results — 17 October 2026

PR #39 remains a draft. This repair adds measurement tools and regression
checks. It changes no production code, dependency version, public API or
storage format. Main remains `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.
The measured production candidate is
`9ae7fd04e2f5cc5944a5a36ebadb2bb9a250a980`.

## Source recovery

The candidate CI artifact 12088872245 from run 39000214467 has SHA-256
`ed8b325bb29ba87b5b475f2514fa894eaf2a5c493e27b6324fa7e64f581c7b50`.
Its recovered source produces tree
`9c208516c8386bb5eb7580532022e88702d7a8cc`, matching the candidate.
The main CI artifact 11693854983 from run 38120363116 has SHA-256
`9456539ced955d8fbf179c57aac80cdd83c75d04dc441ac279e6884c01531721`.
Its recovered source produces tree
`eb3bd4217f132e13b01c42f9b9c6bdc5aa92afab`, matching main.

The exact source, scalar/SIMD Wasm and dist digests listed in the previous
hosted comparison match these recovered builds. No rebuild with another
compiler or dependency version was substituted. The local recovered Git
indexes contain the authentic trees but no HEAD commit. Their measurement
manifests therefore say `commit: null`; these artifact digests and tree
checks supply the source provenance. A null HEAD is not a new source SHA.

## Fixed local runs

The host used Node 22.16.0, Linux x64, AMD EPYC 9V74 80-Core Processor.
Each method ran A/A and A/B once. Every child, warm-up, measured sample,
failed point check and failed confidence check remains in the local archive.
No sample was excluded, no output directory was overwritten, and no
production source changed between these methods.

| Method | Phase | Point checks passed | Confidence checks passed | Overall |
| --- | --- | ---: | ---: | --- |
| Fresh process, all sizes per child | A/A | 47/48 | 14/48 | Fail |
| Fresh process, all sizes per child | A/B | 46/48 | 35/48 | Fail |
| Fresh process, one size, fixed CPU | A/A | 48/48 | 25/48 | Fail |
| Fresh process, one size, fixed CPU | A/B | 48/48 | 40/48 | Fail |

The first method retained 32 children. The fixed follow-up retained 352
children. Each method recorded 32,256 measured batches and 10,752 warm-up
batches across A/A and A/B. All completed child result and full-byte
snapshot checks passed. The largest fixture arena was 8,650,752 bytes,
below the declared 64 MiB bound. This is not a hard RSS bound or a
production memory claim.

The follow-up observed large SIMD/public range ratios of 1.692–1.807.
All twelve large-range endpoints passed both the point and confidence
improvement checks. The ratio is baseline elapsed time divided by candidate
elapsed time. These observations come from an overall failed method and
are not production performance clearance.

Eight A/B confidence checks remain unresolved: point SIMD and public at
size 2; scalar and public range at 31; SIMD range and scalar/SIMD point at
32; scalar range at 262144. The A/A confidence failures also prevent
acceptance. Do not use a later lucky sample to replace these findings.

## Validation and evidence

All 12 Node harness regression tests passed before measurement and passed
again afterward. They check the fixed thresholds and complete schedule,
missing and invalid samples, changed source/runtime identity, retained
child failures, time drift cancellation and output overwrite refusal.
The recovered candidate also passed the real Node worker proof. The new
workflow YAML, shell syntax and all four final outcome checks were validated.
Local Bun, ARM64, complete integration and browser checks were not rerun.
They remain required hosted checks, not presumed passes.

Local archive: `zerocopy-process-repair-20261017.zip` (2,995,147 bytes).
SHA-256: `ba75a5cbadfd867f076bd1d65811cc0864ce4a51ca26adcb2986ef66010b9ece`.
It contains the exact new drivers, method documents, pre-run hash records,
1,626 evidence files and their per-file SHA-256 manifest. This archive is
attached to the accompanying conversation; its bytes are not stored in this
commit. This limitation is explicit. The original failed hosted run remains
on GitHub, and the revised workflow retains all new hosted raw samples,
source archives and exact builds as GitHub Actions artifacts for 30 days.
Artifacts must be preserved before their stated expiry for longer retention.

The measured driver SHA-256 is
`cc0261dc03e50b2c91ff4044493084929d5716dbdd7a1467d981a1ba2cc75de2`.
The size-isolation wrapper SHA-256 is
`af4a3422d477fadc6021810b487efc0bbb6b888185f55c8636ac10853adfb957`.
The old driver, old workflow and all earlier committed evidence remain.
Read [the process plan](PROCESS-METHOD.md) and
[the fixed follow-up plan](SIZE-PROCESS-METHOD.md).

## Hosted continuation

The workflow now runs the fixed size-isolated method for Node A/A, Node
A/B, Bun A/A and Bun A/B on x64 and ARM64. It retains the existing type,
full-suite, real-worker and browser correctness checks. Each measurement
step may finish with a failure so that the other declared phases can run;
the final job gate still requires all four phases to succeed. The explicit
pipefail shell prevents tee from hiding an error. A concurrency group queues
a later run rather than cancelling an active comparison. No package is
published, no PR is merged, and no shared history is rewritten.
