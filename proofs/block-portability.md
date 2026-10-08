# Prospective block traversal portability screen

Status: preparation only. No latency pilots, measurements, browser launches or publication have occurred for this screen. The code and case selection are for independent review. The parent owns publication and the authorized run after signoff.

## Question and immutable source pair

Does the block-view reuse in PR23 retain its large primitive-scan benefit on ARM Node/Bun and on three x64 browser engines, without a detected material slowdown in a small set of structural controls?

- Baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`.
- Candidate: `da9b432cdf4028c62582455376f18657be65fdf8`.
- Proof-only starting tree: `d016ba306375bb9e2146befa68efd112916f34b6`.
- Production change remains only `Arena.blocks` in `arena.ts`.
- Historical source, generated WASM and emitted JavaScript hashes are copied into [the identity manifest](block-portability-identities.json) from the independent audit of the [d016 isolation artifact](https://github.com/natanelia/zerocopy/actions/runs/37848313615/artifacts/11581185806). That artifact has SHA256 `6743eea6153bdcf68f94c4b305701ed32a6de0e6ed6812164244245a1d2ab311`.

This is a bounded portability screen. It cannot establish universal equivalence, establish exactly zero overhead, clear unselected workloads, or authorize adoption. It makes no pooled estimate across CPUs, architectures or engines.

## History remains unchanged

The original x64 40-case study reported 1.86–2.20x Node and 1.46–1.54x Bun speedups in four large primitive scans. Eleven other results remain statistically uncertain. Three original Bun empty-array cases failed measured-duration requirements. Their successful, separate fixed-work supplement used a different CPU and does not replace the original flags.

The original combined Chromium job failed in a baseline worker's compaction arena allocation after its fixture checks; the candidate was not reached. A separate fresh-process study at d016 passed 40 fixtures and six workers per build, 92 checks in total. It does not explain or erase the combined-process failure. The new latency study uses fresh processes and does not investigate the memory-reservation cause.

Relevant evidence remains in [PR23](https://github.com/natanelia/zerocopy/pull/23), the [original study](https://github.com/natanelia/zerocopy/actions/runs/37831469272), the [supplement and original browser jobs](https://github.com/natanelia/zerocopy/actions/runs/37840231430), the [failed Chromium job](https://github.com/natanelia/zerocopy/actions/runs/37840231430/job/113528465037), and the [successful isolation job](https://github.com/natanelia/zerocopy/actions/runs/37848313615/job/113554653319). This proof adds separate evidence files; none of those records are edited.

## Cases selected before timing

All names refer to existing objects in `block-traversal-workloads.mjs`. Fixture functions, values, sizes, edit counts, timed operations and result consumption are unchanged. There is no new input family or cheaper replacement consumer.

| Existing case | Structural purpose | Lanes |
| --- | --- | --- |
| `linked/number/0/append/toArray` | Empty array result; one of the original flagged families | All five |
| `doubly/number/1/append/toArrayReverse` | Singleton reverse array, without blocks | All five |
| `linked/number/32/append/forEach` | Largest tail-only callback control | All five |
| `linked/number/33/append/forEach` | First full block plus one tail value | All five |
| `linked/number/4097/append/forEach` | Large primitive forward scan | All five |
| `doubly/boolean/4097/append/forEachReverse` | Large primitive reverse scan | All five |
| `doubly/number/4097/append/toArray` | Array materialization across many blocks | All five |
| `linked/object/1057/edited/forEach` | Sixteen interior edits and nested object decoding | All five |
| `linked/number/33/append/compact` | Small generic compaction, including a new arena | ARM Node/Bun |
| `doubly/object/4097/append/compact` | Large generic compaction with nested objects | ARM Node/Bun |

The browser screen intentionally has eight cases. The original compaction subject requires an explicit GC API. Firefox/WebKit pages have no portable equivalent. Browser compaction latency is unmeasured. This capability-based restriction is fixed before any timing; it is not an exclusion in response to results. No browser flags or replacement allocation benchmark are added to fill those cells.

The selected cases do not cover all six public scan methods at every size, all value families, or all four edited cases. Full 40-case correctness and six actual worker scenarios per source remain prerequisites in each browser lane.

## Platforms and fixed scope

- Node 22.23.3 and Bun 1.4.2 on Linux ARM64: ten cases each.
- Chromium, Firefox and WebKit from Playwright 1.63.0 on Linux x64: eight cases each. Save actual browser versions, user agents, hardware concurrency and controller versions. Record the path and SHA256 of Playwright's engine executable, or an explicit unavailable/error receipt. That executable may be a launcher; its hash does not pin every browser library.
- Default JIT on every lane. Node uses `--expose-gc` for the existing compaction policy; this is not a JIT setting. No engine-tuning flags or local browser sandbox workaround.
- Exactly one run attempt. A new CI run is not an authorized retry. Any later rerun would need a separately reviewed reason and must retain the first run.

Total planned coverage is 44 independent case/lane rows, 88 disposable pilots, 1,408 measured fresh-process subjects, 29,568 measured batches and 352 quartets. Each lane runs serially within its job. Parallel CI jobs are separate machines; their absolute measurements are never pooled.

## Prerequisites before any pilot

Both exact source commits live in detached worktrees outside the proof checkout. The baseline is also outside the candidate checkout, avoiding accidental test discovery. Runtime/dependency setup output, installed dependency tree and generated lockfile are archived. Source guards cover the 62 declared root source/configuration/direct build-script files; this does not claim independent pinning of every transitive build input.

For each build, the driver requires:

1. Independent WASM, browser JavaScript and declaration builds.
2. Main, value, Redux, geometry and public worker type configurations.
3. The standard full `bun run test` suite.
4. Packed-package consumer validation through `bun run check:package`.
5. Built Node worker task/lifecycle checks plus the actual Node worker, Redux and typed-JSON worker proofs.
6. The original block shared/copy/growth worker scenarios through Node and Bun.
7. The original deterministic block mechanism counts and all 40 original fixture checks.

The proof's original and new deterministic protocol suites also run. Each browser lane then executes all original 40 fixtures and six actual worker scenarios on both builds in 92 fresh processes, reusing the guarded d016 selector/observer and full original assertions. Firefox and WebKit use that same isolation protocol in this study. Each successful receipt includes all browser closures and actual worker closures. Failed correctness prevents all latency work in that lane.

Bare-Node Vitest is not used or claimed as a full-suite pass: it has nine known baseline legacy TypeScript worker-import failures. Full Bun coverage and the built Node worker proofs remain mandatory. No known-failure bypass converts a nonzero prerequisite into a pass.

Every prerequisite has an exact command/cwd identity, exit/signal/error status, raw log and SHA256 receipt. Missing, duplicate, reordered, substituted or nonzero receipts block preparation. The controller then requires exact historical source, 12 WASM and 12 emitted JavaScript identities for each build. An ARM emission difference is a blocker to review, not permission to silently accept changed code.

## Subject identity and calibration

For every A/B and A/A role, the complete `dist` directory and original package bytes are copied to the same neutral `subject/dist/shared.js` path. Source and package hashes are checked before and after a subject. Browser subjects use one common local origin and `/subject/dist/shared.js` URL with no role or variant in the request. Fresh browser processes have separate contexts and caches. All pilot and measured processes contain only one immutable build.

The adapter derives the entire original `measureSingle` function from its guarded source. Exact, reversible substitutions rename the function and separate the higher prospective calibration targets from the original measurement floors. Reversing substitutions reproduces the complete original function body. The entire `scan`, explicit-GC and `timed` closures remain byte-identical. A small portable assertion object implements only the original string/integer/boolean assertions used by this function.

Each case has one disposable pilot per build in a predeclared alternating source order. The existing calibration loop targets 40 ms, with its original 1.25 minimum-headroom rule and 1.5 growth rule, so successful pilot batches reach at least 50 ms. It samples three calibration batches per step, has at most 16 steps and retains the original repeat caps. Scans target 500 ms of pilot warmup; common measured scan warmup work uses the faster pilot with 1.25 headroom and at least the original 262,144-element work minimum. The 10-second warmup cap stays visible.

The common repeat is the larger of the two pilot repeats. Both builds and both A/A roles use exactly the same repeat and warmup work. All cases complete their pilot planning before any measured subject runs. The common plans are checkpointed before measurement, with both pilot records retained. There are no timing-based changes after that point.

ARM compaction preserves the original fixed 512 warmup calls, explicit GC outside timing every 32 warmup calls and before each measured batch, maximum 2,048 repeats, and automatic GC during timed allocation. It does not acquire a new 500/150 ms warmup requirement. The scan warmup floor remains 150 ms; every measured batch, including compaction, must reach 10 ms. Short batches, short scan warmups, repeat/warmup caps and missing warmup work are retained and invalidate interpretation, without reruns or extensions.

## Measured work and statistical rule

Each case/lane has four A/B quartets and four matched baseline A/A quartets, with exactly two ABBA and two BAAB orientations per mode. A fixed seeded schedule is recorded in the prospective manifest, independently of timings. Each measured process has 21 absolute batch durations. A/B means baseline versus candidate; A/A means two independently launched baseline roles.

The existing statistical helpers are reused unchanged. For each adjacent pair, use the median batch duration divided by the common repeat and form the right/left latency ratio. Average the two log ratios within each quartet. The four quartet means are the independent observations, not 21 samples or eight adjacent pairs. Report the geometric mean and pointwise two-sided 95% Student-t interval with three degrees of freedom and critical value 3.1824463053.

- Candidate/baseline latency ratio below one means faster.
- Interval lower bound above 1.02 detects material loss.
- Interval upper bound at or below 1.02 supports being within the declared margin.
- Otherwise the row remains statistically inconclusive.
- Matched A/A drift invalidates a row when its geometric mean is outside `[1/1.02, 1.02]` and its interval excludes one.
- Invalid A/A timing also invalidates its A/B interpretation. A/A is reported directly and never used to normalize A/B.

These are pointwise intervals, without a familywise error claim. A lane can finish collecting data while some or all rows remain inconclusive. The code does not turn completion into acceptance, merge eligibility or an adoption certificate. The eleven original uncertain results remain uncertain regardless of this screen.

Timed callback consumers count nonundefined values; array consumers use result lengths; compaction consumes result sizes. Full expected values and callback indices are checked outside timing by the original functions. The expected digest records those untimed reference checks; it is not a digest of every timed value. The original fixture retains a pre-edit item without separately asserting it in the browser fixture function; the full candidate regression suite supplies the separate retained/lazy/interleaving checks. Do not count these as new isolated-browser assertions.

## Evidence, failures and cleanup

Archive the reviewed prospective manifest, complete proof files, derived subject, immutable source/WASM bytes, full emitted packages, prerequisite logs/receipts, source comparison, actual versions and dependency setup. Each subject records CPU models, speeds and cumulative CPU time counters, system load and available memory before and after. These are observations of runner variation, not a CPU-affinity or frequency guarantee.

Preserve all pilot calibration samples, per-batch repeats, warmup batches, elapsed and wall durations, GC durations, raw measured samples and per-scan absolute summaries. Fresh native processes retain stdout, stderr, exit status, signal and exit observation. Fresh browser subjects retain launch/stage/close/disconnection receipts, console/page errors, browser versions and raw results. The next subject starts only after the preceding one completes its terminal cleanup.

Prerequisite, preparation, pilot, measured-subject and final verification failures retain incremental partial records. Timing stops on a subject error or failed cleanup, with no retry or replacement. All planned but unexecuted work remains visible in the frozen schedule. Duration-invalid but successfully completed subjects remain in the dataset and subsequent scheduled subjects continue. Browser correctness continues case failures when cleanup succeeded, then blocks timing; a failed close stops before another launch.

CI always uploads setup and partial evidence, including failed logs. Hard runner loss may prevent final cleanup or artifact upload; an absent terminal receipt is incomplete evidence, never an implied successful close. Original historical failure logs and results are referenced and preserved separately, not recreated or relabeled by this controller.

## Prepared entry points

The local `freeze` command only writes the prospective manifest; `verify` only checks it. Deterministic protocol tests use stand-ins, not actual browsers or timed workloads. `prepare` also performs no latency measurement but requires actual prerequisite receipts in the declared first-attempt CI context.

The [workflow](../.github/workflows/block-portability.yml) runs only on a non-forced push to `proof/block-traversal-portability-20261008`, on attempt one, whose previous SHA is exactly d016. Branch creation, deletion, force-pushes, other starting commits and retries are rejected in both workflow and execution guards. The parent can first create the branch at d016, then advance it once to the reviewed proof commit. This supported publication route builds and checks both commits, archives them, then runs the single frozen plan. It never modifies PR23 production code or publishes benchmark claims.
