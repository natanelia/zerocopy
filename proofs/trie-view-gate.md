# Frozen radix-only view capture: Node/Bun x64 gate

The published candidate is `c79c803bf7c59a2fc559e43ce7cc74aa4dacde15`, exact tree `b09e5938f1312a91c833b64122657254c8bc1de8`, with pinned main parent `3773c6e519c7c0958da13727ed1082f449f3ee25`. Only `Arena.radixLeaves` changes: the exact held method, seven additions and five deletions. HAMT `Arena.leaves` and every other production byte remain main. All nine candidate test/proof files are frozen too. The gate may add only its declared proof files in one direct child of the published runtime. It cannot edit the runtime, tests, existing proofs, package, compiler/test settings, or build inputs.

This is an adaptation of the reviewed and executed combined-trie gate, not a new benchmark. No local pilot or latency collection is authorized. Node 22.23.3 and Bun 1.4.2 run in separate clean Ubuntu 24.04 x64 jobs. Local deterministic checks use the available Node 24.19.0 and are not clean-CI acceptance.

## All 20 historical cases remain

The catalogue retains empty/singleton ordinary and naturally sorted numeric map entries (four); ordinary/sorted set values (four); HAMT collision-two and patched-32 entries (two); ordinary/sorted 4096-entry first-next-return (two); warmed existing-key get (two); canonical/patched HAMT and canonical/four-edit-journal radix full entries (four); and ordinary/sorted 4096-entry object-map keys (two).

Exactly three former HAMT targets become unchanged controls: canonical full entries, patched full entries, and object keys. There are now 17 controls and three radix targets. Every workload name, description, fixture, size, public operation, output oracle and operation body is retained. Tests reverse only these metadata substitutions and require the entire workload source hash to equal the prior gate. The full protocol module and timed subject module remain byte-identical to the reviewed prior gate. No favorable subset, changed benchmark work, JIT flags, layout search, empty-return special case, scratch tuning or adaptive rerun is introduced.

Unchanged HAMT source does not guarantee unchanged timing: emitted package context and engine decisions may still affect it. Empty radix entries, radix object keys and every formerly inconclusive cell remain required. The capture proof counts executed getters/refreshes and allocation expressions; it does not measure generator-frame size, retained JS heap or latency.

## Frozen timing and statistical rules

The configuration, seed, two modes and chronology are unchanged. Two disposable fresh-process pilots per case, one per build, warm for at least 500 ms and 1024 operations under 15-second and 100-million-operation caps. Post-warmup calibration has at most 16 steps and exactly three samples per step, targeting 40 ms. The final reported repeat must have actually been sampled. Any cap/floor failure invalidates the common plan, retaining partial evidence.

Common measured repeat is ceil(40 ms / fastest observed post-warmup milliseconds per operation across both builds). Warmup targets 500 ms at that rate, rounded up to complete common-repeat batches. Maximum repeat is 10 million and maximum warmup is 100 million operations. All 20 common plans and the seeded schedule freeze before the first measured process. No clamp, later rate update or post-result sample extension is permitted.

Each measured process runs exactly its prescribed common warmup work and 21 fixed-work batches. Actual batches must each reach 10 ms; actual warmup must reach 150 ms. There is no explicit GC, dropped batch or elapsed-driven extension. Any floor, cap, subject, integrity or completeness failure invalidates the cell while preserving its data. A floor flag does not change remaining work; a subject runtime failure ends that job with partial receipts.

Each case has four A/B quartets and four independent baseline A/A quartets, two ABBA and two BAAB per mode. The fixed seed interleaves modes. A process contributes its 21-batch median per-operation latency. The mean of two adjacent left/right pair log ratios forms one quartet replicate. The four independent quartet log ratios yield an exponentiated mean and pointwise two-sided 95% Student-t interval, df=3. Batches and adjacent pairs are not independent replicates. Each runtime has 640 measured subjects, 13,440 batches and 40 pilots.

The material-loss margin stays 2%: upper interval ≤1.02 means evidence within margin; lower >1.02 means detected material loss; otherwise inconclusive. Baseline A/A role drift requires its point estimate outside [1/1.02,1.02] and interval excluding 1. Drift invalidates the cell. Report absolute latency and A/A directly; never normalize A/B by A/A. Do not offset a control loss or inconclusive cell with target gains. All A/B cells must be valid and within margin before the screen can report that label; target gain additionally requires an upper interval below 1 for one of the three radix targets.

Intervals remain pointwise and unadjusted across 20 cells and two runtimes. Four quartets and hosted runners limit precision. No result-driven extra samples are authorized. This x64 screen cannot establish ARM or browser acceptance; those need separately reviewed evidence.

## Explicit prerequisite repair before pilots

The unsupported supplemental bare-Node source Vitest command is removed entirely from both the workflow and required receipt set. Excluding one source-worker file did not make that broader invocation reliable. Its failures stay historical failures; nothing is retrospectively relabeled as passing.

