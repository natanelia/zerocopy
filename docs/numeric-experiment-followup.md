# Numeric experiment follow-up

## Rejected: fused spatial SIMD

After accepting numeric range counts, two point-in-box kernels were tested on the existing interleaved f64 list layout. No new storage format or precision change was required. These explicit SIMD experiments are not in either production PR.

The first kernel handled one point per vector and reduced its mask per point. It improved x64 but its Node ARM64 gain over the branchless scalar kernel was only about 4.4% at 131,072 points. This failed the chosen 5% minimum gain. Evidence: [run 36250673684](https://github.com/natanelia/zerocopy/actions/runs/36250673684).

The second kernel loaded two points, separated x/y values in SIMD registers, and accumulated vector counters. It passed x64 but regressed on ARM64. For 32 scans of 131,072 points with extent 1,000, the optimized scalar kernel took **6.195412 ms**, while SIMD took **7.707145 ms**: SIMD elapsed time was **24.4% higher**. At 512 points, the explicit performance gate also failed. All 591 correctness tests in this experiment passed, but correctness alone is not a performance acceptance criterion.

Evidence: [run 36250995680](https://github.com/natanelia/zerocopy/actions/runs/36250995680), [ARM64 raw samples](https://github.com/natanelia/zerocopy/actions/runs/36250995680/artifacts/10908922186), candidate `c1834fe5dd1e04f8fd9034f98fcd7f8e362d99aa` on `agent/perf-spatial-box`.

The bulk operation itself was faster than per-element JavaScript iteration. That is separate from SIMD. No spatial SIMD PR was opened. A subsequent scalar bulk candidate passed its own full-API gate and is documented in `spatial-bulk-performance.md`. This does not reverse the rejection of the explicit spatial SIMD variants. Typed columns, new hashes, and index redesigns have not been implemented or benchmarked in this series.

## Browser verification

In [range proof run 36251387725](https://github.com/natanelia/zerocopy/actions/runs/36251387725), Chromium 153.0.8010.12, Firefox 155.0, and WebKit 26.6 each passed 350 main-thread range cases with normal module selection and 350 with forced scalar fallback. Chromium and Firefox also passed actual browser-worker reads and snapshot/growth checks under both selection modes.

WebKit worker transport is not a pass. The proof built unmodified main at `75e3626ccc6400d1ae195aefdd3526906622009e` as a control. Fresh browser processes reproduced `RangeError: Out of memory` during `worker-import-existing` on both baseline and candidate, before numeric import or snapshot attachment. Only that exact baseline-reproduced failure is recorded as an existing limitation; unexpected failures fail the proof.

The raw [numeric browser artifact](https://github.com/natanelia/zerocopy/actions/runs/36251387725/artifacts/10909755732) records individual case results, versions, commits, and allocation-error phases. Neither PR changes eager arena initialization or maximum memory size to work around the existing limitation. Playwright WebKit validation is not a claim of testing Safari on Apple hardware.
