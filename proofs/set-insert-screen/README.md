# Set insertion: independent hosted gate continuation

The initial local attempt stopped at its baseline-only feasibility gate. All 36
baseline calibration children completed, but the projected screen took
610,818.7 ms against its fixed 300,000 ms cap. Node's cached-ASCII duplicate pilot
batches ranged from 1.23 to 625.62 ms. No candidate timing child or paired
measurement ran. The failed feasibility outcome is retained in
`local-feasibility.json`; it is not a candidate performance result.

The [first hosted run, 38616575852](https://github.com/natanelia/zerocopy/actions/runs/38616575852),
stopped during correctness before smoke, calibration, or paired measurements.
All 1,065 Bun tests passed; the raw full-Node Vitest invocation passed 1,056 tests
and failed nine SharedList worker tests with `SyntaxError: Unexpected token '{'`.
All ten new Set insertion tests passed. A single pinned Node 22.16.0 worker probe
on unchanged main reproduced the parse failure at `shared-list.ts:3`,
`import type { ValueOf } from './types';`; all 502 baseline source pins remained
intact. This is a baseline worker-loader failure, not a green full-Node gate.
The original run and branch remain preserved, and its later portable Node,
package, smoke, and timing stages were not run.

This new branch is a separate hosted continuation with fresh builds, full Bun
correctness, the same six-file focused Node gate previously used locally, and
the existing portable Node and package gates. Ordinary CI runs full Vitest under
Bun and portable worker proofs under Node; this continuation follows that loading
boundary without adding a loader or changing dependencies, source, tests, or
timeouts. The new job and its timing stages have not run during preparation.

This continuation is a new GitHub-hosted Ubuntu 24.04 hardware cohort. It keeps
the original 18 cells, six paired repetitions, baseline-only calibration,
300-second screen cap, 10-second child caps, 2% regression guards, 10% cross-engine
target threshold, allocation guards, and all uncertainty rules. It does not import
local or prior hosted timing samples or counts. If fresh-host baseline feasibility fails, the
screen stops again. There is no longer cap, source tuning, sample replacement,
automatic rerun, or pooling between cohorts.

## Fixed inputs and gates

- Source baseline: main commit `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.
- Candidate: the exact four runtime files and one focused test in
  `candidate-files.json`, applied by the sealed `candidate.patch`.
- Node 22.16.0 and Bun 1.4.2: official executables checked against the method's
  SHA-256 pins. npm dependencies use the supplied integrity-bearing lockfile with
  install scripts disabled. The toolchain package was renamed for this proof;
  dependency versions, resolutions and integrity values are unchanged.
- Both variants receive ordinary native, portable and declaration builds under
  the same toolchain and commands. Candidate correctness then runs every Vitest
  test under Bun and the 106-test focused Node gate: `shared-set-insert.test.ts`,
  `shared-set.test.ts`, `map-set-index.test.ts`, `map-set-path.test.ts`,
  `map-set-utf8.test.ts`, and `allocation-failure.test.ts`, with `--maxWorkers=1`.
  It also runs all normal main/Redux/value/geometry types plus worker declarations,
  real Node/Redux/typed-JSON/task-lifecycle worker proofs, and the actual
  packed-package Node/Bun/TypeScript consumer check. The replaced Node command
  retains its existing 300-second cap; default per-test timeouts are unchanged.
  Any failed gate stops before smoke or calibration.

The baseline source commit, proof/controller commit, candidate patch and each
emitted build are identified separately. Merely naming a file is not provenance.
All source/build/runtime bindings are checked before and after the screen.
This is not a browser portability matrix, deployment, package release, or merge.

## Bounded execution and evidence

The new workflow triggers only on `proof/set-insert-screen-gatefix-20261014`, with one
job, `contents: read` permission, no stored checkout credentials, and no deployment
or write permissions. A rerun attempt is excluded. Publishing the reviewed proof
commit is the bounded job trigger; this adds no workflow to the default branch.
Checkout is limited to that exact proof commit and its direct fixed-main parent,
with depth two and no tag or all-branch history fetch.
The wrapper has a 25-minute aggregate cap and the job a 35-minute ceiling.

After correctness, four validation-only smoke processes cover both variants and
engines, each with startup once and one batch per fixed hot cell. Timing values
are discarded. The smoke has a 60-second overall cap and 10-second child caps.
Only a complete smoke permits fresh hosted calibration and one screen. The
screen retains its own 300-second cap including calibration and provenance checks.
The wrapper's outer watchdog adds five seconds for deadline cleanup and output
sealing; the unchanged inner controller cannot use that for extra measurements.
No new runtime, benchmark case, timed operation, count rule or estimator is added.

`screen-controller.mjs`, `screen-child.mjs`, and `draft-workload.mjs` are unchanged
from the reviewed local executable packet. The method file received presentation
edits only: preparation/approval wording, a replaced local path reference, and this
cohort explanation. Its scientific workload, rules and thresholds are unchanged.
`INPUT-SHA256.json` seals the complete proof inputs.

The artifact preserves command logs/receipts, exact source and generated-output
inventories, native/portable outputs, smoke evidence, raw per-process samples,
screen custody hashes, and any terminal negative outcome. It excludes dependency
trees, runtime binaries, local-machine raw data, private coordination reports,
environment dumps, hostnames, usernames, mount/cgroup files and unrelated paths.
Only the screen's minimal CPU/OS/memory/runtime metadata is recorded on the hosted
runner. An incomplete screen cannot support a passing summary. A completed job
can validly reject the candidate; inspect the verdict rather than treating a
successful test run as performance or merge clearance.

Official action sources are pinned by commit:
[checkout](https://github.com/actions/checkout/commit/11bd71901bbe5b1630ceea73d27597364c9af683),
[setup-node](https://github.com/actions/setup-node/commit/49933ea5288caeca8642d1e84afbd3f7d6820020),
and [upload-artifact](https://github.com/actions/upload-artifact/commit/ea165f8d65b6e75b540449e92b4886f43607fa02).
