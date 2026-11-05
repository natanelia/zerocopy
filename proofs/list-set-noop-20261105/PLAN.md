# Exact-bit no-op list writes: fixed screen plan

Recorded before timing on 2026-11-05. Baseline is `77599337867dbf785a5f0311d34637d0b36678fc`, built in the immutable round-four baseline checkout. This is independent of the rejected sorted-journal experiment.

## Hypothesis and compatibility

`SharedList.set()` already encodes and validates its input, then always creates a new frozen snapshot. Keep that wrapper unchanged. In `persistent-core.as.ts`, reuse a nonzero tail/leaf only when its stored `u64` equals the exact binary64 bits of the supplied value. Recurse into a vector child before allocating its ancestors; return an existing ancestor when its child pointer is unchanged.

The expected benefit is zero shared-storage allocation for repeated numeric, boolean and interned-string writes that preserve the existing raw bits. Equality is neither JavaScript `===` nor numeric `==`: signed zero and distinct NaN payloads stay distinct. Missing nodes still allocate. String/JSON/nested encoding, user serialization, writable checks and fresh wrapper identity remain unchanged. Generic re-encoding can allocate and produce a different raw pointer despite equal logical content, and must keep doing so.

Changed writes copy the same number of bytes but allocate a child before its ancestors. Published bytes remain immutable; relative pointer ordering is not part of the format. The existing partial-failure fixture uses 320 bytes of headroom so both allocation orders fail after some unpublished storage is consumed, then permit its smaller tail recovery.

## Fixed ten-case matrix

A timed write operation makes **1,024 public `set()` calls**, threading their returned snapshots, and returns its final snapshot. Each complete operation's final snapshot escapes and is fully materialized and checked outside timing; intermediate wrappers are not retained. This measures a repeated-update consumer, not an isolated one-call microbenchmark. All requests are generated outside timing. Boolean/string changed-write cases may end at the original logical value, but every intervening request differs and exact allocation counters verify that the writes occurred.

| Case | Source and index | Requests | Role |
|---|---|---|---|
| tail-number-noop | One-element numeric list, index 0 | Original value 1,024 times | Minimal-tail target |
| tree-number-noop | 65,537 numbers, index 32,768 | Original value 1,024 times | Deep-path target |
| tree-boolean-noop | 1,057 booleans, index 511 | Original value 1,024 times | Boolean target |
| tree-string-noop | 1,057 strings from eight interned Unicode values, index 511 | Original value 1,024 times | Interned-string target |
| tail-number-changed | Same one-element numeric shape | A distinct numeric value on every call | Minimal changed-tail cost |
| tree-number-changed | Same 65,537-number shape | A distinct numeric value on every call | Changed-path cost |
| tree-boolean-changed | Same boolean shape | Toggle on every call | Changed boolean control |
| tree-string-changed | Same interned-string shape | Cycle through eight values, differing on every call | Changed interned-string control |
| tree-json-reencode | 1,057 small JSON records, index 511 | Original logical object on every call | Generic pointer/encoding fallback |
| get-control | 65,537 numbers | 1,024 predetermined scattered public gets, return full result array | Unchanged read control |

Inputs and expected results come from native arrays. Each timed batch builds a fresh private Arena and source outside timing to bound append-only memory; it performs the same source-content verification on both builds. Ordinary intern caches remain active and are populated identically by source construction. There is no persistent cross-build cache. Every timed output is retained, fully checked, and required to preserve the source's complete published bytes from `HEAP_START` through its original used position; the lower scratch area is not published storage. Shared-allocation deltas must equal the exact expected total: zero for candidate raw no-ops and reads; identical predicted totals on changed/generic writes. No-op baseline allocation is retained in the comparison.

## Measurement and decision

Use Node 24.22.1 and Bun 1.4.2, one build/workload per fresh process at the same neutral copied pathname. All builds/tests/timings use the shared `perf.lock`; timing controllers and children use CPU 2. The first screen has two balanced before/after process pairs per engine/case, seven measured batches, at least 150 ms actual timed warm-up and at least eight warm-up batches. Do not treat batches as independent processes or report inferential screen intervals.

Disposable calibration from both builds selects one common repeat count per case/runtime. Target 20 ms batches. Cap each batch by 65,536 complete operations, 1,048,576 output elements checked, and 16 MiB worst-case shared allocation from the baseline path. The same cap applies to both builds, including candidate no-ops. The old blackboxed Arena can remain live while the next batch is constructed; these caps are not RSS or peak-memory claims. Retain short/capped batches. A 2,048-batch warm-up cap must fail visibly if the actual elapsed floor cannot be reached.

Timing includes the outer retained-results array, caller update/get loops, encoding, WASM work, fresh snapshot wrappers and natural GC. Fixture construction, requested-value preparation, hashing, source checking and complete result verification are excluded. No forced GC. Capture all warm-up/calibration/measured batches, allocation deltas, repeat plans and exact driver/source/build identities. Core WASM and its legacy aliases are expected to change; numeric/geometry WASM and unrelated TypeScript/build inputs must match.

Advance only if complete screen results show worthwhile repeatable benefits with acceptable changed-write and read controls. Any confirmation must be separately predeclared before its first measurement, retain all ten cases and the same runtime source, and use at least six balanced fresh-process pairs with at least 500 ms actual timed warm-up. Do not selectively retime favorable cases or silently replace failed runs.

## Correctness before timing

Cover tail/leaf boundaries and multiple vector depths; fresh wrapper identity; old roots, forks and frontier appends; numeric signed zero/infinities/NaNs; exact NaN payloads through a WASM-to-WASM `i64` bridge; missing-node allocation; boolean/interned-string equality; JSON/nested serialization and growth; read-only shared/copy attachments; wrong types and invalid indices; full-capacity no-ops and safe changed-write failure/recovery. Use private Arenas. A real worker proof is required before accepting a PR, including readers built from the unchanged baseline to demonstrate the unchanged format.
