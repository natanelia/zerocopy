# Persistent typed columns — feasibility proof, 27 November 2026

**Not production code.** User-approved architecture investigation. Pinned main 84ad23a76ee197f45cbc7316017f28b5bbe93d6c. PR #100 (JSON valuesView) remains an independent, already-qualified additive feature; finish its outstanding review/publication gates without stacking this proof on it. PR #99 (spatial/GeoArrow) packs existing geometry and tests application-specific overlays; do not duplicate or merge it here.

## Architecture

Object maps currently store a variable-length UTF-8 JSON record per key. Numeric maps have interleaved leaf headers/keys/values; numeric lists store Float64 values in 32-element blocks. The hypothesis is that native-width, schema-defined structure-of-arrays columns remove repeated property strings, decoding and freezing for selective scans while preserving snapshot edits.

V0 stores fixed-width fields (float64/32, int32, uint32/16/8 and byte booleans), stable dense row slots, column-major blocks and one immutable uint32 directory in **one growable shared WebAssembly.Memory**. The directory root and schema plus memory handle form a small trusted descriptor. An edit copies only affected column blocks and one flat directory; old and forked snapshots keep their addresses and reader attachment is read-only at the API level. No raw writable typed array is returned. A trusted worker can still access the underlying shared memory, as in existing ZeroCopy. Native endianness is assumed in this feasibility proof. Not an Arrow wire format.

Intentional limits: fixed row count, no null bitmap, strings, variable-length geometry, append/delete, generic key index integration, compaction, copy transport or public schema APIs. The benchmark includes a separate existing numeric SharedMap index for string-key lookups, so columns themselves occupy one buffer but keyed proof payloads have another arena. The flat directory is copied on every changed revision; measure it and block-copy amplification before designing a persistent radix directory. Allocation failure can leave unused bytes in the append-only owner but must not corrupt any published root.

## Benchmark

Two actual Node workers per case, isolated fresh process per sample. Same deterministic rows, key lookup, range/equality filter and sum, same five-field representation. Existing SharedMap object decoding, identical-build duplicate JSON control, key enumeration + getView, existing numeric/boolean SharedLists with index, prototype with 256/1024/4096 rows per block, native Map copy. Native Map owner clones on edit and reader freezes copied flat rows; shared arms send only descriptors and memory. Point reads go through a stable string-key index for column arms (not free integer IDs). Full result verification and historical/current full ordered digests; sparse 25-row and 10%-dense edits change x and speed only. Distinguish build, worker creation+initial useful answer, local attach/query, warm scans, point reads, mutation, full update round trip, historical read, allocated arena used/capacity and process high-water RSS (includes verification, not equivalent to browser PSS). Rotating order, independent same-build control, excluded warmup, 5 measured rounds at 1k/10k/100k; no speedup claim until raw analysis. Report paired per-round ratios and absolute times, including negative results. Use a larger 1M run only after bounded memory behavior is established. No GPU or Arrow performance claim.

Reproduce on pinned proof checkout:
    bun install --frozen-lockfile
    bun run build:wasm && bun run build:browser
    node --test proofs/persistent-columnar-table-20261127/table.test.mjs
    node proofs/persistent-columnar-table-20261127/bench.mjs columnar-results.json 5 1000,10000,100000

## Decision gates

Require substantial real scan and mixed application gains with bounded initial and sparse-edit costs and lower or comparable memory; expose density/block-size tradeoffs. Use the strongest existing selective path, including #100 if it lands, in follow-up. Then implement append/delete, stable string-key lookup and null/string/variable-length offset columns in an integrated Arena/codec prototype; persistent directory and compaction should preserve structural sharing. Arrow/GeoArrow export must explicitly distinguish chunked zero-copy reads from packed copies and IPC. Add actual Chromium/Firefox readers and Bun-supported transport, long-lived churn/retention, row materialization, dense updates, invalid data/overflow, memory growth, descriptor validation, GC and allocation failure before public API consideration. No changes to main, public API, existing wire format, GitHub Pages or release. Proof-only branch; no competing production PR.
