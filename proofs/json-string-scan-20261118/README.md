# Selected JSON string scanning: measured evidence

The frozen candidate improves repeated selection of long, unescaped JSON strings through the public `JsonView.get` API. All four predeclared primary cases passed: 4096-byte ASCII and Unicode payloads in both Node and Bun took at least 10% less time by the median paired ratio and were faster in at least 6 of 7 pairs. This supports a scoped performance improvement for plain selected strings. Escaped-string controls were mixed and remain visible below; this is not a universal no-regression claim.

The measured baseline is `1242908762b554e3574365c486d5a6c52d5e568f`; the measured candidate is `4082a1fd6055f085dc081fd82f96ebdd92399f05` (tree `7456328291ee7d6e72567071ae78d2192fcc19c8`). Both had an empty tracked diff during formal timing. Subsequent evidence and CI-registration placement changes do not change the runtime or benchmark bytes.

## Primary result

A ratio below 1 means less elapsed time for the candidate. “Less time” is `1 - median paired ratio`, not a throughput percentage. Results come directly from [the complete formal report](results/formal.json.gz).

| Runtime | Selected 4096-byte payload | Median paired time ratio | Less time | Faster pairs |
| --- | --- | ---: | ---: | ---: |
| Node 24.22.3 | ASCII | 0.683879 | 31.6% | 6/7 |
| Node 24.22.3 | Unicode | 0.720769 | 27.9% | 6/7 |
| Bun 1.4.2 | ASCII | 0.380746 | 61.9% | 7/7 |
| Bun 1.4.2 | Unicode | 0.460443 | 54.0% | 6/7 |

The frozen decision rule is in [PLAN.md](PLAN.md). No formal candidate control crossed both blocking conditions (ratio at least 1.10 and at least 6/7 slower pairs), but the adverse Bun escaped-decoy result was investigated anyway. None of the formal, identical-build or focused batches was below 20 ms; the shortest formal batch was 40.32 ms.

## Adverse controls and follow-up

The full matrix measured the Bun number field after a 4096-byte densely escaped string at **1.141479**, with the candidate slower in 5/7 pairs. A separately recorded [focused plan](escaped-control-plan.json) reran this case and the corresponding selected-string case without changing the runtime or harness. The decoy slowdown did not repeat in the focused comparison (0.977972, faster 4/7). However, the selected escaped-string follow-up was adverse at **1.126530**, faster in only 3/7 pairs. Both observations are retained.

| Bun 4096-byte case | Formal candidate / baseline | Focused candidate / baseline | Full-matrix identical builds | Focused identical builds |
| --- | --- | --- | --- | --- |
| Selected densely escaped string | 0.970078 (5/7 faster) | 1.126530 (3/7 faster) | 0.986698 (5/7 faster) | 0.922983 (5/7 faster) |
| Number after densely escaped string | 1.141479 (2/7 faster) | 0.977972 (4/7 faster) | 0.876224 (5/7 faster) | 0.893375 (5/7 faster) |

Identical-build comparisons (“A/A”) run the same baseline on both sides to show variation in this host/runtime setup. They are separate observations, not corrections: no candidate result is normalized, subtracted, pooled with the follow-up, or discarded. In particular, the favorable identical-build decoy ratios of 0.876224 and 0.893375 do not erase the original 1.141479 result. Full-matrix identical-build ratios range from 0.910332 to 1.137332 in Node and from 0.876224 to 1.119338 in Bun. No confidence interval or statistical significance claim is made from these seven-pair runs.

## Change and supported scope

`jsonStringEnd` finds a selected string's closing quote or first backslash in eight-byte chunks using ordinary 64-bit integer operations. A word is loaded only when all eight bytes fit within the enclosing range; the short tail remains a byte loop. The first backslash switches the remainder to the original scalar string scanner and retains the negative end marker that requests native JSON unescaping. Unicode payload bytes are safe to scan because the sought quote and backslash are ASCII bytes.

