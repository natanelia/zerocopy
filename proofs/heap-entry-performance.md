# Heap entry view screen, attempt 1

Frozen baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`. Frozen runtime candidate: `4dea268e4c64acac832bb310efc83de597b27abc`, tree `6e180bc39a10866289816ba5aa6747b1adb18eae`. The runtime captures one per-node DataView inside `SharedPriorityQueue.entries`; runtime and tests stay frozen. Getter counts motivate the question but do not establish performance gains.

## Scope and prerequisites

One x64 runner runs Node 22.23.3 and Bun 1.4.2. Both complete standard Bun suites, WASM/portable/declaration builds, public type checks, installed-package checks and actual built-entry Node/Bun shared/copied worker proofs must pass before any pilot. A bare Node-source Vitest run is not required. The build helper retains source inputs, compiler identities, resolved dependencies/available lockfiles, all WASM bytes and complete emitted bundles. Benchmark-fixture checks use those exact built public entries in four fresh processes and compare full outputs, source bytes and descriptors across engines and arms.

Both comparison source snapshots are retained before dependency inspection or executable probes. Every external command writes immediate start metadata and streams raw stdout/stderr into separate files. A shared bounded runner uses an owned Linux process group, kills the whole group at its deadline or parent interruption, waits for the direct child, and verifies that no live non-zombie group members remain. Unverified cleanup stops the gate before any later child. Command deadlines are 30 seconds for metadata, 180 seconds for builds/package/worker proofs, 120 seconds for typechecks and every measurement subject, and 600 seconds for a complete standard test command. These bounds do not change any test assertion or test timeout. The combined CI step is capped at 65 minutes within the 90-minute job to reserve time for partial-evidence packaging/upload.

Sixteen predeclared workloads cover empty first-next and full completion, singleton full and first-yield-and-close, sizes 31/32/33/65, min/max heaps, ties/mixed priorities, and 1057/4097 numeric, boolean, string, object and nested-map decoding. Sizes 31/32/33/65 are workload controls, not heap layout boundaries. Each full consumption visits every yielded value and priority and folds them into observable count, value, priority and paired checksums. Early-return controls observe the first yield, `return()`, and completion. There is no creation-only generator-discard control. Expected checksums come from fixture input values/priorities rather than an earlier timed result.

Fixtures and untimed correctness checks stay outside timing. Distinct deterministic heap/nested arena IDs include the workload name, keeping nested descriptors and layout stable between processes. The built Snapshot.owner/Arena constructor is inspected only during fixture setup, without prototype patches. Full copied source bytes, byte lengths and descriptors are compared across pilots and measurement subjects.

Public reads naturally warm caches. The 1057-object/nested rows are warmed; the 4097-object/string rows exceed the arena's 2048-record cache and continue decoding uncached records. No cache is cleared or edited, and no row is described as cold. Instrumented mechanism/correctness proofs run in separate processes and never enter pilot or measurement processes.

## Isolation and fixed work

Each subject imports one immutable build in a fresh process at the exact same neutral absolute package path. Original package.json bytes and the entire emitted dist tree are copied, verified before execution, and verified afterward. The whole previous neutral package is removed, including hashed chunks. Both runtimes explicitly import dist/shared.js. Build and comparison-role labels are absent from the child request; the controller records them separately. Within each runtime, cwd, flags and environment are identical across arms and roles. There is no explicit GC; automatic GC remains part of normal public iterator consumption.

For each runtime/case, one disposable baseline pilot and one candidate pilot freeze common timed repeats and common warmup iteration counts. All 64 pilots across all cases and both runtimes must finish successfully before any measurement process starts. Calibration targets 40 ms per batch, using the fastest of three batches with a 25% cushion. Pilot warmup targets 500 ms. The common batch repeat is the maximum calibrated repeat; the common warmup work uses the fastest pilot milliseconds per iteration with a 25% cushion and rounds to whole batches.

Measured validity floors are 10 ms for every batch and 150 ms total warmup. Target misses remain visible above those floors. Caps, failures, floor misses, missing subjects and every invalid cell are retained. Each measured process performs exactly the same prescribed warmup work; one arm is never extended to satisfy a clock target. A measured floor miss invalidates that cell without recalibration or replacement. A pilot failure aborts the global measurement phase.

## Replication and inference

Each runtime/case has four AB quartets and four matched baseline-AA quartets. Each comparison has exactly two LRRL and two RLLR orientations, with seeded mode ordering inside four blocks. Left is baseline; right is candidate for AB and baseline for AA. There are 32 runtime/case cells, 64 pilots, 1,024 measurement processes (512 AB and 512 baseline-AA), and 21,504 measurement batches. Four benchmark-fixture processes and prerequisite proof processes are additional untimed work.

Every measured process has 21 batches. For each adjacent pair, compute log(right/left) from process median milliseconds per public consumption, retaining role direction when chronological order reverses. Average the two adjacent pair logs to form one quartet replicate. The four quartet effects, not 21 batches or eight adjacent pairs, define the two-sided 95% Student-t log-ratio interval with df=3 and t=3.182446305284263. Raw calibration, warmup, absolute timings, variances, environment metadata, full sequence order and failed-process stdout/stderr are retained.

AA drift means its geometric latency ratio is outside [1/1.02, 1.02] and its 95% interval excludes 1. Such a cell is inconclusive. AB is never adjusted by AA. There are no timing-driven retries, discarded outliers, selective case omissions, extra quartets or runtime-source tuning. These are exploratory per-cell intervals, not simultaneous confidence guarantees across 32 cells.

## Predeclared outcomes

- Incomplete or invalid cells, including AA drift, prevent a clear result. Every cell stays visible.
- A usable AB interval with lower bound above 1.02 is a material adverse result.
- Established target gains require a predeclared large full-consumption case whose AB upper bound is below 0.98 in each runtime.
- With those gains, all 32 AB upper bounds at or below 1.02 produce `strong-clear-requires-human-review`.
- With those gains and no material adverse interval, remaining usable intervals crossing 1.02 produce `scoped-review-required-inconclusive-cells`. Such a result may support a narrowly scoped draft after human review; its controls remain explicitly inconclusive. It is not strong clearance and does not justify extra measurements to chase noise.

The controller exits successfully only for strong clearance. Other outcomes preserve complete/partial evidence and remain reviewable. No outcome asserts universal, browser or ARM gains; no outcome automatically opens a PR or publishes code.

## Trigger and evidence

Only the parent may make the sole authorized nonforced push of the reviewed proof commit directly above 4dea on `perf/heap-entry-views-20261008`. The workflow has no dispatch trigger and skips reruns. Its final step packages complete or partial evidence into a tar.gz with SHA-256 even if preceding work failed. Preparation runs syntax, source, fixture and deterministic proof validation only; it does not collect local latency.
