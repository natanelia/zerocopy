# Controller and raw-report schema v1

The normative method is the exact sealed METHOD v2. This document fixes the producer/consumer interface; it supplies no performance observations.

## Group configuration

Every group is one absolute runtime executable plus owner.mjs (preflight.mjs for mechanism) and one absolute JSON configuration path. There is no shell, runtime flag, extra version process, retry or replacement group. The controller generates the full 80-element schedule before the first target.

- schemaVersion: 1
- mode: mechanism, calibration, rehearsal or measurement
- engine: node or bun
- arm: B, C or A; A always resolves to the identical B build
- block: null before measurement; integer 1–12 for measurement
- processOrder: the fixed zero-based index 0–79 in specification.SEQUENCE
- artifactRoot, sharedEntry, workerEntry: absolute authenticated import root and its literal dist/shared.js and dist/worker.js paths
- output: fresh absolute durable group-report path
- bindingSHA256, caseSHA256, sequenceSHA256: exact externally admitted prerequisite binding and canonical case/schedule digests
- counts: exact row-to-integer frozen baseline-calibrated counts, present only for rehearsal/measurement

Case/schedule canonical JSON uses sorted object keys, compact separators, ASCII escaping, finite JSON numbers and UTF-8 SHA-256. The case hash covers parsed cases.json, not its whitespace. The exact bytes of cases.json also appear in the independently reviewed proof inventory. The schedule hash covers mode/engine/arm/block/processOrder/label/wallSeconds for every group.

## Raw group report

The driver durably checkpoints after untimed validation and retains failed/partial records. Its report has schemaVersion, identity (the eight configuration identity fields), status running/complete/failed, workerCount, valueValid, coldValueValid, failures, cold, coldReceipt, rows, counts, phases, fixture, protocol, disposed and workerTerminated. sourceAuthenticated is deliberately false: only the controller's separate authenticated field establishes pre/post source provenance.

Cold keys are exactly workerImportMs, ownerFirstCreateMs, initialConnectMs, initialReceiverConnectMs, firstP8Ms, firstP8AcceptanceMs and firstP8QueryMs. They are separate endpoints, not additive components. coldReceipt proves initial version 0 and first changed version 1 with exact independent checksums 19312 and 19313, firstEligibleReuse true and validated true. coldSourceBytesBefore/After must be identical passed receipts matching the fixture source-byte manifest.

Each source-byte receipt is `{passed:true, arenas:[...]}` with exactly 26 entries in construction order. Each entry has zero-based index, positive used prefix length, capacity at most 1 MiB and a 64-character SHA-256 of that used prefix. Total committed capacity cannot exceed 8 MiB. Before/after lengths, prefixes, capacities and hashes must match; no comparison between arms substitutes for this check.

Each row has batches, nonempty passed validations (at least before-row plus after-every-batch), valueValid, initialSourceBytes and finalSourceBytes. Rows run P8, P1, N8, R8, C8, F8, W8. N8/W8 additionally declare initialVersion and retainedVariant of the final retained P8 view. W8's checksum follows that variant. N8's checksum is operation count times its unchanged returned session version.

Every batch records stage, trial, global-within-row index, count, beforeVariant, startVariant, endVariant, elapsedMs, checksum, expectedChecksum, validated, sequenceStart, sequenceEnd, sessionSequenceStart, sessionSequenceEnd and sequenceReceiptSHA256. P8/P1/C8/F8 also record acceptanceMs and queryMs, each the aggregate within-batch component duration. Durations are not divided by count in raw evidence.

- stage is warmup/pilot for calibration (two/three per trial), warmup/measured for rehearsal/measurement (three/seven), or mechanism for the untimed preflight
- trial is 0–2 in calibration and null otherwise
- startVariant is the first operation's target, endVariant the last; first P8 target is 0 after the cold first reuse left variant 1, and first P1/C8/F8 target is 1
- sequenceStart/End are continuous row-local operation offsets, starting at 0, with difference count; they are not wire message sequences
- publication wire sequences advance by count; N8/W8 remain on final P8 version; R8 has no session and records 0
- sequenceReceiptSHA256 hashes the canonical object containing row, count, beforeVariant, startVariant, endVariant, sequenceStart, sequenceEnd, sessionSequenceStart and sessionSequenceEnd

The analyzer independently derives all checksums from formula-based integer-quarter prices. A driver's expectedChecksum and validated flag do not replace that calculation. A failed or missing per-row source-byte check excludes that endpoint from latency inference.

protocol records the real node:worker_threads route, sequential publications, fixed row order, acknowledgement-before-application-response (or both acknowledgements awaited), verified counts/order, snapshotsN8 0 and applicationResponses. rowCounts has exact P8/P1/C8/F8 snapshot/ack totals and final sequences plus copyFrames, fullMemoryFrames and omittedKnownMemoryFrames. The controller reconstructs those totals from batch operation counts. P8 includes its initial frame and the separate cold first change.

Mechanism groups additionally have untimed true, all cold and repeated endpoint durations null, and mechanism.passed plus exact initialP8/laterP8/laterP1/R8/C8/F8 instantiation counts. There is one operation in each publication/R8 row and two in N8/W8. They still execute ordinary value, source, identity and protocol validation. Supervisor-observed lifetime remains recorded for bounded execution, not efficacy.

## Controller observation and analysis

observations.json retains original report content alongside the exact group, frozen counts, raw report filename/hash, configuration filename/hash and controller-derived authenticated boolean. The controller never edits a raw report to assert trust. Failed groups retain their last durable checkpoint, command logs, cleanup receipt and admission data.

Analysis uses twelve independent paired blocks, each process's arithmetic mean of seven elapsed/count values, the fixed Student-t constant and the predeclared quality and bias rules. Component duration floors are applied independently to every measured component aggregate. Cold events use separate across-block CV/drift rules. All raw observations remain present; quality flags change interpretation without deleting data.

Partial observations cannot produce a lead. All twelve authenticated, value-valid B/C pairs can still produce the conservative adverse veto when auxiliary A, a different endpoint or a phase is incomplete. candidateBaselineSourceValueValidFullSample records the complete B/C subset; sourceValueValidFullSample additionally requires all twelve A observations. Missing, nonfinite, unauthenticated or invalid A never removes an otherwise complete C/B adverse interval, but prevents full-sample qualification, favorable clearance and study completion. Missing or invalid B/C cannot establish that endpoint's interval. The output identifies the engine, endpoint, absolute latencies, complete block values/log ratios, C/B interval, available A/B and chronological later/earlier-baseline intervals, quality/calibration flags and decision. It always sets performanceClaimAuthorized false pending the independent reconstruction audit.

The raw seal and external successful terminal receipt are both required. See PREREQUISITES.md for provenance documents, execution trust roots, preparation costs and final evidence validation.