The private `string_end` scanner is restored verbatim to baseline. Scanning keys, skipping unrelated values, selecting array positions, and selecting numeric fields are outside the optimization. Among the compared optimized WASM selector bodies, only `jsonStringEnd` changes. The public API, WASM ABI and shared-memory format are unchanged. Reading a selected string still produces a JavaScript string; this is not a claim of zero JavaScript allocation or faster full-record `.get()` decoding/freezing.

## Measurement protocol

[benchmark.mjs](benchmark.mjs), [workloads.mjs](workloads.mjs), [verify.mjs](verify.mjs) and [PLAN.md](PLAN.md) were committed before formal timing. The workload file is byte-identical to the pilot. The formal driver records the published candidate commit, exact source and portable-build fingerprints, runtime versions and host details. Node and Bun consume those same portable builds; Bun's direct TypeScript source entry is outside this study.

- Seven alternating baseline/candidate process pairs per runtime, eight warmups, batch scale 2, one process at a time, and rotated case order. The complete 25-case matrix was then run with the baseline on both sides. The focused follow-up uses seven Bun pairs with the same warmups and batch scale.
- ASCII serialized payload sizes are 0, 4, 8, 16, 64, 256 and 4096 bytes. Unicode and densely escaped payloads are 256 and 4096 bytes. Each has a selected-string case and a number-after-string control. First numeric fields with two- and eight-byte keys and a small missing-field case complete the matrix. Payload size excludes the surrounding JSON quotes and counts encoded bytes, not JavaScript characters.
- Each case prepares 64 fresh views of one retained record. Repeated scalar reads on each view use fixed operation counts; field selection has no value cache. This is a warm-engine, repeated-record benchmark, not a fresh-record-per-read benchmark.
- Setup, shared attachment, view preparation, warmup, optional garbage collection and verification are outside timing. The timed loop retains every returned value in ordinary JavaScript Arrays. Full values and types are compared afterward with `Object.is`, including missing values. Shared used/capacity values and every previously used arena byte are checked, alongside retained and updated records.
- The recorded host was Linux 6.18.57, x64, AMD EPYC 9V45, with eight visible CPUs. Runtime versions were Node 24.22.3 and Bun 1.4.2; Rust 1.100.0 and the project dependencies were pinned for builds. Host/runtime details and every process sample are retained in the raw reports.

Each table reports the separate median baseline and candidate time per 10,000 operations, then the median of the seven matched candidate/baseline time ratios. Dividing the two time-median columns does not necessarily produce the paired-ratio column. Every formal and follow-up summary row is included. Identical-build tables label the two baseline runs A and B; “B faster” is only an ordering observation.

## Complete formal results

Source: [formal.json.gz](results/formal.json.gz). The original JSON contains all 28 process samples and all 700 case measurements.

### Node

