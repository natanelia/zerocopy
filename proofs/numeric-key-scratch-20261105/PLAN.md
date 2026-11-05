# Numeric Unicode-key scratch experiment

## Prospective change and decision

Baseline: `77599337867dbf785a5f0311d34637d0b36678fc`, built independently in `zerocopy-r4-base`. Only the two non-ASCII numeric-key branches in `Arena.setNumber` and `Arena.writeNumber` change. For at most `floor(49144 / 3) = 16381` UTF-16 code units, use the existing `encodeUtf8ForWrite` helper, then immediately copy its borrowed bytes into the existing writer scratch. Keep `encoder.encode` for longer strings, both 49,144-byte checks, and every argument to the generic fallback. No change to `utf8.ts`, the ASCII loop, WASM, storage format, or generic value paths.

UTF-8 after replacement of lone surrogates needs at most three bytes per UTF-16 code unit. The bound therefore guarantees complete encoding within the numeric scratch limit, without a speculative partial pass for longer keys. It is a format bound selected before measurement, not a measured crossover. A valid surrogate pair uses two code units and four bytes. Key comparisons retain the existing UTF-8 replacement semantics; the oracle normalizes keys rather than treating distinct malformed JavaScript strings as distinct stored keys.

The existing helper lazily owns one 49,152-byte ordinary buffer per module. Its lifetime and cap are unchanged. Its first use can allocate that buffer; each result can allocate a small view. This experiment removes an eligible temporary payload buffer, retains the copy into shared memory, and does not claim zero-allocation writes or a cold-start improvement. Missing `encodeInto` retains the helper's native allocating fallback. An encoder that rejects shared destinations still receives ordinary memory.

Accept only a meaningful repeated gain on complete public map writes, with every fixed control retained and no unresolved material adverse control. A confidence interval crossing parity is not proof of equivalence. Preserve unsuccessful screens, failures and exact source/driver identities. Do not tune the length bound from timings.

## Fixed ten workloads

| Name | Collection / value | Public writes per operation | Key / operation |
| --- | --- | ---: | --- |
| map-unicode-short | SharedMap / number | 1024 | Short unique Unicode keys, insert from empty |
| map-unicode-medium | SharedMap / number | 256 | Unique keys with 256 repeated Unicode code units, insert |
| map-unicode-one | SharedMap / number | 1 | One short Unicode key, insert from empty |
| map-unicode-replace | SharedMap / number | 1024 | Changed numeric values over a retained base |
| ordered-unicode-short | SharedOrderedMap / number | 1024 | Short unique Unicode keys, insert |
| sorted-unicode-short | SharedSortedMap / number | 1024 | Short unique Unicode keys, insert |
| map-ascii-control | SharedMap / number | 1024 | ASCII keys, unchanged branch |
| map-long-fitting-control | SharedMap / number | 16 | More than 16,381 UTF-16 units, fewer than 49,144 bytes |
| map-oversized-control | SharedMap / number | 8 | More than 49,144 UTF-8 bytes, original generic fallback |
| map-json-control | SharedMap / object | 256 | Short Unicode keys and JSON values, unchanged writer |

The fixture file defines exact strings, values and order. All input strings/values are prepared before timing. The returned complete maps and a middle snapshot escape the timer and are checked against the native input oracle, including every key/value and insertion or byte-sorted order where specified. Numeric values are changed in the replacement case, so it cannot benchmark the same-value shortcut. Every batch verifies its retained original base and published prefix bytes. Readers may use caches during untimed validation; the next batch gets a fresh Arena, so validation cannot warm that batch's write cache.

## Timed scope and memory

One portable library build and one workload per fresh child process. Use the same neutral copied package pathname for both builds. Before each batch reset the relevant writer Arena and prepare any replacement base outside timing. A timed operation is the full public immutable `set` sequence from that base, including intermediate map wrappers, WASM allocations/growth, and returned final/middle snapshot references. An outer array retaining all operation results is also allocated inside timing. Each repetition forks from the same base in that batch; key strings repeat, and writer caches can become warm within the batch. This is warm repeated-write throughput, not a cold unique-string or setup benchmark.

No forced garbage collection. Release retained results between batches, but do not claim an exact peak-RSS cap: garbage awaiting collection and backing memory reservations can remain. Bound repetitions by 65,536 calls, 131,072 public writes, and an estimated 16 MiB of fresh shared allocations using a conservative key/value-plus-node allowance. Report actual Arena used bytes and capacity, hash the complete published heap after each batch, and compare identical repetition counts across builds. The module's reusable UTF-8 buffer is warm by measured samples. Setup, oracle preparation, verification, hashing and process startup are outside timing. They are identical for both builds.

## Fixed process design

All builds, tests and timings use `/workspace/scratch/83f1d4baba1f/perf.lock`. The timing controller is pinned to CPU 2; children inherit that affinity. Node 24.22.1 and Bun 1.4.2 use the portable JavaScript bundles. This study makes no browser or Bun source-entry performance claim.

Pilot: two balanced fresh before/after process pairs per workload and runtime, seven measured batches per process, at least 150 ms of actual timed warm-up and at least eight warm-up batches. Formal confirmation, only after a credible complete screen: six new balanced process pairs, eleven measured batches, at least 500 ms actual timed warm-up and eight warm-up batches. Rotate workload order between pairs; alternate AB/BA within each workload. No run or sample is dropped.

Calibrate each workload/build in its own fresh process. Select one common repetition count from the larger of the two calibrated counts, with the fixed allocation/work caps. Target 20 ms batches, but record and disclose cap-limited or shorter samples rather than deleting them. Formal runs reuse pilot repetitions only after exact production, complete bundle/WASM, support-file, fixture and driver identity checks. Warm-up and calibration do not supply formal samples.

Use each fresh process's median measured time per complete operation as the statistical unit. Report all pair ratios, their geometric mean, marginal medians and nominal 95% Student-t intervals on paired log ratios (six pairs, five degrees of freedom). These are per-workload intervals without a multiple-comparison adjustment; batch counts are not independent process counts. Report all twenty Node/Bun rows and all fixed controls, including adverse observations.

Before and after each study hash all root runtime sources/tests, every built JavaScript chunk/WASM file, package/build support, CI and the local proof driver/fixtures/plan. Refuse existing output files. Preserve a partial output with errors on failure. No source or driver changes while measurement is active.

## Correctness gates

Use private Arenas for regression tests. Cover all three map kinds; empty/ASCII, BMP, astral and malformed UTF-16 keys; 16,381/16,382-unit eligibility and 49,144-byte acceptance boundaries; overwrite order and normalized-key collisions; immediate scratch consumption across interleaved value writes; retained snapshots/forks and bytes after memory growth; allocation failure/retry; validation and read-only behavior. A fresh-process compatibility proof exercises native, missing-encodeInto and shared-destination-rejecting encoders. Record native shared encodeInto capability on both engines without making it a requirement. A real Node worker proof checks shared and copied readers before/after growth and new attachments. Build/type/focused gates precede timing. An accepted candidate additionally receives the ordinary full suite and root's combined integration gate.
