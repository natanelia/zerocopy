# Independent review of the prospective Firefox heap repair screen

Decision: **hold this exact proof tree before publication or execution**. Two bounded infrastructure fixes are required: track and close Firefox's separate native process group, and reserve enough outer-job time to archive and upload failures. The proposed single, selected-case, effect-only experiment is defensible after those fixes receive exact-tree review. This review does not accept the current implementation for execution.

Reviewed commit: `dcca77ce4cb62775c0e3822288b895be3f15a3e2`.
Reviewed tree: `102a8542ffc53e7611fa6716ce3c6b8f41aec73f`.
Direct parent: `7a32ef7006a34202af7cdf5dccca3e2169abfffe`.
Worktree: `/workspace/scratch/e7ec22ef2609/zerocopy-heap-repair-screen-20261009`.
Prospective manifest SHA-256: `7e591c155794168bd717304818a6969cdbf34e9b4114a1f35d0174010d38fa53`.

## Required fixes

### 1. The outer cleanup receipt cannot prove Firefox cleanup

Priority: P1, execution blocker. Sources:

- `proofs/heap-portability-process.mjs:32–37`: the supervisor starts a detached Node subject, then kills only `-child.pid`.
- `proofs/heap-portability-process.mjs:7–24,47–56`: cleanup scans only that Node process group and can report `verified-no-live-processes` while another group remains live.
- Installed Playwright 1.63.0, `node_modules/playwright-core/lib/coreBundle.js:9312–9326`: its native browser launcher independently uses `detached: process.platform !== "win32"`. Firefox consequently leads a different group on the specified Linux lane.
- `proofs/heap-repair-screen-engine.mjs:58–96`: checkpoint process receipts retain descendant PIDs and start ticks, but no process-group identity or post-close liveness check.
- `proofs/heap-repair-screen-browser.mjs:62,69,91,95–107`: actual Firefox identity is observed before work and after work, but closure is inferred from Playwright close/disconnect and worker events. The already observed native identities are not verified dead afterward.
- `proofs/heap-repair-screen-runner.mjs:193–199,215`: successful Node-group cleanup is used as the cleanup receipt and aggregate status. The parent receives native identities only when the subject prints its final JSON.

A deterministic browser-free reproduction is retained in `probe-detached-cleanup.mjs` with the resulting receipt in `detached-cleanup-result.json`. It runs the exact unmodified supervisor, launches a benign detached Node descendant using the same process-group property as Playwright, and cancels the owner after the descendant PID is available. The supervisor reports `verified-no-live-processes`, with no survivors in the owner group, while the detached descendant is still live in its own group. The probe's `finally` block then kills that exact descendant group and verifies no live member remains. It exited successfully. No browser or benchmark was involved.

This reproduction proves a supervisor coverage gap; it does **not** establish that Firefox actually survived an earlier normal subject. Historical completed subjects with recorded successful browser/worker closure retain that observed evidence. Abnormal termination is unproven: SIGKILL cannot run Playwright's Node-side exit handlers, and the proof does not verify whether a native browser exits after its transport disappears. Do not relabel earlier successful normal completions as observed leaks, and do not describe their group receipt as an abnormal-cleanup guarantee.

Required repair: add narrowly scoped, owner-bound native lifetime tracking to this screen. Persist native PID, start tick, executable identity and PGID to the supervisor before work begins; preserve the observed ownership after reparenting. On normal completion, exceptions, deadlines and interruption, close or kill every owned native group as needed and independently verify no live owned process remains. Never kill processes by an executable-name scan or unrelated global group. Cover the launch-before-ready failure window as well, when the subject may die before returning a final JSON result. The supervisor should fail closed if ownership or cleanup cannot be established. Add a browser-free detached-descendant regression and preserve the current workload, timing region and statistical schedule.

### 2. The job cap consumes the failure-artifact reserve

Priority: P1, execution blocker for the promised failure retention. Sources:

- `.github/workflows/heap-repair-screen.yml:14`: job timeout is 135 minutes.
- `proofs/heap-repair-screen-setup.sh:10,13`: permitted installation time is 300 seconds plus 600 seconds, with additional setup outside those limits.
- `proofs/heap-repair-screen-protocol.mjs:17`: prerequisites and pilot/measurement each receive 3,600,000 ms.
- `proofs/heap-repair-screen-runner.mjs:163,208`: these are separate sequential phase budgets after setup.
- `proofs/heap-portability-archive.mjs:18–19`: archive creation and checksum each allow up to 120 seconds.
- `.github/workflows/heap-repair-screen.yml:36–49`: archive and artifact upload occur only after the study step, under the same job timeout.

The allowed setup commands plus the two phase budgets already total 135 minutes, before checkout/tool setup, hashing, worktree creation, cleanup, archive/checksum and upload. A late phase timeout can therefore collide with the job's termination and prevent the `always()` retention steps from running or finishing. `always()` is not extra execution time beyond the job lifetime. A study can be correctly marked failed yet lose the requested durable failure artifact.

