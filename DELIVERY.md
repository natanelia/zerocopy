# Delivery

The complete v0.2 runtime, tests, build scripts, and performance evidence are
integrated in PR #1 on `agent/immutable-performance-proof`.
The earlier source upload failure is resolved.

The initial integration matches the measured local engine. A subsequent browser
fix has its own source digest and passed the full GitHub proof workflow. Historical
local results and newly generated CI results remain separate. The raw-data split
is lossless and checksum-verified. See `proofs/results/README.md`.

This remains a draft for review because the binary format, worker protocol, and
memory lifetime change. The historical comparison has six improved workloads and
eight regressions. Append-only arenas have no per-node reclamation. Do not merge
this as a compatible performance patch. No merge or package release was performed.

See `proofs/README.md`, `immutable-proof.test.ts`, and the Actions run for the exact
PR commit. Previously delivered chat archives are historical copies, not the
latest browser-fixed source. Their incomplete-upload notes are no longer current.
