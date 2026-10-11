# Prospective timing method: empty-root HAMT return

Method preparation only. No driver, pilot, calibration, timing, proof branch, publication or execution is released. This study is conditional on independent acceptance of the completed exact V3 correctness result and review of a later executable packet.

The empty target was motivated by the earlier lazy-overlay-scratch study's nonprimary empty observation. That study failed to support its fixed map8 primary and remains parked. This is a different one-line patch, a fresh hosted cohort, and a prospectively fixed empty primary. Do not pool old observations, reuse their inference, retrospectively promote that control, or rerun the old patch under a changed primary.

Baseline: main `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`, tree `eb3bd4217f132e13b01c42f9b9c6bdc5aa92afab`; arena SHA256 `5ad9f7e4c4e7b9279b646fd758f3955c2597dd4f5f72a9a1445c487e3656cfb4`. Candidate arena `dd3f693928c0d1e2d80c53036e6cced82871606f0f68273ae38eaa173d706c97` inserts only `if (!root) return;` after the journal branch and before stack/scratch. Nonempty eager scratch is unchanged, but an additional falsy-root branch still executes on non-journal nonempty traversal. Its latency must be assessed, not assumed neutral.

## Six fixed public endpoints

1. **Sole primary:** fully exhaust a fresh `SharedMap<number>.values()` iterator on a fresh root-0 empty map.
2. **Changed-path empty control:** fully exhaust fresh `SharedSet<number>.values()` on a fresh root-0 empty set. It delegates to Map keys and the same HAMT traversal.
3. **Nonempty changed-path control:** canonical Map values, 8 entries.
4. **Nonempty changed-path control:** canonical Map values, 4,096 entries.
5. **Nonempty changed-path control:** Map values on the exact accepted late/repeated-overlay correctness fixture. Assert its canonical root, one leaf before the first overlay, at least two distinct overlays and disjoint first two overlay bitmaps.
6. **Unchanged-path control:** natural SharedSortedMap values, 8 entries, no custom comparator; its separate radix traversal is unchanged.

Canonical maps use rows `[key0, 0]` through `[key(N-1), N-1]`, built once by public setMany. The natural sorted control inserts the same eight rows through eight public sets. Empty Map and Set roots and sizes must both be 0. The overlay fixture and independent model are reused exactly from the accepted correctness harness. No journal timing endpoint: journal semantics remain covered by correctness, with no journal speed claim.

The metric is ns per complete public traversal, including wrapper/generator/decoding/checksum work. Each iteration creates and exhausts a fresh public iterator; each yielded number updates the accepted unsigned checksum kernel. Retain and independently validate traversal counts, consumed-value counts and checksums. Empty endpoints have zero consumed values/checksum, but still retain completed traversal counts. Construction/imports/topology checks/model validation occur outside timing; no timed array materialization, forced GC, writer updates, arena rewind, allocation interception or constructor probes. Assert unchanged native used bytes and original payload prefixes after every phase. Natural allocation/GC cost stays inside timing. An optimized empty loop may remain too short; that produces an unresolved cell, never a substituted endpoint or increased cap.

## Reused protocol and setup

Reuse the accepted warmed paired protocol in the pinned predecessor method, with its final hosted runner's fail-closed diagnostic, unresolved-timer, signal-forwarding and original-process-group cleanup rules. Source references bind those exact files. Only the six endpoint roles/fixtures change as listed above; protocol, priorities, limits and statistics below freeze before any calibration.

Use one sequential ordinary GitHub-hosted ubuntu-24.04 job, official Node 22.23.3 and Bun 1.4.2. Keep Bun's source entry and Node's portable entry, with identical fixture models. A later executable review must pin official action identities, exact payload/argv and one-attempt admission; this document does not authorize publication. Record runtime/component hashes, CPU, OS, runner image and affinity. Dependencies resolve once with scripts disabled and pinned reviewed versions. Build unchanged native inputs once on that host and share identical bytes across both arms; do not assert cross-host binary identity. Fresh arms, exact guard, strict emitted/native/declaration checks and the exact twelve-command correctness gate must pass there before timing inputs are bound. Preserve setup/correctness receipts separately. Remote contention remains a limitation.

## Warm calibration and measurements

