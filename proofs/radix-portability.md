# Prospective radix portability diagnostic

This is a new, narrow platform screen for PR 24. It contains no timing result.
It must not replace the earlier x64 study or turn correctness into a speed claim.

## Source and history

- Baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`.
- Candidate PR head: `cda6f639faab0ef627fb97ed199864fc4cc2468a`.
- Candidate production is byte-identical to measured runtime `c79c803bf7c59a2fc559e43ce7cc74aa4dacde15`. Only `Arena.radixLeaves` changes production against baseline: 7 added and 5 removed lines. The later head fixes a test-only Git-history dependency. Exact source, all emitted JS bundles, all 12 WASM files, and transitive compiler package hashes are checked.
- Reused radix proof: `ac7f07a139422bd2fd6e8637c2792c38ece9c4a3`, run [37875343311](https://github.com/natanelia/zerocopy/actions/runs/37875343311). The workload and Node/Bun subject files are unchanged. The statistical protocol has only two declared changes: 1.25 calibration-rate cushion and a platform-neutral outcome label.
- The earlier x64 study remains inconclusive as a whole: 15 statistically uncertain cells and one Node baseline-AA drift cell. Canonical 4096 radix full entries established lower latency by 14.596% on Node and 12.264% on Bun. Bun empty radix estimated +2.765% [0.708%, 4.864%], still unable to exclude a material loss. Its estimate and interval are not erased by this screen.
- The combined-HAMT empty-map regression is the reason for the ordinary empty-map control, even though the current candidate restores all HAMT production code.
- Published PR 23 proof `4640d663eeba989ebebf0623c779ecc447b2920f` and isolation `d016ba306375bb9e2146befa68efd112916f34b6` informed fresh-browser isolation and cleanup. No cancelled PR 23 auditor payload is included or repurposed; no PR 23 write is part of this work.

## Cases and platforms, fixed before timing

Exactly these three complete public operations run in every lane:

| Case | Reason |
| --- | --- |
| `map/radix/number/4096/canonical/entries` | Changed traversal, canonical numeric full entries |
| `map/hamt/number/0/canonical/entries` | Historical combined-HAMT regression control |
| `map/radix/number/0/canonical/entries` | Changed method, zero-root control |

The five lanes are Node 22.23.3 and Bun 1.4.2 on Ubuntu 24.04 ARM64, plus Chromium, Firefox and WebKit on Ubuntu 24.04 x64 through exact Playwright 1.63.0. The browser revision and executable hash are retained at execution. Default engine options remain intact. No custom JIT, GC, memory or shared-memory flags are admitted. No browser compaction or other catalogue work is added.

## Prerequisites and browser adaptation

Both exact source trees rebuild independently. Every output must match the published JS/WASM pins. Complete source files, test files, package inputs, compiler manifests, sources, bundles and the executing proof are retained. Normal exact-head CI remains separate; this scoped diagnostic does not claim a fresh full-suite pass.

Before any pilot, all three fixtures on both builds pass full content, order, retained-snapshot, key/value, terminal-value, shape, immutable-payload and zero-shared-allocation checks. Shared and copy workers then pass for each build, in separate subjects. The original checks preserve 18 structures, two interleaved iterators, reentrant reads, iterator return/throw, read-only rejection, nested reads, source bytes, explicit growth before first `next()`, and writer allocation/growth while the readers are paused. Each browser prerequisite uses a fresh browser process. Each worker prerequisite observes exactly one real browser worker and its closure.

The browser adapter reversibly replaces Node assertion/crypto imports with checked synchronous browser helpers; it leaves all fixture code and the exact timed core unchanged. Browser SHA-256 is checked against Node crypto over UTF-8, block boundaries, a large byte buffer and a shared-memory slice. The browser assertion helper covers the actual plain-object, array, number and typed-byte data used here; it is not a general Node assertion-library replacement. The worker adapter replaces transport APIs and selects one original copy mode. It does not replace any correctness assertion, size, memory-growth step or iteration. The timed operation stays one full public `entries()` traversal retaining the final entry. No checksum, serialization, hash or output assertion enters the timed boundary. If these adaptations cannot run faithfully on an engine, that lane fails; no substitute kernel is permitted.

A fresh Node/Bun process or fresh browser is used for every correctness subject, pilot and measured subject. Both builds are copied to the same real, nonsymlink neutral package path in the lane. Browser modules use the same loopback origin and `/subject/dist/shared.js` route. The local server sets COOP/COEP and no-store headers, serves only that subject package and the derived helpers, verifies served package bytes, and retains requested-file hashes. No comparison build is imported into a subject. Browser lifecycle code follows the published isolation architecture, with per-launch/page/evaluation/close deadlines and worker closure receipts. An outer process-group supervisor ends descendants and verifies no live process remains before another subject starts.

## Fixed experiment and inference

The published seeded case/pilot/quartet ordering is reused on this three-case subset. Each cell has two disposable pilots and four paired AB quartets plus four independent baseline-AA quartets. Two quartets per mode use ABBA and two BAAB; modes interleave. All six pilots and all three common work plans finish and are retained before any measured subject starts.

The calibration target is 40 ms and the warmup target is 500 ms. Common work uses the fastest observed post-warmup rate across both pilots, with a predeclared 1.25 multiplier, giving about 50 ms and at least 625 ms of planned work. Each measured process executes the same frozen repeat count and warmup operation count for its cell. It then records all 21 batches. Floors stay 10 ms for every measured batch and 150 ms for measured warmup. Caps, failures and floor misses are retained, never silently dropped or fixed by extra samples.

For each process use its median batch time divided by its repeat count. Form adjacent left/right latency ratios and average the two log ratios within each quartet. Four independent quartet means give a two-sided, pointwise 95% Student-t interval with df=3 and t=3.182446305284263. The loss margin is 2% (ratio 1.02). Lower interval bound above 1.02 means detected material loss; upper bound at or below 1.02 means evidence within the margin; otherwise it is inconclusive. Target upper bound below 1 establishes a gain only for that cell. No multiplicity adjustment is claimed.

AA drift means its geometric mean lies outside [1/1.02, 1.02] and its interval excludes 1. This invalidates matched AB inference. No AA drift does not prove equivalence. Correctness does not prove performance, and success for these three cells does not establish whole-catalogue or universal portability.

Counts: 3 cells, 6 pilots, 96 measured subjects, 2,016 measured batches and 24 quartets per lane; 15 cells, 30 pilots, 480 measured subjects, 10,080 batches and 120 quartets total. There are ten prerequisite subjects per lane, each with both sources represented; those are untimed.

## Boundaries, retention and execution

Preparation performs no local latency work and no local browser launch. Only deterministic protocol/adapter tests and one untimed pass of the selected fixtures use local sealed builds. The workflow accepts only the first unforced scoped push, from the exact candidate parent, with no retry. All cases and rules are in the prospective manifest before launch. Each lane has a 25-minute controller deadline, 5-minute build commands, 3-minute runtime subjects, bounded browser stages, process-group cleanup, and a 55-minute workflow deadline including setup. Failures retain partial commands, stdout/stderr, partial subject records, chronology and hashes. No study is overwritten.

The always-run archive step emits `radix-portability.tar.gz` plus SHA-256, including hidden files and all complete or partial evidence. Setup failures remain failures. A completed execution need not mean the diagnostic supports a performance claim; every row and its pointwise interval must be reported. The local manifest is for exact-tree independent review. The parent owns publication and any remote execution; this preparation performs neither.

The workflow uses `$RUNNER_TEMP` inside shell steps and `runner.temp` only in step `with` values. GitHub's [context availability rules](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability) do not allow `runner` in job-level `env`.
