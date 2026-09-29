# Scalar map writes

This experiment measures a writer index that avoids repeated upper-branch lookup during scalar `map.set` calls. It does not change the persistent representation, add another value map, or require a bulk builder.

## Measured comparison

Source: the [September 14, 2026 validation run](https://github.com/natanelia/zerocopy/actions/runs/34801792862) and [raw archive](https://github.com/natanelia/zerocopy/actions/runs/34801792862/artifacts/10330799515). The runner used Bun 1.4.2, Immutable.js 5.1.9, AssemblyScript 0.28.20, Linux x64, and an AMD EPYC 7763 processor. Each cell has 45 samples across three independent process rounds, with ten warm-ups per case and rotating order. Times cover complete workloads; lower is better.

| Workload | Shared | Immutable | vs Imm | Native | vs Native |
|---|---:|---:|---|---:|---|
| Insert 10,000 new string values; shuffled keys | 3.4796ms | 6.9285ms | 1.99x faster | 0.3104ms | 11.21x slower |
| Insert 10,000 new numeric values; shuffled keys | 2.6059ms | 6.3545ms | 2.44x faster | 0.3160ms | 8.25x slower |
| Insert 10,000 Unicode keys and values | 8.7007ms | 6.7029ms | 1.30x slower | 0.3389ms | 25.68x slower |
| Insert 10,000 keys with a long shared prefix | 7.5466ms | 20.2847ms | 2.69x faster | 0.3452ms | 21.86x slower |
| Change 1,000 distinct string entries | 0.3678ms | 0.6531ms | 1.78x faster | 0.1198ms | 3.07x slower |
| Change 1,000 distinct numeric entries | 0.3335ms | 0.8786ms | 2.63x faster | 0.0963ms | 3.46x slower |
| Change 1,000 numeric entries after a full read | 0.4374ms | 0.6407ms | 1.46x faster | 0.1059ms | 4.13x slower |
| 64 independent updates from one retained base | 0.0599ms | 0.0443ms | 1.35x slower | 9.6084ms | 160.32x faster |
| 1,000 changed set/get/has sequences | 0.5443ms | 0.8430ms | 1.55x faster | 0.1466ms | 3.71x slower |
| Insert 10,000 strings including arena creation | 3.7682ms | 7.1686ms | 1.90x faster | 0.3706ms | 10.17x slower |

The original README string-build workload records 3.8413 ms for Shared, 5.6149 ms for Immutable.js, and 0.4119 ms for native Map: a 1.46x gain over Immutable.js. Shuffled string construction reaches 1.99x. Numeric construction, numeric overwrites, and long-prefix construction exceed 2x; Unicode, forks, and several string or mixed-write cases do not.

Native fresh builds are mutable. Updates to existing native collections copy once per workload, or once per independent fork, to preserve the base.

## Paired index comparison

The reference is the same compact-memory engine with the writer index disabled. Both use identical compiler settings and workloads. A ratio above 1 means the indexed build was faster in that case. This isolates the index from earlier memory changes.

| Workload | Speed ratio with index / without index | Identical allocation and stored payload |
|---|---:|---|
| Insert 10,000 new string values; shuffled keys | 0.990x | Yes |
| Insert 10,000 new numeric values; shuffled keys | 1.093x | Yes |
| Insert 10,000 Unicode keys and values | 1.011x | Yes |
| Insert 10,000 keys with a long shared prefix | 1.020x | Yes |
| Change 1,000 distinct string entries | 1.016x | Yes |
| Change 1,000 distinct numeric entries | 1.032x | Yes |
| Change 1,000 numeric entries after a full read | 1.049x | Yes |
| 64 independent updates from one retained base | 0.961x | Yes |
| 1,000 changed set/get/has sequences | 1.023x | Yes |
| Insert 10,000 strings including arena creation | 1.052x | Yes |

The largest CI gain is about 9% for numeric construction; several cases improve by 2–5%. Shuffled strings are about 1% slower, and independent forks about 4% slower. The local paired run had a larger numeric gain, but the CI values above are the primary published result. Small differences may be timing variation. No confidence interval or universal no-regression guarantee is established. Stored-byte equality checks are exact.

## Implementation and immutability

A 16-entry first-level directory and 256-entry second-level directory store resolved child pointers. Sixteen masks record initialized second-level lanes. They use 1,152 bytes of existing reserved writer scratch. Two scalar WASM globals track the exact last root and first-level validity. The index reserves no extra memory page and allocates no map nodes.

The index belongs to one synchronous allocating writer. It is usable only when an input root matches the last indexed output root. Copying one immutable path leaves other lanes unchanged. Forks, interleaved maps, deletes, bulk changes, and low-level insertions cause lazy invalidation. Published nodes never reference the directory.

Before allocation, the writer clears the valid root. Allocation failure cannot leave partially updated lanes valid for a retry. User JSON callbacks finish before shared scratch is used. Read-only worker attachments do not use the writer index and cannot allocate through it.

The output is an ordinary immutable HAMT root. There is no deferred flush, owner epoch, or mutation of old nodes. Worker format 4 and the binary layouts are unchanged by this index.

## Recorded verification

The validation run passed 395 unit tests across 21 files and 16 Chromium tests across five files. Builds, core and Redux type checks, and the real Node worker check also passed. The worker check covers all 12 classes, nested values, growth, and at least 10,000 retained reads during writer updates. These counts identify this run, not every later commit.

Ten new tests cover shuffled writes and histories, frozen handles, unchanged payload bytes, forks, interleaved maps, bulk/delete/low-level transitions, exact hash collisions, UTF-8 and large values, allocation failure and retry, reentrant serialization, ordered maps, and attached views.

The paired runner checks equal allocated byte counts for every sample and final payload checksums for each of 30 workload rounds. These checks do not formally verify every possible program.

## Memory

The post-GC three-library comparison includes active backing buffers and JavaScript caches. A warm 10,000-item map retains 2,061,384 bytes for Shared, 2,149,952 for Immutable.js, and 941,816 for native Map. At 100,000 items the totals are 15,487,600, 20,032,368, and 8,473,136 bytes.

The index neither reverses the earlier compact-memory gains nor reduces these payload allocations itself. Compaction is explicit, and old snapshots can retain full arenas. See the [README](../README.md#memory-shared-vs-immutablejs-vs-native) for all scenarios, startup exclusions, and retained-versus-peak memory.

## Reproduce

```sh
bun install
bun run build:wasm
bun run build:browser
bun run build:types
bun run typecheck
bun run typecheck:redux
bun run test
node proofs/node-worker.mjs
bunx playwright install --with-deps chromium
bun run test:browser
node proofs/run-map-set.mjs proofs/results/map-set.json
bash proofs/run-hot-path-evidence.sh
```

Paired mode accepts a second source directory as the final argument. Install matching dependencies and build both engines first; copy the same `proofs/map-set.ts` driver into the reference directory. Paired mode requires identical layouts and aborts on an allocation or final-payload difference. It does not rewrite either runtime.

The [summary](results/map-set-index-summary.json) preserves metadata and raw-file checksums. The artifact contains every measured sample; its recorded retention end is December 13, 2026. Keep new measurements separate from these records.
