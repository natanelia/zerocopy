# Delivery

The complete v0.2 candidate runtime, tests, build scripts, and performance evidence
are integrated in PR #1 on `agent/immutable-performance-proof`.
The earlier source upload failure is resolved.

The runtime and benchmark source hashes match the candidate used for the recorded
local measurements. Documentation now describes the completed upload. Historical
local results and newly generated CI results are separate.

This is a draft for review because the binary format, worker protocol, and memory
lifetime change. Six measured workloads improve; eight regress. Append-only arenas
have no per-node reclamation. Do not merge this as a compatible performance patch.
No merge or package release has been performed.

See `proofs/README.md`, `proofs/results/`, `immutable-proof.test.ts`, and the Actions
run for the exact PR commit. The source ZIP and patch previously delivered in chat
remain historical copies; their incomplete-upload notes are no longer current.