- Four untimed engine/arm six-case smoke children: 15-second/1,536-MiB caps. Then 24 calibration children, one per engine/arm/endpoint: 25-second/1,536-MiB cap and at most 2^31 cumulative traversals each.
- Geometric probes start at 1,024 traversals, multiply by four and clip at 2^27 per batch, seeking at least 100 ms. Failure at the cap stays calibration-short.
- Warm at that successful probe count for at least eight batches and 1,000 ms total, maximum 128 batches. The fastest rate of the last four warm batches selects one count targeting 250 ms, rounded up to 1,024. Run exactly three pilots there, each at least 100 ms. No pilot reselection, restart or unresolved/zero timer duration qualifies.
- Use the fastest of both arms' six pilots to choose one common count N targeting 1,500 ms, rounded up to 1,024. Both arms must qualify. N above 2^27 is capped/unresolved, not clipped into validity. Seal all cell counts before any measured child starts.
- Each fresh measured child runs four N/8 warmups and one N observation, with no adjustment or replacement. Require at least 350 ms total warmup and 500 ms observation; retain every phase duration/checksum. Child limits: 15 seconds and 1,536 MiB. Each child exposes one fixture arena with maximum 16 MiB; each six-case smoke permits at most six. RSS is a safety limit, not a memory-savings endpoint.

## Fixed schedule and resource arithmetic

Twelve engine/endpoint cells × four independent four-process blocks = **192 maximum measured children**. Blocks 0/2 use ABBA; 1/3 use BAAB. Alternate engine order by block and rotate six endpoints deterministically. Freeze full order before measurement; start a child only after the preceding original group is confirmed empty. Never pool engines.

Each measured child's nominal work is four × 187.5 ms warmup + 1,500 ms observation = 2,250 ms. Across 192 children: **432 seconds**, including 144 warmup and 288 observation seconds. Add reserves of 144 seconds for 24 calibrations/four smokes, 120 for startup/validation/authentication, 30 for final analysis/full authentication and 15 for cleanup: **741 seconds** planned. The authoritative **900-second cohort cap** leaves 159 seconds beyond that subtotal. Targets/reserves are not hard bounds or a completion guarantee; individual caps can exceed the total budget. Do not launch into the final 15-second cleanup reserve. One final analysis child has a 30-second/512-MiB cap inside the cohort.

Keep separate seven-minute setup and seven-minute correctness limits; one minute for correctness-to-timing binding, sixteen for timing/finalization, two for export and two for upload. Checkout and two official runtime setup steps each have two minutes (six combined). These step maxima total 41 minutes; job backstop is 45 minutes. Host death can still prevent cleanup/export. The four smokes, 24 calibrations, 192 measurements and one analysis are at most 221 timing-controller children, plus fixed metadata checks; skipped slots remain recorded.

A clean duration/cap outcome leaves that cell incomplete, retaining its scheduled not-run rows while other fixed cells may proceed. Unexpected semantic/hash/identity/diagnostic failure or uncertain cleanup stops the cohort. Invalid finalization suppresses qualifying inference. No automatic retry, outlier removal, extra blocks, endpoint replacement, larger counts/caps or posthoc resampling.

## Frozen analysis and decision rules

The independent unit is the four-process block: log(candidate geometric-mean time / baseline geometric-mean time). Show all raw arm/warmup observations, block ratios, geometric mean, median, between-block log SD, repeated-arm drift and uncertainty for every case, including failed, short, capped, unstable and not-run outcomes. No reduced-block inference.

Only empty Map values is primary. Require all sixteen measurements/all warmups valid, all four block ratios favorable, and a one-sided 97.5% Student-t upper bound (df 3) on candidate/baseline **at most 0.95 in both engines**. This preserves the paired at-least-5% criterion and Bonferroni allocation across two primary comparisons. Four approximately independent normal block log ratios give limited precision, not a universal guarantee.

Let D be the larger median absolute repeated-A/repeated-B log difference across four blocks. Require D ≤ log(1.05) and pooled eight-value interpolated p90 drift ≤ log(1.15), ascending index 6.3; otherwise unstable. A supported primary's conservative log-gain bound must also exceed 2D.

Every complete/stable endpoint gets pointwise one-sided 95% regression bounds. A lower bound above 1.02 establishes a scoped greater-than-2% loss and blocks promotion; an upper bound at or below 1.02 supports only that endpoint/engine guard. Crossing, short, unstable or incomplete controls remain unresolved and visible separately from any primary benefit. No automatic PR promotion or general regression clearance follows.

Equivalence assumes ordinary native private bookkeeping and successful allocations; arbitrary Uint32Array replacement, allocation failure, source-text identity and GC/finalization observations remain excluded. This screen supports only its fixed traversal workloads. It makes no get/write, application-speed, journal-speed, retained-memory, RSS, per-key-byte or existing docs-chart claim. Other holds remain untouched.
