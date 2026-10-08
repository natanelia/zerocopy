# Registry warm-read causal diagnostic, frozen 2026-10-08 22:13:20 UTC

Status: prospective design, fully pinned at 2026-10-08 22:13:20 UTC;
no ARM timings run. This is a diagnosis, not a new
acceptance result or a reason to discard the earlier confirmed regression.

## Question and fixed scope

Explain the Node22.23.3, Neoverse-N2, 512-arena warm nested-read regression with
exact baseline 3773c6e519c7c0958da13727ed1082f449f3ee25 and exact PR22
ab969f043e44d53f6ba7315c2b818c1a51ce49c9. Preserve historical result +3.9104%,
pointwise 95% interval [+3.0640%, +4.7638%], all eight quartets adverse.

Only 512 arenas are timed in this causal screen. Local untimed census already
covers 1/2/12/32/512. Existing historical smaller-size results are reported
separately; they are neither pooled with nor converted into a focused test.

## Four states

- B: exact baseline emitted bundle, native complete per-arena dependency maps.
- C: exact candidate emitted bundle, original closed shared registry.
- D: the same candidate emitted bundle, each arena.dependencies read exactly once
  after attachment, materializing every distinct self-excluding dependency map.
- R: exactly D's materialization followed by restoring each dependencyLookup to
  the original shared lookup. Dense maps have no retained experimental reference.

Use the byte-pinned registry-arm-causal-graph.mjs only outside timed work. Every state retains the same
extra arena list and its original root lookup through the same keeper shape.
The original lookup is deliberately retained in D as well as C/R, retaining its
registry metadata consistently. These controls change setup and graph state;
they never modify emitted library bytes. D and R are experimental states, not
production repair candidates. B uses its original owned-map representation.

R is not an exact restoration of C: registry.shared is false in D/R and true in
C. It changes export behavior outside the hot loop. The candidate backing field
is mutable in C/D/R; B's dependency field is observed const in local Node24 V8.
R also changes allocation/GC history, potentially heap capacity and placement.
Record these facts instead of labeling a favorable R result an allocation cause.

## Prospective comparisons and schedule

Four prespecified paired contrasts: C/B (bridge to the historical signal), D/C
(materialization total effect), R/C (materialization/release history effect), D/R
(dense retention effect after similar materialization history). Dedicated A/A
arms for B, C, D, and R. No normalization by A/A.

Each of the eight arms has eight independent-process quartets, four ABBA and
four BAAB, for 256 measured subjects total. Use xorshift32 seed 2026100822, with
the existing focused protocol's Fisher-Yates shuffle, to shuffle
arm and orientation order within each of eight rounds; use the same physical
package root, cwd, runner path and import path for all states. Archive the
schedule before pilots. Never drop or replace adverse, failed or short subjects.

All states use the historical fixture and hot-loop bytes, full-leaf correctness
warming, shared transport, original probe setup, and original pre-batch GC.
Apply treatment immediately after retained attachment, before post-attachment
GC, memory-after measurement and full-leaf warming. Graph inspection/import
scaffolding must be common across states; its changed harness is not called the
byte-identical historical subject. Only the hot-loop bytes remain identical.

Use the existing frozen focused protocol's pilot procedure independently for
each state, then freeze the maximum prescribed iteration count across all four
states as common work before measured subjects. Three warmups, seven measured
batches, minimum 20 ms for every warmup and measured batch. Pilot target 40 ms, maximum 8 pilot
calibration batches, initial 100,000 and maximum 10,000,000 iterations, original
adaptive multiplier bounds, and three pilot warmups. Process median of seven
batches is the subject value.
Two adjacent A/B pair log ratios average to one quartet log ratio. Estimate the
geometric ratio and two-sided Student t interval on eight quartet log ratios
(df=7, t=2.364624251). All four contrasts are pointwise, exploratory causal
diagnostics, not familywise guarantees. A/A flags use the existing AND rule:
point outside [1/1.02,1.02] and its interval excludes 1. Report relevant A/A,
floor and integrity flags alongside each contrast; don't compensate for them.

Stage hashes, full dist/package bytes, source pins, executable hashes, default
flags, complete stdout/stderr, JSONL and raw batches must be retained. Use Node
22.23.3 default JIT and only --expose-gc in timed cells. No diagnostic JIT flags,
added census wrappers or WeakRefs enter timed processes. Original setup probes
restore their prototypes before any timed action. Record CPU/OS and exact Node
hash; don't assume every ARM runner is Neoverse-N2. Full final integrity failure
invalidates inferential acceptance while keeping every raw result.