Every build must pass the unmodified full standard `bun run test` suite, WASM/browser/declaration builds, ordinary types, strict public worker-consumer types after declarations, typed-value types in both exact-optional modes, Redux/geometry types and installed-package checks. Supported Node coverage uses the built worker-task lifecycle suite, standard built worker, Redux and typed-JSON workers, installed Node package entrypoints, plus actual built Node and Bun trie workers over shared/copied transport and memory growth. No source assertion or timeout is weakened. All 40 declared prerequisite receipts must exit zero, including the candidate mechanism and deterministic protocol/source/workload/archive tests, before sealing or any pilot.

The unchanged worker consumer fixture resolves self-exports through generated declarations after `build:types`; that ordering is mandatory. Preserved pre-declaration diagnostics remain diagnostic history only and cannot substitute for a compiler pass. The receipt runner must log dependency installation before dependencies exist, so TypeScript AST parsing in the source guard loads lazily only during post-install source verification. A dependency-free synthetic install test checks this setup path.

The radix preparation's local full standard Bun run had 763 passes and five async timeouts. A bounded four-file recheck had 84 passes and six timeouts. The focused 139 tests and actual workers passed, but those results do not waive the clean-CI full-suite prerequisite. No broad local rerun or timeout change accompanies this gate.

## Source, invocation and output guards

The source guard pins c79's exact tree and parent, both whole arena files, both generator method bodies, all original production and validation inputs, the nine existing candidate proof/test files, four complete compiler-package manifests, all 12 WASM files and both complete 12-file emitted JS bundle sets. HAMT method hashes must be identical. Both source trees rebuild independently in CI and must reproduce these pins before pilots. Compiler and build/source manifests are checked again after measurements.

The sole trigger is a first, nonforced, noncreated, nondeleted push on `perf/radix-view-only-20261008` with event.before=c79, run attempt 1, event.after=the executing SHA, and exactly one proof commit directly on c79. The workflow has no dispatch or PR trigger. The controller validates the actual event JSON too; a new runtime, extra commit, forced update or rerun requires new reviewed authorization. The event is retained with source evidence. The old held combined `47402ad2ec2ac7226831a577e6e224c555710af8` arena must remain available for the unchanged candidate mechanism proof and is archived as a historical input.

Each timed subject uses the same physical neutral root, exact original package bytes, complete dist, helper paths, cwd and executable. One operation/build runs per fresh process; labels remain in the controller only. Compile cache is disabled and default JIT settings/randomness are unchanged. Before/after full file manifests, physical paths, commands, raw stdout/stderr, exit/signal/error, parsed data, output checksums, published-byte hashes and shared allocator positions are retained. A forced termination can lose in-memory sample arrays, but started attempts and available raw output are preserved and cannot validate as completed.

`if: always()` retains complete/partial build outputs. A separate always-run archive step packages all original evidence paths and bytes, including hidden paths, empty directories, colons and partial JSON, into `radix-view.tar.gz` plus its SHA-256 sidecar outside the evidence directory. Upload sends only those portable filenames. Repeated packaging refuses to replace existing output. Tests cover the archive's binary/hidden/colon/partial roundtrip, checksum and early-empty failure behavior. Raw directories are not handed to artifact upload.

## Preserved combined study and historical failures

The full independent combined-study audit is retained in `trie-view-combined-audit.md`, with identities and original archive hashes in `trie-view-history.json`. Run [37850139130](https://github.com/natanelia/zerocopy/actions/runs/37850139130), gate d7e0972, measured combined runtime 47402ad against main 3773c6e. Bun empty HAMT entries had +3.779% latency, pointwise 95% interval [+3.330%, +4.231%], 58.158→60.349 ns, with all four quartets adverse and valid floors/A/A. Six other cells were inconclusive. Canonical radix's 10.572% gain belongs to that combined runtime and is not evidence for c79. Its Node job failed at baseline/unit-node-compatible before pilots; there is no Node timing result.

Earlier run 37848382333 failed workflow validation before jobs. Run 37848932492 passed 753 full standard Bun tests but failed nine supplemental Node source-worker loader cases before pilots. These failures, the later Node worker-exit failure, local radix timeouts, older rejected scratch candidates and all original raw archives remain preserved. This new structural narrowing and protocol-scope repair do not erase their adverse evidence.

## Entrypoints and review boundary

- `node --test proofs/trie-view-*.node.mjs`: deterministic and untimed validation, including all 20 independent fixture oracles.
- `node proofs/trie-view-source.mjs sources|compare BASE_ROOT CANDIDATE_ROOT`: exact source/build/method/lineage guards.
- `node proofs/trie-view-gate.mjs prepare BASE_ROOT CANDIDATE_ROOT OUTPUT`: validate successful receipts and the approved first-push identity; freeze source, builds and protocol without timing.
- `node|bun proofs/trie-view-gate.mjs run OUTPUT`: first approved clean-CI run only; pilots and measured subjects once.
- `node|bun proofs/trie-view-gate.mjs verify OUTPUT`: require and recheck a complete declared-runtime record.

The parent owns publication and CI. This proof preparation does not itself publish, dispatch a workflow, collect local timings or open a PR.
