# V3: preserve dynamic deletion overrides and private ownership

V2's full pilot is preserved in `pilot-v2.json` and its Arena source in `archive/arena-v2.ts.txt`. It is not accepted. The large primary target improved, but Node's smaller target was noisy and estimated only 8.7% less time. Node's all-missing control estimated 13.1% slower. Bun's unchanged scalar delete estimated 19.8% slower, with both pairs slower.

Independent source review also found a compatibility defect: after the scalar prefix, V2 did not dynamically call an overridden `Arena.delete` for each key. Seven added regressions fail V2 and pass the baseline: subclass/own/prototype deletion hooks, hooks installed by an iterator on the fifth and eighth keys, a getter returning the native method, and an overridden `used` getter.

V3 leaves the first-four/all-missing scalar path unchanged. For each later key it reads `this.delete` once, at the original dispatch point. A function other than the captured native method executes with the original receiver and arguments. The ownership watermark is then cleared. The next native deletion starts above the current allocation frontier, so roots exposed or published by a custom hook remain immutable. A getter that returns the native method is still observed exactly once per key.

The watermark reads `wasm.getHeapEnd()` directly rather than observing an overridable `used` getter that the original public operation never reads. This also ensures the ownership boundary comes from the native allocator.

No V3 performance claim follows from V1/V2 measurements. The native code is unchanged from those variants. Static inspection found the scalar-deletion instruction bodies and call graph unchanged after index renumbering; that does not explain or dismiss the observed Bun scalar loss. A new performance study requires a separate frozen source and explicit evaluation decision.

## Final method declared before any V3 timing

The final matrix keeps all nine original workloads, inputs and repetition counts. Three controls are added: eight deletions, sixteen deletions, and four successful deletions followed by 1,020 missing keys. The two ASCII large-batch cases remain primary acceptance targets; Unicode remains secondary. The original driver, workload and verifier stay unchanged for V1/V2. V3 uses separately named files.

All twelve cases use six fresh process pairs per runtime, alternating AB/BA order, at least eight warmup batches and nine measured batches. Tiny scalar/four/eight/sixteen-key controls use at least 150 ms actual timed warmup. All other cases use at least 500 ms. This is a declared V3 method change, not a change to recorded V1/V2 measurements. The prior pilot showed the scalar control spent a median 14.7 seconds per process on full-result checking despite only 150 ms actual timed warmup; its hundreds of thousands of calls are retained. Both variants use the same per-case minimum and repetition count. The driver records the effective minimum and every raw duration; the independent verifier enforces the per-case rule and all operation/batch counts.

Every output is still checked completely. V3 walks public `forEach` instead of allocating `entries` pairs during verification, equally for both variants. The independent hash-order/value oracle, no-op identity, complete original-byte invariant and allocation observations are unchanged. Fixture creation, full verification and source reconstruction remain outside the timer. Verification may still affect later collection and JIT behavior; no allocation-free timing claim is made.

The separate A/A study runs four same-baseline process pairs for the 1,024-removal target, four/eight-key controls, all-missing control and unchanged scalar delete. It uses the same per-case warmup rules. Formal A/B comprises 288 fresh processes; A/A comprises 80. No A/A estimate is subtracted from A/B, and no earlier pilot is pooled with final timings.

The acceptance thresholds remain unchanged: primary paired time reduction of at least 10% in both runtimes, with the descriptive interval excluding parity; material unresolved control loss blocks acceptance. The additional controls and any unfavorable observations remain in the report. If final evidence fails, this candidate is rejected rather than rerun until favorable.
