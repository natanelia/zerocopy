# Short ASCII map lookup: rejected performance experiment

**Verdict: do not merge the map optimization.** Correctness passed, but the measured changes do not meet the goal of improving the existing API across the tested runtimes. The published candidate improves Node short-key reads while slowing important Bun cases. Both follow-up designs were also rejected.

The original candidate packs ASCII keys of up to 16 bytes into scalar arguments, then hashes, traverses the trie and checks complete key equality in one read-only WASM call. That removes the second JavaScript character scan and bypasses the existing prefix directory for those keys. The measurements show why less work in one layer is insufficient evidence of a faster complete operation.

## Decision and timing interpretation

In the seven-pair main study, Node cold 8-byte and 16-byte lookups have median paired ratios of **0.6927** and **0.6234**. Bun missing-key reads instead have a ratio of **1.1401**, with the candidate slower in **6/7 pairs**. Bun repeated reads beyond the cache capacity have a ratio of **1.1207**, slower in **5/7 pairs**.

At 100,000 keys, Bun cold 8-byte reads, cold 16-byte reads and repeated overflow reads have ratios of **1.1835**, **1.1457** and **1.1727**. These larger-map results reinforce the decision to reject the candidate.

All ratios are computed directly from matched elapsed-time samples: candidate divided by baseline. Below 1 means less time; above 1 means more time. Tables show the median of those paired ratios, separately from the medians of the raw timed batches. The ratio of the two displayed time medians can therefore differ from the paired-ratio column.

The identical-build study is displayed separately. It is never subtracted, divided into the treatment result, pooled with treatment samples, or used to erase an adverse row. For example, the identical-build Bun missing-key ratio is 0.9041; the candidate's 1.1401 remains the recorded result. No samples were removed and no noise correction or statistical-significance claim is made. Different cases perform different numbers of operations per batch, so compare before/after within a row. Exact counts and iterations remain in every raw report.

## Every formal case

[Main archived samples](map-formal.json.gz): seven alternating pairs in each runtime, 28 process samples, 11 workloads. Eight warmups and batch scale 2; ordinary maps have 10,000 keys, overflow cases 32,768 keys, and the warm working set 1,024 keys.

| Runtime | Case | Baseline median batch, ms | Candidate median batch, ms | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `map.number.ascii8.cold` | 126.136 | 92.369 | 0.6927 | 6/7 | 82.568 |
| Node | `map.number.ascii16.cold` | 176.769 | 105.875 | 0.6234 | 6/7 | 88.333 |
| Node | `map.number.ascii32.cold` | 226.174 | 226.974 | 0.9731 | 4/7 | 165.318 |
| Node | `map.number.unicode.cold` | 592.593 | 475.067 | 0.8640 | 5/7 | 369.637 |
| Node | `map.number.ascii8.beyond-cache` | 107.396 | 87.087 | 0.7954 | 7/7 | 80.393 |
| Node | `map.number.ascii16.beyond-cache` | 132.753 | 116.711 | 0.7324 | 6/7 | 87.316 |
| Node | `map.number.ascii16.beyond-cache-repeated` | 91.657 | 72.826 | 0.7924 | 6/7 | 68.495 |
| Node | `map.object.ascii8.cold` | 263.003 | 269.743 | 0.9705 | 6/7 | 234.110 |
| Node | `map.number.ascii8.miss` | 55.950 | 32.273 | 0.6370 | 7/7 | 31.103 |
| Node | `map.number.ascii8.warm` | 51.634 | 53.420 | 1.0044 | 3/7 | 48.432 |
| Node | `map.number.ascii8.updated` | 400.615 | 283.056 | 0.6816 | 7/7 | 244.202 |
| Bun | `map.number.ascii8.cold` | 107.720 | 120.820 | 0.9840 | 4/7 | 93.555 |
| Bun | `map.number.ascii16.cold` | 122.912 | 127.198 | 1.0383 | 3/7 | 103.950 |
| Bun | `map.number.ascii32.cold` | 129.218 | 127.282 | 0.9542 | 4/7 | 108.290 |
| Bun | `map.number.unicode.cold` | 159.485 | 162.033 | 0.9470 | 5/7 | 124.329 |
| Bun | `map.number.ascii8.beyond-cache` | 99.804 | 112.131 | 0.8613 | 4/7 | 68.256 |
| Bun | `map.number.ascii16.beyond-cache` | 106.957 | 106.186 | 0.9995 | 4/7 | 67.897 |
| Bun | `map.number.ascii16.beyond-cache-repeated` | 64.592 | 76.913 | 1.1207 | 2/7 | 56.201 |
| Bun | `map.object.ascii8.cold` | 339.788 | 317.687 | 0.9428 | 5/7 | 267.223 |
| Bun | `map.number.ascii8.miss` | 63.741 | 76.412 | 1.1401 | 1/7 | 58.656 |
| Bun | `map.number.ascii8.warm` | 24.911 | 20.104 | 0.9825 | 5/7 | 16.328 **SHORT** |
| Bun | `map.number.ascii8.updated` | 246.051 | 248.981 | 0.9779 | 4/7 | 205.133 |

