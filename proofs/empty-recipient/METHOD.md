# Empty publication recipients: prospective latency screen

**Source-only method v3, 2026-10-15.** Baseline: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. No subject imports, builds, tests, calibration or timing occurred. This document does not authorize execution.

## Usefulness and limits

This is a small constant-bookkeeping opportunity. With no peers, the proposed `Publisher.commit` guard omits the Frame literal and empty peer snapshot loop. Inside `notify`, the empty-listener return occurs only after the original call arguments, including `options.onError`, have been evaluated. State/version progression and every nonempty loop remain unchanged. Engines may already eliminate some transients; ordinary nonempty calls acquire size checks. No actual allocation or performance saving follows from source syntax.

The sole primary measures complete changed public publication by a local holder with no peers or subscribers, alternating prebuilt immutable roots. This represents frequent small local publications before connection or while disconnected. It excludes root creation, application work and transport. Seven rows suffice: the primary, listener/real-peer controls, a larger root group, and unchanged publish/flush. No width sweep, internal `notify` benchmark or lookup-throughput proxy is warranted.

The real-peer controls measure **synchronous latest-mode burst submission**, predominantly pending replacement after one initial send. They are not end-to-end delivery latency, throughput of delivered snapshots, worker-computation performance or a separate primary. Reader-side empty notification is exercised during untimed draining, not isolated or timed. The screen cannot establish application-wide, memory, startup or platform-portability improvement.

## Admission and identity

Admit only the independently reviewed two-guard production delta. First require the exact final sources to pass the reviewed focused Node/Bun correctness gate: empty/nonempty recipients, live error-handler getters, reentry, snapshot membership, callback errors/promises, ordinary connections and reader progression. Publication without peers followed by a later new connection is supported by source review, not a dedicated focused execution case. Authenticate identical focused tests in both arms. Endpoint lifecycle redesign and registration-failure injection are outside this technical evaluation.

Retain the established broad gates in each arm: `bun run prepublishOnly`, `node proofs/node-worker.mjs` and `node proofs/typed-json-worker.mjs`. The first is build/type/full-Vitest/Redux/package verification, not publication. Missing dependencies, unrun or failed gates block timing. Broad admission retains 27 minutes overall, 600 seconds per aggregate command, 90 seconds per worker command, sampled 4 GiB owned-group RSS and owned cleanup. Disclose correctness preparation separately.

Pin Node **22.16.0**, Bun **1.4.2**, executable/dependency/lockfile hashes, source inventories, build inputs/flags, WASM, output chunks, harness and this method. Node imports matching `dist/shared.js` then `dist/worker.js` from one normal portable build; Bun imports matching `shared.ts` then `worker.ts` from one checkout. Use canonical URLs once, no cache busting, mixed routes or independent rebundling. Baseline B and second baseline A have identical pristine production bytes; C differs only by the reviewed guards. Seal before calibration. Later source/harness changes require a newly reviewed study. No private imports, instrumentation or intrinsic patches.

## Fixtures and seven rows

Before construction, use public `configureMemory({maximumBytes:131072})` and `resetMap()` once. Construct 24 numeric singleton maps M0…M23, each with key `value` and value its index, in that arena. Construct M23b from M23 by setting `value` to 24. Freeze two records R0/R1 with insertion-ordered keys `m0`…`m23`; R1 differs only at the final map, M23b. No subsequent collection mutation, arena reset/growth or record construction is timed. The 128 KiB arena ceiling is a growth bound, not measured memory savings; construction failure blocks the screen.

Each row has its own public `createSharedState` holder, initialized with its revision-zero input. Use ordinary options with `delivery:'latest'`, `timeoutMs:10000`, and one stable error-latching callback. Pin normal transport defaults explicitly: Node `copy:false`, Bun `copy:true`. This predeclared engine difference applies identically to B/C/A; local capture remains the same operation. No source binding, update scheduling or batch API is used.

| ID | Timed public operation | Recipients and purpose |
|---|---|---|
| P | Alternate M23/M23b with `publish` | No peers/listeners; sole primary |
| L1 | Same changed publication | One owner subscriber, no peers |
| E0 | Same changed publication | One ready real peer, no owner/reader subscribers |
| E1 | Same changed publication | One ready real peer, one subscriber on each end |
| W24 | Alternate R0/R1 with `publish` | No recipients; 24 roots in one arena |
| U1 | Repeated `publish(M23)` | No recipients; unchanged capture/publication control |
| F | Repeated `flush()` | No recipients; unchanged-path A/A sentinel |

