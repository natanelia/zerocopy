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


## Paged directory result — Nov 27 (memory win, latency gate failed)

[Run 46007394718](https://github.com/natanelia/zerocopy/actions/runs/46007394718), head `1d9383ff69410fefc523b28fd26cbe4a8ac175d8`. All three jobs succeeded, 120 measured cases, five rounds per mode and pattern; 4 readers and 96 revisions with exact verification. Raw artifacts: [single](https://github.com/natanelia/zerocopy/actions/runs/46007394718/artifacts/15201923281), [clustered](https://github.com/natanelia/zerocopy/actions/runs/46007394718/artifacts/15202388427), [spread](https://github.com/natanelia/zerocopy/actions/runs/46007394718/artifacts/15201573512).

| Pattern | Flat32 → paged32 appended bytes | Flat32 → paged32 total edit-to-answer ms | Median paired paged/flat latency ratio (wins) | Flat256 → paged256 bytes | Median paired paged/flat256 latency ratio (wins) |
|---|---:|---:|---:|---:|---:|
| Single | 6028032 → 171260 | 223.60 → 271.67 | 1.245 (0/5) | 972288 → 282620 | 1.236 (0/5) |
| Clustered | 6048768 → 198140 | 315.94 → 379.18 | 1.187 (0/5) | 1055232 → 367100 | 1.039 (0/5) |
| Spread | 6691584 → 2014460 | 371.80 → 439.96 | 1.182 (0/5) | 6278976 → 5868604 | 1.116 (1/5) |

Single32 directory allocation 6000000 → 143232 bytes (97.6% reduction); total appended arena 97.2% lower, but peak process RSS 240816 → 235988 KiB (~2%), not equivalent to arena allocation. Numeric lists still faster: 175.41/242.80/282.30 ms across single/clustered/spread respectively, adding 122880/169728/1950464 bytes. Paged32 slower than lists in every paired trial. Flat32 A/A paired latency ratios .958/1.014/.979. **Reject unmodified paged path for promotion**, retain as memory-efficient proof, do not merge. Data are same-run paired comparisons, not prior independent hosts.

### Next narrowed diagnosis

Source inspection: flat validation walks columns directly; paged attachment reconstructs column/row via division and remainder for every slot, creates typed arrays for each page, repeats the full validation for every publication, and lookup uses a DataView read after a directory lookup. This is a hypothesis for overhead, not established attribution. The next variant `table-paged-fast.mjs` preserves the identical format, unchanged writer/layout and full independent validation (no trusted shortcut or reuse based on unproven memory identity). It validates all page bounds first and then walks page spans within each column, using native Uint32Array address reads. No skipped block validation. New malformed-pointer coverage includes column/page boundaries, partial pages, odd lengths, empty, growth and retained forks. Do not change the prior paged or flat implementation.

Compare paged32 duplicate A/A, paged256, fast paged32/256, flat32/256 and numeric lists, 7 measured rotating rounds per pattern, same pinned PR100 proof build and exact fixtures. Include sum and p95 of per-publication slowest-reader attach, point, and scan, plus end-to-end wall latency and unchanged allocation. These local phase maxima need not sum to wall time. Reuse raw results instead of rerunning the old broad benchmark; this new run isolates the read-side hypothesis. If full validation remains costly, consider connection-local reuse of previously validated immutable directory pages only under an explicit same-memory session with growth, fork, skipped-revision and independent-copy guards; never trust an arena ID alone. Next consider dynamic row identity and column compaction only once churn results are sound. No browser/GPU claims, production API, merge, or deployment.


## Full-validation result and connection-local proof — Nov 27

[Run 46016818485](https://github.com/natanelia/zerocopy/actions/runs/46016818485), head `d8c2c173d52908411f233e20517b5e88b42f25ba`, all 168 measured cases passed (three patterns × eight modes × seven rounds), four workers, 96 revisions and full retained digests. Same-run medians below, not comparisons to independently scheduled hosts.

| Pattern | Paged32 original → fast total ms | Fast32 summed attach ms (original → fast) | Fast256 total ms | Lists total ms |
|---|---:|---:|---:|---:|
| Single | 269.09 → 224.30 | 99.10 → 50.56 | 196.55 | 176.33 |
| Clustered | 271.77 → 225.17 | 104.08 → 44.15 | 203.05 | 187.43 |
| Spread | 444.39 → 365.73 | 153.03 → 68.85 | 316.79 | 282.69 |

Fast32 median paired latency ratios vs original .834/.812/.807; memory identical. Fast256 still slower than lists in total medians; spread scan p95 52.32 ms vs lists 24.30 ms. Local phase maxima do not sum to elapsed. Do not promote. 

Next narrowly test same-memory connection-local validation. Keep exact layout and full first attach; bind a stream to one owner memory object and shape at publication, with a full handshake then root/used messages only. Reader reconstructs against its existing local memory, checks every root/page bound, skips block validation only for identical immutable page pointers at the same logical page position from its immediately previous validated snapshot. It never infers memory identity from an arena ID or compares addresses across independent copies. New arena or schema requires a fresh handshake; trusted same-application channel only, no protection from malicious shared-memory writes. Retain full checks for independently attached descriptors and changed pages. Test growth, skipped versions, forks, historical roots, wrong stream, malformed changed pages, replacement arena and old snapshots. 

Benchmark same four-worker churn: fast full descriptor, root-only full-validation control (identical transport), root-only incremental, duplicate incremental A/A, 32 and 256 blocks, numeric lists. Seven rotating paired rounds per pattern. The comparison of root-only full vs incremental isolates the validation change; full descriptor vs root-only full also includes message/attachment costs. No public API or existing transport changes, no merge/deploy. If this fails latency gates, don't tune synthetic thresholds blindly; consider scan amplification at small blocks, representative app workload and index publication cost next. 


## Connection-local validation result — Nov 27/28

[Run 46025165579](https://github.com/natanelia/zerocopy/actions/runs/46025165579), exact head `5779abb3eb164678a986482e315db1a7c2d3da93`: all three jobs passed, 168 measured cases (3 patterns × 8 modes × 7 rounds), four real workers, 96 revisions, full verified retained digests. Raw [single](https://github.com/natanelia/zerocopy/actions/runs/46025165579/artifacts/15211647436), [clustered](https://github.com/natanelia/zerocopy/actions/runs/46025165579/artifacts/15212112205), [spread](https://github.com/natanelia/zerocopy/actions/runs/46025165579/artifacts/15211082507). Derived from per-trial JSON lines in the successful job logs.

| Pattern | 32 root-only full → incremental total ms | Paired incremental/full median ratio | 256 incremental total ms | Numeric lists total ms | 32 incremental summed attach ms |
|---|---:|---:|---:|---:|---:|
| Single | 297.13 → 250.72 | .833 | 228.15 | 226.05 | 34.43 |
| Clustered | 292.01 → 237.69 | .834 | 225.00 | 212.63 | 26.59 |
| Spread | 262.61 → 243.94 | .958 | 234.44 | 202.23 | 29.23 |

32-row incremental root-only validation reduces summed slowest-reader attach from 65.26/54.68/40.78 ms to 34.43/26.59/29.23 ms, but spread total improvement is near noise and the numeric list remains the stronger end-to-end control. 256-row incremental is near lists on single but slower clustered/spread. 32 allocation unchanged (171260/198140/2014460 bytes), versus lists 122880/169728/1950464. Process peak RSS is higher in the column arms; not a memory win against lists. No promotion.

**Next targeted scan proof, not another directory variant.** 32-row scan allocates typed views for each of 3,125 blocks × requested columns, despite initial contiguous storage; generic aggregate per-block allocations and pointer chasing may explain remaining latency. 256 still has slow scan tails. Add proof-only `table-paged-runs.mjs` with the identical paged writer, directory validation, and session transport. Its aggregate uses one typed view per physical type over published bytes, and coalesces adjacent row blocks only when every requested column is contiguous, including the sum column. Fragmented edits split runs. No JIT code generation, no query result cache, no skipped rows, same row/sum order including NaN and signed zero. Compare reference on mixed-width, arbitrary predicates, empty conditions, duplicate fields, partial blocks, dense edits, retained and reader snapshots after growth.

The varying-viewport driver `scan-churn.mjs` changes query bounds and kind every 16 revisions, with scans every eighth revision; single and scattered edits plus a burst workload (1,024 changed rows every 12 revisions and 10% edits at 48/96). Same four readers, all point outputs, scan results and full historical/current digests verified. Every mode receives same query and edit semantics. Compare identical session32/256 against run-coalesced32/256, duplicate coalesced32 A/A, pinned direct JSON and numeric lists. Seven rotating rounds and raw artifacts; compare per-round edit-to-answer, scan p95, allocation and RSS. Dense bursts include every edited row in reply, so transport/materialization can dominate; distinguish scan-local timing. This remains synthetic evidence, not a real map tile or browser result. If the gain is marginal or fragile, stop optimizing this fixture and move to a representative varying-length lane geometry/validation prototype with actual browser workers, rather than adding more directory variants. No production changes, merge or publication.


## Contiguous span result — Nov 28 (reject)

[Run 46034214028](https://github.com/natanelia/zerocopy/actions/runs/46034214028), exact head `d901e238b0480c4a481449c2bd7220ab45ccacae`, all three jobs passed: 147 measured cases (3 patterns × 7 modes × 7 rounds), 4 readers, 96 revisions, full verified retained digests. Raw [single](https://github.com/natanelia/zerocopy/actions/runs/46034214028/artifacts/15215148927), [spread](https://github.com/natanelia/zerocopy/actions/runs/46034214028/artifacts/15216116223), [burst](https://github.com/natanelia/zerocopy/actions/runs/46034214028/artifacts/15215263689).

| Pattern | Session32 → span32 total ms | Session256 → span256 total ms | Lists total ms | Session32 → span32 local scan p95 ms |
|---|---:|---:|---:|---:|
| Single | 238.20 → 470.36 | 222.92 → 435.92 | 230.36 | 22.61 → 50.10 |
| Spread | 264.90 → 401.16 | 241.14 → 392.65 | 206.71 | 23.91 → 40.00 |
| Burst | 375.59 → 506.45 | 355.86 → 489.64 | 322.66 | 29.35 → 33.95 |

Reject contiguous span variant; allocation unchanged, fresh first phase improved but sustained queries materially slower, duplicate controls show same problem. Preserve evidence; do not use span implementation or tune this synthetic five-field benchmark again.

### Next: representative browser lane editing feasibility, without a new directory

Use the best retained session-paged implementation without scan-run coalescing. Build a variable-length road-like lane fixture based on pinned #99 synthetic tile layout (not real-world map data): 4–64 vertices with periodic 256-vertex paths, UTF-8 IDs, varying viewports, vertex moves, insertion/removal within paths, soft removal/reinstatement, 25-row changes and 5% batches. Store typed fixed-width bounds/metadata plus offsets into persistent numeric geometry. Length-preserving edits patch coordinates; length-changing edits append and replace the offset, retaining historical data. Both existing numeric list and column-table arms use the same packed geometry and stable string-key map index. This is a hybrid feasibility proof, **not** one-buffer integrated geometry, actual append/delete of rows, Arrow format, GPU upload, or production API. Use existing full JSON, pinned #100 direct JSON with selective bounds then native geometry materialization, duplicate direct A/A, numeric lists, session-paged 32/256, native Map copy with immutable owner snapshots. All arms return equivalent full geometry for point queries and checked visible-feature validation outputs. Four actual browser workers each query a different viewport, 24 revisions; all replies checked and full ordered SHA-256 digests for 0/12/24 verified in every worker. Fresh browser process per case, rotating order, one excluded warmup and five measured rounds at 4,096 and 16,384 rows, Chromium/Firefox, raw phase timings and arena use retained. Native copy uses structured-cloned rows and read-only-by-convention worker logic. Do not infer browser PSS or GC from arena metrics; capture separately in next screen if useful. No actual rendering, transport over network, or GIS production data; use strongest controls before claiming architectural gain. If numeric lists win, prefer using the existing persistent vectors for geometry and focus on functional schema integration, dynamic IDs and reduced duplication rather than further fixture-specific tuning.

Reproduce on proof checkout with pinned #100 control applied as in workflow:
    bun run build:wasm && bun run build:browser
    bunx playwright install --with-deps chromium firefox
    node proofs/persistent-columnar-table-20261127/lane-browser.mjs lane-results.json chromium 4096 5


## Variable-geometry browser result — Nov 28 (prefer existing vectors)

[Run 46041419660](https://github.com/natanelia/zerocopy/actions/runs/46041419660), head `165bbc4109e4db741ab3e576cc55dd462661301d`. All four jobs succeeded: 140 measured cases (2 engines × 2 sizes × 7 modes × 5 rounds), four real workers, 24 revisions with full verified retained digests. Raw artifacts: [Chromium 4k](https://github.com/natanelia/zerocopy/actions/runs/46041419660/artifacts/15220625885), [Chromium 16k](https://github.com/natanelia/zerocopy/actions/runs/46041419660/artifacts/15221105501), [Firefox 4k](https://github.com/natanelia/zerocopy/actions/runs/46041419660/artifacts/15221405261), [Firefox 16k](https://github.com/natanelia/zerocopy/actions/runs/46041419660/artifacts/15221200508). Medians derived from the per-trial verified JSON lines; warmups excluded.

| Browser/lanes | Full JSON total ms | Direct JSON total ms | Existing lists total ms | Table32 total ms | Table256 total ms | Native copy total ms |
|---|---:|---:|---:|---:|---:|---:|
| Chromium 4096 | 497.45 | 217.81 | 117.24 | 128.24 | 126.03 | 1272.83 |
| Chromium 16384 | 1410.51 | 325.16 | 203.57 | 230.06 | 224.59 | 4303.47 |
| Firefox 4096 | 495.74 | 146.24 | 87.36 | 114.50 | 108.46 | 1881.08 |
| Firefox 16384 | 1056.82 | 235.40 | 116.82 | 165.16 | 166.60 | 6084.94 |

At 16k table32 final used arena 12,527,324 vs lists 13,011,188 bytes (3.7% lower), but direct JSON 11,611,812 bytes; no browser resident-memory claim. Table32 median paired latency/list ratios 1.102/1.163/1.288/1.436; table256 1.197/1.059/1.266/1.397. Tables won only 3 of 40 comparisons to lists. Direct JSON A/A shows some noise but the list advantage is consistent. **Do not promote custom fixed-width directory as a faster default.** Retain experiments; use existing persistent numeric vectors for schema functionality instead of another directory optimization. Existing numeric vector geometry remains packed across leaves, not one contiguous Arrow array. The hybrid uses separate map/list arenas.

### Next: dynamic row identity and bounded slot/geometry reuse

A realistic changing tile cannot keep a fixed number of identities forever, nor should scans visit every deleted slot. The fixed-size proof only soft-deleted rows. Add a proof-only schema integration on existing SharedList/SharedMap (no public format change). Stable external key → private dense slot index, occupied/metadata columns, one packed persistent numeric geometry vector, per-slot logical count and allocated capacity. Compare append-only slot allocation with recycled vacant slots and additionally reuse of old geometry capacity when replacement geometry fits, with immutable COW updates so old readers retain the original contents. This bounds row slots under steady replacement, not the append-only arena itself; old paths and capacity slack still require compaction. Slot numbers are not stable external IDs; never use them as identity across publications. All modes include the same string-key index and materialization/validation; direct JSON and native immutable copy are external controls. Duplicate span-reuse mode is A/A.

At 4096 and 16384 rows run 48 revisions, 10% physical row replacement every fourth revision at similar positions with unrelated UTF-8 keys, ordinary vertex edits and changing viewports, four browser workers. Compare end-to-end, p95, build/first-answer and actual used/capacity bytes plus logical slot/coordinate high-water; no inference of process RSS. Verify removed IDs absent and all live rows, sizes and retained roots at revisions 0/24/48; tests cover deletion-only batch, reuse after deletion, fork, geometry shortening/growing, identity checks and duplicate rejection. This is a functional feasibility step; no claim of universally better performance, arbitrary schema support, compaction, direct Arrow export, or single arena across collections. If span reuse regresses dense replacement, retain slot-only evidence and consider bounded capacity classes only when justified; prioritize actual row insert/delete and compact retained geometry before an integrated public storage design. No merge or deployment; #100 remains on review/publication hold.


## Dynamic identity and reuse results — Nov 28 (reject eager recycling)

[Run 46049425584](https://github.com/natanelia/zerocopy/actions/runs/46049425584), exact head `3dc5b1964af4bf350c85e4faa0a9232bd9f7083b`, 120 measured cases, all four jobs succeeded, full retained digests. [Chromium 16k](https://github.com/natanelia/zerocopy/actions/runs/46049425584/artifacts/15224340562), [Firefox 16k](https://github.com/natanelia/zerocopy/actions/runs/46049425584/artifacts/15224076929), [Chromium 4k](https://github.com/natanelia/zerocopy/actions/runs/46049425584/artifacts/15222999823), [Firefox 4k](https://github.com/natanelia/zerocopy/actions/runs/46049425584/artifacts/15223069826). Warmups excluded; median of five rounds from successful job log JSON.

| 16k, 48 revisions | Append | Reuse slots | Reuse spans | Direct JSON | Native copy |
|---|---:|---:|---:|---:|---:|
| Chromium total ms | 591.47 | 678.06 | 778.77 | 683.39 | 8133.69 |
| Firefox total ms | 671.00 | 764.72 | 963.70 | 1151.54 | 24275.26 |
| Final used arena bytes | 29948688 | 41733680 | 52754640 | 27240340 | n/a |
| Logical row slots | 36040 | 16384 | 16384 | n/a | n/a |
| Logical coordinate slots | 2624142 | 2624142 | 1948074 | n/a | n/a |

Slot reuse saves logical slots but increases actual append-only arena growth by 39.4%; span reuse increases it 76.1% versus append, while slower in both engines. Small sizes show same direction. COW path/block allocation on scattered writes is a plausible explanation; no allocator attribution measured. Reject eager recycling as default. Append was 1.16x/1.72x faster by ratio of medians than direct JSON at 16k, but used 9.9% more arena bytes. No browser resident-memory claim.

### Next: bound append-only growth by generation repacking

A fresh packed generation can reclaim dead logical rows and old geometry spans without scattered updates, but materialization/rebuild may produce large latency spikes and old readers may pin generations. Test only this hypothesis, not another allocator. On same browser fixture, extend to 96 revisions and retain 0/24/48/72/96. Compare append plus duplicate A/A, append repack when physical slots reach 1.5x live count plus duplicate A/A, direct JSON and existing compacted JSON every 24 revisions. Repacking uses only live rows of actual snapshot, creates fresh map/list arenas (dedicated single-owner proof resets module defaults; not a safe general production API), and verifies old/forked/current readers. All edit/rebuild cost is included, with compaction separately timed. Explicitly track distinct named current + held arena used and capacity at each revision and during handoff; after verifying all retained roots, release worker-held history and verify current again. These are reachable-by-design arena accounting figures, not process PSS/GC or a guarantee that JS immediately frees bytes. Include p95 and raw individual compaction spikes, first-answer, fresh rebuild and final/current vs retained memory; if synchronous rebuild is too costly, reject rather than promoting. Native copy already measured in immediately preceding screen, not repeated in this narrower compaction proof. Pinned #100 direct JSON control remains unchanged. No production API, merge, publication or new competing lane.
