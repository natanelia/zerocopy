# Block reuse timing recovery: unchanged correctness-first allocation and latency screen

This separately named timing recovery is prepared for independent review; no recovery benchmark timing or full package suite has run locally. Baseline is current main `ad2a19d65a836985a2364b181bc9bd8dce6e42ad`. Runtime candidate is `5df600e139666c28d338800a8d5d79270a284af9`, tree `0dde0756fa4a71aa82112b2d0e52b722f12082af`, directly above that baseline. Only `persistent-core.as.ts` and `block-rotation.test.ts` changed in the runtime candidate. New allocation addresses/frontiers and later allocation failure are intentional. All pre-call published bytes, snapshots, tree contents and format remain immutable.

The candidate reuses unpublished 24-byte block nodes consumed by insertion rotations. This screen can justify scoped memory review without requiring a latency gain. It cannot establish universal no-regression, an aggregate speedup, browser/ARM behavior, end-to-end application latency, JS heap reduction, or isolated RSS savings. No memory-chart measurement is included; refresh the existing comparable chart only if a memory PR proceeds.

## Recovery scope and retained failures

The unchanged original screen was published as [`2a30684146787fd37490da3dd09488f917dcb14d`](https://github.com/natanelia/zerocopy/commit/2a30684146787fd37490da3dd09488f917dcb14d), tree `7146d3dc8833c5393db8ca1d16bfc2d1516023aa`. [Run 37889652642](https://github.com/natanelia/zerocopy/actions/runs/37889652642) completed all 774 baseline tests but timed out after 600 seconds with 781 candidate tests logged and `worker-tasks.test.ts` incomplete. No pilot or measurement ran. That outcome remains failed/incomplete and is not replaced by this recovery.

A separate instrumented diagnostic first failed its source guard in [run 37893809463](https://github.com/natanelia/zerocopy/actions/runs/37893809463), proof `6d50fa9402b7828f78bbe8c9bd1295a17b522a5a`, before either full suite: the guard mistakenly allowed only baseline bundle names for the candidate. The guarded diagnostic recovery [`bcef042ee2bf63bb500193641a790e7b7428965e`](https://github.com/natanelia/zerocopy/commit/bcef042ee2bf63bb500193641a790e7b7428965e), [run 37894975503](https://github.com/natanelia/zerocopy/actions/runs/37894975503), independently passed baseline 774 and candidate 784 tests with separate fresh caches and observers. Its controlled pass does not prove why the original run hung or waive fresh standard correctness. Shared result-cache scheduling is a confirmed confound; the historical cause remains unknown. Exact archive hashes and all three outcomes are retained in `block-reuse-build-pins.json`; no historical artifact is edited or pooled.

Only prerequisite, identity and activation/retention wiring changes from the original screen:

1. A plain config wrapper imports each unchanged `vitest.config.ts` and overrides only its physical `cacheDir`. Both dedicated cache roots are absent before creation, empty with equal inventory hashes, physically distinct, checked again immediately before their respective suites, and fully retained afterward. The original `bun run test` script receives only `--config <wrapper>`. Original four-thread pool, minimum one worker, isolation false, file parallelism, discovery, 5000 ms test and 1000 ms teardown settings remain unchanged. There is no custom runner, reporter, sequencer, trace, or process observer in these suites. Default stdout and the arm's own results cache must show all 41/42 modules and 774/784 tests passed. Failure stops the prerequisite gate and prevents every pilot.
2. Frozen original-run lock, executable/compiler identities, all twelve WASM files and all 53 portable/declaration files per arm are checked. The source guard hashes every tracked file and accepts generated paths only from that exact arm's runtime pin. Unknown refs, wrong-arm unique chunks, unknown files, symlinks and modified build bytes are rejected. Fresh standard WASM/portable/declaration, full tests, types, installed-package, clock-free fixture and cross-version worker gates all remain required under the original per-command deadlines.
3. The recovery uses only a nonforced creation push to `proof/block-reuse-timing-recovery-20261009`, run attempt 1, one parent equal to the unchanged runtime candidate, and exactly one `Reviewed-Tree: <actual tree>` commit trailer. The reviewer and publisher must independently verify that trailer matches their reviewed tree; the trailer is an identity link, not proof that review occurred. No dispatch or rerun path exists. Recreating the branch could still create another first-attempt run, so the one-recovery rule also requires operational discipline.
4. Setup and retention are explicitly bounded outside the unchanged 65-minute scientific step: checkout/Node/Bun setup 3 minutes each, locked install and baseline worktree 5 minutes, deterministic protocol checks 2 minutes, archive/checksum 5 minutes, upload 5 minutes. These caps total 91 minutes inside a 100-minute job, leaving nine minutes unallocated. The subject/build/test/type/package/worker deadlines and all scientific work, warmup, pilots, schedule, statistical rules and budgets remain unchanged. Full or partial evidence has an inner complete-file SHA-256 manifest plus a separately hashed archive and distinct artifact name `block-reuse-timing-recovery-attempt1-x64`.

The original command supervisor, nine workloads, allocation pins, subject loops, raw observations, calibration, schedule, statistics, worker checks and fourteen original protocol fixtures are byte-identical. No platform, workload, repetition, exclusion, repair or retry is added. Preparation runs only deterministic harness and source/build replay checks, not builds, full suites, workers, timing, or browsers.

## Original screen provenance and changes from the audited heap screen

The timing/controller mechanics derive from heap screen `b52aefded8b724e21cd7ddd2713836689ddee299`, tree `1e742055d4da30a7bf29cc7653f78018db96c0e0`, run 37878315068. Local `96d7e4e2772455f5ac612bb785db587360796ccd` has exactly that tree. Its separate original pilot-cap failure remains historical and is not pooled with this screen.

The deliberate changes are:

1. Freeze current-main/block-reuse runtime identities, core source/WASM SHA-256 values, exact compiler versions and new proof-only branch. The original block screen was attempt 1, unrelated to heap attempt numbering; the recovery is separately named and retains its failure.
2. Replace ten heap cases with nine distinct numeric public sequence cases below. Counts fall from 20 to 18 cells, 40 to 36 pilots, 640 to 576 measured processes, and 13,440 to 12,096 measured batches. No equivalent duplicate linked-list wrapper is added.
3. Replace independent heap allocation-log fixtures with empty/small public fixtures or the unchanged `blockBuild` balanced fixture. Both arms have identical starting bytes, pointers, used frontier and backing capacity. Full JS-array semantic oracles, AVL shape/count/height checks and old-byte checks validate the new paths.
4. Replace the heap allocation oracle with frozen, clock-free equal-work allocation observations for 1, 2, 3 and 17 iterations, generated before timing from the pinned builds. The first/subsequent equation is checked on every batch and by the controller against the exact source arm. This is a regression/accounting oracle, not independent proof of the allocator. The separately reviewed candidate differential/ownership proofs remain the independent correctness evidence. No allocation measurement adjusts workload size or timing thresholds.
5. Replace heap-specific WASM binary-equivalence tests with exact reviewed core source/WASM pins and logical/shape fixtures; new addresses and used frontiers intentionally differ. Preserve the complete standard repository tests and all other build/type/package gates. Extend actual worker checks to both writer and reader versions, shared/copied transport, linked/doubly histories, concurrent writes and growth.
6. Replace a mandatory speed gain in each runtime with verified deterministic allocation savings in every declared target. Material latency loss blocks acceptance. Missing/invalid/drifting cells block clearance, and intervals crossing the 2% upper margin remain explicitly inconclusive.
7. Add exact compiler version checks and end-of-gate compiler/dependency rechecks. Preserve common dependency resolution, full source/dist/WASM/lockfile/manifests, neutral import path, per-command logs, process-group cleanup, and partial JSONL receipts.

All other timing rules below retain the audited design. The command helper's behavior is unchanged apart from proof names/provenance. No warmup, sample floor, confidence level, quartet count, exclusions, repair, or retry rule is relaxed.

## Nine frozen workloads and deterministic accounting

Every operation uses numeric values. One iteration means the complete listed history, always starting from the same retained snapshot. Values, ranks, initial bytes and expected results are hashed. The rank schedule is fixed before timing.

| Row | Public work per iteration | Purpose | New used bytes, baseline → candidate |
|---|---|---|---:|
| linked-append-8192 | SharedLinkedList.append 8,192 times from empty | Target: repeated right-side block rotations during normal append history | 120,424 → 114,496 |
| linked-prepend-256 | SharedLinkedList.prepend 256 times from 4,096 items | Target: left-side insertion/splitting into a balanced tree | 98,688 → 98,112 |
| doubly-mixed-insert-256 | SharedDoublyLinkedList.insertBefore 256 fixed distributed ranks from 4,096 items | Target: indexed insertion across both sides and full blocks | 96,304 → 96,256 |
| vector-list-push-4096 | SharedList.push 4,096 times from empty | Control: unchanged vector list append | 61,312 → 61,312 |
| vector-queue-enqueue-4096 | SharedQueue.enqueue 4,096 times from empty | Control: unchanged vector queue append and queue metadata | 61,312 → 61,312 |
| linked-singleton-tail-append | SharedLinkedList.append once from a singleton | Control: small tail path, no block rotation | First 8, later 16 → identical |
| linked-first-block-append | SharedLinkedList.append once from a full 32-value tail | Control: changed blockAppend entry without rotation | 32 → 32 |
| doubly-delete-256 | SharedDoublyLinkedList.removeFirst 256 times from 4,096 items | Control: unchanged block deletion, block collapse and rebalance | 38,280 → 38,280 |
| linked-indexed-read-4096 | SharedLinkedList.get at a fixed permutation of all 4,096 ranks | Control: unchanged indexed block read | 0 → 0 |

SharedList and SharedQueue use vector kernels and are not changed targets. The distributed insertion row saves only 48 bytes per history; it stays in the screen as representative limited-benefit work. No favorable post-timing workload substitution is allowed.

Used bytes, final backing bytes/pages, growth pages and process-memory observations are recorded separately. Equal operations are compared; arena savings are not converted into RSS claims. Frozen allocation observations and fixture hashes live in `block-reuse-allocation-pins.json`. Fixture/header cost is excluded from the table but included in every memory bound.

## Complete correctness barrier

One x64 Linux CI job pins Node 22.23.3, Bun 1.4.2, AssemblyScript 0.28.20, Binaryen 131.0.0-nightly.20260721, TypeScript 5.9.3, bun-types 1.4.2 and Vitest 4.1.11. The complete baseline and candidate standard Bun suites must pass unchanged, together with WASM, portable and declaration builds, general/public/Redux/geometry/worker type checks and installed-package checks. Test timeouts/assertions are unchanged. Full suites have not been run as part of local preparation and cannot be replaced by focused results.

The candidate core source SHA-256 is `1db06a5158579fbdc5290b3f3e54dcb74245545bd283fb11b0408cf6c7062fae`; baseline is `85662fce0e95deef920c8fd52789b11657f0b5d7f00b9f195873c38bc99bfd6a`. Rebuilt candidate core WASM must equal `1ef16c4ef0e193d4b2b4aa128abcc8fab959c55871a1be0e3fa0daed814155aa`; baseline must equal `b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4`. Every legacy core alias must match its arm. Unrelated numeric/geometry kernels and all public declarations must be byte-identical across arms.

Clock-free fixtures run on both built entries under both runtimes. Actual workers run 8 cases per runtime: two writers × two readers × shared/copied transport. Twelve linked/doubly snapshots per case remain readable while owners perform 4,096 appends and 512 indexed writes, force growth, and send a new snapshot. Old published payloads and old reader frontiers are checked. These workers are correctness-only, outside benchmark processes.

The controller accepts only a proof-only commit directly above the frozen runtime candidate. Both source snapshots and complete builds are retained. Each measured child receives an absolute identical neutral `dist/shared.js` path; its package and entire dist tree are replaced verbatim and checked before/after each process. Comparison labels are absent from requests. Source/compiler/build changes fail the gate. All full prerequisites and four fresh-process fixture checks precede every pilot; all 36 pilots must pass before any measured process starts.

## Work, arena and time bounds

Every timed batch creates one fresh arena and starting snapshot outside its timer. Repeated histories fork from the fixed original snapshot within that arena. The initial used frontier, backing capacity, operation count and inputs match across arms. Cumulative allocation therefore cannot turn one arm's iterations into a different amount of work. Natural page growth stays inside the timed public operation. No preallocated array of arenas, timer per public operation, explicit GC, serialization, correctness checks or hidden drain occurs inside mutation timing. The read row consumes every get result into a scalar checksum. First, midpoint and final snapshots escape and are verified outside timing, including AVL metadata and old published bytes.

Hard caps remain 64 MiB used and backing capacity per arena, 10,000,000 timed iterations, 1 GiB cumulative worst-case warmup bytes and 256 fresh warmup batches. Positive-allocation warmup work is floor((1 GiB − 256 × initialUsedBytes) / worstBytesPerIteration); reads retain 10,000,000 iterations. Worst per-iteration bytes are the maximum of the frozen first/subsequent costs in either arm. Finite repeat limits use the baseline-safe byte budget and are identical across arms. The first singleton append's 8-byte frontier extension is represented separately from later 16-byte forks.

Disposable pilots start with up to 65,536 public operations, adapt warmup batches toward 40 ms within fixed limits, and calibrate from the last warmup batch. Three calibration batches use their fastest duration to reach 50 ms (40 ms plus 25% cushion). Only a memory-derived repeat ceiling permits a lower target, and all final three samples must still be at least 20 ms. Any other cap/floor failure rejects the pilot. No rejected outcome is repaired by extending work or replacing a process.

Both arms use the larger calibrated repeat and the same whole-batch warmup work derived from the faster pilot (500 ms target plus 25% cushion). Measured floors remain 10 ms per batch and 150 ms of timed warmup. Actual 40 ms/500 ms target misses remain recorded. A measured floor miss invalidates the cell without extra work or replacement.

Nine rows × two runtimes yield 18 cells. Each cell has 4 AB and 4 matched baseline-AA quartets, each mode balanced as two LRRL and two RLLR; the modes interleave in four seeded blocks. There are 4 untimed fixture processes, 36 disposable pilots and 576 measured processes (288 AB and 288 AA; 432 baseline and 144 candidate builds), each with 21 measured batches, totaling 12,096 measured batches. One row across both runtimes owns 64 measured processes and 1,344 batches.

At nominal 50 ms batches and 625 ms warmup, raw measured work is roughly 16 minutes overall, or 1.8 minutes per row across both runtimes. This is a planning estimate from fixed targets, not locally measured speed. Process startup, fresh setup, validation, pilots and full correctness add time. The main step retains a 65-minute wall cap inside a 100-minute recovery job, with the separately bounded setup and retention reserve above. Individual metadata/build/test/type/package/worker/subject caps are 30/180/600/120/180/180/120 seconds; a failed command preserves its evidence and owned process group cleanup before proceeding. No local benchmark is allowed.

## Inference and decisions

Latency ratio is candidate/baseline, preserving right/left role direction even when chronology reverses. Each process contributes median batch ms divided by prescribed repeats. Two adjacent pair log ratios are averaged within a quartet. The four quartet effects, not batches or adjacent pairs, form a pointwise two-sided 95% Student-t log interval: df=3, critical value 3.182446305284263. All raw batches, ordering, calibration, warmup, allocation and environment records persist. These are exploratory pointwise intervals from one host, not simultaneous guarantees.

AA drift requires its geometric ratio outside [1/1.02, 1.02] and its interval excluding 1. It invalidates the cell; it is never subtracted from AB. No outlier deletion, omitted row, extra quartet, timing-driven tuning or retry is allowed.

- A usable AB lower bound greater than 1.02 is material adverse latency and blocks acceptance.
- Missing, invalid or AA-drifting cells block clearance.
- All three targets must demonstrate the frozen deterministic arena saving under both runtimes; controls must retain equal allocation.
- With that condition and all 18 usable AB upper bounds at or below 1.02, the screen returns `strong-clear-requires-human-review` for this bounded memory screen.
- Otherwise, if no material adverse interval exists but a usable interval crosses 1.02, it returns `scoped-review-required-inconclusive-cells`. Those cells are inconclusive, not passed.
- Optional per-row speed classification still uses the frozen upper bound below 0.98, but speed gain is not required or aggregated.

Only strong clearance yields success. Every incomplete or adverse outcome stays available for review. Nothing creates a PR, runs a memory chart or publishes runtime changes. The recovery workflow accepts run attempt 1 only on its exact named creation-push proof branch, with its reviewed-tree trailer, and has no dispatch trigger. This blocks rerunning an existing run; branch recreation or a new force-pushed direct-child proof commit could start another first-attempt run. The one-campaign rule therefore also requires operational discipline: do not use those routes to replace an outcome, and review any distinct future protocol separately. Complete or partial evidence is archived with SHA-256 even on failure.
