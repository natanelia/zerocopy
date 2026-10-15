# Independent audit: empty-prefix focused correctness v1

**Verified narrow outcome:** four retained Vitest invocations each passed the same eight reviewed cases, on baseline and candidate under Bun 1.4.2 and Node 22.16.0. Each raw report names only map-empty-prefix.test.ts, records eight passed assertions, and has zero failed, pending or todo cases. Each command exited 0. This verifies 32 case executions, not 32 distinct tests or full-suite clearance.

No audit blocker was found. This audit read and hashed retained evidence only; it did not rerun tests, import repository code, build, time, install or access the network.

## Evidence and provenance

- All four command plans agree with receipts. Raw report and stdout/stderr hashes match. The eight complete case names agree across arms/engines. All stderr files are empty. Receipts record no failure reason, no cleanup signals, no leftover descendants before/after cleanup, and leader reap after inspection. The reviewed runner retains the leader with waitid(WNOWAIT), performs group inspection before reap, verifies inputs before/after commands, stops on first failure and refuses a started gate. Recorded wall/RSS values satisfied their operational thresholds; RSS enforcement was sampled, not a hard cgroup limit. No performance comparison was made from these values.
- Both gate source inventories contain exactly the expected 503 paths. Baseline is the authenticated 502-path main manifest plus the exact v2 test; candidate is that same set plus only the reviewed arena.ts runtime change. The test remains SHA-256 `51e3850277791fc7b6308c2467039e789445dabd55ce74179434bb3f3d65b1dd`; candidate runtime remains `fad8b54107a1f672bacbf6d5c9e9cb22a7e0d715b528212fbc4f906e5692292c`. Original baseline, v1 candidate and v2 candidate source digests remain intact.
- Reused WASM comes from the authenticated **baseline** artifact of run 38641407273, attempt 1, artifact 11931130743, source commit d59e3f157c19e051088c1f8996972dce9aa5bb34 with main afdffdcfcbd61013f120de82411c0c4a6b2d1e0e as sole parent. The retained generated inventory equals the baseline-build inventory and the final baseline inventory. All 12 copied WASM files match that inventory and the authenticated artifact manifest; both arms use the same bytes. The core hash is `08b1e91c9ee6d3602c0a100f449f51555ee35e5641e1839b7f719d016c209d90`.
- The hosted 502-path source inventory differs from main at exactly **bulk-input-storage.test.ts**: hosted SHA-256 `b2f494be15095fe9cb135cbfe0c82b4896978afdec536416a61a8116e36e003f`, main SHA-256 `870b94f13cf73d199b3ef0b6b801e7648ae7b981176d0ab5094e7085640b8285`. The other 501 source paths match. All 17 native build/source inputs match main, hosted baseline and candidate; the test overlay is not a native input. Both current gate copies contain the main bulk-test hash, never the hosted overlay.
- PREPARATION-FAILURE.json retains the initial strict whole-inventory mismatch, explicitly before materialization/tests; its hash still matches the preparation and terminal seal. The subsequent preparer allows only the exact named/hash-pinned test exception. This was a corrected provenance assertion before execution, not a failed-test retry or broader source mismatch bypass.
- Pinned Node/Bun binaries match their recorded sizes and SHA-256 now. Retained identities identify Node 22.16.0 and Bun 1.4.2 (Bun's Node-compatibility version field is not the engine identity). The invocation explicitly selects each pinned path and adds --bun for Bun. Both gate dependency links point at the same retained toolchain; its package and lock hashes match preparation.
- All 36 terminal packet checksum entries and every hash reference in GATE-SEAL.json verify. The artifact-manifest provenance copies match the authenticated source artifact. No new native build or portable bundle is represented by this focused gate.

## Next genuine correctness gaps

1. Existing broader map/set/ordered collection and shared-cache regressions, including nested values and public set wrappers, have not run against this candidate. The new test file is useful focused coverage; the earlier bulk candidate's full-suite result cannot be transferred to this JS change.
2. Type/declaration checks remain unrun for this candidate. Vitest execution/transpilation does not establish these checks.
3. Real cross-worker shared/copy integration remains unrun. Current attachment cases run in-process; later validation should exercise actual worker transport and the intended Node/browser entry points. A fresh portable build and its worker/consumer checks are needed before claiming those artifacts work with the guard.

No immediate defect was exposed that calls for changing the runtime. Historical HAMT/Unicode overlap restrictions, other holds, performance testing and publication remain outside this gate. Nothing in this audit authorizes further execution or establishes a speed/memory gain.

## Durable pins

- GATE-SEAL.json: `7ec194642262cfb517ee6c211f8bb8dc8e2241d07e9b889d94b04b95cca106e3`
- command-receipts.json: `b4545c7902db6e2af8906abe2cdd3886837968b544a0aa203317a53fbcbc75e8`
- CORRECTNESS-RESULT.md: `adde6360d48d2ffcdc7118e37e2ca8ec83456f9fd28058ee406de1ce3ffe51b9`
- PACKET-SHA256SUMS: `008795a8c3b5cf4948e81d0ee43a40acfad6feb0e3cc26712efced2ad4f2bca0`

Detailed independent comparisons are in CORRECTNESS-AUDIT-CHECKS.json. Original source-review records are preserved.