| Case | Baseline ms / 10k | Candidate ms / 10k | Median paired ratio | Candidate faster | Min batch ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `string.ascii.0` | 1.292221 | 1.292420 | 0.984639 | 4/7 | 235.64 |
| `after.ascii.0` | 0.804787 | 0.799939 | 1.029941 | 3/7 | 142.01 |
| `string.ascii.4` | 1.923354 | 2.121612 | 1.022146 | 2/7 | 354.43 |
| `after.ascii.4` | 0.840533 | 0.793153 | 0.917295 | 4/7 | 145.21 |
| `string.ascii.8` | 2.010881 | 2.110837 | 0.966540 | 4/7 | 352.66 |
| `after.ascii.8` | 0.865066 | 0.774290 | 0.997373 | 4/7 | 146.84 |
| `string.ascii.16` | 2.162595 | 2.126900 | 0.978874 | 4/7 | 391.84 |
| `after.ascii.16` | 0.777062 | 0.819318 | 0.985234 | 4/7 | 145.14 |
| `string.ascii.64` | 2.266104 | 2.000556 | 0.930429 | 4/7 | 89.66 |
| `after.ascii.64` | 1.023771 | 0.932638 | 0.955064 | 4/7 | 46.47 |
| `string.ascii.256` | 4.601630 | 3.165785 | 0.730403 | 6/7 | 139.53 |
| `after.ascii.256` | 1.758629 | 1.740920 | 0.961148 | 5/7 | 85.88 |
| `string.ascii.4096` | 46.488707 | 31.792649 | 0.683879 | 6/7 | 71.19 |
| `after.ascii.4096` | 15.969131 | 15.140411 | 1.028500 | 3/7 | 183.64 |
| `string.unicode.256` | 3.952005 | 3.144207 | 0.755148 | 7/7 | 149.12 |
| `after.unicode.256` | 1.934885 | 1.985095 | 1.043928 | 3/7 | 89.32 |
| `string.unicode.4096` | 36.628047 | 26.400350 | 0.720769 | 6/7 | 71.04 |
| `after.unicode.4096` | 16.067865 | 16.009363 | 1.007605 | 3/7 | 184.68 |
| `string.escaped.256` | 7.666389 | 7.034028 | 0.901562 | 6/7 | 339.64 |
| `after.escaped.256` | 1.334246 | 1.304866 | 0.963032 | 5/7 | 62.87 |
| `string.escaped.4096` | 67.453582 | 69.222328 | 1.055509 | 3/7 | 198.86 |
| `after.escaped.4096` | 7.896767 | 7.527211 | 0.957535 | 4/7 | 93.18 |
| `first-number.key2` | 0.574737 | 0.575423 | 0.977462 | 4/7 | 113.78 |
| `first-number.key8` | 0.729457 | 0.722634 | 0.971298 | 5/7 | 140.31 |
| `missing.small` | 0.661853 | 0.658550 | 1.014187 | 3/7 | 124.20 |

### Bun

| Case | Baseline ms / 10k | Candidate ms / 10k | Median paired ratio | Candidate faster | Min batch ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `string.ascii.0` | 0.796486 | 0.837756 | 0.968379 | 4/7 | 160.26 |
| `after.ascii.0` | 0.495403 | 0.475310 | 0.966183 | 6/7 | 80.76 |
| `string.ascii.4` | 1.429025 | 1.280087 | 0.995655 | 4/7 | 231.15 |
| `after.ascii.4` | 0.517713 | 0.546794 | 1.086777 | 3/7 | 89.33 |
| `string.ascii.8` | 1.228776 | 1.237093 | 0.956148 | 5/7 | 216.21 |
| `after.ascii.8` | 0.555352 | 0.560606 | 0.995983 | 4/7 | 93.72 |
| `string.ascii.16` | 1.405270 | 1.326230 | 1.019782 | 3/7 | 244.35 |
| `after.ascii.16` | 0.593268 | 0.639602 | 1.037264 | 3/7 | 111.45 |
| `string.ascii.64` | 2.015997 | 1.489242 | 0.691456 | 6/7 | 67.93 |
| `after.ascii.64` | 1.138985 | 1.040462 | 0.970335 | 5/7 | 48.90 |
| `string.ascii.256` | 4.133521 | 2.725415 | 0.664090 | 7/7 | 115.29 |
| `after.ascii.256` | 2.408019 | 2.579390 | 1.072479 | 2/7 | 117.33 |
| `string.ascii.4096` | 46.696979 | 17.779667 | 0.380746 | 7/7 | 40.32 |
| `after.ascii.4096` | 30.301886 | 32.516272 | 1.078309 | 3/7 | 321.57 |
| `string.unicode.256` | 4.194368 | 2.545930 | 0.596262 | 7/7 | 117.67 |
| `after.unicode.256` | 2.544106 | 2.440357 | 0.991323 | 5/7 | 114.73 |
| `string.unicode.4096` | 57.394100 | 25.201694 | 0.460443 | 6/7 | 60.85 |
| `after.unicode.4096` | 30.455446 | 29.784763 | 0.893982 | 4/7 | 315.86 |
| `string.escaped.256` | 10.850272 | 11.202650 | 0.973751 | 4/7 | 513.13 |
| `after.escaped.256` | 1.318198 | 1.337395 | 1.094799 | 2/7 | 57.94 |
| `string.escaped.4096` | 99.998296 | 98.574040 | 0.970078 | 5/7 | 291.86 |
| `after.escaped.4096` | 10.744890 | 12.438430 | 1.141479 | 2/7 | 104.58 |
| `first-number.key2` | 0.294315 | 0.306690 | 1.027936 | 2/7 | 53.50 |
| `first-number.key8` | 0.415197 | 0.408736 | 0.978060 | 5/7 | 79.65 |
| `missing.small` | 0.555437 | 0.544169 | 1.046108 | 3/7 | 99.88 |

