# Why the validation pass was split

V1 reused the recursive reconstruction function for validation. Arrays and objects selected different allocation/return behavior according to whether a resolving table was present. This removed the discarded state tree but added branches to the reconstruction loops.

The V1 pilot was interrupted after 63 of 64 planned subjects. In the available observations, Node's small-tree boundary case was slower in both pairs; the numerical-array case also had an adverse pair. The original partial recording and all completed observations remain retained. V1 is not treated as a completed confirmation or pooled with V2.

V2 gives validation a separate recursive function and restores the original reconstruction function unchanged. The source-informed hypothesis is that separate paths avoid the new per-element branches and mixed validation/reconstruction behavior. No profiler evidence establishes a particular JIT mechanism; that explanation is a motivation for the new candidate, not a measured conclusion.

The validation function still checks shapes, references, cycles, depth/node budgets, holes and duplicate keys before any WASM attachment. It preserves the existing input-read schedule. Record markers use a null-prototype object, and the final property key is coerced only after its child has been validated. Array proxies retain the original length-read order and native constructor error for invalid numeric lengths.

The tradeoff is duplicated tag validation. The reconstruction body remains byte-for-byte equal to the baseline; focused tests cover accepted tags, a malformed-tag corpus, budgets, repeated acyclic nodes, input accessors and error ordering on both the old and new implementations.

The eight workload cases remain the same. Before V2 timing, only the small-tree case's batch count changed from 256 to 1,024 repetitions because the V1 recording showed batches shorter than 2 ms. Counts remain identical between baseline/candidate and Node/Bun. Other repetition counts, warmup requirements, sample counts and comparison methods remain fixed. No source or workload changes are permitted during a study.

The byte-identical V1 source, workload, regression tests and validation record are archived under `archive/`. Historical `.test.ts` source uses a `.txt` suffix so the test runner does not rediscover it.
