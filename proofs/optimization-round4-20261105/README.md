# Optimization round 4: results and combined validation

## Outcome

No new performance PR was opened for this round. Several candidates made their intended workload substantially faster, but none cleared the complete control checks. Nine evidence archives below preserve the successful target measurements, slower controls, rejected variants, exact measured sources, validation logs and original data. No changes were merged.

Separately, the eight existing optimization PRs were combined in an isolated checkout. **All 25 planned validation commands passed, including 60 default unit-test files and 1,159 tests.** This is a correctness and package-compatibility result; it does not establish a combined speedup. No rejected round-4 runtime changes are included in this checkout.

## Representative before/after measurements

These are elapsed times from the final saved study for each candidate. Absolute times are medians across the separate baseline and candidate processes. Paired effects are calculated within each process pair and then combined geometrically; they need not equal the ratio of the two marginal medians. Lower times and ratios are better.

| Candidate and workload | Runtime | Baseline | Candidate | Why it was held back |
| --- | --- | ---: | ---: | --- |
| Lookup-first identical numeric writes, 1,024 calls at index 32,768 of a 65,537-element list | Node | 0.448398 ms | 0.083169 ms | Changed-tail control was slower in all 6 pairs; paired ratio 1.1238, 95% interval [0.9923, 1.2727]. Bun also had adverse changed-boolean and tail controls. |
| Compact a 131,073-element numeric list | Node | 3.876071 ms | 1.073285 ms | Boolean-list control ratio 1.2491 [0.8535, 1.8281], slower in 5/6 pairs; Bun numeric-queue control ratio 1.0800 [0.9952, 1.1721]. |
| Encode a 4,096-element numeric queue | Node | 0.554230 ms | 0.244242 ms | Bun JSON-queue control ratio 1.0699 [0.9952, 1.1502], slower in 5/6 pairs and in both execution orders. |
| Short Unicode-key numeric writes, 1,024 calls | Node | 0.650 ms | 0.354 ms | Bun's same workload changed from 0.275 to 0.315 ms; all six targeted Bun workloads were slower in both pilot pairs. |

The list lookup also improved the corresponding Bun target from **0.385215 to 0.047928 ms** per 1,024 calls. Its deep numeric no-op case reduced shared-storage allocation from **655,360 bytes to zero** per 1,024 calls, while still returning fresh JavaScript wrappers. The numeric compaction target improved on Bun from **4.025726 to 2.142195 ms**, and the queue-encoding target from **0.282754 to 0.089968 ms**. These target wins are real observations in the saved studies; they did not override the acceptance criteria for the controls.

The reported intervals are nominal paired 95% intervals from the individual studies, not simultaneous guarantees across the entire search. Several adverse control intervals include 1. That is unresolved uncertainty, not proof of a regression or proof of neutrality. The cause of slower controls whose source was unchanged was not established.

## Complete experiment archives

Each link contains the full matrix and reproduction instructions. Ratios in this table are candidate/baseline paired effects unless the linked report says otherwise. Pilot-only studies were stopped after their fixed screen; formal studies retained all of their scheduled pairs.