## Complete identical-build control

Source: [identical-control.json.gz](results/identical-control.json.gz). Both variants are baseline `1242908`; these are independent full-matrix measurements, not an adjusted version of the formal result.

### Node

| Case | A ms / 10k | B (same build) ms / 10k | Median paired ratio | B faster | Min batch ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `string.ascii.0` | 1.202429 | 1.266956 | 1.043620 | 3/7 | 239.56 |
| `after.ascii.0` | 0.774471 | 0.784289 | 1.040822 | 1/7 | 138.07 |
| `string.ascii.4` | 2.070898 | 2.168848 | 0.947776 | 5/7 | 358.49 |
| `after.ascii.4` | 0.734864 | 0.715173 | 0.975869 | 5/7 | 139.21 |
| `string.ascii.8` | 1.974849 | 1.920244 | 0.979145 | 4/7 | 359.80 |
| `after.ascii.8` | 0.746862 | 0.846603 | 1.133547 | 0/7 | 145.88 |
| `string.ascii.16` | 2.396103 | 2.029096 | 0.910332 | 6/7 | 396.80 |
| `after.ascii.16` | 0.823887 | 0.765763 | 0.912643 | 6/7 | 156.26 |
| `string.ascii.64` | 2.060998 | 2.137516 | 1.027153 | 2/7 | 93.86 |
| `after.ascii.64` | 0.956404 | 0.966408 | 1.029970 | 2/7 | 45.03 |
| `string.ascii.256` | 3.595489 | 3.663471 | 0.942774 | 5/7 | 171.93 |
| `after.ascii.256` | 1.807830 | 1.728789 | 0.960595 | 5/7 | 85.89 |
| `string.ascii.4096` | 39.938372 | 49.188808 | 1.106082 | 2/7 | 89.89 |
| `after.ascii.4096` | 14.858971 | 15.727753 | 1.047439 | 2/7 | 177.87 |
| `string.unicode.256` | 3.938754 | 4.061533 | 1.043632 | 2/7 | 188.85 |
| `after.unicode.256` | 1.878665 | 1.966555 | 1.043427 | 2/7 | 90.54 |
| `string.unicode.4096` | 33.066016 | 33.900279 | 1.025233 | 3/7 | 101.10 |
| `after.unicode.4096` | 14.456160 | 15.173580 | 1.064554 | 2/7 | 175.51 |
| `string.escaped.256` | 7.139441 | 7.239926 | 0.992647 | 4/7 | 352.89 |
| `after.escaped.256` | 1.229925 | 1.372193 | 1.137332 | 1/7 | 61.90 |
| `string.escaped.4096` | 65.334266 | 66.864565 | 1.049092 | 3/7 | 194.89 |
| `after.escaped.4096` | 7.329157 | 8.042860 | 1.042167 | 2/7 | 90.79 |
| `first-number.key2` | 0.568880 | 0.570472 | 1.013505 | 3/7 | 113.76 |
| `first-number.key8` | 0.702307 | 0.721544 | 1.032283 | 3/7 | 135.53 |
| `missing.small` | 0.643770 | 0.636879 | 0.961549 | 4/7 | 121.47 |

### Bun

