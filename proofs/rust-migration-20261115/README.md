# Rust migration performance proof

The reliable result in this run is the new selective JSON path: all seven paired comparisons were faster for cold map field reads, cold map string predicates and cold list predicates. Repeated queries over fully cached native objects favor existing `.get()` by a wide margin. Full materialization is approximately at parity by paired medians after removing a redundant root JSON scan.

The broad run shows mixed primitive results and substantial timing variation. The focused investigation below did not reproduce the largest apparent slowdown, but leaves modest fresh-reader differences uncertain. The evidence supports the selective JSON use case; it does not support a general claim that migrating languages makes every operation faster.

## Evidence and reproduction

- [benchmark.mjs](benchmark.mjs): complete public-API runner and fixture.
- [final-results.json.gz](final-results.json.gz): all 14 process samples, per-workload samples, paired ratios, compiler/runtime metadata, full SHA-256 hashes for sources and built payloads, arena sizes, and shared-memory digests.
- [primitive-benchmark.mjs](primitive-benchmark.mjs) and [primitive-results.json.gz](primitive-results.json.gz): the separate longer-batch investigation of the flagged numeric operations. It verifies that its bundled inputs exactly match the main report.
- [initial-results.json.gz](initial-results.json.gz): explicitly marked initial diagnostic, run before final optimizations and during concurrent validation. It is not the final performance result.

The AssemblyScript baseline is the exact head of PR #75, `b4c08def84b905026632bfd27612da4efef0a3f0`. Build it with its own dependencies:

```sh
git worktree add --detach ../zerocopy-rust-baseline b4c08def84b905026632bfd27612da4efef0a3f0
(cd ../zerocopy-rust-baseline && bun install && bun run build:wasm && bun run build:browser)
bun install
bun run build:wasm
bun run build:browser
node proofs/rust-migration-20261115/parity.mjs
node proofs/rust-migration-20261115/workers.mjs
```

Run after building both checkouts. The default baseline directory is the sibling `zerocopy-rust-baseline`; `--baseline` and `--candidate` accept alternatives. Set `RUSTC` to the compiler used for the Rust build if it is not on PATH.

```sh
node proofs/rust-migration-20261115/benchmark.mjs --pairs 7 --output proofs/rust-migration-20261115/final-results.json
```

The runner snapshots each complete built JS payload before sampling and verifies that its embedded core matches the raw Wasm. This prevents a rebuild from silently changing the code halfway through a report.

The larger result files are losslessly compressed. [checksums.json](checksums.json) records hashes of both the original JSON and compressed bytes. To inspect a saved result, use `gzip -dc proofs/rust-migration-20261115/final-results.json.gz`. Before running the focused runner against the recorded main result, restore it with `gzip -dc proofs/rust-migration-20261115/final-results.json.gz > proofs/rust-migration-20261115/final-results.json`.

## Method

Seven baseline/Rust process pairs alternate their order. Every sample starts a fresh Node process; every workload resets its writer. Each measured trial follows two untimed warmups over 1,024 records. Workload order rotates between pairs. Imports, setup, reader attachment, explicit garbage collection, verification and byte hashing are outside timing.

Cold JSON cases visit 10,000 distinct products through a new attached shared reader, with no decoded-object cache. Products contain decimal prices, Unicode, escaped descriptions, arrays and nested records. The selected category, price, active flag and ID appear before the larger description and nested fields. Each query returns exactly the same matching IDs, compared outside timing. Full-materialization cases compare every returned record.

Cached cases perform 10,000 reads over a 1,024-record working set. This fits the existing 2,048-record / 2-MiB decoded JSON cache. A repeated view query does not populate that decoded-object cache; its row is deliberately separate from native cached reads.

Every read preserves the entire used shared-memory prefix and reports zero arena growth. All write workloads allocate exactly the same number of arena bytes as the baseline. These checks do not count JS wrappers, decoded strings, caches, result arrays or engine allocations as free; persistent writes intentionally allocate new records.

## Results

Times are medians in milliseconds per 10,000 operations. **Rust/AS below 1 is faster.** “Median paired” first divides each Rust sample by its matching AS sample, then takes the median; it helps expose situations where a ratio of separate medians is misleading. The final column counts pairs with a slowdown exceeding 10%.