## Every identical-build control case

[Identical-build archived samples](map-identical-control.json.gz): the same baseline build on both sides, with the same seven-pair matrix. The “candidate” column here means the second control label, not a changed implementation.

| Runtime | Case | Baseline median batch, ms | Candidate median batch, ms | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `map.number.ascii8.cold` | 133.021 | 127.453 | 0.9496 | 7/7 | 115.180 |
| Node | `map.number.ascii16.cold` | 168.292 | 164.709 | 1.0264 | 2/7 | 152.393 |
| Node | `map.number.ascii32.cold` | 235.677 | 245.473 | 1.0381 | 3/7 | 196.734 |
| Node | `map.number.unicode.cold` | 506.135 | 508.040 | 0.9390 | 5/7 | 406.399 |
| Node | `map.number.ascii8.beyond-cache` | 116.960 | 128.719 | 1.0675 | 3/7 | 104.507 |
| Node | `map.number.ascii16.beyond-cache` | 154.841 | 150.275 | 0.9938 | 4/7 | 121.165 |
| Node | `map.number.ascii16.beyond-cache-repeated` | 110.371 | 115.114 | 1.0167 | 2/7 | 94.054 |
| Node | `map.object.ascii8.cold` | 275.733 | 293.735 | 0.9861 | 4/7 | 257.523 |
| Node | `map.number.ascii8.miss` | 54.160 | 56.364 | 1.0002 | 3/7 | 43.451 |
| Node | `map.number.ascii8.warm` | 55.791 | 56.584 | 0.9696 | 4/7 | 49.007 |
| Node | `map.number.ascii8.updated` | 368.074 | 436.961 | 1.1310 | 3/7 | 332.499 |
| Bun | `map.number.ascii8.cold` | 97.525 | 109.936 | 0.9546 | 4/7 | 82.800 |
| Bun | `map.number.ascii16.cold` | 105.209 | 106.240 | 1.0098 | 3/7 | 88.350 |
| Bun | `map.number.ascii32.cold` | 123.019 | 118.681 | 0.9400 | 4/7 | 103.936 |
| Bun | `map.number.unicode.cold` | 137.106 | 135.151 | 0.9857 | 4/7 | 119.913 |
| Bun | `map.number.ascii8.beyond-cache` | 88.201 | 83.077 | 0.9851 | 4/7 | 75.059 |
| Bun | `map.number.ascii16.beyond-cache` | 104.971 | 102.298 | 0.8812 | 5/7 | 81.916 |
| Bun | `map.number.ascii16.beyond-cache-repeated` | 65.307 | 59.684 | 0.9104 | 5/7 | 47.855 |
| Bun | `map.object.ascii8.cold` | 299.184 | 269.426 | 0.9085 | 5/7 | 239.328 |
| Bun | `map.number.ascii8.miss` | 63.823 | 60.216 | 0.9041 | 4/7 | 51.318 |
| Bun | `map.number.ascii8.warm` | 21.948 | 18.397 | 0.7652 | 6/7 | 16.479 **SHORT** |
| Bun | `map.number.ascii8.updated` | 232.453 | 217.818 | 0.9140 | 4/7 | 195.100 |

