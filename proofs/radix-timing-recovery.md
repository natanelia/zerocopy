# Radix timing after sealed correctness

This proof-only adapter imports the successful correctness evidence from run [37873312900](https://github.com/natanelia/zerocopy/actions/runs/37873312900), commit `ce3a0ec38f156dd361a0e285dd602f937c082692`, tree `abed8dd6ecf9b9498fe10c45040a382273a2c67b`. It does not rebuild either runtime or repeat either full unit suite. The original failed run 37867002724 never reached timing; its Node geometry timeout, cancelled Bun candidate-unit process, original artifact identities and earlier adverse combined-study history remain preserved in the imported evidence.

## Exact admitted input

The sole admitted artifact is 11591645832. Its ZIP SHA-256 is `3f9966fd9e5265a539c9400eeb2a3c8dc38024822019c1ba441725cd68ace06b`; its inner tar SHA-256 is `b483b1a63f74e19040a4b552985921ea839e19738e36a22a4a7fdd49a82e0f4b`. No newer run, alternative artifact or successful subset may replace it. GitHub run/job metadata must identify the exact first successful correctness invocation and completed seal/upload steps.

The loader checks both hashes before extraction, binds every extracted file to the pinned tar, validates all 46 complete exact-command receipts and raw logs, pins all four archived source tars, and rechecks the full baseline/candidate source maps against Git. Both 12-WASM sets, both complete JavaScript bundle sets, every retained declaration, original package bytes, compiler-package digests and the matched two-file semantic overlay remain bound to this one artifact. The original prerequisite outcomes are 753/753 baseline tests, 768/768 candidate tests and 15/15 additional baseline semantic tests. They are imported as prior correctness evidence, not relabeled as new per-runtime test runs.

The physical timing package consists of the same original package bytes and complete dist bytes used by the original prospective gate. One unchanged subject and its unchanged workload/protocol helpers run in a fresh process under the same neutral physical root. Before/after complete file manifests, immutable payload and shared-allocation checks remain required. No alternate bundle, loader transform, wrapper around collection operations, rebuild, source-runtime flag or runtime change is admitted.

## Unchanged study

`trie-view-subject.mjs`, `trie-view-workloads.mjs`, `trie-view-protocol.mjs` and the original `trie-view-gate.mjs` stay byte-identical. The new adapter reuses the original package staging, physical receipts, complete record validation, plan calculations and statistical functions. Its asynchronous traversal of the frozen study retains the exact original chronology: all 40 two-build pilots, every common plan frozen, then 640 measured subjects and 13440 batches per runtime.

All 20 cells remain, including 17 controls and three radix targets. Four balanced ABBA/BAAB quartets per A/B and independent baseline A/A, 21 batches per process, 40 ms planning target, 500 ms warmup target, actual 10 ms/150 ms floors, caps, default JIT, seeded schedule, process medians, quartet log ratios, df=3 pointwise 95% intervals and the 2% loss margin are unchanged. A/A does not normalize A/B. No target gain offsets a control loss or inconclusive control. No case selection, sample extension, result-driven rerun or favorable runtime selection is added.

## Necessary supervision changes

The original 180000 ms whole-subject deadline remains unchanged. The existing bounded runner receives only optional separate stderr, environment and cancellation-signal inputs; its default prerequisite behavior remains the same. Subject stdout and stderr are written immediately to distinct exclusive raw files. Attempt and command checkpoints precede execution. Timeout, signal, malformed output, cleanup uncertainty or a changed file stops the stream and retains the failure; it never starts a replacement subject.

A prospective 45-minute controller deadline and SIGINT/SIGTERM handler cancel the current subject, preserve partial files/receipts and prevent another subject from starting. The controller also checks its wall deadline between synchronous phases. Each Linux child group is killed and checked for live members before control returns; zombies/dead entries are reported separately. Deliberately detached descendants escaping the group remain outside that guarantee. The unchanged subject does not spawn such descendants. GitHub's 50-minute timing-step and 60-minute job caps leave time for always-run evidence archiving/upload.

An uncatchable host/process loss can leave a started attempt incomplete, but its already-written raw files and checkpoints are retained when archive execution remains possible. A partial or failed record cannot validate as completed. Immutable input ZIP/tar, metadata, imported correctness evidence, all logs, frozen proof, all plans and every available subject output are included in the final portable archive.

## Invocation and verification

A single nonforced creation of `proof/radix-timing-recovery-20261009` at a direct proof child of ce3a0ec starts separate Node 22.23.3 and Bun 1.4.2 x64 jobs with fail-fast disabled. There is no dispatch or retry trigger. The loader and controller reject wrong lineage, changed proof files, untracked runtime configuration, wrong event/attempt, modified artifact data and local timing execution. Exactly six proof/workflow paths may change from the correctness commit; all runtime and original experimental files remain unchanged.

Before freezing, each job runs deterministic adapter/protocol/controller tests and the original untimed workload/oracle checks against the imported candidate bundle. These checks use invented durations for synthetic scheduling tests. They cannot authorize a real local pilot. The controller's final verifier recomputes the original complete-record checks plus bounded-child cleanup requirements and revalidates all imported bytes. Completion and statistical acceptance remain distinct: a completed study may still be invalid, inconclusive or adverse.