| Workload | AS ms | Rust ms | Rust/AS | Median paired | Pairs >1.10× |
| --- | ---: | ---: | ---: | ---: | ---: |
| map.number.write.scalar | 9.052 | 9.447 | 1.044 | 1.029 | 3/7 |
| map.number.write.bulk | 9.228 | 12.820 | 1.389 | 1.375 | 4/7 |
| map.number.read.sequential | 4.099 | 7.578 | 1.849 | 1.261 | 5/7 |
| map.string.write.scalar | 18.082 | 16.727 | 0.925 | 0.952 | 3/7 |
| map.string.write.bulk | 42.272 | 37.861 | 0.896 | 0.898 | 1/7 |
| map.string.read.sequential | 9.116 | 8.972 | 0.984 | 0.968 | 3/7 |
| list.number.write.scalar | 3.153 | 2.854 | 0.905 | 0.946 | 3/7 |
| list.number.write.bulk | 0.979 | 0.962 | 0.982 | 1.175 | 5/7 |
| list.number.read.sequential | 0.642 | 0.727 | 1.132 | 1.284 | 5/7 |
| list.string.write.scalar | 10.683 | 9.737 | 0.911 | 0.846 | 2/7 |
| list.string.write.bulk | 6.107 | 6.430 | 1.053 | 1.014 | 2/7 |
| list.string.read.sequential | 4.330 | 4.557 | 1.052 | 0.972 | 2/7 |
| map.json.native.select.cold | 136.315 | 81.869 | 0.601 | 0.800 | 2/7 |
| map.json.view.fields.select.cold | 61.578 | 28.692 | 0.466 | 0.454 | 0/7 |
| map.json.view.equals.select.cold | 72.908 | 25.997 | 0.357 | 0.355 | 0/7 |
| map.json.native.select.cached | 1.253 | 0.600 | 0.479 | 0.474 | 1/7 |
| map.json.view.equals.select.repeated | 0.488 | 11.954 | 24.496 | 24.325 | 7/7 |
| map.json.view.materialize.mutable | 65.394 | 59.935 | 0.917 | 0.986 | 1/7 |
| map.json.view.materialize.frozen | 73.419 | 65.003 | 0.885 | 0.994 | 3/7 |
| list.json.native.select.cold | 51.526 | 54.017 | 1.048 | 0.981 | 2/7 |
| list.json.view.equals.select.cold | 56.429 | 13.021 | 0.231 | 0.225 | 0/7 |
| list.json.native.select.cached | 0.639 | 0.637 | 0.997 | 1.066 | 3/7 |
| list.json.view.equals.select.repeated | 0.357 | 13.066 | 36.641 | 40.291 | 7/7 |

Cold selective views won in all seven pairs. The paired ranges were 0.271–0.543 for map field reads, 0.108–0.755 for map string predicates, and 0.137–0.290 for list predicates. Those results support this particular selective-reading use case despite noise elsewhere.

Repeated view queries were consistently slower than fully cached native objects: all seven pairs for both map and list. Keep `.get()` when its decoded-object cache serves the workload well. Use views when selected fields are needed from records that otherwise require full decoding and freezing.

Mutable materialization has a paired median of 0.986; the frozen materialization control is 0.994. The mutable API intentionally returns a new detached mutable value, whereas legacy `.get()` freezes decoded records and may cache them. The frozen control retains the freeze cost. Neither result supports a meaningful full-materialization speed claim.

### Primitive flags and uncertainty

| Workload | Rust/AS | Median paired | Paired range | Pairs >1.10× |
| --- | ---: | ---: | ---: | ---: |
| map.number.write.bulk | 1.389 | 1.375 | 0.397–2.613 | 4/7 |
| map.number.read.sequential | 1.849 | 1.261 | 0.565–2.646 | 5/7 |
| list.number.read.sequential | 1.132 | 1.284 | 0.765–1.889 | 5/7 |

The numeric list bulk-write row also has a paired median of 1.175 with five of seven pairs above 1.10, despite its ratio of separate medians being 0.982. The raw samples retain this disagreement.

Attached numeric-map lookup remains primarily a JS read path, and sequential numeric-list reads use JS/DataView with periodic block lookups. A difference in these public-API timings is not automatically a Rust-kernel regression. Short samples, JS compilation state, garbage collection and shared-host variation remain possible contributors. The focused primitive results below investigate these specific flags with longer batches after more warmup.

## Focused primitive follow-up

The focused runner uses the exact same built JS payloads, checked against the main report’s hashes. Nine alternating process pairs run only five numeric cases. Each case has 32 untimed warmup passes. Bulk writes and fresh map reads time 64 passes of 10,000 operations; cached map and both list cases time 1,024 passes. Actual timed batches span 67–1,290 ms, reducing the influence of timer resolution and short-sample compilation effects.

Bulk-map arenas reserve 1 MiB before timing, and their capacities remain unchanged during the measured builds. Fresh reads use a newly attached reader per pass; cached/repeated controls use a primed reader. Every result is summed and checked. All read cases preserve the complete used shared-memory prefix, arena size and capacity.

| Workload | AS ms / 10k | Rust ms / 10k | Rust/AS | Median paired | Paired range | Pairs >1.10× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| map.number.write.bulk | 4.210 | 4.744 | 1.127 | 0.936 | 0.537–1.825 | 4/9 |
| map.number.read.fresh | 5.413 | 5.878 | 1.086 | 1.124 | 0.504–2.210 | 5/9 |
| map.number.read.cached | 0.430 | 0.395 | 0.919 | 0.919 | 0.319–1.755 | 2/9 |
| list.number.read.fresh | 0.092 | 0.100 | 1.092 | 1.271 | 0.538–2.191 | 5/9 |
| list.number.read.repeated | 0.079 | 0.075 | 0.942 | 0.866 | 0.687–1.872 | 3/9 |