## Separate untimed ARM diagnostics

Before timings, verify path counts and topology for every state, exact same
511 nested objects/primitive caches, values, read-only behavior and re-export.
For D/R in separate processes, collect WeakRefs via a temporary getter wrapper,
restore it, cross a task boundary, force GC, cross another task boundary, force
GC, then inspect references. Require D retains all 512 and R retains zero dense
maps. Record heapUsed, heapTotal, RSS and external memory before/after; they are
diagnostic snapshots, not universal memory estimates. Snapshot root/child/writer
field indices and field constness. Ensure all diagnostic references and wrappers
are absent in timed processes.

After default-JIT timing, do one separate exact-harness JIT/GC diagnostic process
per state, with --trace-opt, --trace-deopt, --trace-turbo-inlining and --trace-gc.
Report function optimization/inlining, deopts and GC around batch boundaries;
never put diagnostic durations into timing intervals. Local Node24 x64 traces
are supplementary evidence only, not substitutes for these ARM observations.

## Interpretation and stopping rule

- C/B remains the direct comparison; do not erase the historical result if this
  modified-harness bridge is inconclusive or favorable.
- If D/C and D/R differ materially while R/C is near 1, retained graph state is a
  supported contributor under this experiment. It still doesn't identify cache
  placement, GC, instruction layout or an ARM hardware cause by itself.
- If R/C changes alongside D/C, setup/allocation/history is implicated, but the
  exact cause remains mixed with GC/placement and the recorded registry flag.
- If same-code controls do not shift while C/B remains adverse, emitted-code,
  field semantics or earlier construction differences remain candidates; inspect
  ARM traces before proposing a repair. Absence of a shift is not proof of absence.
- Require internally coherent paired results and intervals across prespecified
  contrasts. One favorable state is insufficient to assign cause.

Stop after this one complete bounded run and its separately marked diagnostics.
Preserve failures; don't time-tune or rerun to obtain a favorable result. Propose
a new bounded experiment only for a named unresolved mechanism. A production
repair requires its own source-reviewed correctness, retained-memory and exact
baseline/candidate default-JIT acceptance checks. Never restore quadratic maps
as the repair, and never offset the loss by unrelated read-path changes.

## Execution and evidence

The dedicated workflow runs only for the first non-forced advance of
proof/registry-arm-causal-20261008 from published proof base
96b90882df5d5294489065bd303fbbede6a83184. Creating that branch at the base does
not run measurements. The reviewed advance must add exactly the ten new causal
proof/workflow files. Both the workflow and controller verify the publication
delta; the controller also checks its checkout HEAD against GITHUB_SHA.

Run deterministic checks explicitly with Node, outside Vitest discovery:

    node --test proofs/worker-arena-source-guard.node.mjs proofs/registry-attachment-tests.node.mjs proofs/registry-arm-causal-tests.node.mjs

The workflow builds exact baseline/candidate inputs with pinned Bun1.4.2 and
AssemblyScript0.28.20, verifies historical source and emitted-bundle digests,
runs95 focused attachment/descriptor/worker/record tests and typecheck, then
runs six actual-worker proof invocations and four untimed censuses before pilots.
Test counts describe this prepared revision; the workflow executes the named
suites rather than skipping tests to maintain a count.

The controller invocation is:

    node proofs/run-registry-arm-causal.mjs BASELINE_CHECKOUT CANDIDATE_CHECKOUT NEW_OUTPUT

Local correctness-only validation adds --correctness-only. This mode runs the
worker proofs and censuses with no pilots, measured batches or trace workload;
it allows the local architecture/Node version and labels this difference.

Each invocation streams raw stdout, stderr and structured JSONL to three separate
files. Diagnostic native output cannot corrupt JSONL or overflow a parent capture
buffer. Census-only code is absent from staged pilots/timings/traces. Separate
trace runs mark pre-GC/action boundaries on stdout with both uptime and performance
clocks. They cannot contribute observations to the256-subject inference.

The artifact is a tar.gz plus its SHA256 receipt. Its contents preserve hidden
workflow files and any native trace filenames containing colons. Packing and
upload use always() so failed prerequisites and partial studies remain available,
subject to the runner still being able to execute the upload steps. The archive
contains exact input package/dist/source bytes, both original and new proof files,
toolchain/host receipts, all raw process outputs, frozen pilot prescriptions,
complete or partial inference, and pre/post integrity results when reached.