Run rows in this order. W24 represents a record-root workload as well as larger width; it does not isolate root count from single-versus-record capture. Changing its final root retains preceding comparison work. L1/E1 owner subscribers synchronously update only scalar call count, version checksum and last snapshot/version, returning `undefined`; no timed collection lookup or output history. E1's reader subscriber records equivalent scalars outside the timed loop. No subscriber is installed on E0's reader.

Validate fixture values, key order, descriptor types/roots and one-arena topology with public reads and `getWorkerData(...,{copy:false})` outside timing. Both revisions retain identical arena membership and different final-root descriptors. Retain the inputs and verify their unchanged contents throughout.

## Real-peer boundary and draining

Use unmodified native `MessageChannel` ports from `node:worker_threads`, supported through each pinned runtime, in the measurement process. Connect the holder to one port and `connectSharedSession` to the other; await both public connection promises outside timing. Failure blocks the screen, without a fake-port fallback. This is real structured-clone/message transport, not a separate worker thread.

Use the native EventTarget `addEventListener('message', ...)` API for the read-only owner-port observer, matching the library's preferred listener API when `addEventListener`/`removeEventListener` exist; read each message from `event.data` and remove the observer with `removeEventListener`. Register it **after** `holder.connect` installs the library's listener, before completing the handshake. Require registration-order dispatch through that same API, without mixing EventEmitter `on` listeners. Unavailable same-API ordering fails preparation before calibration, with no mock or alternate transport. Bind the observer to the exact channel and nonempty owner/reader identifiers from the initial sequence-zero acknowledgement; validate `protocol:'zerocopy/session'`, wire version 1 and `kind:'ack'`. Never alter, intercept or synthesize protocol messages, wrap endpoint methods, or inspect private fields.

Before each timed batch, the prior final acknowledgement must already have completed. Arm an outside-clock latch for the independently predicted final sequence. Time a synchronous loop with no yield: its first changed publication transmits a frame and arms the library's acknowledgement timeout; later calls replace the latest pending frame. Message events cannot acknowledge during this loop. Timer creation/transport submission for that first send belongs to the elapsed batch; do not subtract it. It is one first-send cost per batch, diluted by the frozen batch count, not one per publication.

After stopping the clock, await the exact final acknowledgement. The earlier-registered library listener processes that event first; resolve the observer latch and resume after event dispatch/microtask completion. Require both the matching final acknowledgement and the public reader's final version/content, with both endpoints still open and no error latched. A version read or arbitrary `setImmediate` turns alone is insufficient. Observer identity/order support must be validated before calibration; otherwise do not time the peer rows.

The first and final submitted versions are delivered (one version when count is one); intermediate latest-mode versions may be skipped. For E1 verify these reader callback versions/counts outside timing. Drain every pilot, warm-up and measured batch with a 10-second deadline, also subject to child/whole-study caps. Draining, reconstruction, reader callbacks and acknowledgement processing are excluded from the reported submission duration. Do not increase timeouts to salvage a run. Dispose sessions and close owned ports outside timing.

## Clock, consumption and validation

Changed rows retain their revision bit and holder across all batches/trials; toggle before every call, including at odd-count boundaries. Inside each batch include only that selection, public call, returned-version-plus-one checksum and latest-return assignment. Unchanged rows repeatedly use their original input or flush. Use a high-resolution monotonic timer; no empty-loop subtraction or per-operation snapshot reads.

For n changed calls starting at expected version v, require final returned/public version v+n and checksum `n*(v+1)+n*(n+1)/2`. Check selected revision, direct-single snapshot identity, or complete frozen record keys/map references after timing. U1/F remain version zero with checksum n and unchanged current identity. L1/E1 owner callback count/checksum must match every publication. Validate every batch, including discarded batches; exact content checks remain outside timing. Count caps keep arithmetic exact. Keep scalar sinks only.

