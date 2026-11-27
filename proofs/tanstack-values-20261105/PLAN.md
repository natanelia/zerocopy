# SharedCollection value materialization: fixed study plan

Baseline: `09b1a385a7c2ac9b027a4055335ae2f9449abe6e` in
`zerocopy-r2-final-base`. Plan recorded before measurements on 5 November 2026.

## Hypothesis and scope

`SharedCollection.toArray()` currently uses `SharedMap.entries()` and discards
every key. Using the existing `SharedMap.values()` iterator avoids decoding keys
and allocating discarded entry pairs. Both iterators visit the same immutable
HAMT leaves in the same order. This changes only the TanStack adapter, with no
core traversal, JSON codec, cache limit, snapshot format, or text search changes.

Expect the largest improvement when decoded object values already fit the
reader cache. Include fresh-reader decoding and cache overflow so the report
does not generalize that gain to all object workloads. An additional
`toArray()` followed by `entries()` case measures complete downstream work when
keys have not been warmed by the value-only operation.

## Fixed ten-case matrix

| Case | Rows | Keys / values | Reader state and operation |
| --- | ---: | --- | --- |
| empty | 0 | ASCII / flat objects | Warm, `toArray()` |
| single | 1 | ASCII / flat object | Warm, `toArray()` |
| warm-ascii | 256 | ASCII / flat objects | Warm keys and values, `toArray()` |
| warm-unicode | 256 | Long Unicode / flat objects | Warm keys and values, `toArray()` |
| warm-cache-boundary | 2048 | ASCII / flat objects | Warm keys and values, `toArray()` |
| warm-cache-overflow | 4096 | ASCII / flat objects | Identical cache warm-up, `toArray()` |
| fresh-ascii | 256 | ASCII / flat objects | Fresh shared reader for each operation, `toArray()` |
| fresh-unicode-nested | 256 | Long Unicode / nested objects | Fresh shared reader for each operation, `toArray()` |
| fresh-array-then-entries | 256 | Long Unicode / flat objects | Fresh reader, `toArray()` then complete `entries()` |
| entries-control | 256 | Long Unicode / flat objects | Warm keys and values, complete `entries()` only |

Keyed reads are also correctness checks after materialization. This is a bounded
matrix, not every possible size/key/cache combination. Cold reader means its
local decoding caches are empty, not a cold CPU cache or first module import.

## Measurement and correctness

First screen the frozen candidate with two balanced fresh-process pairs per
runtime and workload. If the improvement is clear, retain the pilot separately
and run six pairs with the same source, fixture matrix, and controls. Each
subject imports one build and runs one workload. Alternate before/after order;
rotate case order each round. Node 24.22.1 and Bun 1.4.2 use the same portable
bundles. CPU-heavy work is serialized with the shared `perf.lock`, and timing
processes are pinned to CPU 2.

Input generation, writer construction, transport attachment, and correctness
verification are outside timing. Each timed operation includes full public
materialization, result array construction, and (where specified) the complete
following entry materialization. Keep every result until validation. Verify
every returned row and every entry key against an independently constructed
native data oracle in the map's key order. Both builds receive identical key
enumeration and cache preparation. Fresh reader caches are not touched during
oracle construction. Check unchanged shared bytes/used capacity and deep
freezing, retained forks, growth, and shared/copy attachments separately.

Choose the same measured repetitions for both builds using disposable
calibration, with bounded total output rows and fresh readers per batch. Warm
at that repetition count for at least eight batches and 500 ms of timed work
per formal subject; record actual counts and durations. Pilot subjects use at
least five batches and 100 ms. Keep nine measured batches per subject. Subject
medians, not individual batches, are the statistical observations. Report the
geometric mean of paired candidate/baseline process-median ratios, an
unadjusted 95% Student-t interval on log ratios for the six-pair formal study,
and marginal before/after medians separately. Include every case and slower
result. No dropped samples or data-dependent replacements.

Record exact runtime, hardware, arguments, source hashes, all imported bundle
hashes, driver and fixture hashes, plus start/end identity guards. Preserve
unsuccessful candidates, original drivers, and raw samples under new paths.
The scope is this Linux x64 environment; no browser/ARM or full application
performance claim follows from it.
