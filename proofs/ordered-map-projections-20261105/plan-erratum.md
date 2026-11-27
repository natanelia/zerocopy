# Correction to the V2 rationale

Recorded during V2 screening, before formal confirmation. The hashed measurement plan is retained unchanged as a historical record.

The V2 amendment in [plan.md](plan.md) incorrectly says the baseline never acquires a memory view for an empty map. The exact baseline `entries()` already executes `const a = this.arena, order = [], view = a.dv` before reading the insertion-log head. V1's direct projections also execute that setup. The observed Node empty-projection slowdown in V1 therefore cannot be attributed to a newly introduced view acquisition; its cause has not been established.

V2's early empty-log return removes unnecessary setup that exists in both the baseline and V1. The regression test establishes that V2 does not acquire a view for fresh or deleted-to-empty maps. Timing measures whether that change helps; it does not prove the cause of V1's slowdown. This correction changes no source, workload, warm-up, calibration, sample count, process schedule, output check or acceptance rule. The complete V1 and V2 observations remain part of the evidence.