| Case | A ms / 10k | B (same build) ms / 10k | Median paired ratio | B faster | Min batch ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `string.ascii.0` | 0.830545 | 0.854234 | 1.042565 | 2/7 | 157.40 |
| `after.ascii.0` | 0.454476 | 0.456513 | 0.922369 | 4/7 | 78.67 |
| `string.ascii.4` | 1.353367 | 1.236760 | 0.893097 | 5/7 | 221.49 |
| `after.ascii.4` | 0.502661 | 0.531378 | 1.066968 | 2/7 | 86.51 |
| `string.ascii.8` | 1.209100 | 1.255290 | 0.994584 | 4/7 | 227.32 |
| `after.ascii.8` | 0.529063 | 0.531588 | 1.108899 | 2/7 | 94.68 |
| `string.ascii.16` | 1.481141 | 1.480723 | 0.979767 | 4/7 | 254.02 |
| `after.ascii.16` | 0.600785 | 0.562830 | 0.995436 | 4/7 | 109.33 |
| `string.ascii.64` | 1.892446 | 1.981010 | 0.965707 | 4/7 | 88.45 |
| `after.ascii.64` | 1.037307 | 1.107286 | 1.119338 | 3/7 | 48.54 |
| `string.ascii.256` | 4.012485 | 4.082953 | 1.040451 | 2/7 | 182.30 |
| `after.ascii.256` | 2.534074 | 2.772312 | 1.094014 | 3/7 | 113.60 |
| `string.ascii.4096` | 48.574291 | 42.390634 | 1.040165 | 3/7 | 112.33 |
| `after.ascii.4096` | 25.030386 | 32.191069 | 1.085478 | 1/7 | 308.54 |
| `string.unicode.256` | 4.523906 | 4.568245 | 1.003601 | 3/7 | 192.28 |
| `after.unicode.256` | 2.486318 | 2.504851 | 0.911668 | 5/7 | 107.11 |
| `string.unicode.4096` | 54.367746 | 54.991448 | 1.032318 | 3/7 | 115.32 |
| `after.unicode.4096` | 26.578411 | 29.594664 | 1.019214 | 3/7 | 330.02 |
| `string.escaped.256` | 11.646435 | 11.554264 | 0.992086 | 4/7 | 530.11 |
| `after.escaped.256` | 1.478412 | 1.286171 | 0.967886 | 4/7 | 61.52 |
| `string.escaped.4096` | 94.773657 | 96.119982 | 0.986698 | 5/7 | 289.99 |
| `after.escaped.4096` | 12.521719 | 11.675838 | 0.876224 | 5/7 | 113.30 |
| `first-number.key2` | 0.301675 | 0.289601 | 1.045951 | 2/7 | 54.39 |
| `first-number.key8` | 0.404000 | 0.398347 | 0.990629 | 4/7 | 79.29 |
| `missing.small` | 0.551903 | 0.549148 | 0.886942 | 4/7 | 96.20 |

## Focused escaped-string confirmation

Source: [escaped-control-confirmation.json.gz](results/escaped-control-confirmation.json.gz). These two Bun cases were selected for the concrete adverse row and recorded in [escaped-control-plan.json](escaped-control-plan.json) before the follow-up. Their results do not replace the full matrix.

| Case | Baseline ms / 10k | Candidate ms / 10k | Median paired ratio | Candidate faster | Min batch ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `string.escaped.4096` | 100.205173 | 117.229423 | 1.126530 | 3/7 | 296.60 |
| `after.escaped.4096` | 12.479464 | 10.811211 | 0.977972 | 4/7 | 107.18 |

### Focused identical-build control

Source: [escaped-control-identical.json.gz](results/escaped-control-identical.json.gz). Both sides use the baseline.

| Case | A ms / 10k | B (same build) ms / 10k | Median paired ratio | B faster | Min batch ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `string.escaped.4096` | 101.363535 | 94.699556 | 0.922983 | 5/7 | 283.70 |
| `after.escaped.4096` | 12.643595 | 11.560778 | 0.893375 | 5/7 | 112.91 |

## Exploratory versions and provenance

All three pilots used three pairs per runtime, eight warmups, batch scale 1, and the same complete 25-case matrix. They selected the candidate for confirmation and are not pooled with the formal study. The initial V1 smoke and later formal-harness smoke used one pair and deliberately small batches; they are retained for correctness/provenance only.