Required repair: give the artifact path an explicit protected time reserve. Keep both scientific phase budgets, per-subject caps and no-retry rules unchanged. Bound setup/verification/cleanup overhead, bound packaging and upload, and choose an outer job envelope larger than their entire sequential allowance plus a stated reserve. Alternatively stop admission of new work before that reserve is consumed. Ensure the controller's own stop/cleanup occurs before the job hard cap. Add a deterministic budget-accounting check. This is an infrastructure envelope change, not permission to extend the pilot or measurement phase.

## Protocol elements accepted in principle

- The exact cases remain `empty-next`, `number-1057-min`, and `string-4097-min-ties`; no replacement fixture was introduced. Source and transport hashes, the fixture body, the measured scan and the result sink remain bound to the retained implementation.
- The prospective schedule equals the reviewed historical proposal: repair/baseline and repair/current, each with its own baseline/baseline or current/current AA. There is no current/baseline rerun or reuse of measured subjects between comparisons. Counts are 15 fresh Firefox correctness subjects, 9 pilots, 192 measured subjects, 4,032 batches, and 216 total planned browser subjects.
- All three full standard Bun/build/type/package/Node-worker prerequisite sets are required before actual Firefox correctness, and all 15 Firefox results must pass before pilots. Failure stops the attempt. The ordinary Bun test command, assertions, timeouts and concurrency remain unchanged; neither retained failed aggregate suite is waived.
- Arm-local real dependency directories and private `.vite` state eliminate the known shared Vitest ordering cache. The installed cache implementation and configuration are checked, each arm begins from the exact 33-byte empty results seed, and existing arm results are rejected rather than reset. Historical shared bytes are read only and retained.
- Each fresh build must match all pinned portable JavaScript, WASM and declaration outputs; all arms use matching compiler-package manifests. Exact served bytes and neutral per-subject files are checked. My retained-build verification was not a fresh build.
- All nine pilots precede measurement. A workload's maximum pilot repeat and fastest retained per-iteration pilot time determine one common repeat/warmup plan for both contrasts and controls. The plan is frozen before measurement, and a floor miss is retained and stops the attempt without replacement.
- The inherited estimator remains four quartet log effects, with process medians, pointwise 95% Student-t intervals at df=3, the 2% loss margin and the original AA invalidation rule. A wide AA interval is not equivalence. The overall all-required-contrasts decision is narrow and conjunctive; no cross-case pooling or broad performance claim is supported.
- Native provenance is substantially stronger than a launcher checksum: the full installed distribution, ELF/build receipts, default launch arguments and mapped `libxul` are tied to live `/proc` descendants. Its live-checkpoint scope and exclusion of host libraries are disclosed. Actual Firefox applicability remains untested here and must pass the fresh semantic gate before any pilot.
- Exact Firefox `nfixed`, `nslots`, allocation size/bucket and JIT behavior remain unmeasured. I accept an **effect-only research question in principle**, with those values left null and the mechanism remaining a hypothesis. The V8 observations do not establish a Firefox slot mechanism. This conditional scope acceptance does not waive either execution blocker.

## Independent verification and boundary

Read CONTRIBUTING.md and checked relevant parent/worktree instructions and `.agents/skills` paths; no applicable repository AGENTS.md or local skill files were found. The engineering-task guidance permits review within this assigned environment.

Performed only deterministic/source checks:

- 40/40 built-in Node fixtures passed: 24 new screen/cache/native-receipt fixtures and 16 inherited transport fixtures. Review runtime was Node 24.19.0; these are not a Node 22 runtime-gate pass. Full output: `deterministic-tests.tap`.
- The browser-free detached-descendant cleanup probe passed by reproducing the bad cleanup claim, then closing its own descendant.
- All 450 baseline, 452 current, and 452 repair tracked-source hashes matched their exact Git objects. All 53 retained bundle/declaration files per arm matched the proof pins. Receipt: `source-pin-verification.json`.
- The prospective manifest verified, the incremental Git bundle verified against its required repair parent, and the checkout matched the reviewed commit/tree. Its existing untracked `node_modules` symlink remained unchanged.
- Documentation preservation passed: 72/72 recorded benchmark rows unchanged, zero changed recorded evidence files.

No source edits, fresh source builds, full Bun/Node runtime suite, browser installation, browser launch, actual Firefox semantic subject, pilot, timing, GitHub publication, PR change or merge occurred. Original PR25 adverse evidence, including Firefox empty-next +2.8264%, remains in force. A future positive screen would support only this repair's selected-case effects; it would not clear other platforms or public-PR integration.

The next review should be limited to the two infrastructure repairs and their updated frozen manifest/commit, while verifying that the accepted protocol elements above remain byte-for-byte or semantically unchanged as appropriate.
