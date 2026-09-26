# Numeric experiment follow-up

## Rejected: fused spatial SIMD

After accepting numeric range counts, two point-in-box kernels were tested on the existing interleaved f64 list layout. No new storage format or precision change was required. These experiments are not in the production PR.

The first kernel handled one point per vector and reduced its mask per point. It improved x64 but its Node ARM64 gain over the branchless scalar kernel was only about 4.4% at 131,072 points. This failed the chosen 5% minimum gain. Evidence: [run 36250673684](https://github.com/natanelia/zerocopy/actions/runs/36250673684).

The second kernel loaded two points, separated x/y values in SIMD registers, and accumulated vector counters. It passed x64 but regressed on ARM64. For 32 scans of 131,072 points with extent 1,000, the optimized scalar kernel took **6.195412 ms**, while SIMD took **7.707145 ms**: SIMD elapsed time was **24.4% higher**. At 512 points, the explicit performance gate also failed. All 591 correctness tests in this experiment passed, but correctness alone is not a performance acceptance criterion.

Evidence: [run 36250995680](https://github.com/natanelia/zerocopy/actions/runs/36250995680), [ARM64 raw samples](https://github.com/natanelia/zerocopy/actions/runs/36250995680/artifacts/10908922186), candidate `c1834fe5dd1e04f8fd9034f98fcd7f8e362d99aa` on `agent/perf-spatial-box`.

The bulk operation itself was faster than per-element JavaScript iteration. That is separate from SIMD. This experiment does not establish a portable SIMD win, so no spatial SIMD PR was opened. The accepted range-count API remains the only production change from this series. Typed columns, new hashes, and index redesigns have not been implemented or benchmarked in this series.

## Browser verification

Chromium and Firefox passed main-thread numeric checks, worker snapshot checks, and the forced scalar fallback. WebKit passed 350 main-thread numeric checks before a worker failed with `RangeError: Out of memory` while importing the existing transport. The worker had not imported the numeric module or attached its snapshot. Evidence: [run 36250949893](https://github.com/natanelia/zerocopy/actions/runs/36250949893).

The browser proof now builds unmodified main at `75e3626ccc6400d1ae195aefdd3526906622009e` as a control. Each case uses a new browser process. All three engines must pass main-thread numeric checks with normal selection and forced scalar fallback. Candidate worker checks must pass wherever the exact baseline works. Only an exact WebKit out-of-memory error during existing transport import, reproduced on that baseline, is recorded as a baseline limitation rather than a new kernel failure. Other errors fail the proof. A baseline-limited worker result is not reported as a worker pass.

The raw `numeric-browsers.json` artifact records each case, engine version, candidate commit, baseline commit, and any allocation failure. Consult the current workflow for the outcome of the new control run. This PR does not change the existing eager arena initialization or maximum memory size to work around browser limits.
