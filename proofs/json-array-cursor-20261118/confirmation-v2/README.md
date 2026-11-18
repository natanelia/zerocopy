# JSON array cursor: raw-value confirmation

The same runtime source and built JavaScript retain the forward and repeated-index improvements when every actual JavaScript result is stored without coercion. All four forward/repeated cases improved in 7/7 pairs in both Node and Bun. Every formal and control process passed the strict raw-value, primed-cursor, snapshot, dimension/checksum, and shared-memory checks.

This is a separate recording using the [frozen confirmation plan](PLAN.md). The [original measurements](../README.md) and their harness remain unchanged.

## Why this confirmation exists

The original Float64Array output buffer could convert an incorrect null, false, or string value into a number before comparison. This harness uses ordinary preallocated Arrays and compares every returned value with Object.is. The retained array view is first positioned at its final element, then checked at and beyond the boundary, rewound to the first element, and read forward again. These checks run outside timing.

No library runtime changed for this confirmation. All 62 source files and all 12 built JavaScript files per variant matched the original report fingerprints before timing, and the archived report manifests still match them.

## Sequential traversal results

| Runtime | Elements | Before, ms/traversal | After, ms/traversal | Median paired speedup | Faster pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node | 1,024 | 2.943 | 0.218 | 13.5× | 7/7 |
| Node | 4,096 | 47.963 | 0.954 | 51.1× | 7/7 |
| Bun | 1,024 | 4.054 | 0.182 | 22.5× | 7/7 |
| Bun | 4,096 | 72.165 | 0.759 | 94.4× | 7/7 |

Absolute times are normalized from longer batches to one complete traversal. Paired speedups are calculated separately from matched samples, so they need not equal the ratio of the two absolute medians.

## Every formal case, including controls

| Runtime | Case | Before, ms/10k calls | After, ms/10k calls | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `json-array.sequential.1024` | 28.741811 | 2.129340 | 0.074085 | 7/7 | 103.652 |
| Node | `json-array.sequential.4096` | 117.096619 | 2.328394 | 0.019580 | 7/7 | 100.253 |
| Node | `json-array.stride.4096` | 115.030636 | 0.792406 | 0.007371 | 7/7 | 38.147 |
| Node | `json-array.reverse.4096` | 120.668243 | 118.947900 | 0.972399 | 4/7 | 175.662 |
| Node | `json-array.random.4096` | 118.941191 | 75.708148 | 0.641926 | 7/7 | 115.997 |
| Node | `json-array.repeated.4096` | 60.042124 | 2.830397 | 0.041806 | 7/7 | 118.847 |
| Node | `json-array.fields.control` | 0.601731 | 0.622947 | 1.004730 | 3/7 | 28.108 |
| Bun | `json-array.sequential.1024` | 39.590946 | 1.781388 | 0.044404 | 7/7 | 62.212 |
| Bun | `json-array.sequential.4096` | 176.185228 | 1.852799 | 0.010597 | 7/7 | 57.602 |
| Bun | `json-array.stride.4096` | 167.293622 | 1.098131 | 0.007090 | 7/7 | 33.709 |
| Bun | `json-array.reverse.4096` | 164.954293 | 162.292202 | 1.005359 | 3/7 | 235.810 |
| Bun | `json-array.random.4096` | 165.224133 | 110.079263 | 0.690829 | 7/7 | 169.845 |
| Bun | `json-array.repeated.4096` | 80.366982 | 1.368611 | 0.018418 | 7/7 | 59.874 |
| Bun | `json-array.fields.control` | 0.389632 | 0.414617 | 1.046806 | 3/7 | 17.942 (short) |

A ratio below 1 means less elapsed time. No sample is removed, and no result is adjusted using the identical-build control.

## Identical-build controls

Both labels use the baseline source and build. These runs use batch scale 4; the formal matrix uses scale 2, as frozen before timing.

