# Empty-prefix guard: focused correctness result

**Passed the authorized narrow gate:** the exact v2 regression file passed all eight cases once on both current-main and guarded sources, under both Bun 1.4.2 and Node 22.16.0. Four commands completed with exit status 0, for 32 case executions. None failed, skipped or remained pending.

This result is limited to the new focused regressions. It is not full-suite clearance, a performance result or permission to publish. No benchmark, native build, portable build, package install or external action was performed.

## Inputs and invocation

The source-review v2 packet remains unchanged, with patch SHA-256 `77f05fa906d9ccfc6d0afdaebc04cf181f3a7dea23d8b88b82c2a9d11a6077bb` and pins SHA-256 `acecd28397fc87fd661ba2df4c68b7f56ec384a1bce972ba45c17ac3bc8fd98c`.

Separate gate copies are `baseline/` and `candidate/` under this directory. Both have the exact v2 regression file, SHA-256 `51e3850277791fc7b6308c2467039e789445dabd55ce74179434bb3f3d65b1dd`. Both source inventories contain 503 files. Their sole difference is `arena.ts`; all other source bytes, including the focused test and existing Vitest configuration, match. The original baseline, v1 candidate, v2 candidate and both source-review packets were verified unchanged before and after each command.

The existing locked toolchain was linked into each gate copy. Executable authentication checked the exact file path, file size, SHA-256, version output and runtime-reported `process.execPath`:

- Node v22.16.0: SHA-256 `8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d`.
- Bun 1.4.2: SHA-256 `a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c`.

Commands ran sequentially: baseline Bun, baseline Node, candidate Bun, candidate Node. Each invoked the existing `node_modules/vitest/vitest.mjs run map-empty-prefix.test.ts --maxWorkers=1 --reporter=json --outputFile=...`, using the pinned executable; Bun additionally used `--bun`. Exact absolute argv, working directories and report destinations are in `command-plan.json` and `command-receipts.json`. No custom loader or ad hoc transpiler was introduced.

## Native artifact provenance

Both arms received the same 12 native WASM files from the authenticated **baseline** output of successful run `38641407273`, attempt 1, artifact `11931130743`. Its source commit is `d59e3f157c19e051088c1f8996972dce9aa5bb34`, whose sole parent is current-main commit `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.

The retained generated manifest agrees with the baseline build manifest and the successful correctness run's final baseline manifest. Each copied WASM file was checked against both that generated manifest and the authenticated artifact manifest, SHA-256 `26aacc2a43f22bfc6f7d6c3bf91f556424ff17fc1fb40de7138ca39e571899eb`. All 17 native build/source input files are identical between main, the retained baseline inventory and this JS-only candidate. `persistent-core.wasm` has SHA-256 `08b1e91c9ee6d3602c0a100f449f51555ee35e5641e1839b7f719d016c209d90` in both arms. No bulk-candidate native output or prebuilt portable JS bundle was used.

An initial preparation assertion expected complete equality between the retained hosted source inventory and current main. It stopped before gate materialization or test execution because the hosted run had its known augmented `bulk-input-storage.test.ts` overlay. The original failure is preserved in `PREPARATION-FAILURE.json`. After the parent confirmed provenance, the assertion was corrected to permit exactly that one recorded test-only difference:

- Hosted test: `b2f494be15095fe9cb135cbfe0c82b4896978afdec536416a61a8116e36e003f`.
- Current-main test: `870b94f13cf73d199b3ef0b6b801e7648ae7b981176d0ab5094e7085640b8285`.

The other 501 source paths matched, including every native input. The hosted overlay was **not** copied into this gate; both arms retain current-main test bytes plus the v2 focused test. No test invocation was retried, and neither the candidate runtime nor its focused tests were changed during the gate.

## Bounds, cleanup and evidence

Each test command had a 60-second wall limit and a 1 GiB sampled RSS threshold. Memory checks used `/proc` group RSS and process high-water observations; this is a sampled guard, not a hard cgroup memory cap. All four commands stayed within the guards. Recorded durations and memory readings are operational limit receipts only, not comparative measurements or performance evidence.

Process ownership used `waitid(WNOWAIT)` to retain the original leader until descendant inspection/cleanup finished. All four commands had no remaining descendants and required no cleanup signals. Only then was each leader reaped; no numeric group was signaled after reap. Source, native and executable hashes remained unchanged after every command.

Durable evidence is retained in:

- `PREPARATION.json`, `PREPARATION-FAILURE.json`, `native-inputs.json`, `native-artifacts.json`, `executables.json` and `provenance/`.
- `command-plan.json`, `command-receipts.json`, `result.json`, `reports/` and `logs/`.
- `baseline-sources.json` and `candidate-sources.json`.
- `GATE-SEAL.json` and `PACKET-SHA256SUMS`.

Historical HAMT/Unicode overlap limitations and all unrelated holds remain unchanged. Broader ordinary correctness work requires its own authorized gate; no timing or publication follows from this result.