| Evidence archive | Main idea and useful result | Acceptance decision |
| --- | --- | --- |
| [Queue front cache](https://github.com/natanelia/zerocopy/blob/561130f572e6e819fa1ab52b400a902543ba766a/proofs/queue-front-cache-20261105/README.md) | Reuse the vector read cache for queue peeks; repeated peeks improved. | Alternating roots were about 41% slower on Node and 21% slower on Bun. Rejected after the pilot. |
| [Sorted journal merge](https://github.com/natanelia/zerocopy/blob/69e0c2328a558b5529d558ef49655d8094a7c53f/proofs/sorted-journal-merge-20261105/README.md) | Avoid a repeated comparison during journal/tree merging; long-prefix ratios 0.7802 on Node and 0.7061 on Bun. | Node ordinary scan 1.0573 [1.0069, 1.1103] and empty scan 1.1914 [1.0384, 1.3669]. Rejected. |
| [Broad heap view capture](https://github.com/natanelia/zerocopy/blob/ba069cae250e8d36eabd0bc616f3a4da015e7a5c/proofs/heap-single-view-20261105/README.md) | Capture a shared-memory view once while iterating a heap; several Node and generic-value targets improved. | Bun large numeric heap 1.1537 [0.9513, 1.3992], adverse in 4/6 pairs. Rejected. |
| [Scoped boolean/JSON heap view capture](https://github.com/natanelia/zerocopy/blob/ee57fdd76838bd4c9165d07528cd66540fc234d4/proofs/heap-generic-view-20261105/README.md) | Keep numeric/string loops unchanged; boolean ratios 0.5607/0.8760 and JSON 0.5413/0.9380 for Node/Bun. | Empty, singleton, ties or overflow controls regressed in the pilot. Rejected without confirmation. |
| [Primitive/large list compaction, V1–V3](https://github.com/natanelia/zerocopy/blob/bc55fa9e309dcc18dc8d40ae11fe44d36a42e0b9/proofs/primitive-compaction-20261105/README.md) | Use direct primitive scans and limit their dispatch scope; final large-list ratios 0.2714 on Node and 0.5396 on Bun. | Boolean-list and numeric-queue control effects remained unresolved. All five studies, including earlier variants, are retained. |
| [Portable numeric queue codec, V1–V3](https://github.com/natanelia/zerocopy/blob/44177a698b11debb021ae59f1e7a44bf5a042ae4/proofs/queue-portable-20261105/README.md) | Scan primitive storage directly when method/decoder guards permit it; final encoding ratios 0.4515 on Node and 0.3158 on Bun. | Bun JSON-queue control remained adverse. The initial method-reentry correctness failure, repaired variants, pilots and formal run are retained. |
| [Child-first no-op list writes](https://github.com/natanelia/zerocopy/blob/80fa39bafe5311b74acb8f1a1994c552aafa2897/proofs/list-set-noop-20261105/README.md) | Compare exact stored bits and propagate an unchanged child before allocating ancestors; all four no-op targets improved in all six pairs on both runtimes. | Node changed-number 1.1149 [0.9857, 1.2611], adverse in 6/6 pairs; other Bun controls also adverse. Rejected. |
| [Numeric Unicode-key scratch buffer](https://github.com/natanelia/zerocopy/blob/b3a6998df52b7fd47bc17a3fa839ccb0101b7068/proofs/numeric-key-scratch-20261105/README.md) | Reuse the existing ordinary UTF-8 write buffer for keys with a proven byte bound; all six Node targets improved in both pilot pairs. | All six Bun targets were slower in both pairs. No confirmation or further variant followed rejection. |
| [Lookup-first tree-only no-op list writes](https://github.com/natanelia/zerocopy/blob/c81fda059ef10e5503fedd21366b8ff1b9f331e3/proofs/list-set-lookup-20261105/README.md) | Check existing tree bits before the unchanged baseline copy path; numeric no-op ratios 0.1781 on Node and 0.1295 on Bun. | Node changed-tail 1.1238, adverse in 6/6 pairs; Bun changed-boolean 1.1827 [0.8919, 1.5683], adverse in 5/6 pairs. Final rejection; no more variants or timing runs in this round. |

The queue-front-cache and broad-heap branches retain experimental active source and tests for historical inspection. The other rejected branches restore active runtime/tests/CI to baseline and keep candidate files under their proof directories. None is an optimization PR or part of the combined runtime in this validation branch. In proof-only archives, historical test copies use `.test.ts.txt` so test discovery does not execute those candidates.

## Measurement scope and safeguards

The studies used Node **24.22.1** and Bun **1.4.2** on Linux x64, AMD EPYC 9V74, with timed workloads pinned to CPU 2. Baseline and candidate ran in fresh processes using portable builds. A shared machine lock prevented overlapping builds, tests and benchmarks from the cooperating workspaces. Source/build hashes, case definitions, checksums and allocation expectations were checked by each study's driver or audit.

Each study's plan records its warmup, calibration, repetitions and stop rules. The later confirmation matrices used six alternating-order process pairs per runtime/case. Pilot-only Unicode-key and scoped-heap results have two pairs per runtime/case and do not support confirmation-level claims. Short and capped batches are disclosed in their reports. We preserved unfavorable measurements and failed attempts; no selective replacement of the formal results was used to obtain an acceptance.

The reports include focused correctness and real-worker checks where completed. A rejected candidate's report explicitly distinguishes checks that ran from checks merely prepared. Independent audits recomputed the final reported data and checked saved source identities. Historical evidence verification reads archived source and data; it is not a requirement that future production source retain the historical hashes.

This round did not measure real browsers, ARM, production traffic or the combined eight-PR runtime. Results apply to the listed workloads and environments, not an application-wide speed guarantee.

## Combined validation of eight existing PRs

The [fixed plan](PLAN.md) lists the exact standalone published commits for [#50](https://github.com/natanelia/zerocopy/pull/50), [#51](https://github.com/natanelia/zerocopy/pull/51), [#53](https://github.com/natanelia/zerocopy/pull/53), [#54](https://github.com/natanelia/zerocopy/pull/54), [#55](https://github.com/natanelia/zerocopy/pull/55), [#56](https://github.com/natanelia/zerocopy/pull/56), [#57](https://github.com/natanelia/zerocopy/pull/57) and [#58](https://github.com/natanelia/zerocopy/pull/58). A final [GitHub readback](published-pr-snapshots.json) confirmed those same heads were still open and unmerged. Their individual performance claims remain attached to their own measured sources and PR reports. This branch is a reviewable validation checkout, not a request to merge those PRs as a batch.

| Validation group | Recorded result |
| --- | --- |
| WASM, portable browser bundle and declaration builds | Passed |
| Project, Redux, typed-values, geometry and worker type checks | Passed |
| Default Vitest suite | **60 files / 1,159 tests passed** |
| Actual Node worker lifecycle and affected collection proofs | Passed, including linked callbacks, ordered projections, TanStack values, list batches, map values, sorted callbacks, standard worker, Redux and typed JSON paths |
| Checkpoint correctness proof | Passed |
| Saved evidence verifiers | Block callbacks and sorted-map callbacks passed; this gate did not replay every earlier performance archive |
| Documentation tests and preservation | Passed; 72/72 historical rows preserved and zero historical evidence records changed |
| Installed package consumers | Node, Bun and TypeScript checks passed offline |

All **25 commands** returned exit code zero in the single recorded gate. The full commands, output, timings and identities are in [integration-manifest.json](integration-manifest.json) and [integration-validation.txt](integration-validation.txt), with a separate [saved-evidence audit](independent-audit.txt). The unit count excludes the additional proof and documentation tests in that log. Building the portable browser bundle is not a real-browser execution test.

Recorded validation ran from 2026-11-05 03:34:06 to 03:35:11 UTC on local commit `913550f53e57d541c71b0bdbf7050eda92da17a2`, tree `2f075eabda070b51538d5653b5f8433cbe353527`. That commit is local provenance and is not presumed fetchable from GitHub. Subsequent additions on this branch are the saved report and evidence only; the tested runtime is unchanged. The manifest records root TypeScript source hashes and portable/WASM output hashes. The original log SHA-256 is `e6dfb1ee27ae78ca81c4eb88b01ab5e7bab33e99ec7872e0e5014d9a14a69d54`.

## Reproduce or inspect

Check out this published validation revision to reproduce the combined source. For a rejected experiment, use its linked archive and source hashes; do not assume that a local measured commit ID is remotely fetchable.

The baseline has no committed dependency lockfile. The original run used the shared installed dependency tree and pinned direct versions. A fresh install can resolve different transitive dependencies; record that difference alongside any reproduction. Use the recorded Node and Bun versions, and preserve the clean tracked source state before invoking the runner.

```sh
bun install
python3 proofs/optimization-round4-20261105/verify.py
flock /tmp/zerocopy-perf.lock python3 proofs/optimization-round4-20261105/integration-gate.py "$PWD" /tmp/zerocopy-round4-validation-fresh
```

Use a new output directory for each validation. On the original shared machine, use `/workspace/scratch/83f1d4baba1f/perf.lock` instead of the illustrative `/tmp` lock so cooperating jobs share the same lock. Ensure the recorded Bun is on `PATH` and package dependencies are already installed; the runner uses `npm_config_offline=true` for its installed-package check. A lockfile created locally by installation was not part of the historical input and should not be represented as one.

The archive-only `verify.py` checks the saved report artifacts, original log hash, command outcomes and recorded test totals. It does not run benchmarks, rebuild the runtime or compare future live production files against historical source hashes.
