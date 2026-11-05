# Portable queue encoding: fixed study plan

The original plan was recorded before timing. The correctness amendment was recorded after the first pilot, and the final structural amendment below after the second pilot; each preceded its new source's measurements. Baseline: `77599337867dbf785a5f0311d34637d0b36678fc` in the isolated round-four baseline worktree.

## Hypothesis and boundary

The portable Redux encoder currently calls `peek()` and `dequeue()` once per queue item. Each dequeue constructs and freezes a temporary snapshot. Each committed-prefix peek separately resolves its vector path. A codec-local block scan can remove these temporary snapshots and resolve one leaf per at most 32 values, while retaining the same value decoder, recursive encoder, FIFO order, envelope and limits.

Only **number/boolean queues with at least 32 live items**, the original `peek`, `dequeue` and `isEmpty` prototype descriptors, and an exact base Arena with its original decoder take the direct path. This threshold was fixed before the original screening and remains unchanged. Smaller queues, string/JSON/nested types, custom decoders and replaced queue methods retain the old loop. Original method identities are captured in their defining modules, not at Redux import time; descriptor checks do not invoke replacement getters. Supported exact built-in instances keep their existing prototype-replacement behavior. Subclasses are already rejected by the codec's exact-prototype recognition and remain rejected. This is not a general guarantee for arbitrary changes to other internal arena methods, WASM exports or language intrinsics.

The completed first pilot at local `d910db0a5764f74f9d4f27c61e65ed0ac8dfd2f4` is superseded for a correctness issue: nested reconstruction can replace queue read methods during encoding, after the original one-time guard. A custom Arena decoder can do the same. Its exact source, tests, driver and plan are archived in `superseded-reentry/`, and every pilot observation is retained. The repair narrows eligible value types and checks the original decoder; it keeps all ten cases, sizes, repetitions/calibration rules and process methods. Run a fresh pilot for this repaired source. String/JSON cases are now unchanged-loop controls, not proposed speedups.

The second complete pilot at local `568aa128f31ef90fab2e2ff9e07dcee882864bc4` improved the numeric targets but showed adverse controls: Node empty and Unicode queues, plus Bun empty queues and the unchanged stack path. Its exact source/tests/driver/plan and every observation are retained in `superseded-inlined/` and `results/pilot-02.json.gz`. The final structural variant moves the same guards and raw traversal into a codec-local helper, leaving one call in the recursive generic `walk()` function. It passes the existing walker, output array and child depth directly, with no additional per-queue callback or array. Recursive-frame/code-size effects are a hypothesis, not a proven cause of those timings. All ten cases and benchmark settings stay fixed. Use a fresh pilot, then six fixed confirmation pairs only if credible; reject if clear adverse controls persist. No further source tuning follows this variant, and prior timings are not final gain estimates.

The queue class's methods, fields, binary format and public package exports are unchanged. The queue and Arena modules add internal original-method guards. Root's compaction candidate and the separate public queue-peek candidate are independent changes; their standalone speedups must not be added to this result.

## Fixed ten cases

Each case times the entire listed public operation, including its returned envelope or JSON text. Construction and verification are excluded. Native input values determine an independent expected envelope; the optimized traversal is never used to build the oracle.

| Case | Live items | Operation | Setup and purpose |
|---|---:|---|---|
| queue-empty | 0 | codec.encode | Existing-loop control |
| queue-one | 1 | codec.encode | Existing-loop control |
| queue-tail31 | 31 | codec.encode | Existing-loop control below the fixed threshold |
| queue-offset34 | 34 | codec.encode | Create 65 numeric items, dequeue 31; crosses prefix and tail |
| queue-number4096 | 4096 | codec.encode | Numeric target; includes special numbers |
| queue-stringify4096 | 4096 | codec.stringify | Complete portable text export of the same numeric shape |
| queue-unicode1024 | 1024 | codec.encode | Unchanged string fallback; decode cache warmed symmetrically |
| queue-json256 | 256 | codec.encode | Unchanged JSON fallback; decode cache warmed symmetrically |
| stack-number4096-control | 4096 | codec.encode | Unchanged sibling collection path |
| plain-array4096-control | 4096 | codec.encode | Unchanged ordinary-state path |

All repeated-read cases first execute and verify the same measured operation once. Timed warm-up repeats the same operation. The string and JSON cases fit the existing 2,048-value / 2 MiB decode limits; this study does not claim cold-reader performance. A later correctness proof separately covers fresh worker readers.

## Measurement protocol

- Preserve the exact production, tests, build-support, all WASM and complete portable JavaScript bundle identities; hash the driver, fixtures and this plan before and after. Use one imported build at one neutral copied pathname in each fresh process.
- Freeze source and driver before the two-pair Node/Bun screen. Preserve every screen observation, error and attempted variant in new paths. Screen results do not have inferential confidence intervals.
- If justified, confirm the unchanged candidate using six new balanced A/B process pairs per runtime and case. Alternate order, rotate cases, and retain all samples. Use the same repetitions for both sides, calibrated from both builds prospectively in the screen.
- Use at least 500 ms actual timed warm-up and at least eight warm-up batches for confirmation, then eleven measured batches. The independent unit is the process-pair median ratio, not a batch or iteration. Report paired geometric latency ratios and nominal 95% log-t intervals with five degrees of freedom, alongside all controls and absolute times. No multiple-comparison correction is claimed.
- Time complete materializations and retain every result through a global blackbox. Validate complete output after timing. The outer retained-results array is also timed. Cap repetitions by 65,536 calls, 1,048,576 estimated output slots and an estimated 32 MiB retained output per batch; these estimates are not a heap/RSS or total live-memory claim. Keep short/capped batches visible.
- Run all heavy builds/tests/benchmarks under the shared `/workspace/scratch/83f1d4baba1f/perf.lock`; pin timing controllers and children to CPU 2. Use Node 24.22.1 and Bun 1.4.2. Do not overwrite any result path.

The preferred acceptance evidence is a clear repeated reduction for the numeric encode and stringify targets in both runtimes, with the complete fixed matrix available. Slower controls must be assessed and disclosed; unchanged source is not evidence of unchanged speed. Marginal or inconsistent gains are grounds to reject the candidate.

## Semantic checks before acceptance

Check exact envelopes and JSON text; queue offsets/tails at 31/32/33 and vector levels 1024/1025; numbers including NaN, infinities and negative zero; booleans; Unicode/unpaired surrogate strings; JSON and nested collections; old snapshots/forks; read-only shared and copied workers; growth during captured-view reads and nested-decode reentry; node/depth/collection/text-limit failure parity. Preserve prototype replacements installed both before and after importing Redux, including accessor counters and replacement `isEmpty` getters, and replacements made during nested reconstruction or a custom decoder. No change to checkpoint Base64, long text search, TanStack materialization or historical proofs is part of this candidate.