| Runtime | Case | Before, ms/10k calls | After, ms/10k calls | Median paired ratio | Faster pairs | Shortest batch, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `json-array.reverse.4096` | 116.765010 | 113.306335 | 0.970379 | 6/7 | 339.035 |
| Node | `json-array.fields.control` | 0.620839 | 0.578401 | 0.982825 | 4/7 | 53.082 |
| Bun | `json-array.reverse.4096` | 178.475178 | 178.369920 | 1.017029 | 2/7 | 514.925 |
| Bun | `json-array.fields.control` | 0.421698 | 0.419372 | 0.994483 | 4/7 | 34.693 |

The unrelated field control has formal paired ratios of 1.004730 in Node and 1.046806 in Bun; the matching identical-build ratios are 0.982825 and 0.994483.

Reverse traversal has formal paired ratios of 0.972399 in Node and 1.005359 in Bun; the identical-build ratios are 0.970379 and 1.017029. These control differences remain visible and do not establish a general regression-free guarantee.

The Bun formal field control has a 17.942 ms minimum batch and is flagged below the 20 ms reporting threshold. All formal forward/repeated target batches exceed 20 ms. Random access benefits when a forward jump can reuse the cursor; backward/random access still requires a linear scan in the worst case.

## Source and method

- Runtime baseline: `1242908762b554e3574365c486d5a6c52d5e568f`.
- Runtime candidate from the original measurement: `75409acb6d9eab2b26b693c1d690568cd1cedb11`.
- Confirmation checkout head: `0b7c0960adcad3ec61b4a2557490be45df6dcdf7`. Its additional changes are proof/test-only; runtime source and bundle manifest hashes match the original candidate.
- Node 24.22.3 and Bun 1.4.2, Linux x64. Host metadata reports an AMD EPYC 9V45 processor and nine CPU entries. Full environment and fingerprints are retained in each raw report.
- Seven alternating pairs per runtime, each label in a fresh process; eight warmups; case order rotates by pair. Formal and A/A runs executed sequentially.
- Every measured pass starts with a fresh prepared view. Timing includes reading values into the ordinary result Array. Input generation, attachment, view preparation, warmup, forced GC when available, and verification are outside timing.
- Code is warmed, and the integrity copy can warm CPU caches. This measures local attached-reader JsonView access, not process startup, worker-message latency, ordinary full-object .get(), browser performance, or whole-application latency.
- Shared used bytes, capacity, and every byte in the used shared-memory prefix are checked. JavaScript heap allocation and peak RSS are not measured.

## Combined correctness validation

The cursor and selected-string changes merged automatically without conflicts. The combined tree passed all 12 serial checks, including **68 files and 1,274 tests**, **7/7 WASM audits**, type checks, and both dedicated worker proofs with two readers each. Retained readers remained correct while shared memory grew from 131,072 to 327,680 bytes; shared bytes and tracked source stayed unchanged. Both worker CI registrations are retained.

The [combined-validation report and exact logs](combined-validation/README.md) record the tested parents, the published-equivalent string tree, and all source/build identities. This is a correctness check of the combined changes; the timing tables above remain cursor-only measurements.

## Evidence and verification

- [Formal raw samples](formal.json.gz): 28 process samples and all seven cases.
- [Identical-build raw samples](identical-control.json.gz): 28 process samples and both frozen controls.
- [Correctness smoke](smoke.json.gz): four process samples; its short, unwarmed timings are not performance evidence.
- [All recomputed summaries](summary.json), including every smoke, formal, and A/A row.
- [Independent verification results](verification.json), including fixed case/dimension/checksum validation and original runtime identity checks.
- [Lossless archive checksums](archive.json). Decompression reproduces every byte of each original JSON report.
- [Driver](benchmark.mjs), [workloads](workloads.mjs), [verifier](verify.mjs), and [frozen commands/protocol](PLAN.md). The originals remain in their earlier directory.

Verify the archived evidence and recompute its summaries:

```sh
node proofs/json-array-cursor-20261118/confirmation-v2/verify.mjs \
  proofs/json-array-cursor-20261118/confirmation-v2/formal.json.gz \
  proofs/json-array-cursor-20261118/confirmation-v2/identical-control.json.gz \
  proofs/json-array-cursor-20261118/confirmation-v2/smoke.json.gz
```

The verifier checks internal evidence consistency; it does not infer statistical significance or promise performance on other platforms.
