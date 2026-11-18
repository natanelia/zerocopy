# Addendum: fixed adjudication of the short warm-cache A/A hold

Date: **2026-11-18**

This addendum is declared while the main A/B study is still running and before
its results are interpreted. It supplements the fixed-repetition section of
`ascii-current-confirmation-PLAN.md`. It changes no runtime code, workload,
primary acceptance gate, or existing evidence file.

## Trigger observed before interpreting A/B

The completed, verified main A/A study has one validity HOLD:

- Runtime/case: **Bun `list.string.get.ascii16.warm`**.
- Median paired ratio: **1.1468**.
- The nominal candidate side is slower in **6 of 7 pairs**.
- Batches are **below 20 ms**.

The other main A/A rows do not meet the plan's combination of a ratio outside
0.90-1.10 and at least six pairs pointing in the same direction.

This observed A/A result triggers the conditional longer-batch block below,
**regardless of whether the main A/B warm-cache ratios are favorable or adverse**.
The block investigates this specific measurement-validity problem. It is not an
attempt to replace an unfavorable A/B result with a preferred result.

## Eligibility: decide before running the block

Run the block only if all other main A/A and A/B gates remain eligible:

1. Both main reports must be complete and independently verified.
2. All four Node primary workloads must satisfy the original median-ratio and
   six-of-seven faster-pair requirements. A failed primary gate rejects promotion;
   do not run extra warm-cache tests to rescue it.
3. There must be no confirmed Unicode or other material control regression in
   either runtime. Such a regression rejects the candidate and cancels this
   extra block. In particular, a confirmed Bun `map.keys.unicode.cold`
   regression is not eligible for this warm-cache adjudication.
4. All controls outside the affected short warm-cache block must meet the
   original eligibility rules. Any other unresolved HOLD remains a HOLD and
   does not authorize this block as a general rescue experiment.
5. The only issue admitted to this block is the identified warm-cache A/A
   validity problem, together with any short warm-cache uncertainty already
   covered by the original plan. It does not excuse an otherwise confirmed
   control regression.

If any disqualifying result is present, preserve all main results, record the
rejection or HOLD, and **do not execute the extra warm-cache block**.

## Fixed block: separate A/A, then A/B

If eligible, run exactly the following block once:

| Setting | Fixed value |
|---|---|
| Studies | Separate A/A first, then A/B |
| Runtimes | Node, then Bun |
| Cases | Both cases named below, in both runtimes |
| Pairs per runtime | 7 |
| Variant order | A-B, B-A, A-B, B-A, A-B, B-A, A-B |
| Batch scale | 16 |
| Warmups | 8 |
| CPU affinity | Controller and every worker restricted to CPU 2 |
| Artifacts | Exactly the frozen current-main formal-study source, bundles, controller, workload, and verifier |

Selected cases, in catalog order:

1. `list.string.get.ascii16.warm`
2. `map.keys.ascii16.warm`

Workload order rotates by pair index using the unchanged controller. Each report
contains 28 fresh worker processes and all four runtime/case combinations. Each
case has 4,194,304 timed reads or yielded keys per sample. Construction,
attachment, warmup, GC, and exact-result/state verification remain outside timing.

Use the same current-main baseline and candidate artifacts as the main study;
do not rebuild or tune them. Require identical source, bundle, and harness
manifest identities to the main reports. A/A compares the same baseline bytes
with themselves. Require `environment.allowedCpus === '2'` and every sample's
`allowedCpus === '2'`. No concurrent builds, tests, compression, or other
benchmarks may run in this slot.

Save new, non-overwritten reports, for example:

- `ascii-current-warm-scale16-aa.json`
- `ascii-current-warm-scale16-confirmation.json`

Complete and independently verify both reports. Do not stop or select rows
based on interim results. There is no second batch-size adjustment or further
runtime variant.

## Interpretation remains governed by the original plan

The new A/A report is assessed using the original 0.90-1.10 band and
six-of-seven directional-consistency rule. Any remaining validity concern stays
held. Keep all sub-20-ms warnings visible; a longer requested batch is not itself
proof that a timing problem was resolved.

For the new A/B warm-cache rows, any control median above 1.10 is at least a
HOLD. A median above 1.10 with at least six slower pairs is a replicated material
regression and rejects the candidate. Primary Node requirements and the status
of all non-warm controls remain unchanged.

Even if this block resolves the warm-cache validity HOLD, the original main A/A
row remains recorded as a failed validity check. Present the original main A/A,
main A/B, longer-batch A/A, and longer-batch A/B results together, with their
different batch scales and the predeclared reason for the follow-up. Never
overwrite, replace, silently discard, or relabel the original result as passing.

Do not subtract A/A, divide A/B by A/A, pool the different-scale measurements
into a replacement main result, or choose the most favorable report. Any final
claim remains limited to the predeclared Node ASCII improvements and must
surface material adverse controls in either runtime.

This addendum schedules no unconditional execution. It was saved without
running tests, builds, compression, or measurements and without modifying any
existing source, plan, harness, or evidence file.
