# Session flush: one fixed portability screen

This packet preserves authenticated main `8a9075aa530f4cc65c577ed665389ba440d5d156`
and one private commit identity guard. Baseline worker SHA256 is
`7efe2ca4e10037401eb75e15c7c38b5e72ce615d406fd309b328da9c3f4cd888`;
candidate worker SHA256 is
`5bb4e740785dd133199c82f23f7eb462801a4ad285b43509e3badcd0e6b05cea`.
All twelve previously audited portable modules per arm are staged byte-for-byte.
`SOURCE-PROVENANCE.json` binds both full source-tree file inventories and their
unchanged WASM identities; only the files needed for these preflights are staged.
No hosted build may replace the staged JavaScript. The source patch is unchanged.

## Design frozen before execution

Two jobs: Node 22.23.3 and Bun 1.4.2 on `ubuntu-24.04-arm`; sequential Chromium,
Firefox and WebKit from Playwright 1.63.0 on `ubuntu-latest`. Exact installed
executable/browser/dependency hashes are captured and frozen by hosted preflight,
before subjects, and checked afterward. Versions, architecture and browser
revisions must match. Runner/image labels alone do not establish availability.

Each cycle has 32 public operations. Fixed case order:

1. mixed-128, sole primary: publish an alternate prebuilt 128-name record,
   changing only the last alias, then 31 unchanged explicit flushes.
2. mixed-4, representativeness: identical mix with four names.
3. changed-single, control: 32 changed publications of alternate prebuilt maps.
4. reverted-one, control: publish, update away and back, flush and drain before
   timing; repeated flushes retain a distinct-but-equal capture and version one.

The untimed fixture checks public versions, aliases, retained snapshots and
ordinary disposal. uint32 returned-version sums remain inside timing; exact
BigInt expectations and checks are outside. Construction, import, browser launch,
navigation, IPC, logging and cleanup are outside timing. Ordinary changed
publication capture, serialization, transient allocation and GC remain timed.
No performance-loop peers/listeners, private instrumentation, forced GC or extra
workload sweep is used. Browser clocks are page-local `performance.now()`;
observed resolution, isolation and shared-memory support are retained.

Calibration: one fresh subject per runtime/case/arm, two 32-cycle seed warmups,
at most seven pilots from 32 cycles. Freeze the first pilot at least 100 ms.
Otherwise grow by `ceil(cycles * min(16,max(2,1.25*100ms/elapsed)))`, bounded by
the case ceilings in PROTOCOL.json (8192, 32768, 131072, 4194304 respectively).
Failure to reach target at the final attempted count stays capped/unresolved.
Both mixed cases retain arm-specific counts. Controls use the larger of both
completed calibration selections for both arms, without another pilot. Each
arm's original calibration cap remains visible. All runtime counts freeze
before that runtime's first measured launch.

Each runtime/case gets eight fresh subjects in ABBA BAAB order, with pairs
(0,1), (3,2), (5,4), (6,7). Interleave case order within each slot; ARM interleaves
Node then Bun. Complete each browser engine before the next. Each subject has
two warm batches and three measured batches; its three-batch median is one
estimate. A browser subject owns a fresh process, context and page for one arm.
The full screen is exactly 40 calibration and 160 measurement subjects, at most
480 measured rows. No replacements, retries, resumptions or reruns for noise.

## Correctness, limits and evidence

One Node and one Bun execution of the preserved public corpus cover both arms
(36 public case-group executions). The unmodified current-main real Node worker
proof runs once per arm. The unmodified focused browser session test runs once
per engine/arm with isolation headers and an engine-only configuration. Metadata
probes launch each browser once without importing the runtime subject; these
are capability/ownership/timer-resolution preflight, not extra measurements.
No held reliability scenarios or broad historical proof workflow is invoked.

Every warm/measured batch must reach 50 ms; short rows remain and make the cell
unresolved. A completed batch above one second or a validation/process cap
fails that job. Every start/completed row awaits the adapter pipe-write callback outside timing before work/post-batch validation proceeds. Pipe completion is not disk durability. A completed row is emitted before post-batch validation; an
interrupted batch retains its start without an invented duration.

