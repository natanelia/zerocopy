# Chromium correctness with a fresh browser for each scenario

This is a separate, correctness-only study of baseline `3773c6e519c7c0958da13727ed1082f449f3ee25` and candidate `da9b432cdf4028c62582455376f18657be65fdf8`. The new workflow is limited to `proof/block-chromium-isolation`, including manual dispatch, and rejects run attempts beyond one. It uses Node 22, Bun 1.4.2 for the same exact-source build procedure, and Chromium only. It does not rerun timing studies or launch a browser locally.

## Existing evidence stays unchanged

The original Chromium correctness [job 113528465037](https://github.com/natanelia/zerocopy/actions/runs/37840231430/job/113528465037) failed in the baseline worker path with `RangeError: WebAssembly.Memory(): could not allocate memory`. Its stack includes `new Arena`, `new Compactor`, `compactMany2`, and `block-traversal-worker.mjs:23:27`. The unchanged original runner awaits all 40 fixture checks before entering the worker checks, so the failure occurred after those fixture checks. There is no separate per-fixture success record in that failed job's artifact. The error and execution order do not establish the allocation failure's cause.

That original runner used one browser process per source for all 40 fixtures and six worker scenarios. This study instead starts a fresh browser process for each fixture or worker scenario: two exact sources × (40 fixtures + six worker scenarios) = 92 scheduled browser processes. This is a changed execution context. Even if all isolated checks pass, the original Chromium job remains failed; an isolated pass neither reproduces a pass in the original context nor explains its failure.

Every existing proof helper, fixture, worker, timing protocol and workflow remains byte-for-byte unchanged. The original timing gate stays flagged, and the original statistically inconclusive cells stay inconclusive. This study cannot establish performance, adoption, broad equivalence, or a diagnosis of Chromium memory behavior.

## Exact checks and observation

The adapter copies the entire hash-pinned original workload module and appends two derived functions. Only their names/arguments and outer case-selection loop headers change. Restoring those headers reproduces the original function bytes exactly; every assertion, inner loop, fixture size and worker body is retained. Both sources run once for each scenario in alternating baseline-first/candidate-first order, with 23 first positions per source. There are no retries or exclusions. Each case gets a separate Playwright `chromium.launch({ headless: true, timeout: 30000 })`; no browser arguments are added. The browser is closed and its disconnect and actual worker closures are recorded before the next launch.

Per source, the original 40 fixtures retain all 22 live-growth checks, 80 attachment checks (40 shared and 40 copied), 68 read-only rejection checks, eight explicit compaction workloads and four edited fixtures with 16 edit steps each. The fixture constructor retains the old item, but the original `runChecks` does not separately assert that retained item. This diagnostic preserves that limitation. Each of the six actual worker scenarios retains 129 special-number values, its 130-value fork, 65 nested snapshots, checks of both original and compacted nested results (130 nested comparisons), one inside-block pause, growth by two pages for every original writer memory, callback indices, write rejection and original worker termination. There are three shared and three copy worker transports per source.

An observational wrapper records `getWorkerData` transport kinds, roots and arena counts, each observed writer memory's before/after size, Worker message counts and result lengths, and termination requests. It returns the original API results and delegates the original Worker operations. It restores the global Worker after the case, with emergency termination recorded separately if the original cleanup was not observed. Playwright separately records actual worker creation/closure. This wrapper is part of the changed diagnostic context, not a production change or performance measurement.

The atomic result file is updated when a case starts, at controller stages, after cleanup and at completion. Every scenario is attempted even after an earlier failure. Errors retain their stage and stack; cleanup failures also fail the case. An interrupted run keeps its last partial record. The process exits unsuccessfully if any scenario fails, if results are incomplete, or if final archive verification fails. A full pass requires 40 fixtures plus six actual worker scenarios for both sources.

Launch, page creation and navigation each have a 30-second deadline; the original scenario checks have a 90-second deadline and browser cleanup has 30 seconds. The job's 360-minute ceiling accommodates the bounded worst case for all 92 attempts, so repeated failures do not automatically truncate the schedule after a short job limit. This is a ceiling, not prescribed waiting or repeated work.

Deterministic tests restore exact function bytes, compare all original and derived operation traces, inject corrupt outcomes into every worker result family and fixture value/index/growth/read-only checks, and verify failure continuation, browser cleanup, telemetry and partial preparation records. These stand-ins test the diagnostic protocol; they are not browser correctness evidence. Optional archive tests verify the real pinned supplement and reject changes to source, bundles, helpers or the case schedule.

## Immutable prerequisite

Preparation requires the already successful `fixed-bun-controls` [job 113527447692](https://github.com/natanelia/zerocopy/actions/runs/37840231430/job/113527447692) from supplement run `37840231430` at proof commit `e58e49f5bb981257d2403ed4b7d9aebf5b8d9ec6`:

- Artifact: [`block-traversal-empty-controls`, ID 11577770777](https://github.com/natanelia/zerocopy/actions/runs/37840231430/artifacts/11577770777)
- ZIP SHA256: `b228e45627f7156bea0320374a0e8e3b6d000aa50de3b856a89d3a9c2ce2dfe0`
- Baseline source: `3773c6e519c7c0958da13727ed1082f449f3ee25`
- Candidate source: `da9b432cdf4028c62582455376f18657be65fdf8`

The workflow fetches the artifact by ID, verifies its API identity, source run and proof commit, verifies the successful supplement job, and checks the ZIP's actual SHA256. It builds the exact source pair using the supplement workflow's existing procedure. Preparation verifies and archives the complete supplement and source bundles. The original supplement's `verifyForBrowser` is then independently invoked with its explicit old proof commit, rather than defaulting to the new study commit. Chromium installation and execution require that verification to pass. Overall supplement run success is not assumed: its original Chromium job failed.

## Commands and evidence

The untimed preparation command is:

```sh
node proofs/block-traversal-chromium-isolation.mjs --prepare SUPPLEMENT_ZIP BASELINE/dist/shared.js CANDIDATE/dist/shared.js OUTPUT
```

Preparation freezes the per-scenario schedule and exact source and emitted-byte evidence in a new output directory. The CI execution command is:

```sh
node proofs/block-traversal-chromium-isolation.mjs --run OUTPUT
```

The execution command itself also requires GitHub Actions, the scoped branch, attempt one, and a prepared archive whose proof commit, run and attempt match the current job. It refuses local browser execution and reuse of a prior run's archive.

The deterministic protocol check is:

```sh
node --test proofs/block-traversal-performance.node.mjs proofs/block-traversal-empty-controls.node.mjs proofs/block-traversal-chromium-isolation.node.mjs
```

The workflow always uploads complete or partial study output, including hidden files, together with a separate workflow evidence directory. The latter preserves the downloaded ZIP, source artifact/run/job metadata, fetch statuses and errors, preparation and eligibility receipts, deterministic-test output, and execution output. It also attempts to retain the original failed Chromium job metadata and log; an unavailable old log is recorded as an archival retrieval failure and does not change either study's result. The separate workflow directory exists before preparation, so a preparation failure can still leave useful evidence without pre-creating the study output directory.

No local browser launch or timing measurement is part of preparation or deterministic validation. The prior local Chromium sandbox denial must not be bypassed. A failed or incomplete isolated check remains failed or incomplete in its own evidence. A new run or manual dispatch must be reported as a separate attempt, not substituted for an earlier failure.