## Every large-map case

[Large-map archived samples](map-large.json.gz): seven pairs per runtime at 100,000 keys. This study checks whether bypassing the prefix directory remains beneficial as the trie grows. It contains exactly the five cases specified in the fixed protocol; missing-key large-map cases appear only in the later exploratory studies.

| Runtime | Case | Baseline median batch, ms | Candidate median batch, ms | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `map.number.ascii8.cold` | 113.788 | 95.251 | 0.8346 | 6/7 | 88.384 |
| Node | `map.number.ascii16.cold` | 149.478 | 98.774 | 0.6825 | 7/7 | 92.646 |
| Node | `map.number.ascii32.cold` | 239.773 | 229.064 | 1.0550 | 3/7 | 199.433 |
| Node | `map.number.unicode.cold` | 509.449 | 479.402 | 1.0359 | 3/7 | 427.494 |
| Node | `map.number.ascii16.beyond-cache-repeated` | 130.190 | 99.189 | 0.7815 | 7/7 | 88.035 |
| Bun | `map.number.ascii8.cold` | 96.195 | 119.734 | 1.1835 | 3/7 | 64.051 |
| Bun | `map.number.ascii16.cold` | 105.599 | 120.576 | 1.1457 | 2/7 | 87.039 |
| Bun | `map.number.ascii32.cold` | 120.708 | 120.042 | 0.9032 | 4/7 | 100.208 |
| Bun | `map.number.unicode.cold` | 144.144 | 140.796 | 1.0509 | 3/7 | 117.944 |
| Bun | `map.number.ascii16.beyond-cache-repeated` | 93.295 | 101.849 | 1.1727 | 1/7 | 73.353 |

## Rejected follow-up designs

Two further designs were screened independently against the same main baseline, using the unchanged driver and workloads. Each screen uses three alternating pairs per runtime, eight warmups and batch scale 2. The full small-map screen includes every map workload. The 100,000-key screen includes cold 8/16-byte ASCII, Unicode, missing keys and repeated 16-byte reads beyond the cache capacity.

These are exploratory results and are not pooled with the seven-pair formal study. The tables below retain **every adverse median-ratio row** from the four screens. All positive and adverse rows, raw paired ratios and process samples remain in the linked archives.

### Aggregate ASCII packing

This refinement removed the per-character Unicode branch from packing. Leading Unicode falls back immediately; later Unicode is encoded once after the aggregate ASCII check. The WASM bytes are identical to the original candidate. It did not fix the Bun regressions.

[Small-map screen](map-pack-screen.json.gz):

| Runtime | Case | Baseline median batch, ms | Candidate median batch, ms | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Bun | `map.number.ascii8.cold` | 83.866 | 109.129 | 1.2484 | 0/3 | 79.755 |
| Bun | `map.number.ascii16.cold` | 98.180 | 114.521 | 1.0561 | 1/3 | 97.403 |
| Bun | `map.number.unicode.cold` | 123.727 | 141.988 | 1.2541 | 1/3 | 113.218 |
| Bun | `map.number.ascii8.beyond-cache` | 89.897 | 89.822 | 1.0895 | 1/3 | 60.050 |
| Bun | `map.number.ascii16.beyond-cache` | 85.209 | 108.837 | 1.2773 | 1/3 | 82.777 |
| Bun | `map.number.ascii16.beyond-cache-repeated` | 59.839 | 78.281 | 1.0451 | 1/3 | 51.787 |
| Bun | `map.number.ascii8.miss` | 51.665 | 70.443 | 1.4362 | 0/3 | 49.050 |
| Bun | `map.number.ascii8.warm` | 25.329 | 19.831 | 1.2964 | 1/3 | 15.297 **SHORT** |

