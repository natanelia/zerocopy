# Queue prefix-cache CI screen

Default-off, original-attempt-only Linux x64 screen of the one-expression
`SharedQueue.peek` candidate. There are no operation timings at preparation.
`origin.json` pins baseline 2e88bc4 and candidate 0c5524a, including the latter's
test-only follow-ons. Production bytes equal runtime-only 787d018. Source guards
require exactly the queue expression and two known regression/proof files.
Historical focused results are not fresh standard gates.

## Fixed workloads and units

Eight cells, chosen structurally before queue effect data:

1. Numeric drain 65: two prefix blocks and one tail value.
2. Numeric drain 4097: 128 prefix blocks and one tail value.
3. Repeated prefix peek 4097, explicitly primed through public peek.
4. Alternating roots: two 33-value queues in one Arena, depth-zero prefix leaves.
5. Alternating blocks: retained offsets 0 and 32 of a 4097-value queue.
6. Empty peek, unchanged early return.
7. Tail-only peek at offset 31 in a 32-value queue, unchanged tail path.
8. Object drain 4097 after one public priming drain. Indices 0–2047 hit the
   ordinary object cache; 2048–4096 decode and freeze again every measured pass.

`protocol.json` fixes inputs, ladders, units and exclusions. `PLAN.md` records the
prospective design. Warm prefix peeks are not first reads. Numeric drains include
one initially empty vector-cache access per fresh chunk, mixed into full-drain
cost. Alternating roots/blocks miss on every measured lookup. Standalone
first-ever-call latency, construction/startup, all-cold object reads, growth,
worker transport, browser/ARM and memory savings are unmeasured.

All setup uses public construction, enqueue, dequeue and peek. No cache is
mutated or instrumented. Read-only assertions inspect vector/decode state before
and after each loop, outside the timer. Every chunk resets the default Arena,
collects, builds/primes, then collects again symmetrically before timing. Fixed
timed bodies contain queue calls, checksum arithmetic, loop/dispatch overhead
and a result record. Drain bodies include dequeue-handle allocation and ordinary
GC. The retained root is reused for each full drain; intermediate handles are
not retained as history. Inputs, descriptors, used bytes and published-byte
digests are checked, and retained snapshots are fully traversed after timing.

`operations` means complete drains for drain cells and public calls for peek
cells. Primary drain units are ns/full drain; `nsPerItemPair` divides by N and
describes one peek plus dequeue, never isolated peek latency. Raw rows record
both public call counts. Untimed mode uses the actual first and last ladder
counts, with every duration and derived latency null.

## Reused science and execution controls

The adapter comes from reviewed native CI packet 3bdd45c. `math.mjs`,
`controller.py` and the frozen dependency lock remain byte-identical. Exact
changes and reasons are in `ADAPTER_CHANGES.md`.

Four fresh paired process blocks per runtime use BCCB/CBBC/BCCB/CBBC, alternating
runtime order: 32 measurement processes plus four calibrations. Both arms collect
all five fixed calibration levels and select one common count. The target is
12 ms; 32 warmups and seven measured samples follow. Keep the 5 ms floor,
200 ms warmup-body minimum, 10% warmup drift, 5% relative-MAD and inherited A/A
flags. Four process-block contrasts supply pointwise 95% intervals, with 2%
material-loss and 5% worthwhile-gain thresholds. No multiplicity adjustment or
cross-platform assurance is implied. Inconclusive controls do not pass a
no-regression requirement; warm gains cannot erase adverse losses.

Both exact sources must freshly pass the adapter's complete 23-command standard
gate before source/build/tool/receipt freezing and all four untimed subjects.
This includes full unmodified Vitest defaults, official builds/types, actual Node
workers, list/memory proofs, docs and Chromium correctness, entry points,
installed-package validation and historical evidence. Candidate queue regressions
are included in its full suite. A failed gate stops before clocks. Full gates
are not run during local packet preparation.

The inherited controller's historical local admission function remains unused:
the hosted adapter replaces its admission hook with `fresh_admission`, which
requires this run's successful exact-source gates and freeze receipts. Invoking
the copied controller directly is not an approved timing route. The adapter
itself rejects local execution and remains disabled until an authorized,
digest-bound activation. Local fixture checks use untimed mode only and cannot
transfer their historical-build admission into hosted timing.

The job retains the reviewed 90-minute outer cap and 82-minute work deadline.
Each full arm gate gets 15 minutes; freeze and pre-screen admission have finite
two-minute envelopes; untimed aggregate gets six minutes. The performance
controller needs its full 35 minutes plus cleanup remaining before it may start.
Individual calibration/measurement subjects are bounded at 180/90 seconds.
Limits: 64 MiB Arena, 512 MiB subject RSS, 256 MiB controller RSS, 8 MiB subject
output and two-second cleanup grace. These bounds do not guarantee completion.

## Activation and evidence

Only `proof/queue-prefix-cache-ci-20261009` triggers the new workflow; permissions
are read-only. Publication/activation are separate authorized actions. Activation
must be an intent-only child of the exact reviewed packet commit, bind its digest,
match repository/ref/head, preserve clean tracked source and use GitHub attempt
1. No held workflow or prior activation is reused.

Keep every original raw sample, failure, diagnostic, source/build/tool hash and
owned-group cleanup receipt. No replacement slots, larger caps or automatic
reruns. The report requires a complete ledger and successful final verification;
missing final verification invalidates conclusions even if all slots completed.
Unresolved writers prevent stable hashes/source archives from being claimed.
Artifact preservation uses the reviewed bounded, raw-first behavior; hard runner
termination or upload failure can still lose delivery and must be disclosed.

A useful initial lead still needs independent review and fresh exact final PR CI.
One reserved later integration control is ordinary SharedMap warm reads after
queue `vectorValue` setup in the same process; default Arenas remain separate.
That control is untested and does not expand these eight cells.
