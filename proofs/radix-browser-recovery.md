# Prospective browser-only radix recovery v1

This is a new prospective protocol for the same three PR 24 mechanism cells on Chromium, Firefox and WebKit. It contains no new timing result and cannot replace, repair or pool results with the original portability study. No ARM measurements are scheduled. The original proof files, manifest, workflow and source/statistical helpers remain byte-identical and independently verifiable.

## Prior study and bounded reason for recovery

The preserved original portability proof is `44b6b88f3773731438356b4826914be12040a6b4`, tree `0e4b88e044a350ba95324a590867b597c827ddd0`, prepared locally as `040dde8a3d65edecf1612cc03a45f5bc2039b87f`. Its run is [37881676434](https://github.com/natanelia/zerocopy/actions/runs/37881676434). Its browser failures remain failures. The independent ARM study remains governed by that original protocol and must be reported separately.

Chromium and WebKit passed all ten correctness prerequisites and recorded a successful first baseline empty-radix prewarm. The final retained batches were respectively 835,003 calls / 39.920 ms and 564,335 calls / 39.520 ms. Calibration then reset repeat to one, the clock returned zero, and the unchanged strict-positive-duration assertion rejected the pilot. There were no browser measured subjects. These observations motivate a new calibration start; they are not new pilot inputs or performance results for this protocol.

Firefox passed the worker assertions, but the browser transport's async terminate method resolves without waiting for Playwright's exact-worker close event. Browser disconnect can dispose that worker listener before the receipt arrives. A worker close emitted during browser teardown can sometimes be recorded, so terminal closure alone cannot prove that the controller waited before teardown.

## Exactly two behavioral changes

1. Register a close promise against each exact Playwright worker when the page reports its creation, before page navigation or workload execution. After the worker checks return, require exactly one registered worker and await its actual close event for at most 30 seconds before requesting browser close. Fixture, pilot and measurement subjects require zero workers. Retain a separate completed barrier receipt; a timeout fails even if a later teardown closes the worker. Browser close completion, browser disconnection, server closure and the unchanged outer process-group cleanup remain independently required. Missing or unexpected workers fail. There is no retry, substitute event, URL-only identity match, or inference that terminate implies closure.
2. In the browser-derived pilot only, replace the post-prewarm calibration reset `repeat = 1` with `repeat = prewarm.batches.at(-1).repeat`. Use the last retained batch's actual count, not the next speculative adapted count. This is the sole declared exception to the original whole-core-unchanged adapter assertion. The transformation is exactly reversible. An untimed derivation label identifies this new adapter. The original Node/Bun pilot is unchanged. Every retained prewarm batch and completed calibration sample remains present; any later zero, nonfinite duration, cap or error still fails without skipping, clamping or additional attempts.

The calibration probes observed under this protocol can differ from those under the original protocol. This is therefore a fresh frozen experiment, not a continuation or statistical rescue. Do not pool its pilots, common plans, measured subjects or intervals with the old browser attempt or ARM study.

## Unchanged execution and inference

The complete fixture is unchanged apart from the original browser assertion/crypto imports. The adapter independently checks byte identity and SHA-256 for the fixture execute closure, timedBatch, positiveDuration and runFixedMeasure. Reversing the declared edits reconstructs the entire original browser-derived subject. Worker correctness code and every assertion, source/bundle/compiler pin, API operation, memory-growth step, sink and immutable-memory guard are unchanged. No cancelled PR 23 auditor payload is included or used.

Baseline remains `3773c6e519c7c0958da13727ed1082f449f3ee25`; candidate remains `cda6f639faab0ef627fb97ed199864fc4cc2468a`, whose production matches `c79c803bf7c59a2fc559e43ce7cc74aa4dacde15`. Only the retained radix traversal view differs in production. The exact source, independently rebuilt JS and WASM outputs, and compiler hashes remain pinned by the original source proof.

Each engine runs the same canonical 4096-entry radix entries target, empty ordinary HAMT entries control, and empty radix entries control. All ten prerequisites finish before pilots. Six disposable pilots and all three common plans finish before any measurement. Original seeded case order, pilot order, four AB quartets plus four independent baseline-AA quartets, balanced ABBA/BAAB schedules, 21 batches per subject, and all summaries remain unchanged.

The 40 ms calibration target, 500 ms prewarm target, 1.25 common-work cushion, 10 ms measured-batch floor, 150 ms measured-warmup floor, all operation/time caps, and fixed common measured warmup/repeat counts are unchanged. Common work still uses the fastest retained post-prewarm rate across both builds. Intervals remain pointwise 95% Student-t with df=3, 2% loss margin and the same AA-drift invalidation. No multiplicity correction, equivalence, catalogue acceptance or universal portability is inferred.

Each lane has 3 cells, 6 pilots, 96 measured subjects, 2,016 measured batches and 24 quartets. Across exactly three browser lanes: 9 cells, 18 pilots, 288 measured subjects, 6,048 measured batches and 72 quartets, plus 30 untimed prerequisite subjects. All three use Ubuntu 24.04 x64, Node 22.23.3 as controller, Bun 1.4.2 for pinned builds and Playwright 1.63.0. Fresh browser processes, neutral source paths, default engine settings and same loopback URLs remain required.

## Execution and review boundary

The separately named workflow is `.github/workflows/radix-browser-recovery.yml`; its branch is `proof/radix-browser-recovery-20261009`. It admits only attempt 1 of an unforced non-created/non-deleted push from exact candidate `cda6f639faab0ef627fb97ed199864fc4cc2468a` to one direct prospective proof commit. The existing portability workflow does not match this branch. No ARM lane is present or accepted by the recovery controller. There is no workflow dispatch or automatic retry.

The new manifest binds every original input and its original manifest hash plus all recovery sources and this document. Both manifests are reverified before execution and each subject. Raw partial evidence, attempts, commands, setup receipts, browser stages and cleanup failures remain archived even when a lane fails. The existing archive helper retains its internal filename `radix-portability.tar.gz`; recovery directories and artifact names are distinct. No prior result or archive is overwritten.

Preparation permits deterministic invented-duration tests, fake worker events and source/manifest checks only. It launches no browser, performs no latency measurement and publishes nothing. Local proof preparation is separate from the later single-commit publication onto the candidate parent. Independent review of the exact prospective tree is required before that publication. The tests include the unchanged original suite and recovery-specific regression cases; a passing fake-event test does not establish real Firefox recovery or browser performance. Those remain prospective clean-CI questions.