[100,000-key screen](map-pack-large-screen.json.gz):

| Runtime | Case | Baseline median batch, ms | Candidate median batch, ms | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `map.number.unicode.cold` | 482.873 | 506.069 | 1.0633 | 0/3 | 453.069 |
| Bun | `map.number.ascii8.cold` | 98.221 | 132.914 | 1.2093 | 1/3 | 67.890 |
| Bun | `map.number.ascii16.cold` | 112.276 | 133.372 | 1.2264 | 1/3 | 108.750 |
| Bun | `map.number.ascii8.miss` | 83.959 | 110.521 | 1.3336 | 0/3 | 71.596 |

### Prefix-preserving packed equality

This refinement hashed and packed short keys together in JavaScript, retained the original prefix-directory lifecycle and passed its cached subtree/shift to a read-only packed equality kernel. It removed native rehashing. Some large-map hit cases approached parity, but misses still regressed; several small-map Bun cases were also slower. It was rejected.

[Small-map screen](map-prefix-screen.json.gz):

| Runtime | Case | Baseline median batch, ms | Candidate median batch, ms | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `map.number.ascii8.miss` | 44.409 | 55.532 | 1.3221 | 0/3 | 39.145 |
| Node | `map.number.ascii8.warm` | 47.725 | 49.547 | 1.0933 | 1/3 | 45.317 |
| Bun | `map.number.ascii8.cold` | 107.201 | 108.321 | 1.0574 | 1/3 | 101.728 |
| Bun | `map.number.ascii16.cold` | 95.395 | 115.091 | 1.2096 | 0/3 | 90.969 |
| Bun | `map.number.ascii8.beyond-cache` | 80.449 | 99.557 | 1.1694 | 0/3 | 80.431 |
| Bun | `map.number.ascii16.beyond-cache` | 87.368 | 121.707 | 1.3930 | 0/3 | 83.693 |
| Bun | `map.number.ascii16.beyond-cache-repeated` | 61.995 | 72.381 | 1.2503 | 0/3 | 49.645 |
| Bun | `map.object.ascii8.cold` | 240.699 | 256.223 | 1.0645 | 1/3 | 229.232 |
| Bun | `map.number.ascii8.miss` | 54.906 | 76.309 | 1.4743 | 0/3 | 51.759 |
| Bun | `map.number.ascii8.updated` | 201.146 | 247.353 | 1.0606 | 1/3 | 196.651 |

[100,000-key screen](map-prefix-large-screen.json.gz):

| Runtime | Case | Baseline median batch, ms | Candidate median batch, ms | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `map.number.unicode.cold` | 456.150 | 486.239 | 1.0660 | 1/3 | 444.569 |
| Node | `map.number.ascii8.miss` | 54.051 | 69.010 | 1.2385 | 0/3 | 53.604 |
| Bun | `map.number.ascii8.miss` | 77.275 | 104.206 | 1.3159 | 0/3 | 70.081 |

## Source, scope and correctness

