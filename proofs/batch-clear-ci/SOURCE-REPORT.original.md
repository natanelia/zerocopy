# Batch count-only clear: source screen entry

The accepted source still changes one runtime operation: `batchAt` initializes 64 count bytes instead of its entire 256-byte private frame. There is no new performance result. The original full correctness suites remain failed: baseline 770/774 passed with four default-5000ms timeouts; candidate 758/774 passed with sixteen. This report does not transfer historical focused correctness into fresh full-gate admission.

## Exact source and fresh main check

- Historical baseline: `ad2a19d65a836985a2364b181bc9bd8dce6e42ad`.
- Independently reviewed original candidate: `2ee42fdac4020d637d9909db25297ba978b0aeaa`, tree `1ffe747c37174134f9e83f44edca844bdf447639`.
- Fresh read-only GitHub `main` lookup on 2026-10-09: `2e88bc4a53871476da9ca1ec4e6c374b61512436`, tree `11ad61e759f07f69fac6a5c6fa34ccb283a7563b`, sole parent ad2. The complete local tree diff deletes exactly `.kiro/steering/{product,structure,tech}.md`; no production, test, build or package input changes.
- New local current-main candidate: `48b9334788794a561f131c6619e5280748f32b08`, tree `601ec6bea713dd7b06783228c677f586267b8a25`, sole parent current main. It contains the original runtime and four-test file byte-for-byte. Its full-tree diff from the original candidate is exactly the same three document deletions.
- Isolated detached worktree: `/workspace/scratch/e7ec22ef2609/zerocopy-batch-clear-screen-prepare-20261009`. Separate preparation output: this directory. No remote ref, branch publication, PR, activation, install, build, full gate or operation clock was run.

`SOURCE-MANIFEST.json` records every tracked file's mode, Git blob, byte length and SHA-256 in all four complete trees. `source.patch` retains the exact integrated two-file patch. `live-main-read-receipt.json` retains the fresh connector result. The original evidence packet and all its failure logs remain untouched; every original listed file hash was verified and indexed in `HISTORICAL-EVIDENCE.json`.

## Source and contract audit

`batchAt` returns before frame access for count 0, count <=4 and shift >=32. A qualifying frame is `8192 + (shift/4)*256`, with eight disjoint depth ranges ending at 10240, below the heap at 65536. All sixteen count words `[0,64)` are read before increment and need clearing. All sixteen cursors `[128,192)` are unconditionally assigned before partition reads; later, each output-child word is stored before copying exactly `children*4`. The unused gaps are not read. Parent recursion and child recursion use different frames. Old roots, zero-input children and full-hash buckets preserve their established paths.

Public `SharedMap.setMany` calls `Arena.bulk`, which normalizes/deduplicates keys and constructs private input before synchronous `mapBatch`. Public compaction of unordered/ordered maps and sets also reaches `mapBatch`; sorted collections use `radixBuild` instead. The conservative reverse call graph lists sixteen possible exports, but valid scalar journal folds have <=4 leaves and therefore bypass this fill. An unchanged scalar control is still useful for contextualizing whole-package effects, not a claim that it directly exercises the edited instruction.

Read-only attachment, one allocating owner, immutable reachable published nodes, retained snapshots, and actual-worker transport are repository contracts. Private allocation scratch has no published zeroing guarantee. Imported shared memory is the only WASM import; there are no callbacks allowing WASM writer reentry. JavaScript serialization callbacks complete before the batch scratch pass. Different scratch bytes in a raw transport copy are permitted; published heap payloads and descriptors must remain equivalent. A retained payload digest must start at 65536, not include private scratch, and any future fixture must compare exact used heap bytes as well as logical values.

Read `CONTRIBUTING.md`, `docs/architecture.md`, the standard `ci.yml`, package scripts, builder, batch tests, relevant `Arena.bulk`, wrapper and compaction source. No checkout or ancestor `AGENTS.md` or relevant `.agents/skills` was present. Historical independent review found no implementation blocker, but it is not a fresh all-green correctness result.

## Existing emitted-code proof and limits

The original official optimized WAT differs in one operand only: function 19 `memory.fill` length 256 -> 64. Both core modules are 26,118 bytes with just two signed-LEB bytes changed. The eight legacy aliases match their core within each arm. Scalar numeric, SIMD numeric and geometry modules are unchanged. All twelve official modules, their 55 exports, sole imported-memory descriptor and build inputs are pinned in the original packet.

The original AssemblyScript version is 0.28.20 with the unmodified import/shared-memory, threads, stub-runtime and O3/shrink0 flags. Original Node is 22.23.3 and Bun is 1.4.2. Separate diagnostic instrumentation counts the target fill and is never a timing input. The 4096-number historical fixture executes 294 fills (75,264 versus 18,816 requested initialization byte positions); eight genuine FNV collisions exercise all eight frame depths. This is exactly 192 fewer requested byte positions per qualifying fill, 75% of that fill, with no demonstrated latency, retained heap, backing-buffer, RSS, physical-store or total bandwidth saving.

The original packet retains 800 differential scenarios and 24 actual worker executions, plus four regressions per source/runtime. It also retains the initial declaration-order failures and recovery, instrumenter import-order error and recovery, and initial missing Git author identity. No failed evidence is removed. The rejected-allocation fixture fails before `batchAt`, so it is not a mid-recursion trap recovery test. Five collection-compaction rows only record size/order; ordinary map rows also record roots/payload hashes. The Unicode regression's Map equality verifies normalization/last values, with order separately established by differential ordered-entry digests.

## Next review boundary

The prospective screen will stay Linux x64, Node/Bun, small and default-off. It must reuse the reviewed native/queue controller, math and CI adapter, with fresh exact-arm full gates before any calibration or measurement and a batch-specific replacement for the adapter's currently invalid “all WASM identical” guard. Source/build proof must instead establish the exact one-operand core change and unchanged other modules. Historical errors and original local timing instability from unrelated bulk work remain separate evidence. All held PR24/25, cache, ASCII and HAMT actions remain held.

No gain, correctness admission, publication, or activation is recommended by this source report alone.
