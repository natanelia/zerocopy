# Final candidate: track recursive containers only

The completed V2 pilot retained every declared case. Node's flat-array result was slower in both pairs (ratios 1.085 and 1.053; paired estimate 1.069). Bun's primitive control was also slower in both pairs (1.074 and 1.401; estimate 1.226). These adverse observations remain in the pilot recording. Reviewing the dedicated validator showed that it inserted and removed every tagged primitive leaf from the active WeakSet, even though scalar and snapshot tags cannot recurse.

V3 keeps the initial `active.has(node)` check before reading any tag/value getters. It parses and returns valid scalar/snapshot tags without adding them to that set. Only array/object container traversal adds membership and removes it in `finally`. This removes two WeakSet writes per scalar or snapshot leaf during validation. The original reconstruction walk remains byte-for-byte equal to the baseline.

The initial ancestor check is essential. A cyclic ancestor can have a getter that changes its apparent tag to a scalar on the next read; checking membership first rejects the cycle before running that getter again. A dedicated regression test covers this condition. Ordinary input accessors, key coercions, read order, budgets and errors retain their existing behavior. Arbitrary replacement of built-in WeakSet methods to observe private bookkeeping is outside this compatibility proof.

No workload, fixture, operation count or statistical rule changes from V2. The final source is frozen before one six-pair full-matrix confirmation and a separately analyzed four-pair A/A subset. There is no V3 pilot. Neither earlier pilot is pooled with the final confirmation.

The primitive and snapshot-only cases keep their predeclared control role. V3 does change their initial scalar/snapshot validation, so they are scope controls rather than unchanged code paths. Their results remain outside the five-target headline. A/A still compares two copies of the identical baseline build.

V2 source, tests, validation notes, design rationale and browser output remain under `archive/`. V1's interrupted pilot and exact archived inputs are also retained. No adverse observation was removed from those studies.
