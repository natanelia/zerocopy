# Independent raw audit: hosted run 38668352050, attempt 1

**Verified outcome: partial correctness pass, stopped on a Git-context harness failure.** Native build, portable build, declarations, full Bun suite and documentation-script tests passed. The Bun JSON report records exactly 1,063 passed assertions across the 51 pinned test files, including all eight new empty-prefix cases; failures, pending/todo cases and unhandled errors are zero. Documentation-script TAP reports six passed, zero failed/skipped/cancelled/todo.

The next stage, docs-links, exited 1. Its retained stderr states `git ls-files -z *.md` failed because the candidate is not a Git repository. The reviewed controller materialized it with `git archive` plus the fixed patch; the unchanged documentation checker obtains its Markdown inventory through Git. This is a missing harness prerequisite, not evidence of a broken documentation link or candidate-runtime regression. The review did not previously catch this prerequisite; the failed attempt remains intact.

Exactly seven later stages are unrun: docs-examples; Node worker, Redux and typed-JSON worker integrations; package dry run; package archive; and package consumer. No package archive was validated. The run and hosted-result both remain failed/incomplete. Source and generated integrity and owned-process cleanup are verified.

## Authentication and reconciliation

- Retained GitHub metadata identifies run 38668352050, attempt 1, proof head e768726f66c2d140b08921c300968ca57de273e5 and artifact 11942087972. The retained parent receipt gives pinned main afdffdcfcbd61013f120de82411c0c4a6b2d1e0e as sole parent. No fresh network call was made by this reviewer.
- The 2,482,323-byte ZIP SHA-256 equals the GitHub artifact digest. Every ZIP member matches its extracted file. All 129 artifact-manifest entries verify; there are 130 files including the manifest. All reviewed v2 inputs and the workflow match byte-for-byte.
- Both source inventories and every candidate tar member match all 503 approved source hashes. Main tar bytes match its complete 502-file source inventory. Native output manifest covers 13 files; final generated inventory and retained files match all 66 approved build/declaration outputs. The portable shared.js import graph reaches the embedded native core, whose decoded bytes independently equal persistent-core.wasm.
- All 16 command receipts have matching stdout/stderr hashes, correct plan argv and exit status, no cleanup signals or leftover descendants, and leaders reaped after group inspection. The five passing ordinary stages have validationPassed=true. docs-links has exit 1 and is not passed. No later-stage receipt exists. No per-command cap was exceeded; maximum sampled group RSS was 1,245,483,008 bytes. These are operational receipts, not memory-regression evidence.
- Runtime/test/patch hashes remain those previously approved. Original local resource-cap failure remains separate and unchanged. Terminal seal and authentication record hashes verify.

This establishes the reported full Bun and five-stage partial outcome only. Remaining ordinary checks, broader exact-head CI/browser checks, historical restrictions, and any performance claim are still uncleared. No repository code, build, test, benchmark or controller was executed in this audit; no retry or publication occurred.

## Pins

- Terminal seal: ba9010e96904516b7be66a83ca74fd12f58b62ea050c3bc6057fc9dc24663081
- Authentication: c14bda619e2512c7e7116a1cff2b954fa1f55de174a9de838774e79eb372b652
- ZIP: dc444b788ea0016daddfd680c32d765d74d3e3a7f3fc16370968f4aa30c878db
- Artifact manifest: ac254b7276ac1b4112984e57204ae0f0083992f3c359b1206d335ff48aae9bef
- Full Bun raw JSON: d08df62385886d0a6cb170ee26239ef0938aa3ef30d79c9ab50d0c43bc98cb4d
- docs-links stderr: 4ff2a6f14db35a642d0da297a1463c5164d40bbdd15261e03fcf900d2760d3d8

Detailed comparisons are retained in AUDIT-CHECKS.json.