Construct P first and emit readiness before its first changed publication. Time that one public publish before fixture validation; retain the holder and advanced revision/version for P. Record parent spawn-to-readiness separately, including import/construction/scheduling/message overhead. This is first changed publication after construction, not cold runtime latency. Record it for all measurement children, apart from warmed estimates; calibration observations are separate. Finish remaining setup and exact validation afterward.

## Fixed sampling and bounds

Reuse the established runner: six fresh B/C/A blocks per engine, **36 measurement children**, and one baseline-only calibration child per engine, **38 total maximum**. Orders are `B C A`, `A B C`, `C A B`, `B A C`, `C B A`, `A C B`. Node runs first in odd blocks, Bun in even blocks. Children run sequentially on one host without concurrent study builds/tests/benchmarks.

Calibration starts each row at 256 operations: five warm-ups and three pilots per trial, at most four trials. Accept pilot median 20–50 ms, target 30 ms; otherwise multiply count by 30 ms/median, round and clip to [1,2^20], except F may reach 2^24. No candidate calibration. Uncalibrated P blocks measurement; other uncalibrated rows retain their last attempted counts and remain unresolved with adverse evidence preserved. Freeze per-engine counts before measurement; exclude calibration from estimates.

Each measurement row receives **five discarded warm-ups and nine measured batches**. A process mean is the arithmetic mean of nine elapsed-per-operation values. Retain all data: no explicit GC, outlier removal, trimming, selective repeats or optional stopping. Quality is unresolved for nonpositive/nonfinite duration, any measured batch below 10 ms, batch CV above 25%, or last-three/first-three mean ratio outside 0.85–1.15. Any P quality failure blocks a gain verdict. Control failures remain explicit. Wrong output, missing child, timeout, crash or resource termination makes the whole screen incomplete.

Calibration through analysis and cleanup share **870 seconds**, **90 seconds per child**, no replacement children. Sample summed owned-process-group RSS every **50 ms**, terminate at **2 GiB**, and reserve two seconds for termination/reaping inside both wall caps. Sampling may overshoot/double-count shared pages and perturb scheduling; it is a safety guard, not a memory outcome. No virtual-address limit or runner reconfiguration. Preserve partial evidence and reap descendants; remove only identified study-created disposable copies.

## Fixed decision and reporting

For every engine/row/block use `d=log(C/B)`. Report ratio `exp(mean(d))` and paired two-sided 95% Student-t interval `exp(mean(d) ± 2.570582*sd(d)/sqrt(6))`. Processes, not batches, supply replicates. No bootstrap, engine pooling, favorable-baseline choice or A/B averaging. Small-n log-ratio assumptions and shared-host limitations remain explicit.

Also report A/B and chronological later-baseline/earlier-baseline intervals. Major systematic A/A bias means an entire interval above 1.05 or below 0.95. Major P or F bias blocks a gain verdict; other biased controls remain unresolved. Crossing one or a noisy point alone is not regression evidence.

P must have ratio **≤0.95 and 95% upper bound ≤0.95 in both engines**, with complete admission/calibration/quality and no blocking A/A bias. **Any of the six controls with 95% lower bound >1.02 in either engine parks the candidate**, even with unresolved quality. An upper bound >1.02 without such a lower bound is unresolved, not passed; unresolved calibration/quality/A/A also remains explicit. No extra samples resolve uncertainty. First-publication/startup diagnostics remain descriptive and unresolved; apparent material adversity requires review before promotion. Unadjusted controls are warning screens, not simultaneous no-regression certification.

Report absolute ns/public call, all process means/paired ratios, intervals, calibration, quality/A/A diagnostics, first-publication/startup observations and peer-batch counts. A pass is only a **promising hosted recipient-free publication-latency lead, with named unresolved controls**. Failure of the fixed primary rule ends this screen. Preserve commands/cwd, pins/manifests, host/runtime metadata, timestamps, stdout/stderr/status, raw data and analysis inputs/outputs.

Promotion still requires browser/platform CI and contributor checks: `bun run test:browser`, `node --test scripts/check-docs.node.mjs`, `node scripts/check-docs.mjs --base afdffdcfcbd61013f120de82411c0c4a6b2d1e0e --preserve`, `node scripts/check-doc-examples.mjs`, and `node scripts/check-doc-browser.mjs`. This prospective screen establishes neither those checks nor publication readiness.
