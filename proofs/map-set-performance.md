# Scalar map writes

This change removes repeated upper-branch lookup work from scalar writes.
It does not change the immutable representation, add a second value map,
or require users to call a builder. The public operation remains `map.set`.

## Measured comparison

Source: [completed GitHub validation](https://github.com/natanelia/zerocopy/actions/runs/34801792862) and its
[raw timing, memory, and test evidence](https://github.com/natanelia/zerocopy/actions/runs/34801792862/artifacts/10330799515).
Bun 1.4.2, Immutable.js 5.1.9, AssemblyScript 0.28.20, Linux x64,
AMD EPYC 7763. Each cell has 45 measured samples from three independent
process rounds. The test order rotates; each case gets ten warm-ups.
Times are for complete workloads. Smaller times are better.

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

The unchanged original README string-build workload records 3.8413 ms
for Shared, 5.6149 ms for Immutable.js, and 0.4119 ms for native Map.
That is 1.46x Immutable.js, not the requested general 2x advantage.
Random-order string construction gets close at 1.99x. Numeric construction,
numeric overwrites, and long-prefix construction exceed 2x. Unicode, forks,
and several string or mixed-write patterns do not. All rows remain visible.
Native fresh builds are mutable. Updates to existing native collections copy
once per workload, or once per independent fork, to preserve their base.

## Incremental effect of this change

The paired reference is the same compact-memory engine with this small
writer index disabled. Both use identical compiler settings and workloads.
This separates the new optimization from the preceding memory improvements.
Ratios above 1 mean the index was faster in that measured case.

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

The largest CI improvement is about 9% for numeric construction. Several
other cases improve by 2-5%. Shuffled string construction is about 1% slower;
independent forks are about 4% slower. The local paired run showed a larger
numeric gain, but the CI measurements above are the published primary result.
Small differences may be timing variation; no confidence interval or universal
no-regression guarantee is claimed. The stored-byte equality checks are exact,
not timing estimates.

## Implementation and immutability argument

A 16-entry first-level directory and a 256-entry second-level directory hold
resolved child pointers. Sixteen masks record initialized second-level lanes.
Together these use 1,152 bytes within the existing reserved writer scratch
prefix. Only two scalar WASM globals record the exact last root and first-level
validity. The index does not reserve another memory page or allocate map nodes.

The index belongs to one synchronous allocating writer. A write may use its
lanes only when its input root equals the last indexed output root. Other lanes
are unchanged when the selected immutable path is copied. Forks, interleaved
maps, deletes, bulk changes, and low-level insertions change the root and cause
lazy invalidation. Published nodes never point into the directory.

Before allocating through the indexed path, the writer clears its valid root.
An allocation failure therefore cannot leave partially updated lanes valid for
a retry. User JSON callbacks complete before shared scratch is used. Read-only
worker attachments do not use the writer index and cannot allocate through it.

The result is an ordinary immutable HAMT root. No deferred flush, owner epoch,
or mutation of old nodes is introduced. Worker format 4 and binary layouts are
unchanged by this index. The preceding format-4 memory work remains intact.

## Verification

395 unit tests across 21 files and 16 Chromium tests across five files pass.
Builds, core and Redux type checking, and the real Node worker proof also pass.
The Node worker checks all 12 structures, nested values, memory growth, and at
least 10,000 retained reads during writer updates.

Ten new tests cover shuffled insertion and overwrite histories, frozen handles,
unchanged old payload bytes, forks and interleaved maps, bulk/delete/low-level
insert transitions, exact hash collisions, UTF-8 and large values, allocation
failure and retry, reentrant serialization, ordered maps, and read-only attached
instances. The paired runner checks matching allocated byte counts for every
sample and final stored-payload checksums in each of its 30 workload rounds.
These checks do not constitute formal verification of all possible programs.

## Memory

The three-library post-GC memory comparison counts active backing buffers and
JavaScript caches. A 10,000-item warm map retains 2,061,384 bytes for Shared,
2,149,952 for Immutable.js, and 941,816 for native Map. At 100,000 items the
totals are 15,487,600, 20,032,368, and 8,473,136 bytes respectively.
The index does not undo the preceding compact-memory improvements. It does not
itself reduce these payload allocations. Compaction remains explicit, and old
snapshots can retain their full arena. See the README for all memory scenarios,
startup exclusions, and the distinction between retained and peak memory.

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

The paired mode accepts a second source directory as the last argument. Install
matching dependencies and build both engines first, then copy the same
`proofs/map-set.ts` driver into the reference directory. Paired mode requires
identical storage layouts and aborts on any allocation or final payload change.
The [summary](results/map-set-index-summary.json) preserves metadata and raw
file checksums. The artifact preserves every measured sample. Benchmarking
scripts never rewrite the reference runtime or the candidate runtime.
