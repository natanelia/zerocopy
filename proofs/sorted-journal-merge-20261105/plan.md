# Sorted journal merge plan

Written before any timing on 2026-11-05. Fixed baseline: `77599337867dbf785a5f0311d34637d0b36678fc`.

## Hypothesis and scope

`Arena.radixLeaves()` merges up to four recent sorted-map changes with a canonical radix tree. The existing loop compares the current pending leaf with the same base leaf once for the less-than test and again for the equality test. Reuse the first result for equality. Recompute whenever a pending leaf is emitted and the pending index changes. Published pointers, value decoding, comparison implementation, journal sorting, canonical traversal, format and APIs stay unchanged. Only `arena.ts` changes production source; WASM is identical.

The expected benefit is fewer JS/WASM calls and byte comparisons during complete scans whose pending keys remain ahead of many base keys. A journal entirely before the base should offer little benefit, and canonical/empty roots should not benefit. These cases are mandatory controls. There is no new persistent cache or changed allocation format.

## Fixed ten-case matrix

Every fixture is created through the public API. Its actual journal tag, pending count and canonical base are checked before timing. Base sizes 31 and 4,096 produce canonical roots; additions/overwrites then create precisely one or four pending entries. Numeric payloads are distinct, with overwritten values changed. The byte-order oracle is built independently from native Map inputs without invoking another library operation.

| Case | Shape and timed complete operation | Role |
|---|---|---|
| values-tail-4096 | 4,096 base keys plus one later key; all values array | Target |
| keys-tail-4096 | Same normal-key shape; all keys array | Target |
| values-long-prefix-4096 | Same shape with a 336-byte common UTF-8 prefix; all values array | Long comparison target |
| entries-mixed-4096 | Four interleaved changes: two insertions, two overwrites; all entries array | Mixed journal target |
| values-overwrite-4096 | Four overwrites spread across the base; all values array | Replacement target |
| values-front-4096 | One pending key before all base keys; all values array | Adversarial guard |
| values-small-32 | 31 base keys plus one later key; all values array | Small journal |
| values-canonical-control | 4,096 keys with no journal; all values array | Unchanged path |
| map-get-control | 4,096 ordinary HAMT-map lookups including one-eighth misses; full result array | Unrelated control |
| empty-projections | Both complete keys and values arrays of an empty sorted map | Empty guard |

## Measurement protocol

Adapt the previously reviewed fresh-process driver, with new paths and these fixed inputs. Node 24.22.1 and Bun 1.4.2 use the complete portable builds. Every measured child imports one build, at the same neutral pathname, and executes one case. Baseline/candidate order alternates; case order rotates. Build, test and timing work is serialized using the shared `perf.lock`; subjects inherit CPU 2 affinity.

Screen with two independent process pairs per case/runtime, seven timed batches, and at least 150 ms actual timed warm-up. If worthwhile, freeze runtime/source/harness and confirm with six fresh balanced process pairs, eleven samples, at least 500 ms actual timed warm-up, at least eight warm-up batches and 32,768 output-row bookkeeping units. The 512-batch warm-up cap fails instead of silently relaxing the floor. Separately retain four baseline A/A pairs for `values-canonical-control` and `map-get-control`.

Calibrate a common repeat count using both builds before screening, targeting 20 ms batches, then reuse it in formal confirmation after checking all source/bundle/driver identities. Caps are 65,536 calls, 1,048,576 returned element slots and an estimated 32 MiB returned storage per batch. This estimate is not heap, RSS or peak memory; the previous blackboxed batch may remain alive while the next is built. Empty cases keep the same elapsed warm-up floor. Retain capped/short batches, every observation, adverse controls and failed runs.

Timing includes the outer result-retention array and every complete public materialization. Fixture/oracle creation, memory hashing and verification are outside timing. Every returned array escapes and every row/entry pair is checked, including exact values and order. Both variants perform only the measured operation for their initial check and warm-up. Shared bytes, allocation position and result digests must match and remain unchanged.

The independent units are process medians. Combine candidate/baseline pair ratios geometrically; use nominal 95% Student-t intervals on log ratios, df 5 for six A/B pairs and df 3 for four A/A pairs. Do not treat batches as independent experiments or use A/A to cancel adverse A/B results. Claims must name the runtime, operation, journal shape and workload.

Record and guard baseline identity, all root production/test files, build-support inputs, complete imported JS bundles, root WASM and driver files. Preserve full raw data and exact source identities; lossless gzip is allowed with original length/SHA and round-trip checks. Archive any test-source copies as `.txt` so they cannot be discovered by Vitest. Final reports distinguish local measured commit identities from the published PR revision.

## Correctness risks

Test zero/one/four pending entries, pending keys before/between/after base keys, equal-key overwrites, exhausted journals, long/Unicode keys and normalization, old roots and forks, shared/copy readers, lazy and closed generators, two interleaved suspended scans, and growth/reentry after a pending yield. Counter tests use legitimate snapshots to establish one comparison per base leaf in the single trailing-key case. Real Node workers must verify retained outputs across writer growth/reset. No malformed descriptor is used as a performance fixture.
