# Heap compaction child-record first screen

This prospective x64 experiment compares the minimal zero-child-push omission
against main `ad2a19d65a836985a2364b181bc9bd8dce6e42ad`. Only `compaction.ts` may
differ in production. The source guard checks that exact single substitution;
it does not admit the unrelated pointer-cache or primitive-span candidates.
No local timing result was used to choose this patch, cases, or thresholds.

The current preparation has **not passed fresh full correctness**. A local
baseline standard suite stopped with 762 passed and 12 standard 5-second test
timeouts; candidate full units and later package/worker stages were not run.
Those failures remain in the preparation evidence. There will be no further
broad local rerun. The controlled CI job must freshly pass the complete standard
unit, type, build, package and actual Node-worker gates for both arms before any
pilot or measurement. Browser/ARM checks and full exact-head PR CI remain later
requirements if this first screen provides a useful signal. Current-main integration
and the same-method memory chart refresh also remain adoption requirements.

## Bounded cases and engines

The eight cases in `heap-compaction-records-fixtures.mjs` are fixed:

1. Number heap, 4,096 nodes, deterministic ordinary priority order.
2. Number heap, 4,096 nodes, a long left spine.
3. String heap, 4,096 nodes, two retained forks and a repeated snapshot.
4. Nested heap, 128 outer nodes referencing eight shared 512-node string heaps.
5. Empty number heap control.
6. Singleton object heap control.
7. Unchanged 4,096-value number-list compaction control.
8. Unchanged 4,096-entry string-map compaction control.

Pinned initial engines are Node 22.23.3 and Bun 1.4.2. Earlier Node 24 worker
results are supplemental evidence only. The ordinary and skewed cases isolate
heap traversal; the shared and nested cases exercise existing caches and
reentrant compaction without adding a broad type/size matrix.

## Correctness and allocation evidence precede measurement

`heap-compaction-records-check.ts` includes the original focused differential
checks and all eight exact screen fixtures. Test-only fixed target IDs permit
full nested byte comparison. The proof compares source bytes, values, aliases,
descriptors, target allocation request sequences, target used lengths, complete
target bytes, and backing lengths. Uninstrumented production fixtures also
validate values and aliases and establish conservative backing bounds.
Instrumentation and fixed IDs never enter timing processes.

The previously audited nested-ID rule is preserved: the production target ID
counter can gain digits during repeated compaction, legitimately changing
encoded descriptor sizes and occasionally page counts. Initial and final used
and backing sizes are recorded separately, while full logical results, alias
relations and original source bytes stay exact. The protocol does not require
constant production `compactedBytes`, normalize IDs, or label such growth a
runtime defect.

`heap-compaction-records-stats.mjs` reuses the audited quartet estimator from
commit `ef1e2a16e687c8af385ddbd735094b9ec00179e9`, file
`proofs/compaction-pointer-performance.mjs`, without arithmetic changes. New
deterministic tests distinguish data validity, AA drift, and statistical
uncertainty. The controller retains the audited neutral-import-path, independent
process, manifest, balanced-order, and incremental-artifact approach.

## Shared work and bounded churn

The measured operation is complete `compactMany` plus the same small size
checksum. Source construction, attachment/inspection, output proof checks,
neutral staging, and explicit GC are outside measurement. Results are not
retained across compactions. Latency samples do not estimate physical memory.

Both arms preserve the default **128 KiB initial** and **256 MiB maximum** arena
settings. A chunk performs at most 64 compactions and creates at most 8 MiB of
target backing according to its conservative per-case bound, whichever permits
fewer operations. Explicit GC is requested before each chunk, outside its
timer. This bounds work/backing created between cleanup requests, not physical
retention, GC completion, reserved address space, peak heap, or RSS.

Each case has one common chunk count for both arms. Untimed proof bounds include
six target-counter digits, allocator alignment, and an extra page for nested
descriptor growth. The maximum predeclared process workload stays below that
counter-width bound. A bound violation is a correctness/protocol failure.