Timing subjects: ARM 15 s/512 MiB; browsers 30 s/2 GiB. Each supervisor reserves
four seconds of its cap for cleanup. Complete screens: ARM 360 s; browsers
900 s. Preflight commands: ARM 60 s/1 GiB; browsers 90 s/2 GiB; combined
preflight budget 240 s per job. Setup steps and job budgets are bounded in the
workflow. Jobs are at most 20/30 minutes, totaling at most 50 runner-minutes.
A job deadline measured after bounded checkout reserves two minutes for final
hashing/evidence upload. Exhausted preparation/screen budgets fail visibly.

Playwright deliberately starts detached Linux browser process groups. The
supervisor therefore uses Linux child-subreaper parentage, tracks descendants
and PID start identities, and signals with pidfds. Before each subject starts
work, it verifies ownership of the adapter and the public launchServer browser
PID and acknowledges it over stdin. Detached or orphaned browser descendants
remain in the owned census. Cleanup must finish before the next subject.
50 ms RSS sampling is safety metadata; it can miss short peaks and is not an
allocation or retained-memory measurement. No host-death cleanup guarantee is
claimed. The synthetic preparation gate and hosted ownership receipts must
validate this design before results are accepted.

Each stdout/stderr stream is limited live to 8 MiB for preflight/timing commands and 32 MiB for setup. Overflow is terminal; preserve the exact accepted prefix, observed/retained/discarded byte counts and truncation state, then drain/discard during bounded cleanup. Source export fails closed on any pin/whitelist/symlink violation; partial science uses independently fixed names with no-follow reads.

Keep all start events, seed/pilot/warm/measured durations, counts, checksums,
validation, disposal, stderr, command/exit/timeout/cleanup receipts, freeze
decisions and installed-byte inventories. Analysis audits the raw evidence
before computing summaries. The always-run finalizer hashes completed/partial
scientific files and copies only explicit whitelisted source/science artifacts.
Postflight mutation or incomplete evidence prevents a valid result. Host/job
termination can prevent finalization; missing evidence is failure, never success.

## Interpretation and terminal stopping

Four-pair descriptive 95% log-ratio t intervals use df=3. Retain every pair's
C/B ratio and absolute savings; A/A and B/B repeat ratios; full-arm ranges;
within-subject ranges; and original/calculated common counts. Repeated-arm or
full-arm deviation above 5%, or within-subject range above 10%, is noisy. Every
paired ratio at least 1.02 is adverse, including noisy cells.

mixed-128 reproduces on a runtime only when all four ratios are below one,
upper interval bound is at most 0.95, median saving is at least 10 ns/public-op,
median relative gain exceeds the largest absolute A/A deviation, and no warm
or measured batch is short and neither calibration capped. Noise remains
visible. ARM support requires both Node and Bun. Browsers qualify separately;
a five-runtime claim requires all five. mixed-4 cannot replace the primary.

A control lower interval bound above 1.02 blocks advancement. Wide control
intervals, adverse pairs, noisy cells and calibration bounds stay unresolved;
missing engines or safety-cap failures leave a failed/incomplete screen;
absence of a blocker does not establish equivalence. Unequal mixed counts have
different GC/JIT exposure; common control counts reduce that confound without
proving equal exposure. The conclusion can remain a narrow reproduced primary
with inconclusive controls. These results do not supersede the noisy earlier
local screen or justify local x64 resampling. Stop after this fixed screen or
the first terminal failure in a job. Narrow or park claims that do not reproduce.

## Dormant publication layout

This directory is prepared for `proofs/session-flush-portability/` on an isolated
proof branch, with workflow.yml copied to
`.github/workflows/session-flush-portability.yml`. The branch push trigger is
restricted to `proof/session-flush-portability-20261010`; both jobs are default
false. A later reviewed activation patch must bind the exact preparation predecessor, reviewed intent and canonical source digest, with updated pins. The parent must read back and verify the computed activation commit/tree before one ref update. The workflow rejects attempt>1 and later branch transitions; the host verifies the exact event predecessor, immutable scientific payload and execution HEAD, then records its SHA/tree. The canonical source digest excludes exactly ACTIVATION.json, workflow.yml and INPUT-PINS.json to avoid self-reference. This controlled branch transition is the one-use protocol. There is no default-branch merge, publication, dispatch,
installation or execution permission in this source-only packet.

The existing public API/compatibility boundary remains unchanged. Frequency in
applications, worker delivery latency, startup, retained memory and universal
observational equivalence are outside this timing claim.
