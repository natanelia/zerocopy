# SharedSortedMap callback: ordinary hosted correctness

This independent proof branch checks one frozen source candidate against main `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. It runs no benchmark, calibration, memory study, deployment or package publication. Passing this job establishes only its listed correctness checks.

The runtime patch is limited to SharedSortedMap.forEach. It captures original entries/naturalEntries identities, selects direct radix traversal only for genuine base handles with a falsy comparator and an original naturalEntries data descriptor, decodes keys before values and retains normal for-of cleanup. Overrides/subclasses/comparators keep the original entries path. Public generator bodies, Arena, native code and APIs are unchanged. The ordinary-standard-intrinsics boundary is explicit: forged handles, private/raw-node instrumentation and replaced Array/generator intrinsics are not a universal-equivalence claim.

Two test files accompany the one runtime file:14 focused semantic cases and additive assertions in the existing portable Node worker proof. The latter checks sorted callbacks and read-only refusal on both shared and copied worker attachments while preserving all prior checks. The exact patch SHA256 is `2f11252bd6ea9eeee68265f07bf6be2e63b055e52965b85520477ad574856aa9`.

## Preserved local outcome

The local focused checks passed14 baseline cases and78 candidate cases in each engine, plus the amended real-worker proof. The original focused gate stopped on a checker count error: worker-attachment's13 cases run for each copy mode, so the correct total was26, and all78 requested candidate assertions had passed. Its failed result remains intact. An independently reviewed continuation ran only the previously unrun candidate Node/worker commands.

The remaining local normal gate passed five type checks, then full Bun reached its fixed300-second timeout. SIGTERM ended the child without a remaining process group. Its JSON-only run produced no report or log content, so test progress and the cause are unknown. Four later integration/package commands were not run. There is no local full-suite rerun or cause attribution. `local-status.json` preserves these limits and exact local receipt digests; this hosted run supplies fresh ordinary correctness evidence independently.

## Fixed source, toolchain and commands

The workflow checks out only its exact triggering proof commit and direct fixed-main parent, depth2, without tags or persisted credentials. The controller asserts that parent before archiving main. It applies the exact patch with -p1, verifies precisely the three changed paths and source hashes, and retains complete inventories of502 baseline and503 candidate source files.

Official Node22.16.0 is installed by pinned actions/setup-node and its executable SHA256 must equal `8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d`. Official Bun1.4.2 comes from the existing integrity-bearing npm lock with installation scripts disabled; its executable SHA256 must equal `a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c`. Only the toolchain package's descriptive name changes from the prior proof. Dependency versions, resolutions and integrity values remain fixed.

There are21 sequential commands, with these upper bounds:

- Locked npm dependencies180s; exact-main archive30s; exact candidate patch application30s.
- Baseline native build90s, portable build60s and declarations60s. No baseline test matrix runs. The unchanged native source is checked, and its generated WASM/WAT bytes are copied and checked for candidate use.
- Candidate portable build60s and declarations60s.
- Candidate configured main, Redux, typed-values, geometry, worker and inexact-optional-value type checks:60s each.
- Full Bun Vitest:300s, requiring exactly51 files and1,069 passing cases, no skips/todos/failures.
- Focused Node Vitest:60s, requiring the five unchanged reviewed files and78 passing cases, with one Vitest worker. The unsupported full-Node raw-TypeScript legacy worker suite is excluded.
- Existing portable Node worker45s, Redux30s, typed-JSON worker30s, ordinary real-worker task/lifecycle checks60s, packed-package consumer180s. The package script retains its actual local tarball install, Node/Bun/TypeScript consumers and packaged worker proof.

The source test inventory is sealed in `test-inventory.json`; per-test timeouts remain unchanged. Both Vitest commands use the supported verbose and JSON reporters, with a dedicated JSON output path. Human-readable per-test progress remains in command logs. The controller records command start/end plus15-second liveness/log-byte events, so a missing final report does not erase the observed stage. It does not change tests to obtain progress.

The existing Set hosted controller supplies the workflow and execution pattern. Screen/calibration code is absent. Each child has its own process group, bounded TERM/KILL cleanup and a durable receipt. A failed command, timeout, unexpected source/output change, remaining group, report mismatch or interruption stops all later work. No retries occur. Source inventories are checked before and after commands; baseline/candidate outputs are frozen after their declaration builds and verified thereafter.

The controller's whole preparation/execution budget remains1,500seconds; per-command maxima are also constrained by its remaining allowance. The existing35-minute job ceiling leaves time for cleanup and evidence upload. These are correctness budgets, not performance measurements.

## Publication and retained evidence

Only `proof/sorted-callback-correctness-20261014` triggers this workflow. It has one attempt1 job on Ubuntu24.04 with contents:read, an independent concurrency group and cancel-in-progress:false. Publishing the reviewed proof commit is the single bounded trigger. No default-branch workflow or existing source file is changed by the proof publication itself.

The artifact retains public inputs, workflow, the exact-main source archive, complete source inventories, runtime binary hashes, command progress/logs/receipts, both build/output inventories and emitted outputs, test reports and any terminal negative result. It excludes installed dependency trees, executable binaries, local raw logs/paths, environment dumps and unrelated host information. No local measurements are reused. The original local incomplete gate remains an incomplete result even if this fresh hosted gate passes.

Downstream consumers can bind `SOURCE-SHA256SUMS`, `baseline-build-v1/{plan,receipts,generated,result}.json`, `correctness-v1/{plan,receipts,final-generated,result}.json`, `executables.json` and the artifact-wide SHA256 inventory. Both plan.sourceFiles maps are relative to their own source root. Both generated-file JSON maps use relative paths with sha256/bytes. The retained main.tar and frozen patch permit independent source reconstruction. No downstream execution is authorized by this packet.

Exact-head ordinary repository CI and its docs/browser checks remain required before any later production PR promotion. No merge or release is part of this proof.