Each arm gets one fresh-process pilot. Pilot warmup stops at 150 ms of summed
operation-body time, with a hard 64-chunk ceiling. Calibration tries 1, 2, 4, 8,
then 16 chunks, seeking at least 30 ms summed operation-body time. Failure to
reach either target is cap-invalid, not a license to grow an unbounded batch.
The slower arm's larger batch requirement is frozen for both roles, AA and AB.
Measured processes also share twice the larger pilot warmup count (at most 128
chunks). This shared count must actually reach the 150 ms body-time floor in
every measured process; misses remain invalid evidence. GC duration does not
count toward the warmup floor.

A process records five batches, each with the frozen count of chunks. A batch
is the sum of those timed chunks, with GC outside each timer. Every batch must
reach a 20 ms summed body-time floor. Raw per-chunk durations remain available
to inspect granularity/overhead. GC exclusion and chunking mean the estimand is
not end-to-end application throughput including cleanup pauses.

## Independent units, materiality, and no favorable reruns

For each case/engine/protocol there are four independent fresh-process
ABBA/BAAB quartets. Each quartet has two descriptive process pairs. Five batch
summaries produce each process's median; batches and pairs never increase the
inferential sample size. The estimand is the geometric mean candidate/baseline
latency ratio from quartet-mean log ratios. Two-sided 95% Student-t intervals
have three degrees of freedom and assume independent, approximately normal
quartet log ratios. Intervals are per case, unadjusted for multiple comparisons.
There is no pooling across cases or engines.

Direct baseline AA uses the same work plan, process setup, labels, URL,
warmup, chunks and GC policy. AA is never subtracted or divided out. Its interval
must fit within [0.98, 1.02] to support an adoption signal; detected AA drift and
valid but inconclusive AA intervals are reported separately.

The predeclared materiality band is **2%**:

- Candidate/baseline interval entirely below 0.98: detected material benefit.
- Interval entirely above 1.02: detected material loss.
- Interval entirely within [0.98, 1.02]: within the declared band.
- Otherwise: valid but statistically inconclusive, if the data are valid.

Incomplete, cap-invalid, floor/warmup-invalid, or proof-failed observations do
not become usable intervals. A valid but inconclusive interval is not a pass.
No cap/floor change, favorable rerun, outlier deletion, alternative variant, or
post-hoc case substitution is authorized by a poor result. All raw process
results, errors, partial cells and stopped stages are retained.

The per-engine report can signal broader validation only with a substantial
target benefit, compatible AA throughout, complete valid data, and no detected
material loss in any case. Final judgment compares both engines and treats
unresolved controls explicitly. A green workflow is a correctness/protocol
result, not automatic adoption, a universal no-regression guarantee, or a
physical-memory claim.

## Budget, reserves, and publication identity

The original proposal was eight minutes per engine and a 55-minute job. Before
any timing, arithmetic showed that this did not cover even the proposed subject
watchdogs. It was superseded by **12 minutes per engine** and a **65-minute job**.

Per engine, eight cases × two protocols × four quartets × four fresh processes
is 256 measured launches; sixteen pilots add to that. The fixed two-second
measured-process and five-second pilot watchdogs permit at most 592 seconds of
total subject envelopes (including owned-group cleanup), leaving 128 seconds inside the 720-second engine envelope for
neutral copies, hashing, parsing, orchestration, and saving evidence. These are
enforced watchdog bounds, not measured cost estimates or promises that all
subjects can finish. The watchdog includes setup, warmup, all five batches and
deterministic checks. Each fixed envelope reserves 200 ms for cleanup: TERM
first, KILL after 50 ms, and verification through the remaining 150 ms. Thus
active execution has at most 1.8 seconds or 4.8 seconds; cleanup does not extend
either cap. These are hard invalidation caps, not promised sufficient durations. A subject that cannot finish becomes cap-invalid; it is
never silently rerun. The engine envelope covers all staging and orchestration
and preserves partial results if exhausted.

The job reserves eight minutes for setup, twenty for fresh correctness,
twenty-four for both engine screens, and five for source/artifact retention.
This totals 57 minutes within a 65-minute envelope, leaving eight minutes for
checkout/tool setup, the one-minute activation guard, and scheduler overhead. The artifact reserve is explicit:
two minutes for source/proof packaging and three for upload, both `always()`.

