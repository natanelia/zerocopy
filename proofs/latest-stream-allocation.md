# Latest snapshot stream queue allocation candidate

Base: `3773c6e519c7c0958da13727ed1082f449f3ee25`.

The production change keeps the stream's existing queue object. Latest-mode publications assign index 0; termination clears its length. The waiting-consumer branch, FIFO push/shift behavior, public API, publisher transport queue, and worker pool are unchanged.

## Verified mechanism and behavior

Run after `bun run build:wasm` using Bun 1.4.2:

```sh
bun run test worker.test.ts
bun proofs/latest-stream-allocation.ts
```

The proof builds both worker sources against identical remaining production sources and instruments only array-literal expressions inside `Reader.snapshots`. It counts executed expressions, not inferred allocations from source occurrences. Actual sessions deliver all 10,000 publications to a paused default stream; publisher `delivery: 'all'` deliberately prevents transport coalescing from hiding stream callbacks. Two prebuilt immutable maps alternate to keep this mechanism check bounded. This fixture is not a performance workload.

Real MessageChannel sessions and Node workers each pass with shared and copy transport. In all four cases, baseline evaluates 10,001 stream array literals (one initial queue plus 10,000 replacements); candidate evaluates one initial literal. Eight waiting-consumer updates evaluate none in either version. Return evaluates one extra literal on baseline and none on candidate.

Baseline/candidate traces match for default and explicit latest mode, `emitCurrent: false`, initial and later versions, paused coalescing, simultaneous independent streams, concurrent `next()` rejection, all-mode FIFO/overflow, abort (including already aborted), return, throw, and disposal. Instrumented queue accessors verify empty queues after consumption/termination; this is deterministic removal of queue-held references, not GC, retained-memory, or heap-byte evidence. The functional worker suite adds the same key regressions in both copy modes. Existing real Node worker-session proof also passes.

No elapsed-time result was collected for this candidate. Capture, deserialization, transport, snapshot wrappers, and promise work can dominate the removed array expression. There is no established API speedup yet.

## Prospective clean CI protocol

Only proceed with a performance trial after the mechanism and functional gates above pass for the exact compared commits. Do not publish a performance claim from the mechanism count.

1. Build baseline and candidate from separate clean checkouts on the same runner, with identical WASM inputs and pinned Bun 1.4.2 / Node 22 dependencies. Record full commit IDs, source/build hashes, runtime versions, CPU, and runner image. Instrumentation is excluded from timed builds. No simultaneous jobs, tests, or browser runs on that runner during measurement.
2. Use the public `createSharedSession` / `connectSharedSession` / `reader.snapshots()` API over real Node Worker endpoints, with both shared and copy transport. Primary cases keep the default publisher delivery and default latest stream. Use a 256-entry map and cross a 32 / 4,096 update burst, one / four independent streams, and paused / continuously waiting consumers. Retain the initial snapshot and check it after every sample. MessageChannel sessions provide a smaller same-process control. Include a 32-update all-mode FIFO control and a lossless `delivery: 'all'` diagnostic; label the latter separately because default transport may coalesce before the stream.
3. Time from immediately before the first immutable update/publication to consumption of the final expected stream value. Include mutation, capture, transport, reader delivery, and consumption. A paused consumer begins reading only after a subscription confirms the final reader version; a waiting consumer repeatedly calls `next()` until it consumes that final value. Record publisher versions, reader deliveries, and consumed snapshots so differing coalescing cannot masquerade as faster equivalent work. Check value and version correctness outside each interval.
4. First calibrate a fixed repetition count on baseline only, then freeze it for both variants and every confirmation run. Run balanced randomized baseline/candidate process order, with six independent process pairs per job and three fresh clean jobs. Warm up each case identically. Record all samples and pair ordering; do not discard unfavorable cells or rerun only failed performance cells.
5. Report paired per-case ratios and confidence intervals, without a pooled headline that hides copy/shared or paused/waiting differences. Require repeatable end-to-end improvement in the intended paused-consumer cases, no meaningful regression in waiting-consumer or FIFO controls, and identical semantics/coalescing. If the effect is below runner noise or changes sign across fresh jobs, retain only the narrow mechanism statement and park the optimization. No microbenchmark-only speed claim.

The current strict worker consumer typecheck (`tsc --noEmit -p tsconfig.worker.json`) has the same pre-existing errors on baseline and candidate in `arena.ts` and `redux-jsan.ts`. Normal `bun run typecheck` passes. Resolve or explicitly carry those baseline failures in any clean CI trial; do not describe all type checks as passing.