- Main baseline: `1242908762b554e3574365c486d5a6c52d5e568f`.
- Published measured candidate: `56337fa7aa6dda4eed4dfcc22ecd7edf073cd082`. This evidence-only closeout does not change its runtime implementation.
- Node 24.22.3 and Bun 1.4.2 on Linux x64. Exact runtime versions, CPU metadata, dependency versions, source hashes and built-module hashes remain in each archive. Both revisions use the pinned Rust 1.100.0 build.
- Inputs, construction, reader attachment, warmup, optional garbage collection and verification are outside timing. Cold cases use newly attached readers with empty local caches. Warm and repeated-overflow cases are labelled separately. Integrity copies can warm CPU caches.
- Timed work uses the ordinary public `.get()` API. The full-object case still decodes and deeply freezes its result. Every result, shared allocation/capacity and every byte of the shared prefix are verified after timing.
- These measurements cover loaded-runtime lookup work. They do not measure process or worker startup, transport, application latency, JavaScript heap, peak process memory or browser speed. The original core WASM grows from 54,845 to 57,394 bytes; the prefix refinement is 56,534 bytes. These size changes are not substituted for measured lookup performance.
- The original candidate passed 67 test files / 1,264 tests, the main TypeScript check, seven Rust ABI/read-only audit checks, and the existing real-worker proof with 12 readers and concurrent writer growth. Both refinements passed the main TypeScript check and all 19 focused map tests; the changed prefix kernel also passed all seven audit checks.
- [Focused key tests](../../map-ascii-reader.test.ts) cover empty/NUL keys, packed-word boundaries, actual equal-length hash collisions with identical first halves, Unicode/unpaired surrogates, nonzero end-of-memory padding, deep freezing and retained roots after growth. [The real-worker proof](../rust-migration-20261115/workers.mjs) checks read-only shared bytes, private state and retained snapshots.

## Exact reconstruction of the experiments

The two exploratory commits were local and are not assumed to be fetchable from the remote repository. Use the included patches against the published measured candidate:

| Experiment | Local commit | Exact reconstruction patch |
| --- | --- | --- |
| Aggregate ASCII packing | `6e0933b7561bfbc90ae3f84a16010b2707f3da5f` | [map-pack-refinement.patch](map-pack-refinement.patch) |
| Prefix-preserving equality | `0b41c27e5122059017040376eecb8e08507f4aef` | [map-prefix-refinement.patch](map-prefix-refinement.patch) |

The packing screens were measured while their patch was uncommitted on `56337fa7aa6dda4eed4dfcc22ecd7edf073cd082`; the local packing commit was created afterward from the same source. Its recorded tracked-diff hash and source manifest identify that tested state. The prefix screen was measured after its local commit. Both patches are byte-for-byte diffs from the published candidate to the corresponding local commit.

Create a separate checkout at `56337fa7aa6dda4eed4dfcc22ecd7edf073cd082`, apply exactly one patch with `git apply /absolute/path/to/the.patch`, then rebuild with the pinned dependencies using `bun run build:wasm && bun run build:browser`. Run the unchanged benchmark driver against a separate baseline checkout. See [the original protocol](PLAN.md) for full commands; use `--pairs 3 --warmups 8 --batch-scale 2 --group map` for the small exploratory screen. For its large counterpart use `--count 100000` and the exact `--only` list recorded in that report. Existing evidence filenames must never be overwritten.

## Evidence integrity and independent audit

All seven reports are compressed losslessly with an empty gzip filename and `mtime=0`. [archive.json](archive.json) records the compressed and decoded SHA-256 checksums, exact byte counts, patches and unchanged supporting tools. Original uncompressed reports remain in the local workspace; no duplicate uncompressed raw reports are committed. Reproduction patches have their own checksums.

The [original driver](../performance-20261118/benchmark.mjs), [workloads](../performance-20261118/workloads.mjs) and [independent verifier](../performance-20261118/verify.mjs) are retained. The verifier recomputes summary values from all samples, checks pair/case coverage, stable workload sizes and checksums, runtime metadata, source/build manifest hashes and unchanged-shared-byte assertions. It is a consistency audit, not proof of authenticity or statistical significance. [verification.json](verification.json) records the completed archive audits and local preservation checks.

```sh
node proofs/performance-20261118/verify.mjs \
  proofs/map-lookup-20261118/map-formal.json.gz \
  proofs/map-lookup-20261118/map-identical-control.json.gz \
  proofs/map-lookup-20261118/map-large.json.gz \
  proofs/map-lookup-20261118/map-pack-screen.json.gz \
  proofs/map-lookup-20261118/map-pack-large-screen.json.gz \
  proofs/map-lookup-20261118/map-prefix-screen.json.gz \
  proofs/map-lookup-20261118/map-prefix-large-screen.json.gz
```
