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

First correctness run [45982635071](https://github.com/natanelia/zerocopy/actions/runs/45982635071) stopped before timing because the test expected negative zero in an int32 field. Integers canonicalize signed zero; floating-point columns preserve it. Normalize before comparison so a negative-zero integer edit does not allocate a redundant block. Retain the existing special-float and exhaustive row checks and add an explicit integer-vs-float test. No benchmark results from the failed run.

## First completed screen — 27 Nov 2026

[Run 45982820752](https://github.com/natanelia/zerocopy/actions/runs/45982820752), head 5fd2fd6045e43422579059a9ae0ad79d47a5c1b4. All three Node22 jobs passed (120 measured cases across 3 sizes, plus 24 excluded warmups). Each case used two real workers and verified every row of initial and final snapshots. At 100k flat rows, medians across five rounds, elapsed includes replies:

| Mode | Cold first ms | 5 warm scans + points ms | Sparse phase ms | Dense phase ms | First point portion ms | Initial arena used bytes |
|---|---:|---:|---:|---:|---:|---:|
| JSON full | 124.98 | 312.17 | 133.30 | 129.77 | 3.19 | 9444280 |
| JSON keyed projection | 145.42 | 307.10 | 157.33 | 154.32 | 2.90 | 9444280 |
| Numeric lists | 58.99 | 19.33 | 19.48 | 18.44 | 7.30 | 9659200 |
| Table 256 | 63.01 | 7.14 | 13.27 | 26.50 | 7.17 | 7435572 |
| Table 4096 | 64.97 | 11.47 | 36.91 | 14.22 | 8.08 | 7428252 |
| Native copied Map | 161.61 | 13.48 | 125.45 | 132.78 | 0.71 | n/a |

First phase excludes owner build. Sparse/dense phases exclude mutation, reported separately in raw evidence. Table 256 allocates 65,424 bytes for 25 spread edits vs 6,688 bytes JSON; larger block 4096 allocates 885,240 bytes. Table process high-water includes final verification and is nearly the same as JSON (195836 vs 196392 KiB). Table first answer is slower than numeric lists; 1k native is markedly faster than table for mixed work. Thus promising for large selective scans, **not a universal improvement**. Initial fixed-width table payload is only about 1.91 MB including its directory; the existing string-key index consumes the majority of the total arena. Keep key lookup in fair comparisons.

## Follow-up — isolate row materialization and stronger control

Hypothesis from source inspection and first point measurements: row() allocates one typed-array view per field per lookup plus a directory view, independently of the HAMT key lookup. Compare rowDirect(), which caches one bounded DataView/directory and type dispatch per snapshot, against unchanged row(); still return identical frozen ordinary objects, same key index, no decoded-object cache or new format. Includes held cached views during real memory growth, all scalar types, special floating values and unusual schema names. No claim of a speedup yet.

The workflow now checks out exact PR #100 head 172839f20b24392d96ba21723fd300efa2e5ee8b separately and copies only its shared-map.ts into the ephemeral proof build. It is the only runtime file changed by #100 against pinned main; no runtime file is changed in this branch. All arms use the same resulting build. Add direct valuesView selective JSON control (same predicates) and keep full/keyed JSON, identical-build control, numeric lists, native Map, old table-256 and direct 256/1024. Separate fresh point-only workers after mixed phases and report process high-water before exhaustive verification; the fresh readers overlap the two retained mixed readers, so report this memory separately. Eight measured rounds per size, rotating/alternating order; maintain full digests. The additional benchmark is targeted at the observed point penalty and strongest control, not a rerun of the previous screen. Next assess churn/metadata and variable length only after this result.

## Point path results and churn decision — 27 Nov 2026

[Run 45990674226](https://github.com/natanelia/zerocopy/actions/runs/45990674226), exact proof head 3f174025fd9b9d8a602d8eb33a0d8304fea45a0c, all three jobs succeeded; 216 measured cases (3 sizes × 9 modes × 8 rounds), 27 excluded warmups. Raw logs and per-trial artifacts: [100k](https://github.com/natanelia/zerocopy/actions/runs/45990674226/artifacts/15193113708), [10k](https://github.com/natanelia/zerocopy/actions/runs/45990674226/artifacts/15193806530), [1k](https://github.com/natanelia/zerocopy/actions/runs/45990674226/artifacts/15192274468). Two actual workers, full digests pass; fresh point-only measurement uses two additional workers after mixed phases. Medians (average middle two) at 100k below. Mixed = owner build + initial/warm/sparse/dense/history elapsed + mutation; excludes separate fresh-point experiment. RSS high-water through mixed phases (not later extra readers or verification).

| Mode | Mixed ms | First ms | Warm ms | Fresh point work ms | RSS KiB | Initial used bytes | Sparse added bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Full JSON | 1436.56 | 178.20 | 463.74 | 7.06 | 172402 | 9444280 | 6688 |
| Direct JSON #100 | 832.84 | 132.79 | 197.14 | 6.90 | 173626 | 9444280 | 6688 |
| Numeric lists | 322.68 | 80.29 | 27.23 | 10.04 | 161590 | 9659200 | 20224 |
| Table 256 row | 336.37 | 88.53 | 9.87 | 11.43 | 171728 | 7435572 | 65424 |
| Table 256 rowDirect | 345.22 | 86.94 | 9.58 | 7.74 | 168112 | 7435572 | 65424 |
| Table 1024 rowDirect | 336.91 | 83.51 | 13.66 | 7.67 | 166956 | 7429712 | 232360 |
| Native copied Map | 706.15 | 229.50 | 19.31 | 1.05 | 356100 | n/a | n/a |

256 direct paired fresh point speedup 1.481× versus row, but mixed ratio old/new 0.971 (not an end-to-end improvement); no production promotion. Versus strongest direct JSON, paired mixed speedup 2.409×. Versus lists paired 0.947×, so columnar is not yet superior overall. Initial footprint includes a 5,527,744-byte string-key index; column storage itself is 1,907,828 bytes. Sparse update allocates 9.78× JSON bytes. Native wins small datasets, and the full JSON duplicate is the A/A noise control. Do not generalize to browser, GPU or dynamic geometry.

**Next: measure churn before changing the layout.** At 100k rows/5 fields/256 rows per block, a flat directory has 1,955 entries = 7,820 bytes every changed revision even for a one-row edit; one x/speed block pair is 2,304 bytes. This is a structural allocation calculation, not measured latency. A 32-row block reduces the payload copy but increases directory to 62,500 bytes. A 1024-row block reduces metadata but amplifies sparse edits. Measure 96 consecutive published revisions with four actual readers, stable string key index, one edit or 25 clustered/spread edits, point replies on every revision and full viewport filters every eighth revision, hold revisions 0/48/96 and verify full ordered digests. Separate directory/data/padding bytes, attach and query time, median/p95 per-trial reply, owner edit and process RSS before verification. Compare 32/256/1024 blocks, exact identical table control, exact #100 direct JSON + identical control, numeric lists and native Map with equivalent snapshot/copy. Five measured rounds + one warmup per pattern, rotating order, raw events retained. This is an unchanged-storage baseline, not a new production candidate. Only consider path-copied directory pages or sparse patch pages when the measured allocation/latency distribution supports it; do not repeat the old one-shot scan benchmark.

Reproduce this next proof with pinned #100 runtime control as in workflow, then:
    node proofs/persistent-columnar-table-20261127/churn.mjs churn-results.json single 5
    # repeat with clustered or spread

## Publication/churn baseline results and paged directory decision — Nov 27

[Run 45998665907](https://github.com/natanelia/zerocopy/actions/runs/45998665907), exact head 5e40c5b21a6ab1b5ec5921a41ce373475e3ddf9b; all three jobs passed, 120 measured cases, five rounds each. Four actual workers, 96 revisions per case plus initial, all point answers/scans and full digests at revisions 0/48/96 verified. [Single raw](https://github.com/natanelia/zerocopy/actions/runs/45998665907/artifacts/15196978614), [clustered raw](https://github.com/natanelia/zerocopy/actions/runs/45998665907/artifacts/15197487183), [spread raw](https://github.com/natanelia/zerocopy/actions/runs/45998665907/artifacts/15197466635). Report per-pattern medians across five trials; not comparable across independently scheduled hosts. Time is summed edit-to-all-four-reader answers (excludes owner build, initial, full digest); bytes are appended arena use, not resident memory.

| Pattern | Direct JSON ms / bytes | Numeric lists ms / bytes | Table 32 ms / bytes | Table 256 ms / bytes | Flat directory alone (32 / 256 bytes) |
|---|---:|---:|---:|---:|---:|
| Single | 701.74 / 25044 | 158.87 / 122880 | 202.49 / 6028032 | 171.43 / 972288 | 6000000 / 750720 |
| Clustered 25 | 1175.09 / 539704 | 266.48 / 169728 | 337.36 / 6048768 | 308.61 / 1055232 | 6000000 / 750720 |
| Spread 25 | 742.86 / 538936 | 180.06 / 1950464 | 236.97 / 6691584 | 203.22 / 6278976 | 6000000 / 750720 |

Flat 32 directory dominates bytes (99.5%, 99.2%, 89.7%); flat 256 directory dominates single/clustered (77.2%/71.1%) but not spread (12.0%). 256 total latency still slower than lists in all median cases, though overall p95 is lower (single 4.95 vs 5.58 ms, clustered 8.08 vs 10.03, spread 5.90 vs 6.51). Point-only p95 favors lists (2.78 vs 3.13, 3.75 vs 4.64, 2.95 vs 3.94 ms); same-build controls show noise. No universal claim. Native copy total ~19.6–30.6 seconds with 1.3 GiB process high-water; not comparable to shared arena bytes.

**Next experiment:** separate proof-only paged layout in table-paged.mjs, same native-width payload and snapshot semantics. A small immutable top index references pages of 64 block addresses. Copy only changed pages and top per revision, even if multiple changed blocks share a page. This is a bounded two-level tree, not a full multi-level radix tree; for 100k rows/5 fields/32-row payload blocks, top is 980 bytes, versus flat 62,500 bytes; two changed pages cost at most 512 bytes. For spread updates at 256 rows/page, directory savings may disappear, and page lookup/validation may regress scans/attach. All descriptors retain strict page/block bounds checks; cached directory views survive growth. Test partial final page, multiple changed blocks sharing pages, distinct page changes, fork, invalid page pointer, allocation failure and old worker digests. Preserve unchanged flat implementation in table.mjs. Repeat only churn with the new hypothesis (same two JSON controls, numeric lists, flat32 duplicate A/A, flat256, paged32 and paged256; native copy already characterized). Compare actual appended bytes split metadata/data/padding, point and scan p95, total, peak process RSS and attach overhead. Reject material regressions or narrower suitability; no public code or format promotion. Note that two-level top copying still scales with table size; only pursue further radix levels when measured.
