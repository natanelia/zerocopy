# Sorted pending-delete subject contract

This is prospective source for METHOD-v3.md, SHA-256 `61d039666924bb9dcf73ad2385d99252fd25902fb7a62ae22c76a61443e9e22f`. The baseline source revision is `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. This file describes the child interface and implementation; it contains no measured result.

## Invocation

`node --expose-gc subject.mjs child <module-file> <calibrate|measure> <counts-file-or-> <remaining-study-bytes>`

`bun subject.mjs child <module-file> <calibrate|measure> <counts-file-or-> <remaining-study-bytes>`

The child verifies Node 22.16.0 or Bun 1.4.2 and synchronous explicit-GC availability. Its ordinary production entrypoint is the selected arm's `dist/shared.js` under Node or `shared.ts` under Bun. It resolves that file to one canonical file URL and imports it once. The controller authenticates the arm, production bytes, runtime and dependency hashes, correctness admission, and baseline-only calibration; the child cannot infer an arm from its portable interface.

For calibration, the counts argument is `-`. For measurement it is a JSON object with exactly eleven keys, each mapping directly to its frozen positive integer count: `P`, `S16`, `R1`, `N4`, `G1`, `B0`, `C0`, `M0`, `L4`, `X4`, `I4`. Values must obey the method's row caps. The last argument is the remaining global actual-payload allowance, before this child's allocation, including at least its 112 MiB initialization reservation. It may not exceed 128 GiB. The child separately enforces its 8 GiB actual-payload cap and each prospective setup-plus-loop allowance.

## JSONL output

The first line has `event: "ready"`, `schemaVersion: 1`, `engine`, `version`, and `mode`. Boundaries have `event: "ledger"`, `stage`, `caseId`, `phase`, `ordinal`, `arenaId`, `addedPayloadBytes`, `cumulativePayloadBytes`, both remaining payload allowances, and a JSON-only `receipt`. Every newly created arena is accounted exactly once using its final `used - 65536`; released bytes are never subtracted. Template builders, retained templates, and the X4 sacrificial replay are included.

A batch boundary's `receipt` contains the completed raw batch. Initialization boundaries preserve their relevant scalar receipts; the sacrificial-replay boundary also preserves the timer precheck. The child snapshots each ledger receipt as JSON before emission so its final ledger remains identical to its streamed ledger. Thus completed batch evidence remains in stdout if a later batch is interrupted. No extra output event types are used.

The final line has `event: "result"`, `schemaVersion: 1`, `status: "complete" | "incomplete"`, `mode`, `engine`, `version`, `cases`, `cumulativePayloadBytes`, `accountingComplete`, `timer`, `initialization`, `ledger`, `failure`, and numeric `limits`. A caught failure produces an incomplete result and exit status 1. Missing or interrupted final results remain incomplete at the controller. Error codes omit file paths. A partial allocation that cannot be reached through a returned public snapshot sets `accountingComplete: false` and cannot be used to continue the study.

The final `cases` field is an object keyed by row ID, inserted in the fixed row order, including any partial result. Measurement case values are `{id, count, warmup, measured}`, with five warm-ups and nine measured batches. Calibration case values are `{id, count, accepted, trials}`. Trials are `{trial, count, warmup, pilots, medianMs, accepted}` with five warm-ups and three pilots. Ordinals and trial numbers are one-based. Phase names are `warmup`, `pilot`, and `measured`. Rows always follow the order listed above.

Batch fields include:

- `caseId`, `count`, `phase`, `ordinal`, `trial`
- `elapsedMs`, `elapsedNs`, `durationClassification`, `timerEligible`
- `arenaId`, `startUsed`, `endUsed`, `startCapacity`, `endCapacity`, `allocationBytes`
- `prospectivePayloadBytes`, `cumulativePayloadBytes`, final scalar `arena` receipt
- `preGcMs`, `setupMs`, `setupConstructionMs`, `setupValidationMs`, `setupGcMs`, `validationMs`
- JSON-only `inputShape`, `finalShape`, `sinks`, `validation: "passed" | "failed"`, `failure`

`setupMs` is total model/construction/input-validation wall time. Its construction and validation components are also recorded. GC and final-result validation have separate wall durations. Durations use milliseconds except `elapsedNs`, which is `elapsedMs * 1e6`. Nonfinite elapsed durations are stored as null with their classification retained; they cannot qualify for latency. The controller owns process wall time, 50 ms RSS sampling, 2 GiB RSS enforcement, process-group cleanup, and the 870/90-second deadlines with reaping reserves.

`timer` contains `readingsMs` (exactly 4,096), `positiveDeltasMs`, `quantumMs`, and `precheckPassed`. An exceptional nonfinite reading is represented by `"NaN"`, `"Infinity"`, or `"-Infinity"`. The quantum is the minimum finite positive adjacent delta, or null. The precheck requires every reading finite and nondecreasing and a finite positive quantum. Batch eligibility additionally requires a positive finite duration and `quantumMs <= 0.005 * elapsedMs`. Timer eligibility never changes count selection, adds a trial, or discards a receipt.

Calibration starts at 256, except I4 at four. Acceptance depends only on a three-pilot median in the inclusive 20–50 ms range. Otherwise the next count is `round(count * 30 / medianMs)`, clipped to the declared range. Four trials maximum, unchanged clipped counts stop that row, and the last attempted count is frozen. A nonpositive/nonfinite pilot duration ends the child incomplete. Latency eligibility, process-quality diagnostics, paired intervals, and allocation comparisons belong to analysis, not count selection.

## Lifetime and validation

The only persistent snapshot handles are four canonical templates and the separately accounted empty default-arena handle. Template construction uses public `compact(new SharedSortedMap('number'))`, public sets, and public compact again. `configureMemory({maximumBytes:134217728})` occurs once before the first collection construction. No construction write targets the default arena.

Every complete batch is one synchronous function frame. The next pre-construction GC occurs only after that frame has returned JSON-only data. Its input, base, final output, exported payloads, memory, buffers, views, graph/model helpers, and iterators cannot escape through its receipt or a retained closure. The four template builders and X4 replay use the same return-only-JSON discipline. No previous batch snapshot is retained by the caller.

Each batch performs exactly one synchronous GC before compaction and one after preparing and validating the fresh input. Its ordinary public operations and scalar sinks are the only work between the two operation-clock reads. Every repetition starts from the same batch input; X4 performs all four replacement sets, and I4 performs its two reads and complete iteration. Size and wrapper-identity mismatches are consumed as scalar counts. Root sinks use unsigned roots.

Untimed inspection uses only public reads and public `getWorkerData({map},{copy:false})`. It checks the complete canonical graph, node/key/header bounds, branch critical-position order and digit membership, subtree sizes, representative membership, exact numeric contents, sorted uniqueness, ordered journal leaves, canonical base identity and contents, allocated pending-key ranges, and target membership. It reacquires exported memory after growth. The final output, original input, base snapshot, and associated template are checked after every batch. M0 must keep object identity, its exact journal, and zero native growth. G1 must preserve prior-root inequality. X4's separately accounted untimed replay verifies all four intermediate journal shapes and its final canonical result.

The source makes no retained-heap, backing-capacity, RSS-saving, or application-wide performance claim. Those quantities are distinct from the exact append-only payload receipts.