The apparent 85% numeric map-read slowdown in the broad table becomes 8.6% by the ratio of medians in this longer diagnostic. Its paired median is 12.4% slower, with five of nine pairs over 10% and a range crossing both directions. Fresh list reads show the same uncertainty: 9.2% by separate medians, 27.1% by paired median, five of nine pairs over 10%, and a wide range. These results leave a modest fresh-reader penalty unresolved; they do not establish a consistent large regression.

Numeric map bulk writes show why both summaries are retained: separate medians suggest 12.7% slower, while the median paired comparison is 6.4% faster, and four of nine pairs exceed a 10% slowdown. Cached map and repeated list medians favor Rust, also with variation between pairs. No primitive speedup or exact-equivalence claim is made from these samples.

The longer diagnostic isolates memory growth and increases warmup; JS cache allocation, garbage collection and shared-host scheduling remain part of these public-API workloads. It is separate from any direct numeric/geometry kernel benchmark.

## Optional kernels and final tuning

[KERNELS.md](KERNELS.md) records the separate scalar/SIMD numeric and geometry checks. The initial geometry path showed a consistent slowdown. Checking alignment once per leaf removed its per-coordinate null branches for ordinary vectors while preserving a general unaligned fallback. The follow-up paired ratios were 1.054 for full vectors and 0.960 for a partial tail, with mixed rather than consistent slowdowns. The final geometry artifact is 1,199 bytes; the main-run payload table below intentionally records the earlier 1,323-byte geometry artifact.

The rebuilt collection core and every reachable shared JavaScript chunk remained byte-identical to the main benchmark after this geometry-only tuning and the whitespace cleanup. No broad performance samples were rewritten.

## Validation evidence

[validation.json](validation.json) records the completed checks: 1,260 unit tests in 66 files, 58 Node proofs, seven build-guard tests, all listed typecheck configurations, documentation examples and installed-package consumers. Logs are retained as [final-vitest.log](final-vitest.log), [final-node.log](final-node.log) and [build-guards-final.log](build-guards-final.log).

[parity-results.json](parity-results.json) records cross-runtime correctness and byte-layout checks against the AssemblyScript baseline. [geometry-abi-results.json](geometry-abi-results.json) additionally verifies aligned, unaligned, address-zero and memory-end geometry reads. [workers-results.json](workers-results.json) records 12 reader workers with a live writer over 60 rounds, including readers attached during writes and growth. It verifies reader isolation, unchanged shared bytes, retained JSON views across growth, zero view freeze calls, and independent explicit materialization.

## Payload size

The Rust core includes the new JSON scanning exports as well as the migrated collection kernels. Gzip sizes use level 9.

| Module | AS raw bytes | Rust raw bytes | AS gzip bytes | Rust gzip bytes |
| --- | ---: | ---: | ---: | ---: |
| persistent-core.wasm | 26,781 | 54,845 | 9,060 | 18,722 |
| numeric-kernels.wasm | 720 | 1,297 | 433 | 747 |
| numeric-kernels-simd.wasm | 782 | 1,529 | 495 | 900 |
| geometry-kernels.wasm | 571 | 1,323 | 362 | 734 |
| Complete shared entry plus reachable JS chunks | 151,524 | 197,975 | 38,889 | 53,878 |

The complete shared JS payload is 30.7% larger before compression and 38.5% larger after gzip. It already embeds the core Wasm, so adding the raw core size would double-count it. Startup/compilation time is excluded from the timed workloads; the larger payload is a separate migration tradeoff.

## Recorded environment

- Node 24.22.1; V8 13.6.233.17-node.58.
- AssemblyScript 0.28.20.
- Rust 1.100.0, commit 0ef1bc386059596dada8fb65b50425aab2ea637a, LLVM 23.1.5, target wasm32-unknown-unknown. Release settings and complete build scripts are retained in the JSON report.
- INTEL(R) XEON(R) PLATINUM 8573C; linux/x64.
- Baseline source fingerprint: `bb2ef10b6ea1e133adc3d592065dd160a6e5525186f7321626b8c1acd13d414b`.
- Rust source fingerprint: `dca77263a7bdc5152b5ffda2af968935aee9f6564fe42009b0dbb6fb706b07b3`.
- Rust core SHA-256: `2e6901f2427b084022d82f421a87290a06ab57fab93baf91ae156ca4275aa08a`.

These measurements describe Node/V8 on this host and these fixtures. They do not establish results for browser engines or different access patterns.

### Source provenance after the main run

Validated production code was committed as `9a2d32e40004934da7b071d94d1caf576e521a6c` after the main run. The only subsequent compilation-source edits before that commit removed trailing blank lines from `rust-toolchain.toml`, `rust/Cargo.toml` and `rust/src/lib.rs`; these were whitespace changes. The report retains the original measured source fingerprint rather than rewriting historical metadata. The measured core and complete JS bundle hashes identify the actual code used by both performance runners.

The tuned geometry build also passed the complete differential proof again and 63 focused geometry, numeric and JSON-view tests. [tuned-vitest.log](tuned-vitest.log) records that run. The original main CI passed, including browser workers and package checks; a secondary job exposed a test-harness timeout in whole-buffer comparison. The final patch isolates that test arena and uses native full-buffer equality without dropping byte coverage.
