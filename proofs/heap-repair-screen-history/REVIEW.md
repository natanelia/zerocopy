# PR25 dead-node slot repair: preparation receipt

The single runtime repair is ready for independent exact-source review. It is not a full correctness-gate pass or a Firefox performance result. No timing, calibration pilot, browser/shell launch, installation, push, PR body/state edit, merge or replacement run occurred.

## Immutable source

- Worktree: /workspace/scratch/e7ec22ef2609/zerocopy-heap-slot-repair-20261009
- Parent/public PR25 head: 994c0fc3929f64df6303739c79f71d45252350d9
- Local runtime-only commit: 4cc59aa8b0e68e61e8d53c09d356227f9e793aac
- Tree: 84c0f4135f3292bebf72100588aff432abefea45
- Only changed tracked path: shared-priority-queue.ts; six added and three removed lines
- Runtime source SHA-256: 91aaf57e239377e73befc7bddf16b845d78a66e475e1ef7fb576413e431c8c54

The source makes node mutable and uses that binding for the right child after its last parent-address use. Read order stays priority, value/decode, left, right; push order stays right, left; the yielded tuple and native lazy generator shape stay intact. The assignment RHS completes before node changes, preserving coercion and exception order. One existing per-node view is captured before decode, preserving the prior shared-view/reentrant-growth behavior. There is no empty special case, helper, delegation, transport or format change.

CONTRIBUTING.md, CI/test configuration and repository steering files were read. No AGENTS.md or applicable .agents skills were present in the checked workspace/repository paths. Existing heap-entry-views.test.ts already covers the relevant native generator, attachments, immutable snapshots, reentrant decode/growth and exception behavior. No redundant production test was added; the runtime commit contains only the repair. External review checks extend operation/throw observability without changing shipped code.

The tracked worktree matches the commit. Local untracked node_modules symlink and geometry-kernels.wat are build inputs/output only. Other worktrees and public state were untouched. runtime-repair.bundle, repair.patch and repair-source.tar retain the exact change.

## Exact builds and slots

All three source arms were freshly built using Node 22.23.3, Bun 1.4.2, TypeScript 5.9.3 and AssemblyScript 0.28.20. Both comparator arms' 12 JavaScript bundle hashes and all WASM hashes exactly match the audited portability pins; 41 additional declaration files were generated and retained. The repair's full dist output is retained in repair-dist/. Full source/build and toolchain manifests are source-build-manifest.json, compiler-manifests.json and local-runtime.json.

The repair entries() lives in dist/chunk-bbwazsv5.js, SHA-256 4e27b54ce87dd48e0351b88d876ad4e2441c86ab1f9f29eb85c5654dba87b95d. Its exact Function#toString method bytes hash to b384975fa5355ad1ffc5b4fa839b5508fd7d420eabca415cf42af0167c59a597. The canonical whole-dist manifest, including declarations, hashes to 6d59e4b0cf256de8eae34cb8f4399f05a83f88fe744413e12127dc4ef86b4805; the encoding is specified in the manifest.

Actual freshly imported full bundles, without method overlays, produce these Node 22/V8 12.4.254.21-node.57 observations (baseline/current/repair):

- Emitted lexical bindings: 7 / 8 / 7
- Bytecode registers: 15 / 16 / 15
- Bytecode frame bytes: 120 / 128 / 120
- Created-before-first-next parameters_and_registers array bytes: 136 / 144 / 136
- Generator object bytes: 160 / 160 / 160
- Bytecode lengths: 285 / 270 / 270

slot-observations.json, the emitted methods, bytecode logs and v8-created.heapsnapshot retain the observations and bindings to each source. V8 debug-print flags and heap snapshots were used only for untimed inspection. These are V8-only facts. Firefox 155 nfixed, nslots, actual allocation size/bucket and active JIT behavior remain unmeasured. The upstream SpiderMonkey mechanism remains a plausible causal route, not proof that it caused or fixed the historical 2.8264% loss.

## Verification outcomes

Passed:

- Fresh WASM, browser and declaration builds for baseline, current and repair
- Repair root, Redux, strict/loose typed-values, geometry and worker type-check targets
- Pinned Node 22 heap suites: 21 tests across heap-entry-views and shared-priority-queue
- Actual built-method observability: 1,752 assertions on Node 22.23.3 and 1,752 on Bun 1.4.2, including laziness, receivers, property/coercion/read/push/throw order and generator prototype behavior
- Six real Node worker checks, using the fresh full builds for each of three source arms × shared/copied transport; sizes 0, 33, 65 nested, 1,057 number and 4,097 string
- Independent retained-row comparison: current and repair rows and generator shape match exactly. Baseline and repair output/bytes/state/descriptors match; getter and refresh counts differ by exactly three per visited node, with decoder counts unchanged
- Built Node task, list-query, memory-startup, ordinary worker, Redux and typed-JSON worker checks

Retained aggregate failures:

- Prescribed Bun Vitest: 745 passed, 13 failed by the existing 5,000 ms timeout across geometry, numeric-spatial, performance-revision, typed-values and redux-checkpoint files; 36 files passed and five failed
- Extra direct Node 22 Vitest, already running when the parent requested no further broad runs: 749 passed, nine failed, all workers.test.ts cases that import raw TypeScript workers with unresolved extensionless arena imports; 40 files passed and one failed

No test timeout was raised and no failing suite was filtered or rerun. These aggregate outcomes are not claimed to be equivalent to a baseline/current result; those full suites were not run locally. Independent source builds occurred concurrently during parts of local verification, so these are correctness/observability records, never timing evidence. A prospective same-condition three-arm CI correctness gate must pass before timing. Detailed command arguments/results and complete logs are retained in validation.json, full-vitest-node22.json and built-verification.json.

## Focused prospective diagnostic

The active proposal is prospective-firefox-diagnostic.md, with deterministic schedule in prospective-plan.json. It includes only repair/baseline and repair/current for empty-next, number-1057-min and string-4097-min-ties. The original “8192” mention was explicitly corrected by the parent; no workload substitution was made. The initial three-contrast proposal is retained as superseded-three-contrast-* and is not active.

There are six pair/case cells, each with four AB and four independent matched same-byte AA quartets; 192 measured subjects and 4,032 retained batches. Nine common three-arm calibration pilots and 15 fresh correctness subjects make 216 planned browser launches. It retains the original 2% margin, 95% pointwise df=3 estimator, fixed work/floors, default Firefox 155 flags, fresh processes, no outlier removal, no retry/rerun/replacement, and the working audited transport/closure checks.

The proposal requires actual launched Firefox distribution provenance: full distribution manifest, native executable/loaded-library binding, real process-tree executable paths and launch argv, build IDs/version receipts, and unchanged pre/post hashes. A wrapper or executablePath checksum alone cannot satisfy the gate. Exact Firefox slot inspection, if supported, is separate and untimed; otherwise those values stay explicitly unmeasured and review must accept an effect-only screen.

This is a proposal and schedule, not an implemented/published timing runner or authorization to launch it. Independent review remains outstanding. The historical Firefox loss and other PR25 unresolved controls remain in force; a selected-case positive result would not clear broader platform integration or authorize a merge.
