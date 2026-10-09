# Native key normalization CI packet

This is a default-off, single-attempt Linux x64 screen of the native
`String.prototype.toWellFormed` key normalization change. It does not publish a
package, merge code, or clear PR promotion. The experiment has no latency data
at preparation time.

The separate current-main runtime commit and tree are in `origin.json`. They
contain only the two reviewed `arena.ts` additions. The original ad2 baseline,
original native candidate, and corrected local preparation manifest are retained
as historical identities in that file. Their builds, failures, and correctness
claims are not relabeled as current-main CI results. Any later main divergence is
reported separately and requires an integration check before promotion; it does
not silently relabel or invalidate measurements of these pinned sources.

## Unchanged measurement method

`protocol.json`, `subject.mjs`, `math.mjs`, `controller.py`, and
`protocol.test.mjs` are byte-identical to the corrected revision2 packet.
The controller keeps its original process cleanup, deadline, source verification,
common calibration, schedule and failure handling. The adapter changes only its
run-local path and admission hook. The report changes provenance text and adds
a whole-run admission flag: incomplete ledgers or missing final verification
retain ratios and raw evidence but cannot support gain/loss/exclusion decisions.
Its formulas and cell thresholds remain unchanged. Two controller tests replace
historical admission assumptions with fresh CI checks.

There are ten predeclared cases and two runtimes, Node 22.23.3 and Bun 1.4.2.
Four paired fresh-process blocks per runtime use the original ABBA/BAAB order,
32 warmups and seven samples. Common two-arm calibration, all floors, variance
and A/A flags, pointwise four-block intervals, 2% material-loss and 5% worthwhile
gain thresholds are unchanged. No local effect sizes selected these cases.
The malformed scalar cell uses numeric writes through `setNumber` and
`cachePrimitive`; the unaffected malformed string fallback is not substituted.

## Fresh gates before clocks

Both exact runtime commits get separate clean worktrees, the same frozen lock
snapshot, fresh installs, and fresh official WASM, portable JavaScript and type
builds. `ci.py` runs all commands in the pinned main `ci.yml` standard gate:
the full Vitest suite, all type checks, actual Node workers, list and memory
proofs, documentation checks and Chromium documentation correctness, Node entry
points, installed-package validation, and historical-evidence verification.
Compiler and Playwright CLIs use their installed paths rather than a potentially
resolving `bunx` call. There is no browser or ARM performance measurement.

Each command must exit zero and its owned process group must be gone. Failure
stops the gate; neither another arm's pass nor historical timeout exceptions can
admit timing. Runtime binary hashes, compiler/library hashes, all tracked source,
fresh build hashes, gate logs and receipts are frozen before untimed checks.
All four untimed subjects must complete before calibration can start.
Gate command/log paths must belong to this run and their recorded working
directories must match the exact arm source. Passed whole-stage envelopes cover
source checks, command execution, cleanup and hashing. An unresolved writer
prevents hashing its log and is explicitly disclosed during preservation.

The lock snapshot is a CI input because main ignores `bun.lock`. Its root direct
dependencies match the unchanged package manifest. Both installs use
`--frozen-lockfile`; changed lock bytes or unequal compiler/tool bytes abort.
The installed-package test retains the repository's existing consumer-install
behavior; that consumer's optional-peer resolution is not benchmark input.

## Deliberate activation

The workflow is restricted to `proof/native-key-normalization-ci-20261009` and
has read-only repository permissions. No held workflow is reused. A new
`workflow_dispatch` workflow would require the default branch, so this packet
uses an explicitly restricted push trigger.

1. Review and publish the disabled packet only when publication is authorized.
2. If publication changes local commit IDs, update only `origin.json`'s runtime
   commit IDs, verify the trees remain identical, and regenerate `packet.json`.
   The reviewed controller, subject and science stay unchanged.
3. Freeze and review the final `packet.json` digest and packet commit. The file
   lists every packet input except itself and `activation.json`; runtime source
   identities are separately fixed by commit, tree and the arena hash.
4. A separate child commit may change only `activation.json`: set `enabled` to
   true and insert that reviewed packet commit and digest. The adapter verifies
   parent, diff, branch, repository, source and digest before setup.

This preparation leaves activation false. No external write is implied by these
instructions. GitHub run attempts after attempt 1 are rejected. Repeated pushes
of activated content are not a substitute for an independent decision; failures,
partial runs and all original artifacts must remain visible. Never repeat an
inconclusive screen to seek favorable results.

## Bounds and artifacts

The outer job is capped at 90 minutes. Runtime setup actions are each capped at
two minutes; fresh installs and Chromium setup get six minutes. Each complete
arm gate gets 15 minutes plus bounded cleanup. Untimed subjects get an aggregate
six-minute alarm using the reviewed controller's deadline handler. The original
35-minute controller cap governs calibration plus all 32 measurement subjects.
Per-subject calibration/measurement limits remain 180/90 seconds. Subjects have
a 64 MiB arena limit, 512 MiB RSS limit and the original output limit. Cleanup
gets two seconds and unresolved owned groups prevent further subjects.
An 82-minute work deadline after preflight reserves artifact time. The screen
starts only if its full original 35-minute budget plus cleanup remain; it is
never shortened to fit the outer job.
Source/tool freezing and each pre-screen admission pass have finite two-minute
caps within that work deadline. Setup and gate caps include their source checks
and tool/log hashing; only the fixed two-second cleanup grace may extend them.

All normal, failed and interrupted attempts retain logs, raw samples, ledgers,
source archives, builds, tool hashes and an artifact inventory for 30 days.
Artifact steps use `always()`. A hard runner termination or storage/upload
failure can still prevent artifact delivery and must be disclosed. The workflow
does not delete source worktrees, previous outputs, or failed slots. Its report
shows slower and inconclusive cells as well as any supported gains. CI gates and
this exploratory x64 screen alone do not establish browser/ARM performance or
permit promotion without exact final PR CI and independent review.
If owned writers are unresolved, original partial logs are retained for upload,
quiescence and archival verification are marked unknown, and source/build
copying and stable hash claims are skipped.

Preparation checks are syntax, pin/diff review and deterministic adapter checks
only. Builds, full gates, untimed integrated-runtime checks and latency execution
remain unrun until the authorized hosted attempt.