| Version | Change | Node after escaped 4096 ratio | Bun after escaped 4096 ratio | Decision |
| --- | --- | ---: | ---: | --- |
| V1 | Word scans in selected strings and the private skip scanner, including repeated escape encounters | 7.979445 | 5.884861 | Rejected: severe dense-escape regressions |
| V2 | Both scanners use word scan until first escape, then scalar fallback | 1.277585 | 1.074224 | Rejected: adverse Node skip control remained |
| V3 | Private skip scanner restored; selected-string optimization only | 1.131215 | 1.112701 | Frozen for independent formal confirmation |

The pilots were uncommitted working variants on baseline, so their report `commit` field remains `1242908`. Their exact Rust source hashes, tracked-diff hashes and built-module manifests identify the actual tested variants. [pilot-harness/](pilot-harness/) contains the exact original driver, workload and verifier files. [results/screen-v1.json.gz](results/screen-v1.json.gz), [screen-v2.json.gz](results/screen-v2.json.gz) and [screen-v3.json.gz](results/screen-v3.json.gz) preserve every original JSON byte and case.

| File or variant | SHA-256 |
| --- | --- |
| Original pilot driver | `9f8f49a67be1337ae71b3f8e8ee95d30bb3a01bc8067fc7d6830d47738e304fa` |
| Pilot and formal workloads | `bfa82185019b81a1a115650464b81aecb341ba22126567745978d3039f3e844f` |
| Original pilot verifier | `48c383dbbe63c877486695468b91792ddf37d37d43be63e639543c9d1f5d4ced` |
| Frozen formal driver | `62cdc696733c29c3c95f6567c516c99ce675f40a520799f7630d00ceaf2fdaf8` |
| Frozen formal verifier | `96597c3247d6ab7dbd70ffbaea245aa88d1b483fd0c1e178d6f1d7738bb22aac` |
| Baseline `rust/src/json.rs` | `0df408c61fe3b720de57d3a7915f9df1362ff5db801cfc334e77b2eb67475f0f` |
| V1 `rust/src/json.rs` | `abd79b4eb3449a244db045f34cbde29957ffe2df9bb661894a6a311bc1bc6c90` |
| V2 `rust/src/json.rs` | `6e8b79cf4a67bbf804a01c75eea018926224e1378d6f244ba99c9156cf75a1a2` |
| V3 / formal `rust/src/json.rs` | `f74f4f1d4851254b1c1794b6d0bf4cf2328f7f6cb156d49851a818fd07d08a97` |

The rejected source is reconstructable by applying [v1-against-baseline.patch](exploration/v1-against-baseline.patch) or [v2-against-baseline.patch](exploration/v2-against-baseline.patch) to a separate checkout of `1242908`. Each reconstructed file was checked byte-for-byte against its saved source and pilot source hash. The exact rejected WASM builds are also retained in [exploration/](exploration/). For example, in a disposable baseline checkout:

```sh
git apply /absolute/candidate/proofs/json-string-scan-20261118/exploration/v1-against-baseline.patch
sha256sum rust/src/json.rs
```

## Correctness, generated code, and size

[json-string-scan.test.ts](../../json-string-scan.test.ts) covers quotes and escapes at every word alignment, Unicode and lone surrogates, exact physical-memory tails, truncated tokens, enclosing-record bounds, long quoted decoys, nested selections, and retained map/list views after growth in shared and copied modes. The separate [two-worker proof](workers.mjs) keeps long ASCII, Unicode and escaped strings alive in real workers across owner growth from 131,072 to 327,680 bytes. It checks old and updated values, frozen ordinary reads and unchanged shared bytes.