The runtime is published at `21de2bf4b49d1b2cf5da698be41a27f37fd84bed`,
with tree `4c7dc0ac84cfdb016e70f01bde711a2650bcf724`; that immutable runtime
commit is the parent/pin of the revised proof preparation. The GitHub connector
has no workflow-dispatch capability, so the prepared workflow uses an isolated
creation push under `proof/heap-compaction-records-run-*`. The committed intent
file defaults to disabled. A separately reviewed activation-only commit must
name the accepted **published** proof commit, its exact tree and the canonical
harness file/mode/blob digest; the activation commit has that sole parent and
changes only the intent file. The event must create a new branch, have an all-zero
before SHA, and be neither forced nor deleted. Existing-branch pushes fail closed.
The guard verifies committed and actual physical 0644 modes (including when Git
ignores physical mode changes), accepted file bytes and the published runtime
ancestry. No local-only commit is a CI reference. Publishing or activating is
outside this repair task.

The job defaults `HEAP_ENABLE_TIMING` to zero. Only the two guarded screen steps
set it to one, after fresh exact-head correctness succeeds. The controller also
rechecks the accepted creation-push intent and exact gate receipt. Pilot and
measurement subjects independently reject a missing timing opt-in before fixture
work. The checkout and `HEAP_EXPECTED_HEAD` use the exact event SHA. A default-off
publication cannot run gates or screens through this workflow.

The baseline checkout is outside the candidate checkout under a fresh runner
private directory. A glob-only preflight uses unchanged Vitest defaults/config,
including `dot: true`, to compare each arm's discovered tests with its own tracked
standard test set (41 files at this source). It rejects ancestor overlap and
cross-arm discovery before executing suites. Both arms receive separate physical,
initially equal dependency trees and initially empty, physically distinct default
`.vite`/`.cache` destinations. Vitest exclusions and 5-second timeouts stay unchanged. Dependency hashes, file modes, source hashes, WASM hashes and portable
bundle hashes are recorded. Package caches are also separate. Generated proof
output lives under the existing npm-excluded `.proof-tools/` path; moving it
there corrected a preparation packaging issue without changing runtime code.
All new files use mode 100644 and are invoked explicitly through Node/Bun.

The controlled job calls `heap-compaction-records-gates.mjs` first. Only its
complete successful exact-head receipt authorizes the controller to start a
pilot. Standard 5-second unit timeouts are not relaxed. Interrupted gates and
failed units block both engines; a failed Node timing cell does not hide the
independently authorized Bun screen after gates have passed.

## Repair evidence retention and supervision

Every gate, pilot and measured launch has a durable pre-spawn receipt with exact
engine, case, build, mode, AA/AB protocol, quartet block, pair, label and frozen
counts, plus the command, deadline, and PID/process group once spawned. Output
streams directly into separate stdout/stderr files. Only registered owned groups
receive signals; descendants are cleaned after normal exit, cap, interruption or
controller exit. A failed cleanup blocks later launches and preserves staging.
The controller rechecks its fixed engine budget after staging and will not spawn
when staging or evidence preparation exhausts it. Bounded synthetic checks use an
independent external guardian and an unrelated witness; they never execute the
performance operation. Abrupt controller-exit cleanup is honestly marked
unverified until the external guardian verifies no live group members.

Before any data collection, this revision declares synchronous incremental
JSONL evidence plus atomic state snapshots after each warmup/calibration/measurement
chunk and each calibration/batch summary. These writes occur after the timer's
second read and before subsequent chunks, with identical policy across arms.
Their between-chunk/runtime overhead is part of the fixed process/engine budgets,
not operation latency; it can invalidate a cap and may influence later runtime
state. Receipts are never overwritten. A failed or partial subject preserves its
last chunk/batch and full slot identity, but cannot enter a statistical interval.
Focused Node 22 and Bun correctness receipts are saved immediately under distinct
names and validated against their engine; neither can overwrite or relabel the other.
Historical baseline timeouts and supplemental Node 24 evidence remain unchanged.
