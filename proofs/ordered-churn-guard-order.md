# Focused ordered-scan guard-order experiment

The original ordered-churn candidate 82f8d9c produced large high-churn gains, but
its compact gate detected a Node singleton-replacement latency loss of 6.27%
(95% quartet interval +5.22% to +7.32%). The result and raw artifacts are retained;
this follow-on does not replace or reclassify them.

This experiment changes exactly one condition order in shared-ordered-map.ts:
test tail > size before !orderStable. Ordinary replacements have tail==size,
so they can exit before the stability check. No log loop, sorting algorithm,
threshold, decoding, worker, class layout or singleton fast path is changed.
The hypothesis is narrower than an assumption that the original loss came from
this guard. Append-only singletons now read two counters before skipping the
adaptive branch, so they are explicitly included to expose that tradeoff.

## Sources and study

Three sources run on the same Node/Bun x64 runner:

- Main 3773c6e519c7c0958da13727ed1082f449f3ee25
- Original 82f8d9cc9d81c459ecbd0d9c06189e0fa9ec5120
- Reordered source at the exact workflow-event SHA

The original measurement function, fixture/oracle, source guard and interval
formula must remain byte-identical to original 82f8. Each source is checked against
its pin; the original/reordered runtime text must differ by precisely that one
replacement. Every generated WASM file must match. Only the two focused x64
jobs run on this branch; the full architecture/browser matrix remains held.

The six cases are append-only and replaced number maps at sizes 1, 32 and 4096.
There are three direct comparisons (main/original, main/reordered and
original/reordered) plus matched A/A for all three builds. For each case, three
disposable pilots choose a single work plan from the fastest build. Timed repeat
counts and warmup scan counts are fixed before measuring any build or A/A role.
All subjects use fresh processes and the same neutral import path, with the actual
identical package.json copied byte-for-byte and the original dist-relative layout.
Package and bundle hashes are verified before and after each subject. Exactly two
ABBA and two BAAB quartets per comparison are assigned by seeded ranks, preserving
the existing case/mode interleaving and random stream. These four balanced quartets
supply eight adjacent process pairs.
Quartets, not their pairs or batches, are the independent statistical units.

Settings stay fixed: 21 batches per measured process, 10 ms target batches,
150 ms minimum pilot warmup, 262144 minimum elements, four quartets, 95% Student-t
intervals on quartet-mean log latency ratios and a 2% non-inferiority margin.
There are 594 fresh subjects per runtime (18 pilots plus 576 measured subjects).
All samples, source/bundle/harness hashes, prescribed work, process order,
absolute timings and flags are retained. A/A is never used to adjust A/B.
Lower latency-ratio bound >1.02 means a material loss; upper<=1.02 means evidence
within the margin; other outcomes are inconclusive. The right/left build direction
is explicit for every comparison. Small shifts and uncertainty remain visible.

No local speed experiment or timing-based runtime selection is part of this
preparation. Any promotion waits for the focused evidence and review. High-churn
gains from the original candidate cannot offset a common-path regression.

```sh
node --test proofs/ordered-churn-guard-order.test.mjs
node proofs/ordered-churn-guard-order.mjs MAIN/dist/shared.js ORIGINAL/dist/shared.js REORDERED/dist/shared.js node.json
bun proofs/ordered-churn-guard-order.mjs MAIN/dist/shared.js ORIGINAL/dist/shared.js REORDERED/dist/shared.js bun.json
```