| Validation | Recorded result | Evidence |
| --- | --- | --- |
| Full Bun suite | 1,266 tests in 67 files passed; 33.82 s wall time | [Saved suite output](validation/full-v3-bun.log.gz) |
| Focused Node tests | 20 passed | Session observation in [validation summary](validation/summary.json) |
| WASM/ABI audits | 7 passed | Session observation in validation summary |
| TypeScript check | Passed | Session observation in validation summary |
| Real workers | Shared and copied readers passed retained-string/growth/byte checks | Session observation and committed worker proof |
| Final report consistency | All four final reports passed the verifier | Session observation in validation summary |
| Independent formal audit | 50 recomputed rows, 28 process samples, zero issues | [Saved independent audit](validation/final-independent-audit.json.gz) |
| Hosted runtime/library CI associated with `4082a1f` | Passed | [Run 44296155146](https://github.com/natanelia/zerocopy/actions/runs/44296155146) |
| Hosted website CI associated with `4082a1f` | Passed | [Run 44296155262](https://github.com/natanelia/zerocopy/actions/runs/44296155262) |

Separate raw stdout logs were not retained for the focused tests, audits, typecheck and worker execution; the validation summary identifies those as transcribed successful session observations. The first V1 focused test run hit a five-second timeout while Vitest deeply compared MiB-sized byte arrays. Replacing only those assertions with native Buffer equality resolved the test overhead; the runtime was not changed for that correction. Saved pilot and build output is retained as well.

After timing, the existing worker proof registration was moved immediately after the existing portable JSON worker check, preserving the same `node(...)` invocation. This test-registration-only placement change avoids a merge conflict with the separate JSON-array PR. The two CI runs cited above are associated with the measured commit and do not attest to that later placement. No runtime tests or measurements were rerun during evidence packaging.

The [optimized WASM comparison](validation/codegen-v3.json) records baseline-identical bodies for `jsonArrayAt`, `jsonValueEnd`, `jsonFieldAscii8`, `jsonFieldCandidate` and `jsonInteger`, after exported call targets were consistently named. `jsonStringEnd` differs. This is a generated-code scope check, not proof that unchanged selectors can never show timing variation.

| Artifact | Baseline bytes | Candidate bytes | Increase |
| --- | ---: | ---: | ---: |
| Uncompressed `persistent-core.wasm` | 54,845 | 55,074 | +229 |
| Sum of all portable uncompressed JavaScript modules | 299,031 | 299,335 | +304 |

The JavaScript sum is not the download size of one entry point or a compressed transfer-size measurement. WASM SHA-256 hashes are baseline `2e6901f2427b084022d82f421a87290a06ab57fab93baf91ae156ca4275aa08a` and candidate `a84616b8d8df08b66495e9f1d8c9a341d4503fd2fdc11f3f88ce1bed19d03f69`.

## Limits and reproduction

The study measures warm-engine scalar selection of one record. It does not measure cold hardware caches, process startup, end-to-end application latency, ordinary full-object `.get()`, worker transport time, or browser performance. JavaScript heap allocations, peak RSS and garbage-collection pause attribution were not measured. Shared-arena byte checks prove no shared-arena writes/allocation during these reads; they do not imply no JavaScript allocation. The output arrays can retain up to 256 MiB of string payload under the formal batch scale; that is a calculated fixture bound, not an observed heap measurement. Worker execution is a correctness proof, not a speed result.

Follow [PLAN.md](PLAN.md) to build separate baseline/candidate checkouts and reproduce the full matrix and identical-build runs. For the focused comparison, use the same command with `--runtimes bun` and:

```sh
--only json-string.string.escaped.4096,json-string.after.escaped.4096
```

Use unique output paths; the driver refuses to overwrite existing evidence. The read-only verifier accepts the retained gzip files directly:

```sh
node proofs/json-string-scan-20261118/verify.mjs \
  proofs/json-string-scan-20261118/results/formal.json.gz \
  proofs/json-string-scan-20261118/results/identical-control.json.gz \
  proofs/json-string-scan-20261118/results/escaped-control-confirmation.json.gz \
  proofs/json-string-scan-20261118/results/escaped-control-identical.json.gz
```

[archive-manifest.json](archive-manifest.json) records file hashes, decoded hashes for lossless gzip archives, source reconstruction hashes and harness identities. Every archive was decompressed and compared byte-for-byte with its original file during packaging. [SHA256SUMS](SHA256SUMS) covers every file in this proof directory except itself; run `sha256sum -c SHA256SUMS` from this directory. The consistency verifier checks the reports' internal arithmetic, coverage and fingerprints; it is not an independent proof of data authenticity.
