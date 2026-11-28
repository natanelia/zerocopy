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


## Generation repacking — Nov 28: reject eager synchronous rebuild as default

[Run 46056839085](https://github.com/natanelia/zerocopy/actions/runs/46056839085), head `44b448d90919e26efbb247100795d8e56239619a`. Four successful jobs, 120 measured cases, full retained digests. Raw artifacts: [Chromium 16k](https://github.com/natanelia/zerocopy/actions/runs/46056839085/artifacts/15226783820), [Firefox 16k](https://github.com/natanelia/zerocopy/actions/runs/46056839085/artifacts/15226738618), [Chromium 4k](https://github.com/natanelia/zerocopy/actions/runs/46056839085/artifacts/15227086651), [Firefox 4k](https://github.com/natanelia/zerocopy/actions/runs/46056839085/artifacts/15227216493). Parsed measured verified summary JSON from job logs; five rounds per arm, warmup excluded.

| 16,384 lanes, 96 revisions | Append | Repack | Direct JSON | JSON compact |
|---|---:|---:|---:|---:|
| Chromium total ms | 1140.80 | 1744.66 | 1442.66 | 1547.67 |
| Firefox total ms | 751.96 | 1347.38 | 1429.04 | 1514.42 |
| Chromium p95 ms | 34.64 | 54.08 | 47.11 | 54.70 |
| Firefox p95 ms | 23.50 | 36.80 | 44.24 | 48.78 |
| Current-only arena bytes | 47096732 | 12259276 | 43994528 | 11400520 |
| Peak distinct held + current bytes | 47096732 | 96134044 | 43994528 | 89583436 |

Repack reduced current-only arena bytes by 74.0% but more than doubled peak reachable arena bytes while five historical publications were held. Paired total ratios 1.524 Chromium and 1.783 Firefox (4k 1.479 and 1.454). Append A/A 0.981 and 1.018 at 16k. Four rebuilds cost 611.21/570.38 ms in aggregate, versus JSON compaction 74.46/64.56 ms. No browser RSS/GC claim; retaining revisions means retaining whole arena generations. **Do not promote automatic synchronous repacking.** Append remains the baseline; test whether eliminating per-row JS geometry copies can reduce rebuild costs, and quantify the separate effect of bounded retention.

### Next: direct packed copy and retention control

The materializing rebuild reads each live geometry into a Float64Array, turns it into a JS array, then validates and copies the JS array again into the packed destination. Direct rebuild computes live size, copies each range straight into one destination Float64Array, and gathers metadata and key index without row objects. Still copies coordinates, not zero-copy. No runtime changes. Same current-only and retained correctness, stable IDs, empty/fork/old roots, dedicated proof-only reset behavior. Compare original repack vs direct + duplicate direct, append + duplicate append, direct JSON and compacted JSON, 16k lanes, 96 revisions, four real workers, five timed rounds per engine and retention policy. Retain last two named checkpoints versus all five; every expired checkpoint is fully verified by every reader before release, including absent keys; diagnostic digest work is reported separately and excluded from edit-to-answer timing for every arm. Track handoff and reachable bytes before and after expiry, not process PSS. Retention=5 reproduces original lifetime; do not conflate retention change with copy optimization or claim that applications can discard history they still need. Use raw artifacts and paired ratios; if repack remains costly, stop tuning this path and consider coarse independently owned tile generations only with a representative spatial workload. No public API, production change, merge or publication.


## Direct packed rebuild and retention result — Nov 28 (not default eligible)

[Run 46063269735](https://github.com/natanelia/zerocopy/actions/runs/46063269735), head `f8244842d5b7dae6ed4fdbc83888b0bc0cd21d02`: four successful jobs, 140 timed verified cases, five rounds per arm excluding warmup. Raw [Chromium hold2](https://github.com/natanelia/zerocopy/actions/runs/46063269735/artifacts/15229428083), [Chromium hold5](https://github.com/natanelia/zerocopy/actions/runs/46063269735/artifacts/15230655216), [Firefox hold2](https://github.com/natanelia/zerocopy/actions/runs/46063269735/artifacts/15230016864), [Firefox hold5](https://github.com/natanelia/zerocopy/actions/runs/46063269735/artifacts/15230251389). Medians from verified job-log JSON.

| Engine/retention | Append total ms | Original repack total ms | Direct repack total ms | Original → direct rebuild sum ms | Append → direct p95 ms |
|---|---:|---:|---:|---:|---:|
| Chromium 2 | 1100.25 | 1708.50 | 1415.97 | 593.71 → 281.24 | 32.52 → 58.60 |
| Chromium 5 | 1135.98 | 1772.45 | 1447.50 | 597.69 → 299.70 | 32.59 → 56.01 |
| Firefox 2 | 991.18 | 1622.08 | 1294.32 | 681.84 → 323.22 | 30.48 → 54.82 |
| Firefox 5 | 743.94 | 1359.18 | 1041.84 | 571.76 → 279.84 | 24.14 → 39.82 |

Direct copying approximately halves rebuild time but still increases p95 substantially versus append. Current-only 12,259,276 B; peak held + current 54,474,580 B (two checkpoints) or 96,134,044 B (five), against 47,096,732 B append. Final retained two: 33,097,176 B. Distinct arena bytes, not resident memory. Two-checkpoint policy verifies expired roots before release outside timed path; do not compare latency between retention policies causally. Reject synchronous whole-generation repacking as default; retain for explicit compaction research.

### Next: independently owned spatial bands (proof only)

Test eight independently owned spatial bands with existing numeric vectors and persistent global ID-to-band routing map. Rebuild only bands crossing 1.5x slot threshold. Conservative vertical envelopes skip provably disjoint viewport queries, never shrink on edits. Include routing and all publications in timings/accounting. Compare unpartitioned append/A-A, direct repack, optimized JSON/compacted JSON, partition append, partition repack/A-A on identical 16k/96-revision/four-reader runs, both scattered replacements and edits localized to successive bands. Local edits concentrate 10% whole-tile replacements within a band. Stable keys, absent IDs, retained historical roots and final digests checked by every worker; two retained checkpoints. This is a feasibility screen, not a production API, general spatial index, actual map trace or memory reclamation guarantee. Global routing arena remains append-only. If overhead or concentrated rebuilds fail, stop tuning compaction and consider schema API independently. No production change or merge.


## Spatial bands — Nov 28: not a general compaction solution

[Run 46070852292](https://github.com/natanelia/zerocopy/actions/runs/46070852292), exact head `70cc5569d1f5ac1df04cf4e000641c11ca5ef073`: four successful jobs, 160 measured verified cases, 16,384 lanes, four browser workers, 96 revisions, two retained checkpoints. Warmup excluded; medians parsed from verified job-log JSON. Raw [Chromium spread](https://github.com/natanelia/zerocopy/actions/runs/46070852292/artifacts/15233271759), [Firefox spread](https://github.com/natanelia/zerocopy/actions/runs/46070852292/artifacts/15232923152), [Chromium local](https://github.com/natanelia/zerocopy/actions/runs/46070852292/artifacts/15232628234), [Firefox local](https://github.com/natanelia/zerocopy/actions/runs/46070852292/artifacts/15232663450).

| Engine / edits | Append total ms | Partition append ms | Partition repack ms | Append → partition repack p95 ms |
|---|---:|---:|---:|---:|
| Chromium local | 838.19 | 850.07 | 917.96 | 23.38 → 32.97 |
| Firefox local | 776.06 | 696.24 | 839.86 | 26.92 → 29.20 |
| Chromium spread | 1170.78 | 1115.47 | 1373.71 | 31.57 → 52.98 |
| Firefox spread | 829.42 | 768.06 | 1067.88 | 27.32 → 44.86 |

Local edits: peak distinct retained+current arena bytes 46,671,568 → 26,687,908 (42.8% lower), current 20,725,212. Spread: peak 47,096,732 → 66,380,964 (41.0% higher), current 25,014,576. Paired total latency ratios partition repack/append 1.112/1.119 local and 1.173/1.267 spread. Partition append increased arena bytes to 53,174,636 local and 55,656,436 spread. Append A/A ratios 1.020/.975 local and 1.017/.999 spread. No process memory claim. Independently owned arenas can help genuinely localized changes, but global routing and multi-band rebuilds hurt spread churn and p95. Reject automatic partition compaction as a general default; preserve this implementation and do not tune compaction further in this fixture.

### Next: schema API feasibility on existing vectors (proof only)

Use a schema compiler that maps finite numeric, boolean, string and variable numeric array fields to persistent existing SharedLists, optional explicit null via validity columns, stable key index and append-only row identities. No JSON row encoding, new memory format, custom directory, or automatic compaction. Schema signature is metadata, not a security boundary; type/shape checks and exact old roots tested. This narrow prototype requires an explicit id, finite JSON-compatible numeric values (canonical zero), all declared fields present, and no arbitrary nested objects. No schema evolution, public contract, integrated single-buffer format, or claim of zero-copy array materialization. Numeric array get returns a fresh array.

Benchmark identical lane edits against previous hand-written append and #100 direct JSON, with duplicate A/A arms, 4k/16k lanes, Chromium/Firefox, four readers, 48 revisions, five timed rounds. The generalized scan reads predicate fields first, so any scan gain is not solely schema compilation. Browser replay verifies exact historical rows and visible results; separate typed-schema tests exercise nullable strings/numbers/arrays, UTF-8, empty arrays, forks, invalid input, and schema mismatch. This benchmark uses existing numeric lane fields only; nullable/string performance is not established. Keep this as an unverified isolated proof until the run returns. No production changes, new PR, merge or publication. #100 remains held.

## Generic schema feasibility — Nov 28

[Run 46077230542](https://github.com/natanelia/zerocopy/actions/runs/46077230542), exact head `fc4ee64b8140a86ae31f47c3ece0d527d7b25e7d`: all four jobs succeeded, 100 measured verified cases (five rounds × five modes × four engine/size combinations; warmup excluded), four real browser readers, 48 revisions, two retained checkpoints. Medians from raw job-log JSON. Artifacts: [Chromium 4k](https://github.com/natanelia/zerocopy/actions/runs/46077230542/artifacts/15236205435), [Chromium 16k](https://github.com/natanelia/zerocopy/actions/runs/46077230542/artifacts/15236170706), [Firefox 4k](https://github.com/natanelia/zerocopy/actions/runs/46077230542/artifacts/15235767187), [Firefox 16k](https://github.com/natanelia/zerocopy/actions/runs/46077230542/artifacts/15235372324).

| Engine/lanes | JSON direct total ms | Hand-written append total ms | Schema total ms | Hand-written → schema build ms | Hand-written → schema p95 ms |
|---|---:|---:|---:|---:|---:|
| Chromium 4096 | 250.64 | 204.03 | 187.22 | 27.43 → 54.79 | 11.48 → 10.36 |
| Chromium 16384 | 898.69 | 754.40 | 554.70 | 89.24 → 161.73 | 43.76 → 43.44 |
| Firefox 4096 | 298.78 | 209.06 | 178.12 | 22.74 → 38.10 | 11.48 → 9.66 |
| Firefox 16384 | 984.16 | 524.18 | 393.18 | 63.30 → 144.22 | 31.34 → 22.04 |

Median paired schema/append ratios .904/.756 Chromium and .842/.759 Firefox; 19/20 wins overall. A/A append ratios .976/.966 and .963/1.015; schema A/A .957/1.017 and .983/.976. 16k final used arena 29,606,000 B schema vs 29,948,688 B hand-written and 27,240,340 B JSON. No RSS/PSS measurement. The schema scan deliberately filters bounds before building row metadata; hand-written baseline did not. Do not attribute the difference to storage or compiler alone. Cold build is materially slower; schema first reply excludes build. Positive but not a production qualification; current numeric fixture does not establish string/nullable field performance.

### Next: packed schema ingestion and matched predicate control

Keep the same schema, persistent vectors, updates and query path. Add direct pre-sized typed column/payload construction for cold ingest after validation, preserving original schema build as A/A and A/B control. Hand-written append-predicate control checks the same cheap bounds before materializing metadata. Include build + first reply separately, point/attach/mutation p95, scan and full replay; verify exact rows, nullable/string/array correctness, duplicates, collision, empty input and subsequent edits. Six balanced rounds across six modes, same four browser/size cells. No new production runtime, no merge or publishing. A useful cold improvement must not be inferred until results return; mixed string/nullable throughput and larger representative workloads remain next gates. #100 still draft and no human review, main unchanged.


## Packed ingestion and matched predicate — Nov 28

[Run 46082132617](https://github.com/natanelia/zerocopy/actions/runs/46082132617), exact head `30d781c15dd63f7dec317b9f25c5f9bb0e118f9e`. All four jobs succeeded, 144 measured verified cases (6 balanced rounds × 6 modes × 4 engine/size cells, warmups excluded). Medians recalculated from full verified job-log JSON, including paired ratios by round. Raw artifacts: [Chromium 4k](https://github.com/natanelia/zerocopy/actions/runs/46082132617/artifacts/15237710514), [Chromium 16k](https://github.com/natanelia/zerocopy/actions/runs/46082132617/artifacts/15237283446), [Firefox 4k](https://github.com/natanelia/zerocopy/actions/runs/46082132617/artifacts/15237443910), [Firefox 16k](https://github.com/natanelia/zerocopy/actions/runs/46082132617/artifacts/15236279883).

| Engine / lanes | Original schema → packed build ms | Build + first reply (original → packed) ms | Matched numeric total ms | Packed schema total ms | Direct JSON total ms |
|---|---:|---:|---:|---:|---:|
| Chromium 4096 | 68.84 → 51.44 | 179.54 → 163.43 | 224.28 | 253.22 | 341.55 |
| Chromium 16384 | 128.64 → 90.08 | 204.61 → 172.59 | 414.82 | 455.98 | 691.10 |
| Firefox 4096 | 39.12 → 26.82 | 144.76 → 133.21 | 169.62 | 177.48 | 301.31 |
| Firefox 16384 | 136.42 → 95.56 | 315.07 → 260.31 | 393.89 | 417.85 | 1014.42 |

Median paired packed/original build ratios .757/.712 Chromium and .691/.665 Firefox. Packed versus matched numeric total paired ratios 1.132/1.081 and 1.073/1.072. At 16k, p95 matched numeric/packed 25.51/33.22 ms Chromium, 25.60/27.60 ms Firefox. Final used arena bytes unchanged at 29,606,000 schema, versus 29,948,688 hand-written and 27,240,340 JSON. No process RSS/PSS claim. Cold packed ingestion is a useful schema improvement; matching cheap predicates removes the previously reported speed advantage over hand-written storage. Keep the schema as a functionality proof, not a claim of faster numeric scans or a new runtime default.

### Next gate: mixed nullable metadata replay

Test the existing schema storage rather than optimize more numeric-only fixtures. Add nullable UTF-8 road labels, nullable speed limits, review flags, and nullable variable-length numeric connection lists; metadata changes independently on some revisions and new identities have varied values. Identical initial rows, edits, viewport predicates (including review and speed), and visible metadata materialization for JSON full scan, pinned #100 selective JSON scan and its duplicate, original schema ingest and packed schema ingest plus duplicate. Full point results and retained digests include all new fields; expired roots and deleted keys remain checked. Six paired rounds, 4k/16k lanes, four browser readers, 48 revisions, same retention. This is a synthetic structured workload, not actual user map data; no 100k/1M or real application claim yet. No production code, new PR, merge, preview deletion or publication. #100 remains draft on scope/review hold. If mixed performance fails, investigate measured phase overhead before any further runtime work.


## Mixed nullable metadata qualification — Nov 28

[Run 46087917233](https://github.com/natanelia/zerocopy/actions/runs/46087917233), head `a5573b588f1b22752b6cc293532defd1064053c7`: all four jobs succeeded, 144 measured verified cases, six balanced rounds (0–5; -1 excluded), six modes, four actual browser readers, 48 revisions. Raw artifacts: [Chromium 16k](https://github.com/natanelia/zerocopy/actions/runs/46087917233/artifacts/15240580102), [Firefox 16k](https://github.com/natanelia/zerocopy/actions/runs/46087917233/artifacts/15240316841), [Chromium 4k](https://github.com/natanelia/zerocopy/actions/runs/46087917233/artifacts/15240246286), [Firefox 4k](https://github.com/natanelia/zerocopy/actions/runs/46087917233/artifacts/15239329787). Medians from complete verified job-log JSON.

| Engine / lanes | Direct JSON total → packed schema total ms | Direct → schema p95 edit ms | Direct → schema p95 mutation ms | Direct → schema p95 scan ms | Schema/direct paired total ratio |
|---|---:|---:|---:|---:|---:|
| Chromium 4096 | 168.00 → 167.50 | 9.84 → 9.73 | 3.93 → 6.77 | 9.24 → 4.28 | 1.011 |
| Chromium 16384 | 734.45 → 645.00 | 40.84 → 46.91 | 22.72 → 36.87 | 41.18 → 15.14 | .879 |
| Firefox 4096 | 359.73 → 270.00 | 19.44 → 15.07 | 8.52 → 8.94 | 18.11 → 8.96 | .746 |
| Firefox 16384 | 863.79 → 492.39 | 54.43 → 34.50 | 25.04 → 25.96 | 35.76 → 12.92 | .568 |

JSON A/A total ratios .990/1.008 Chromium, 1.024/1.025 Firefox. Packed schema versus original build medians at 16k: 151.46 vs 217.38 ms Chromium, 122.45 vs 188.53 Firefox. Final distinct used arena bytes 32,555,824 vs 30,238,132 JSON (7.7% higher); at 4k 8,388,260 vs 7,347,860 (14.2% higher). No process memory claim. Chromium 16k p95 mutation regresses ~62%; faster scans alone do not clear the interactive gate. No universal win, no default or production PR.

### Next: eliminate intermediate JS arrays during variable-payload bulk append

The measured Chromium mutation tail is the limiting phase; source inspection shows full validated geometry and connections appended element-by-element to growable JS arrays, then converted to Float64Array before persistent append. Hypothesis, not a measured attribution: for 10% replacement bursts, sizing and directly filling numeric payloads will lower transient allocation and mutation time. Keep same layout, validation, operations and persistent updates. Count append lengths after validation; allocate exact typed buffers and verify offsets/lengths. Compare packed ingest + original edit and duplicate against packed ingest + direct payload edit and duplicate, and pinned #100 JSON + duplicate, on unchanged mixed fixture and 4k/16k Chromium/Firefox. No skipping validation, no change to point or scan paths; all historical roots, nulls, signed zero, mixed length, invalid rows, deleted keys and final digests remain checked. Report paired total, bulk revision mutation/round-trip p95, sparse controls, and used bytes separately; no RSS/GC claim absent direct measurement. If not useful, reject instead of tuning further. Proof-only, main and #100 unchanged, no merge/publication.


## Packed variable-payload mutation result — Nov 28

[Run 46093488201](https://github.com/natanelia/zerocopy/actions/runs/46093488201), exact head `62895cf107635163b2d13aeca722723bc44c947c`: four successful jobs; 144 verified measured cases, six rounds per mode/cell, warmups excluded. Recalculated from full verified job logs. Artifacts: [Chromium 4k](https://github.com/natanelia/zerocopy/actions/runs/46093488201/artifacts/15242396057), [Chromium 16k](https://github.com/natanelia/zerocopy/actions/runs/46093488201/artifacts/15242372017), [Firefox 4k](https://github.com/natanelia/zerocopy/actions/runs/46093488201/artifacts/15241874820), [Firefox 16k](https://github.com/natanelia/zerocopy/actions/runs/46093488201/artifacts/15241539253).

| Engine / lanes | JSON direct total ms | Original packed total ms | Direct-payload total ms | Original → direct p95 mutation ms | Original → direct p95 edit ms | Median paired direct/original total |
|---|---:|---:|---:|---:|---:|---:|
| Chromium 4096 | 194.28 | 182.32 | 191.50 | 7.01 → 6.55 | 9.86 → 9.90 | .972 (5/6) |
| Chromium 16384 | 441.71 | 405.89 | 379.07 | 24.25 → 20.01 | 29.05 → 26.64 | .929 (5/6) |
| Firefox 4096 | 355.93 | 276.39 | 268.88 | 10.00 → 8.14 | 15.39 → 16.78 | .977 (6/6) |
| Firefox 16384 | 440.37 | 262.09 | 247.44 | 15.80 → 14.05 | 19.36 → 19.74 | .949 (6/6) |

Paired mutation ratios .857/.836 Chromium, .848/.904 Firefox. Paired total versus direct JSON .976/.850 and .753/.560. Schema original A/A total ratios .986/.988 and .956/1.004; direct-payload A/A .947/.970 and 1.009/.980; JSON A/A 1.026/.994 and .993/.981. Direct payload is a modest useful proof-only simplification of transient allocation, not a major end-to-end win. At 16k Chromium JSON p95 edit 25.93 ms and mutation 15.10 ms, still better than direct payload; Firefox p95 edit 27.34 ms and mutation 14.69 ms. Arena bytes unchanged versus original schema, 32,555,824 versus 30,238,132 JSON (7.7% higher). No browser process memory or GC measurement. The new logs use different CI hosts than prior runs; do not compare absolute elapsed across runs. Keep the direct-payload implementation for scale qualification, do not promote default or claim universal win. Stop small numeric and compaction tuning.

### Next gate: 100k mixed records, matched scan and point-heavy replay

Same fixture, current main and pinned #100 JSON control; no production runtime change. Compare only direct selective JSON and direct-payload schema, each with independent A/A duplicate. Four balanced rounds per engine/workload (every arm occupies each order position once) plus warmup. 100k live rows, four real browser readers, 48 revisions, 10% identity replacement every fourth revision, two retained named checkpoints. Standard spread uses prior viewport/point cadence. Spread-point exercises 128 independently selected point reads per worker per revision and scans on initial attachment and every twelfth revision starting at revision 1. Same mutations, full output checks and retention across arms; not a point-only microbenchmark. Report cold build + first correct reply, full timed replay, sparse and replacement phase p95 separately, scan count and arena used/capacity. Bound diagnostic peak allocation by hashing fixed-size ordered chunks and hashing their digests; still verify every field and absent ID at retained/expired roots. Diagnostic hashing is untimed in both arms, not a storage optimization or comparable digest to old runs. 45-minute bounded read-only proof job, no secrets, no new production PR or publication. If scale/point-heavy loses, document the tradeoff and avoid further speculative tuning. Synthetic map-like fixture, not a proprietary or real map trace. No process memory claims. #100 remains draft with no formal review and no scope-matched publication authority, main unchanged.


## 100k mixed-record qualification — Nov 28

[Run 46097863881](https://github.com/natanelia/zerocopy/actions/runs/46097863881), exact head `3dbf464162c3fc8ea6baac535b065d97bfea1c7b`: four successful jobs, 64 timed verified cases (four balanced rounds × four arms × four engine/workload cells), all 16 schema/JSON paired total comparisons favored schema. All four readers verified current, retained and expired roots. Raw [Chromium scan](https://github.com/natanelia/zerocopy/actions/runs/46097863881/artifacts/15244576802), [Chromium point](https://github.com/natanelia/zerocopy/actions/runs/46097863881/artifacts/15244736276), [Firefox scan](https://github.com/natanelia/zerocopy/actions/runs/46097863881/artifacts/15244326632), [Firefox point](https://github.com/natanelia/zerocopy/actions/runs/46097863881/artifacts/15244731378). Recalculated medians and median paired ratios from complete verified job-log JSON, excluding round -1.

| Engine/workload | JSON → schema total ms | JSON → schema cold build + first reply ms | JSON → schema p95 edit ms | JSON → schema p95 point ms | JSON → schema bulk p95 mutation ms | Paired total ratio |
|---|---:|---:|---:|---:|---:|---:|
| Chromium scan | 3113.79 → 1981.28 | 1012.61 → 704.72 | 199.05 → 139.63 | 2.91 → 3.38 | 123.19 → 156.74 | .643 |
| Firefox scan | 4514.81 → 1746.82 | 1340.50 → 697.40 | 301.81 → 120.83 | 2.44 → 2.04 | 167.99 → 118.44 | .384 |
| Chromium point | 2209.70 → 1840.45 | 919.92 → 686.16 | 144.21 → 130.45 | 9.08 → 10.75 | 113.95 → 147.49 | .830 |
| Firefox point | 2142.72 → 1434.44 | 1115.49 → 638.05 | 132.58 → 99.53 | 4.94 → 7.87 | 149.37 → 108.36 | .673 |

A/A total ratios (JSON/schema): Chromium scan 1.001/.984, point .997/.995; Firefox scan .990/1.010, point .995/1.010. 100k current used arena bytes 196,618,680 JSON versus 204,103,268 schema (+3.8%); allocated capacities 196,673,536 versus 204,144,640. Arena bytes are not process memory. Schema's point-heavy total win includes four full scans per replay (plus initial scan), not a point-only win. Chromium bulk mutation paired ratio 1.288 scan and 1.311 point; point-heavy bulk edit-to-answer ratio 1.261. Point-heavy paired point p95 ratios 1.196 Chromium and 1.567 Firefox. Sparse mutation medians .67→1.17 ms Chromium point and .45→.76 Firefox point. Scan p95 paired ratios .383/.346 Chromium and .253/.228 Firefox. Substantial end-to-end gains at scale, but a material bulk/point regression remains. No default or production PR, no 1M claim, no main changes. This is still a synthetic map-like workload, not a production trace.

### Next: bounded phase attribution, not another speculative optimization

At 100k and 10k replacement bursts, instrument only the schema proof's input validation/index lookups, payload sizing/allocation, mutation-plan construction, per-column persistent updates, and key-index mutations. Separate point lookup from full row materialization in actual workers. Same 100k point-heavy trace, both browsers, same four readers and retained correctness. Compare uninstrumented schema/A-A versus instrumented schema/A-A with four balanced rounds. Report raw stage timings, column append/patch counts and per-column elapsed, point lookup/materialization aggregates per worker per revision; do not infer causation if instrumentation overhead materially changes latency. Prior pinned JSON benchmark already established the control and is not repeated in this attribution-only run. No new storage strategy, runtime code, PR or publication. If measured stages do not reveal an actionable proportional fix, stop micro-tuning and focus on production semantics/real application integration once #100 is resolved.


## 100k phase attribution — Nov 28

[Run 46102762214](https://github.com/natanelia/zerocopy/actions/runs/46102762214), exact head `8e15aba14e10d73d8858d8c22f34c23de66ab458`: both jobs passed; 32 timed verified cases, four balanced rounds per arm per browser, warmup excluded. Raw [Chromium](https://github.com/natanelia/zerocopy/actions/runs/46102762214/artifacts/15246427829), [Firefox](https://github.com/natanelia/zerocopy/actions/runs/46102762214/artifacts/15246187532). Recomputed medians from complete verified log JSON. 100k mixed rows, four readers, 48 revisions including twelve 10k replacement bursts.

| Engine | Uninstrumented → instrumented total ms | Bulk validation + lookup ms | Payload sizing ms | Planning ms | Apply columns ms | Index writes ms | Point lookup / materialization ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Chromium | 1488.65 → 1529.47 | 525.18 | 7.50 | 305.01 | 96.59 | 132.24 | 125.57 / 487.57 |
| Firefox | 1150.66 → 1117.42 | 321.62 | 13.22 | 206.88 | 78.77 | 127.22 | 105.43 / 340.99 |

Stage totals aggregate twelve bulk revisions before taking medians. Point parts aggregate worker times across all 48 revisions; not wall-clock latency, and not additive to replay wall time. Validation/lookup plus planning are ~78% Chromium and ~71% Firefox of the five median stage sums. Materialization ~79%/~76% of measured lookup+materialization. Instrumented total is +2.7%/-2.9% by ratio of medians; duplicate arm totals uninstrumented/instrumented 1501.26/1510.27 Chromium, 1133.95/1124.95 Firefox. Timers perturb paths and cannot isolate validation from lookup. Bulk p95 mutation uninstrumented/instrumented 123.35/130.99 ms Chromium, 88.15/84.87 Firefox. No measured process memory. Do not attribute earlier JSON gaps to these phases alone.

### Next: direct fresh-row column append, one measured hypothesis

Most planning time is outside persistent column operations. Source inspection shows each new row dispatches every field through a dynamic write planner and grows scalar JS arrays, even when every insertion is a fresh identity. Reuse the cold packed column builder for such batches: size variable payloads, append preallocated scalar/payload columns with old payload offsets, patch only removed occupancy, preserve same index operations and prior full validation. Existing-row/mixed edits fall back unchanged. Preserve layout, row identity, old roots, nullable UTF-8, empty arrays, signed zero, collision and failure behavior. Both baseline and candidate share the factored cold builder. No skipped validation, no point-read change, no new production API. Compare previous packed bulk and new column bulk, each with duplicate A/A, four balanced rounds, both 100k scan and point workloads, both browsers, four actual workers, same checks/retention; record paired bulk p95, total and sparse controls, arena bytes. If this doesn't materially reduce bulk tail without regressions, stop this optimization rather than tune small cases. No new production PR, main change, merge or deployment; #100 still on draft/review/publication hold.


## Fresh-column append qualification — Nov 28

[Run 46107878075](https://github.com/natanelia/zerocopy/actions/runs/46107878075), exact head `844bda7c7bd5d65c7be8bb91a5263e327000fe8d`: all four jobs passed, 64 timed cases verified, four balanced rounds per arm per engine/workload, warmup excluded. Recomputed from complete job-log JSON. Raw artifacts [Chromium scan](https://github.com/natanelia/zerocopy/actions/runs/46107878075/artifacts/15248462689), [Chromium point](https://github.com/natanelia/zerocopy/actions/runs/46107878075/artifacts/15248278136), [Firefox scan](https://github.com/natanelia/zerocopy/actions/runs/46107878075/artifacts/15248462659), [Firefox point](https://github.com/natanelia/zerocopy/actions/runs/46107878075/artifacts/15247744820). Same synthetic 100k mixed rows, four workers, 48 revisions and twelve 10k replacement bursts.

| Engine/workload | Old → fresh columns total ms | Old → fresh columns bulk p95 mutation ms | Old → fresh columns point p95 ms | Old → fresh columns cold build + first ms |
|---|---:|---:|---:|---:|
| Chromium scan | 1910.33 → 1858.64 | 146.66 → 118.67 | 3.33 → 3.20 | 673.05 → 668.62 |
| Chromium point | 1809.04 → 1770.91 | 150.11 → 117.22 | 10.26 → 9.87 | 684.43 → 693.10 |
| Firefox scan | 1488.10 → 1428.11 | 127.35 → 96.46 | 1.51 → 1.65 | 595.96 → 574.87 |
| Firefox point | 1633.33 → 1544.05 | 118.12 → 110.66 | 10.65 → 10.48 | 696.40 → 698.18 |

13/16 paired primary-arm totals favored fresh columns; ratio-of-medians total gains 2.1–5.5%, bulk p95 reductions 6.3–24.3%. Duplicate-arm totals old/fresh: Chromium scan 1892.16/1848.22, point 1856.06/1751.09; Firefox scan 1469.00/1414.34, point 1641.82/1543.66. The modest total gains are not uniform; Firefox scan point p95 rose ~0.14 ms. No direct JSON arm in this run, so do not claim the previous JSON bulk gap is eliminated by cross-run comparison. Arena used unchanged at 204,103,268 bytes in all arms (two arenas, not process memory). Keep as proof-only fresh insert path, no further bulk tuning. Main unchanged, #100 still draft without formal review or scope-specific publication approval.

### Next gate: direct full-row materialization

The earlier attribution identified materialization as 76–79% of measured worker point processing, not wall-clock. The current row decoder allocates a mapped entry array and one pair per field, and looks descriptors up by name even though it already iterates them. Test a direct loop over resolved descriptors using the identical field decoder; preserve independent returned objects/arrays, key order, misses, collision checks, bounds checks, signed zero and retained snapshots. Both arms share factored field decoding and fresh-column bulk; change only the full-row get path (scan path stays unchanged). Four balanced rounds plus warmup, two independent duplicates, 100k scan and point-heavy browser traces, same correctness, historical roots and arena checks. Assess absolute point and total latency, A/A noise, and regressions; no claims before raw results, no more small materialization tuning if no meaningful win. No production PR or deployment.


## Direct full-row read qualification — Nov 28

[Run 46112290698](https://github.com/natanelia/zerocopy/actions/runs/46112290698), exact head `9efa63b9a986475165d4725cf5d2337c527b0ec8`: four successful jobs, all 64 timed cases verified, four balanced measured rounds per arm per engine/workload. Recomputed from complete verified job-log JSON (round -1 excluded). Raw artifacts: [Chromium scan](https://github.com/natanelia/zerocopy/actions/runs/46112290698/artifacts/15250596100), [Chromium point](https://github.com/natanelia/zerocopy/actions/runs/46112290698/artifacts/15250152044), [Firefox scan](https://github.com/natanelia/zerocopy/actions/runs/46112290698/artifacts/15250796220), [Firefox point](https://github.com/natanelia/zerocopy/actions/runs/46112290698/artifacts/15249279947).

| Engine/workload | Original → direct-row total ms | Original → direct-row point p95 ms | Paired total ratio (candidate/base) | Paired point ratio |
|---|---:|---:|---:|---:|
| Chromium scan | 1495.49 → 1498.13 | 2.73 → 2.78 | .998 | 1.031 |
| Chromium point | 1344.68 → 1308.52 | 8.11 → 6.84 | .961 | .848 |
| Firefox scan | 1726.17 → 1743.34 | 2.34 → 2.33 | 1.002 | 1.136 |
| Firefox point | 953.39 → 1018.08 | 5.68 → 5.47 | 1.072 | .984 |

Total wins 8/16. A/A total paired ratios (original, direct) Chromium scan 1.000/1.000, point .977/1.048; Firefox scan .995/.996, point 1.060/.970. Chromium point duplicate candidate/base total 1.031, point p95 .996: the primary point gain does not reproduce in the duplicate. Firefox point total regresses within substantial baseline A/A variation. All arms end at 204,103,268 used arena bytes. **Reject the direct-row optimization as unproven, retain only as historical proof; use fresh-column append with original get for subsequent qualification.** No more small row materialization tuning. No direct JSON control here; no cross-run speedup claim. #100 exact head and main unchanged; automated review has no actionable findings but formal reviews remain empty and the draft/publication gate is unchanged.

### Next gate: long-lived mixed storage, measured process memory

The 100k fixture retains 220k allocated row slots after just twelve replacement bursts; 204 MB arena data is not actual resident memory, and neither snapshot expiration nor unused slots necessarily returns memory. Before attempting 1M rows or additional storage algorithms, test 96 revisions (24 10k replacement bursts) with four actual readers, two retained checkpoints, scan-heavy cadence, same mixed fixture, pinned #100 selective JSON versus best qualified schema (fresh-column append with original get), each duplicated in four balanced rounds. Report cold/settled latency, per-revision arena growth, retained/expired full verification and actual sampled Linux descendant-process PSS (proportional set size counts shared physical pages proportionally) during each fresh browser trial. Sampler uses asynchronous ps and /proc/<pid>/smaps_rollup reads, records elapsed time, process count and read failures; no missing process is treated as zero, use complete samples only. This is whole-trial sampled browser/driver descendant memory including reference fixture and untimed verification, not storage-only RSS, exact instantaneous peak or GC attribution. Record A/A variation and no universal browser/process claim. No runtime changes, new PR, merge or publication. Only this new proof run; no repeat of prior direct-row benchmark.


## Long-churn failure and bounded recovery — Nov 28

[Run 46116426311](https://github.com/natanelia/zerocopy/actions/runs/46116426311), exact head `e01976604a866aed2d620dc0caa1cbc413f9e4fa`: both Chromium and Firefox passed six schema unit tests but the browser replay trapped inside the **JSON control's** SharedMap.deleteMany → Arena.delete → WebAssembly path before any complete trial was logged. No verified comparative memory or timing results. Artifacts [Chromium](https://github.com/natanelia/zerocopy/actions/runs/46116426311/artifacts/15251453619) and [Firefox](https://github.com/natanelia/zerocopy/actions/runs/46116426311/artifacts/15251916344) contain setup/hash/partial logs, not completed trial JSON.

Likely cause, not yet proven: current main's memory.ts defaults to 256 MiB per arena; Rust memory.rs ensure_capacity traps if memory.grow fails. Prior 48-revision JSON control already used 196,618,680 B in its arena. The 96-revision trace increases cumulative replacements to 240k. A trap alone does not establish exhaustion versus another invariant failure. Test a single matched 512 MiB maximum **per arena** for both JSON and schema, using public configureMemory before any allocations in the fresh page; no runtime change, no change to initial reservation policy or actual logical workload, no claim of bounded memory or safe default. Preserve original four balanced rounds, worker checks, retention, PSS sampler and pinned #100 control. Capture mode, failing revision, last verified used/capacity, post-failure arena usage if available and partial PSS/stack even on failure. If successful, results apply only under this larger cap; document that default-cap behavior failed and investigate compaction/reuse and graceful allocation failure before production. If it still traps, isolate the minimal failing sequence rather than repeating. Main unchanged, #100 still draft with no formal review; no production PR, merge or publication.


## Long-churn recovery and memory qualification — Nov 28

[Run 46121147439](https://github.com/natanelia/zerocopy/actions/runs/46121147439), exact head `204413df7ca054435cfd35a509e24f714ca9d51a`: both jobs passed, 32 timed verified cases, four balanced measured rounds per arm and engine, warmup excluded. Raw artifacts [Chromium](https://github.com/natanelia/zerocopy/actions/runs/46121147439/artifacts/15253719637) and [Firefox](https://github.com/natanelia/zerocopy/actions/runs/46121147439/artifacts/15253724869). Recomputed medians of complete verified job-log JSON. 100k synthetic mixed rows, four actual workers, 96 revisions, 24 x 10k replacements, retention two checkpoints with full digest of each expiring and remaining checkpoint in all readers. Matched 512 MiB per-arena ceiling (not a new default).

| Engine | JSON → schema total ms | Build + first ms | Scan p95 ms | Mutation p95 ms | Point p95 ms | Whole-trial sampled peak PSS MiB |
|---|---:|---:|---:|---:|---:|---:|
| Chromium | 7053.20 → 4245.58 | 1083.31 → 792.27 | 167.86 → 61.00 | 129.57 → 132.66 | 3.48 → 3.68 | 3380.70 → 2289.03 |
| Firefox | 9560.79 → 3902.79 | 1377.41 → 711.57 | 222.18 → 60.16 | 150.74 → 105.87 | 2.86 → 2.64 | 1921.15 → 2404.09 |

Duplicate arm total medians JSON/schema: Chromium 7295.31/4279.88, Firefox 9569.91/3902.66; duplicate PSS 3185.38/2268.94 and 1901.37/2449.26 MiB. PSS includes the complete browser/driver tree, reference rows, and separately timed exhaustive verification; it is sampled at 250ms, not storage-only or exact instantaneous peak. Chromium favors schema, Firefox materially regresses in this metric. No universal process-memory win. JSON used 318155132 B (303.42 MiB) in one arena at end, exceeding the previous 256 MiB per-arena ceiling; successful recovery strongly supports capacity exhaustion in the prior run, but exact failed allocation was not instrumented there. Schema used 323101436 B across two arenas (308.13 MiB) with 340k slots for 100k live rows. No compaction, same current bytes even after history release: freeing JS references alone cannot reclaim unreachable content inside a live append-only arena. Not a long-running production guarantee. #100 unchanged draft, no formal approval, no main changes.

### Next: matched live-generation compaction proof

Compare uncompact JSON and best qualified schema with a fixed 48-revision repack cadence for each, at the same 512 MiB ceiling and four balanced measured rounds. Prior run provides duplicate-arm noise context; do not compare across runner hardware for a precise speedup. JSON uses existing compact(map); schema gathers occupied slots and directly copies live variable numeric ranges and scalar columns into newly allocated arenas, rebuilds key-to-slot index, preserves nullable/empty/UTF-8 data and all old snapshots. Only in the dedicated single-writer proof reset module default arenas; not safe as a general public API. No slot identifiers escape. Include both compaction pauses in measured edit-to-answer, named retained and distinct old/new handoff bytes, current arena bytes after release, whole-trial PSS and exact full digests. Unit test old reader attachment, multiple generations, slot count, edits after repack, empty roots and distinct arena IDs. The two-generation overlap can increase peak memory despite lowering final used bytes; no claim until qualified. Fixed cadence is an experimental control, not a proposed default. If overlap/latency gates fail, record rather than ship. No production changes, new PR, merge, preview deletion or publication.


## Matched generation compaction decision — Nov 28

[Run 46125991455](https://github.com/natanelia/zerocopy/actions/runs/46125991455), exact head `fd490c033445ab779d2f829ffb66af0c0bec2f2e`: both browser jobs passed, 32 verified timed cases (four balanced rounds per arm and engine, warmup excluded). Recomputed from complete job-log JSON; raw artifacts [Chromium](https://github.com/natanelia/zerocopy/actions/runs/46125991455/artifacts/15255792948), [Firefox](https://github.com/natanelia/zerocopy/actions/runs/46125991455/artifacts/15256301129). Same 100k mixed rows, 96 revisions, 24 × 10k replacements, four readers, two held checkpoints, matched 512 MiB cap per arena. Fixed repack every 48 revisions.

| Engine | JSON no repack → repack total ms | Schema no repack → repack total ms | Schema bulk edit p95 ms | Schema two repacks ms | Schema sampled peak PSS MiB |
|---|---:|---:|---:|---:|---:|
| Chromium | 5425.37 → 5462.11 | 3045.33 → 3888.94 | 120.24 → 472.98 | 829.03 | 2259.32 → 1974.49 |
| Firefox | 7309.78 → 7470.70 | 3193.37 → 3977.52 | 134.04 → 523.09 | 835.79 | 2566.10 → 2551.19 |

Schema current used bytes 323101436 → 81489600 (−74.8%), slots 340000 → 100000; JSON 318155132 → 80653932 (−74.6%). But schema distinct held arena bytes at final checkpoint 281967020, peak handoff 345076912 versus no-repack 323101436; release leaves 81489600 current used bytes, not proof of immediate resident memory release. JSON final held 282857216, peak handoff 338067524. Whole-trial browser/driver sampled PSS includes untimed exhaustive checks; JSON repack PSS 3452.22 → 1993.12 Chromium, 1977.84 → 2270.65 Firefox. Schema repack total is 1.40× / 1.88× faster than matched JSON repack by median, but its own total is 27.7% / 24.6% slower and bulk tail ~3.9× worse; synchronous pause remains unacceptable as default. Two schema repacks take ~3.3–3.5× JSON time. Retain scalar compaction as proof baseline, no production/default recommendation.

### Next gate: bounded numeric gathers and contiguous payload copies

Source review identifies one numeric list get per live slot per field and one range copy per nonempty array, including a second read of array offsets/counts after validation. Test one bulk numeric source copy per scalar column (temporary source plus dense destination), reuse gathered numeric metadata for validation, and coalesce adjacent source payload ranges without changing slot order or array contents. Preserve scalar path and validation, nonnumeric fields, key index checks, nulls, and old reader generations. Candidate and scalar control each duplicated in four balanced fresh browser rounds, same 100k replay and fixed cadence; compare compaction time, bulk p95, end-to-end, current/held/peak bytes and sampled PSS. Additional unit coverage for reordered payloads, holes, numeric ids, UTF-8, null/empty arrays and old attached readers. No measured gain yet; reject if tails or memory regress materially. This is not a general compaction API, and stable bounded memory still requires a retention-aware policy. #100 still held in draft, formal review list empty; main unchanged. No new PR or publication.


## Range-copy compaction qualification — Nov 28

[Run 46130709273](https://github.com/natanelia/zerocopy/actions/runs/46130709273), exact head `2248c4ac1cb30f662cf894bc0c2dc1aaf8b416ea`: both jobs passed, 32 timed verified cases, four balanced measured rounds per arm/engine (warmup excluded). Recomputed complete job-log JSON; raw artifacts [Chromium](https://github.com/natanelia/zerocopy/actions/runs/46130709273/artifacts/15258246027), [Firefox](https://github.com/natanelia/zerocopy/actions/runs/46130709273/artifacts/15258057095).

| Engine | Scalar → range total ms | Two repacks ms | Bulk edit p95 ms | Sampled peak PSS MiB |
|---|---:|---:|---:|---:|
| Chromium | 3226.87 → 3174.23 | 709.79 → 629.38 | 386.53 → 369.42 | 2114.43 → 2175.95 |
| Firefox | 3893.20 → 3778.82 | 851.12 → 771.25 | 522.50 → 508.78 | 2589.04 → 2633.45 |

All 8 primary and all 8 duplicate paired totals favor range copies; median total gains only 1.6–2.9%, within some A/A variability (individual A/A total ratios .97–1.04), two-repack time down 9.4–11.3%. Duplicate total medians scalar/range: Chromium 3264.54/3197.07, Firefox 3848.01/3744.43; duplicate PSS 2127.04/1933.49 and 2536.46/2580.94 MiB. Firefox point p95 1.68 → 2.21 ms on primary; duplicate 2.05 → 2.16. Same used bytes after release 81489600 and peak handoff 345076912. PSS remains noisy whole-tree sampled memory, not storage-only. Range copies do not solve the hundreds-of-ms pauses; keep as proof control, not a production optimization or default. No more tiny synchronous compaction tuning.

### Next gate: independently compactable shards

Eager scattered slot/span recycling was already rejected on actual arena growth and throughput in run 46049425584. Try separating lifetime domains instead: four independently allocated map/list arena pairs, stable numeric-id partition, same schema and range compaction, no global production contract change. Compare unsharded range baseline, all four shards repacked together every 48 revisions, and one shard repacked every 12 revisions (duplicate stagger arm for A/A). Over 96 revisions each shard gets two repacks in both shard variants; staggered current bytes at end are expected to differ because last repack ages differ. Compare aggregate high-water and final used/live arena bytes, per-arena cap caveat (512 MiB each, not a matched aggregate hard limit), sampled PSS, maximum individual edit and repack pause, all-edit and bulk/sparse p95, total latency, startup/scan/point, exact current/retained worker results. Note staggered compactions occur on bulk revisions in this fixture; no hidden deferred work. No assumption of uniform partition workloads or general public sharding API; numeric IDs are proof-only and old roots keep their original arenas. If extra arena/attachment costs outweigh lower maximum pauses, reject instead of shipping. Same 100k spread churn, four workers and two named retained checkpoints, four balanced measured rounds. Synchronous sharding isolates partition overhead, stagger duplicate estimates noise, prior range run supplies baseline A/A context, not cross-run speed proof. No new production PR or deployment; #100 still held in draft with no formal reviews and main unchanged.


## Staggered shard compaction decision — Nov 28

[Run 46135200506](https://github.com/natanelia/zerocopy/actions/runs/46135200506), exact head `aaf79338928a933d3d05756fc2ddc2cdd0273045`: both jobs succeeded, all 32 timed cases verified, four balanced rounds per mode/engine (warmup excluded). Raw artifacts [Chromium](https://github.com/natanelia/zerocopy/actions/runs/46135200506/artifacts/15260070514), [Firefox](https://github.com/natanelia/zerocopy/actions/runs/46135200506/artifacts/15259059970). Medians recomputed from complete verified job-log JSON. 100k rows, four readers, 96 revisions, 24 replacement bursts, two held checkpoints.

| Engine / metric (ms unless noted) | Unsharded | Four sync | Four stagger | Stagger duplicate |
|---|---:|---:|---:|---:|
| Chromium total | 5057.29 | 5138.55 | 5196.89 | 5242.94 |
| Chromium build + first | 719.98 | 892.66 | 883.33 | 871.45 |
| Chromium max edit | 676.95 | 722.32 | 351.28 | 375.79 |
| Chromium max repack | 555.19 | 576.55 | 199.44 | 205.31 |
| Chromium bulk edit p95 | 624.32 | 560.03 | 315.74 | 317.32 |
| Chromium all edit p95 | 140.55 | 154.17 | 253.26 | 250.14 |
| Chromium peak sampled PSS MiB | 2064.30 | 1963.88 | 2222.74 | 2245.96 |
| Firefox total | 4096.29 | 4372.14 | 4160.89 | 4109.73 |
| Firefox build + first | 644.61 | 777.32 | 755.49 | 745.27 |
| Firefox max edit | 602.08 | 643.06 | 358.35 | 359.39 |
| Firefox max repack | 495.60 | 503.15 | 177.78 | 179.70 |
| Firefox bulk edit p95 | 565.73 | 590.84 | 295.12 | 287.92 |
| Firefox all edit p95 | 122.76 | 141.77 | 200.39 | 197.87 |
| Firefox peak sampled PSS MiB | 2744.27 | 2687.10 | 2480.23 | 2859.93 |

Stagger cuts median trial maximum edit ~48%/40% and bulk p95 ~49%/48% versus unsharded, but all-edit p95 worsens ~80%/63%, cold build+first ~23%/17%, total ~2.8%/1.6% slower. Current used after historical release 81,489,600 → 123,744,424 B (+52%, different generation ages); final retained 281,967,020 → 221,123,600 B, peak handoff 345,076,912 → 322,893,140 B. Firefox PSS gain reverses in duplicate; Chromium PSS increases. Whole-tree sampled peaks include verification, not storage-only resident memory. Each shard repacked twice. Reject fixed stagger as default: exchanges rare extreme pauses for more frequent moderate ones and startup overhead. Preserve proof control. Main unchanged; #100 exact head still draft, no formal review or scope approval.

### Next gate: finer lifetime domains and bounded quiet-window scheduling

Prior schedule places all eight repacks on bulk+scan revisions. Test a quiet revision (no removal, at most 25 changed rows, no full scan) within two revisions before each round-robin deadline, otherwise execute at deadline. No lookahead or hidden idle time. Compare four fixed, four quiet, eight quiet and identical eight control in four balanced fresh rounds. Both counts repack each shard twice within 96 revisions; eight uses six-revision period. Partition count and threshold are experimental, not defaults. Report event type, max and p95 all/sparse/bulk edits, total, startup, scans, point, current/held/handoff and sampled PSS. Unit test early window, forced deadline, each shard twice, attached roots and old reads. Include a local-window replay alongside spread to expose uneven work. If sparse tails or overhead outweigh gains, reject; if synchronous approaches remain slow, investigate worker-owned generations with bounded replay rather than more cadence tuning. No production PR or publication.
