# Priority-queue entry traversal: measured results

**Draft evidence. The frozen performance gate is `hold-invalid-cells`, not passed.** All 14 large full-traversal targets have valid measured gains. Four of the 32 runtime/workload cells remain unresolved: Node `nested-65-first-close` is invalid because its baseline control drifted; Node `empty-full`, Node `empty-next`, and Bun `empty-next` are inconclusive. Normal PR CI for the final head is pending. ARM and browser performance are unmeasured.

## Change and concrete example

`SharedPriorityQueue.entries()` walks the queue's stored tree. It keeps the existing traversal order: read the current node, then visit the left and right subtrees. This is heap traversal order, not a sorted list of priorities.

Before, each node's four stored fields requested `arena.dv` separately: priority, raw value, left child, and right child. After, the iterator requests the existing `DataView` once for that node and uses it for all four reads. It requests the arena's current view again for the next node. The decoder still runs between the raw-value read and the child reads. The stack operations, yield, and generator method stay the same.

| Metadata and raw-value reads in one complete traversal | Before | After |
|---|---:|---:|
| Getter requests per visited node | 4 | 1 |
| Getter requests for 1,057 numeric entries | 4,228 | 1,057 |

These counts are getter calls, not allocations. A getter calls the arena's refresh check; it need not create a new `DataView`. Decoding some value types can do other work. The numeric example isolates these four stored-field reads. These executed-call counts do not establish lower heap memory.

For the `number-1057-min` workload, a complete traversal took 158.440 → 67.844 µs on Node and 62.149 → 37.569 µs on Bun. The paired latency reductions were **57.58% [55.79%, 59.30%]** and **39.61% [37.68%, 41.49%]**, respectively. The confidence intervals are pointwise 95% intervals. These are latency reductions, not throughput increases.

## What remains unresolved

AB compares candidate with baseline. AA runs the baseline on both sides to detect drift. A ratio above 1 means more time on the right side. All times below are microseconds per public traversal or specified control operation.

| Runtime / control | Baseline µs | Candidate µs | AB ratio [95% CI] | AA ratio [95% CI] | Result |
|---|---:|---:|---|---|---|
| node / empty-full | 0.044320 | 0.044642 | 1.007978071 [0.995709975, 1.020397322] | 1.000698370 [0.981218616, 1.020564847] | inconclusive |
| node / empty-next | 0.042779 | 0.043858 | 1.021403763 [0.997311692, 1.046077827] | 0.996129577 [0.986701721, 1.005647515] | inconclusive |
| bun / empty-next | 0.015115 | 0.015153 | 0.998276707 [0.965213464, 1.032472527] | 1.022288869 [0.892843768, 1.170501011] | inconclusive |
| node / nested-65-first-close | 0.283707 | 0.186826 | 0.664079445 [0.654404278, 0.673897656] | 0.978751924 [0.967757579, 0.989871173] | invalid |

The invalid Node early-close cell has AA ratio 0.978751924, below the frozen lower band `1 / 1.02 = 0.980392157`, and its interval excludes 1. All four AA quartet ratios are below 1. Its apparent AB reduction is excluded from established gains. AA is never used to adjust an AB result.

The three empty controls have intervals that include 1 and extend above the 1.02 limit. They do not establish a material loss, but they also do not meet that limit. Bun `empty-full` is within margin. Across usable cells, no AB interval establishes a latency increase above 2%. This is not evidence of zero regressions or a pass for all controls.

## Large full-traversal targets

All 14 runtime/workload cells below have valid matched controls and an AB upper confidence bound below 0.98. They are the seven predeclared large workloads on each of two runtimes. Each row remains a separate result; there is no aggregate speedup.

| Full traversal | Node baseline → candidate µs | Node latency reduction [95% CI] | Bun baseline → candidate µs | Bun latency reduction [95% CI] |
|---|---:|---|---:|---|
| number-1057-min | 158.440 → 67.844 | 57.58% [55.79%, 59.30%] | 62.149 → 37.569 | 39.61% [37.68%, 41.49%] |
| number-4097-max-ties | 655.016 → 281.869 | 56.68% [55.60%, 57.73%] | 254.448 → 164.410 | 35.68% [32.20%, 38.99%] |
| boolean-1057-max | 155.555 → 67.321 | 56.57% [55.94%, 57.19%] | 60.281 → 36.761 | 39.24% [38.22%, 40.24%] |
| string-4097-min-ties | 1599.460 → 1251.266 | 22.25% [19.46%, 24.95%] | 974.912 → 894.618 | 8.71% [6.89%, 10.50%] |
| object-1057-min-warm | 185.647 → 92.752 | 50.39% [48.50%, 52.22%] | 75.553 → 51.632 | 31.91% [30.78%, 33.03%] |
| object-4097-max-saturated | 3493.742 → 3120.028 | 10.52% [8.74%, 12.27%] | 1844.187 → 1702.160 | 8.03% [6.63%, 9.41%] |
| nested-1057-max-ties | 474.765 → 373.100 | 20.56% [16.96%, 24.00%] | 389.298 → 360.795 | 7.53% [5.34%, 9.67%] |

The reduction ranges are 10.52–57.58% on Node and 7.53–39.61% on Bun. Normal public reads warm the 1,057-object and nested-value workloads. The 4,097-object and string workloads naturally exceed the arena's 2,048-record cache. No internal cache was cleared. Those cases must remain separate.

## Scope, method, and completed checks

The measurements used the explicit portable `dist/shared.js` entry on Node 22.23.3 and Bun 1.4.2, Linux x64, on an AMD EPYC 7763 host with four visible CPUs. CPU governor and frequency policy were unavailable in the receipt. These results make no ARM, browser, default Bun source-condition, or whole-library performance claim.

The frozen baseline is [3773c6e519c7c0958da13727ed1082f449f3ee25](https://github.com/natanelia/zerocopy/commit/3773c6e519c7c0958da13727ed1082f449f3ee25). The runtime candidate is [4dea268e4c64acac832bb310efc83de597b27abc](https://github.com/natanelia/zerocopy/commit/4dea268e4c64acac832bb310efc83de597b27abc), with tree `6e180bc39a10866289816ba5aa6747b1adb18eae`. Its parent is the baseline. Its only changes are `shared-priority-queue.ts` and five tests in `heap-entry-views.test.ts`. This evidence document does not change the runtime, tests, benchmark kernels, or measurement protocol.

Completed historical checks in the measurement run:

- All 26 prerequisite commands passed, including WASM and portable builds, declarations, public and worker type checks, and installed-package checks.
- The full standard Bun suites passed: baseline 753 tests in 40 files; candidate 758 tests in 41 files.
- Node and Bun each passed 80 built-entry matrix cases and 320 shared/copied worker cases using four actual workers.
- The five new tests cover generator shape and lazy access, one view per visited node on owner/shared/copied attachments, suspended/interleaved/early-closed iterators through growth, special binary64 values and detached tuples, and custom decoder receiver/order/reentrant growth/errors. The tests use local modules and Vitest and have no Git-history or subprocess fixture dependency.
- The independent receipt audit completed 29,792 checks with no discrepancy. Source inventories, 12 WASM files per arm, 53 emitted dist files per arm, package manifests, and retained harness/workflow files matched their identities. WASM and public declarations agreed between arms.

Every required measurement finished: 64 pilots and 1,024 measured subjects, comprising 512 AB and 512 baseline-AA processes. That is 768 baseline and 256 candidate executions and 21,504 measured batches. Four untimed fixture processes bring the controller receipt count to 1,092. All subject commands exited zero. Each owned process-group cleanup receipt was verified with no recorded surviving members. This does not certify the absence of unrelated host activity.

All pilots finished before measurement began. Each process used the common pilot-derived warmup work and batch repeats and ran 21 measured batches. There were no caps, missing subjects, duration-floor flags, or target misses. The minimum batch was 49.390148 ms against a 40 ms target; the minimum warmup was 619.561163 ms against a 500 ms target.

Each cell uses four AB quartets and four matched AA quartets, balanced between two LRRL and two RLLR orders. The four quartet log-ratio effects define each Student-t interval with three degrees of freedom. The 21 batches are not independent confidence-interval replicates. Each absolute time shown is the median of eight process medians per AB arm. The paired ratio need not equal the quotient of the two displayed medians. The intervals have no simultaneous multiple-comparison guarantee.

The independent numerical audit reproduced all 64 AB/AA intervals and the original gate without arithmetic corrections. The final classifications are **27 valid material gains, one within-margin cell, three inconclusive cells, and one invalid cell**. The original campaign exited 1 for `hold-invalid-cells`; it did not pass. No new timings or full-suite runs were collected to prepare this document.

## All 32 cells

The table retains every cell, including invalid and inconclusive results. Ratios and intervals are rounded to nine decimals; absolute times are rounded to six decimals. Only `material-gain` rows count as valid gains. The raw artifact retains the underlying process outputs and full precision.

| Runtime / case | Large target | Baseline µs | Candidate µs | AB ratio [95% CI] | AA ratio [95% CI] | Result |
|---|---|---:|---:|---|---|---|
| bun / boolean-1057-max | yes | 60.280645 | 36.761126 | 0.607591407 [0.597586091, 0.617764241] | 0.996267781 [0.967027125, 1.026392606] | material-gain |
| node / boolean-1057-max | yes | 155.554749 | 67.321148 | 0.434340180 [0.428149551, 0.440620321] | 1.004030185 [0.971462892, 1.037689263] | material-gain |
| bun / boolean-32-max-ties | no | 1.876963 | 1.119812 | 0.595194260 [0.581639362, 0.609065050] | 1.001554924 [0.993892176, 1.009276751] | material-gain |
| node / boolean-32-max-ties | no | 5.170771 | 2.420448 | 0.472042810 [0.456742293, 0.487855883] | 1.006460809 [0.960876176, 1.054208010] | material-gain |
| bun / empty-full | no | 0.015590 | 0.015592 | 0.999578782 [0.989409964, 1.009852110] | 1.000229728 [0.991316239, 1.009223363] | within-margin |
| node / empty-full | no | 0.044320 | 0.044642 | 1.007978071 [0.995709975, 1.020397322] | 1.000698370 [0.981218616, 1.020564847] | inconclusive |
| bun / empty-next | no | 0.015115 | 0.015153 | 0.998276707 [0.965213464, 1.032472527] | 1.022288869 [0.892843768, 1.170501011] | inconclusive |
| node / empty-next | no | 0.042779 | 0.043858 | 1.021403763 [0.997311692, 1.046077827] | 0.996129577 [0.986701721, 1.005647515] | inconclusive |
| bun / nested-1057-max-ties | yes | 389.298232 | 360.795026 | 0.924728401 [0.903326198, 0.946637679] | 1.001832388 [0.976023860, 1.028323359] | material-gain |
| node / nested-1057-max-ties | yes | 474.764602 | 373.100031 | 0.794417040 [0.759963243, 0.830432839] | 1.004936071 [0.967090212, 1.044262980] | material-gain |
| bun / nested-65-first-close | no | 0.134100 | 0.113795 | 0.851581994 [0.845852545, 0.857350252] | 1.002921874 [0.985032574, 1.021136063] | material-gain |
| node / nested-65-first-close | no | 0.283707 | 0.186826 | 0.664079445 [0.654404278, 0.673897656] | 0.978751924 [0.967757579, 0.989871173] | invalid |
| bun / number-1057-min | yes | 62.148631 | 37.569327 | 0.603850669 [0.585103794, 0.623198198] | 0.986369339 [0.941620354, 1.033244946] | material-gain |
| node / number-1057-min | yes | 158.440242 | 67.843538 | 0.424176977 [0.406970368, 0.442111078] | 1.001022792 [0.991102545, 1.011042335] | material-gain |
| bun / number-31-min | no | 1.889398 | 1.125288 | 0.599278416 [0.586161607, 0.612688746] | 0.985953870 [0.932135323, 1.042879730] | material-gain |
| node / number-31-min | no | 4.901697 | 2.203232 | 0.450065068 [0.444360425, 0.455842947] | 1.000746311 [0.998163817, 1.003335487] | material-gain |
| bun / number-4097-max-ties | yes | 254.448117 | 164.409964 | 0.643154147 [0.610116275, 0.677981024] | 1.003542547 [0.995539494, 1.011609935] | material-gain |
| node / number-4097-max-ties | yes | 655.016011 | 281.868568 | 0.433229622 [0.422704998, 0.444016292] | 1.016735570 [0.966736417, 1.069320655] | material-gain |
| bun / object-1057-min-warm | yes | 75.552673 | 51.631816 | 0.680854287 [0.669724388, 0.692169149] | 1.000385060 [0.972143645, 1.029446907] | material-gain |
| node / object-1057-min-warm | yes | 185.646509 | 92.751509 | 0.496096990 [0.477846306, 0.515044733] | 1.029760026 [0.949727942, 1.116536288] | material-gain |
| bun / object-4097-max-saturated | yes | 1844.186515 | 1702.160088 | 0.919697392 [0.905860914, 0.933745214] | 0.993152900 [0.974315701, 1.012354293] | material-gain |
| node / object-4097-max-saturated | yes | 3493.741789 | 3120.027842 | 0.894780178 [0.877310467, 0.912597760] | 0.993953370 [0.985291946, 1.002690933] | material-gain |
| bun / object-65-max-ties | no | 4.181229 | 2.779405 | 0.663047935 [0.655075025, 0.671117884] | 0.999674281 [0.991343487, 1.008075083] | material-gain |
| node / object-65-max-ties | no | 11.291075 | 4.983713 | 0.445665861 [0.430390770, 0.461483084] | 0.999619359 [0.989160021, 1.010189295] | material-gain |
| bun / singleton-first-close | no | 0.101911 | 0.085638 | 0.840943757 [0.836148933, 0.845766077] | 0.995132065 [0.944239791, 1.048767312] | material-gain |
| node / singleton-first-close | no | 0.237043 | 0.138486 | 0.581988526 [0.557403862, 0.607657513] | 0.993024515 [0.957829480, 1.029512777] | material-gain |
| bun / singleton-full | no | 0.093185 | 0.070994 | 0.758470172 [0.751615592, 0.765387265] | 0.998097785 [0.985172657, 1.011192487] | material-gain |
| node / singleton-full | no | 0.201673 | 0.111658 | 0.557676306 [0.553059418, 0.562331736] | 1.001084434 [0.987142176, 1.015223610] | material-gain |
| bun / string-33-min | no | 2.412608 | 1.644916 | 0.673219463 [0.644781800, 0.702911350] | 1.004661328 [0.972575703, 1.037805469] | material-gain |
| node / string-33-min | no | 6.263462 | 3.305773 | 0.519438776 [0.511183497, 0.527827373] | 0.981051317 [0.962150377, 1.000323556] | material-gain |
| bun / string-4097-min-ties | yes | 974.912029 | 894.617514 | 0.912851602 [0.894991464, 0.931068151] | 0.987745582 [0.953315482, 1.023419165] | material-gain |
| node / string-4097-min-ties | yes | 1599.460422 | 1251.266039 | 0.777477665 [0.750492833, 0.805432767] | 0.992401438 [0.955394190, 1.030842164] | material-gain |

<details>
<summary>Per-cell work, minimum durations, and flags</summary>

The repeat count is public consumptions per timed batch. Warmup counts use the same public consumption for that workload. Both AB and AA use the common plan. Minimum durations cover the measured AB and AA subjects in that cell.

| Runtime / case | Repeats per batch | Warmup traversals or control operations | Minimum batch ms | Minimum warmup ms | AA drift | Duration flags / target misses |
|---|---:|---:|---:|---:|---|---|
| bun / boolean-1057-max | 1,692 | 18,612 | 60.439112 | 693.292506 | no | none / 0 |
| node / boolean-1057-max | 840 | 9,240 | 55.936523 | 636.961626 | no | none / 0 |
| bun / boolean-32-max-ties | 54,993 | 604,923 | 60.144330 | 686.608769 | no | none / 0 |
| node / boolean-32-max-ties | 26,362 | 289,982 | 63.203984 | 717.223835 | no | none / 0 |
| bun / empty-full | 3,959,228 | 43,551,508 | 60.380136 | 708.435758 | no | none / 0 |
| node / empty-full | 1,387,413 | 15,261,543 | 56.032117 | 678.687569 | no | none / 0 |
| bun / empty-next | 4,056,527 | 44,621,797 | 56.554407 | 679.556215 | no | none / 0 |
| node / empty-next | 1,440,947 | 15,850,417 | 55.158455 | 683.216755 | no | none / 0 |
| bun / nested-1057-max-ties | 170 | 1,870 | 57.288456 | 702.076536 | no | none / 0 |
| node / nested-1057-max-ties | 162 | 1,782 | 58.411298 | 692.785785 | no | none / 0 |
| bun / nested-65-first-close | 518,618 | 5,704,798 | 57.980259 | 663.796201 | no | none / 0 |
| node / nested-65-first-close | 335,554 | 3,691,094 | 61.243243 | 694.346725 | yes | none / 0 |
| bun / number-1057-min | 1,588 | 17,468 | 58.691981 | 671.125495 | no | none / 0 |
| node / number-1057-min | 882 | 9,702 | 59.272891 | 673.352941 | no | none / 0 |
| bun / number-31-min | 53,721 | 590,931 | 57.875285 | 681.334832 | no | none / 0 |
| node / number-31-min | 26,996 | 296,956 | 59.060207 | 668.769939 | no | none / 0 |
| bun / number-4097-max-ties | 385 | 4,235 | 59.659979 | 711.093151 | no | none / 0 |
| node / number-4097-max-ties | 219 | 2,409 | 61.336936 | 694.375905 | no | none / 0 |
| bun / object-1057-min-warm | 1,182 | 13,002 | 58.983677 | 681.397280 | no | none / 0 |
| node / object-1057-min-warm | 644 | 7,084 | 58.182452 | 661.692908 | no | none / 0 |
| bun / object-4097-max-saturated | 34 | 374 | 56.428387 | 679.298120 | no | none / 0 |
| node / object-4097-max-saturated | 19 | 209 | 57.982060 | 656.974648 | no | none / 0 |
| bun / object-65-max-ties | 21,777 | 239,547 | 58.878185 | 677.818735 | no | none / 0 |
| node / object-65-max-ties | 12,145 | 133,595 | 60.052310 | 679.707423 | no | none / 0 |
| bun / singleton-first-close | 589,824 | 7,667,712 | 49.390148 | 670.819712 | no | none / 0 |
| node / singleton-first-close | 398,616 | 4,384,776 | 54.658367 | 619.561163 | no | none / 0 |
| bun / singleton-full | 845,903 | 9,304,933 | 58.967420 | 678.891720 | no | none / 0 |
| node / singleton-full | 545,271 | 5,997,981 | 60.411358 | 681.317351 | no | none / 0 |
| bun / string-33-min | 36,719 | 403,909 | 57.554881 | 671.309378 | no | none / 0 |
| node / string-33-min | 17,856 | 214,272 | 54.829934 | 693.691595 | no | none / 0 |
| bun / string-4097-min-ties | 69 | 759 | 59.126378 | 704.641603 | no | none / 0 |
| node / string-4097-min-ties | 51 | 561 | 61.162631 | 698.340072 | no | none / 0 |

</details>

<details>
<summary>Process dispersion and all quartet effects</summary>

SD is the sample standard deviation across eight process medians for each comparison arm, in microseconds. Quartet ratios are the four independent effects used by each interval; they are not additional cells.

| Runtime / case | AB baseline SD µs | AB candidate SD µs | AA left SD µs | AA right SD µs | AB quartet ratios | AA quartet ratios |
|---|---:|---:|---:|---:|---|---|
| bun / boolean-1057-max | 0.305999 | 0.455875 | 1.842458 | 0.683378 | 0.613548532, 0.605735684, 0.611641130, 0.599539402 | 0.998965982, 0.969482882, 1.008379988, 1.008763313 |
| node / boolean-1057-max | 0.628425 | 0.879243 | 1.993129 | 4.402351 | 0.432852707, 0.433808278, 0.430809685, 0.439943189 | 1.002509105, 0.985366973, 1.033803194, 0.995091192 |
| bun / boolean-32-max-ties | 0.025999 | 0.006907 | 0.024759 | 0.015234 | 0.594620127, 0.601905922, 0.601097717, 0.583339839 | 1.005659024, 1.004809999, 0.995093059, 1.000692584 |
| node / boolean-32-max-ties | 0.027541 | 0.044037 | 0.079508 | 0.177854 | 0.462479257, 0.482016954, 0.465067805, 0.478910876 | 0.975821864, 0.998090500, 1.006744530, 1.046472280 |
| bun / empty-full | 0.000101 | 0.000151 | 0.000105 | 0.000096 | 0.992852202, 1.001171016, 1.007776522, 0.996577336 | 1.002243843, 1.006412861, 0.993044120, 0.999265546 |
| node / empty-full | 0.000466 | 0.000259 | 0.000422 | 0.000343 | 0.998311505, 1.005865304, 1.011474639, 1.016350332 | 1.018047472, 0.995706477, 1.000223642, 0.989045546 |
| bun / empty-next | 0.000191 | 0.000189 | 0.000210 | 0.001814 | 0.994763384, 1.015737358, 0.970192747, 1.013081794 | 0.997079887, 1.158612015, 0.958611667, 0.986242776 |
| node / empty-next | 0.000525 | 0.000604 | 0.000394 | 0.000156 | 1.009874622, 1.009540342, 1.024492061, 1.042053652 | 0.993427852, 1.005092889, 0.992875405, 0.993175634 |
| bun / nested-1057-max-ties | 14.934035 | 14.944366 | 14.404913 | 8.846174 | 0.934530253, 0.926330622, 0.905234510, 0.933117420 | 0.985213753, 1.003057675, 1.024109317, 0.995354040 |
| node / nested-1057-max-ties | 5.839511 | 12.766387 | 4.076858 | 9.784749 | 0.774010079, 0.789890719, 0.788283599, 0.826414801 | 0.991668227, 1.040964506, 1.000593999, 0.987400916 |
| bun / nested-65-first-close | 0.001438 | 0.001700 | 0.004210 | 0.005215 | 0.849453533, 0.851844212, 0.848472432, 0.856580810 | 0.989600640, 1.014130414, 0.997766038, 1.010382746 |
| node / nested-65-first-close | 0.006820 | 0.005030 | 0.004527 | 0.006174 | 0.662045180, 0.657856554, 0.672456900, 0.664044008 | 0.979811691, 0.987916759, 0.975748754, 0.971604550 |
| bun / number-1057-min | 1.066685 | 0.455879 | 1.817066 | 0.554529 | 0.613544699, 0.608889001, 0.586659499, 0.606663355 | 0.995381972, 0.996290973, 1.009852525, 0.945201351 |
| node / number-1057-min | 3.274432 | 0.379947 | 1.243384 | 0.638833 | 0.428173607, 0.431699504, 0.408078033, 0.429184187 | 1.001666810, 0.992462894, 1.007451408, 1.002568820 |
| bun / number-31-min | 0.020770 | 0.025051 | 0.059463 | 0.031952 | 0.596103297, 0.589036473, 0.605725540, 0.606422000 | 0.952298229, 1.032038779, 0.967145498, 0.994181270 |
| node / number-31-min | 0.032503 | 0.018738 | 0.051805 | 0.051741 | 0.448778448, 0.455300062, 0.446970007, 0.449255231 | 1.000435515, 0.999247078, 1.003057168, 1.000249444 |
| bun / number-4097-max-ties | 5.685333 | 3.238660 | 3.260592 | 3.951856 | 0.659372605, 0.651205154, 0.612484451, 0.650603658 | 0.998383390, 1.010484725, 1.003091822, 1.002248396 |
| node / number-4097-max-ties | 15.875005 | 1.917398 | 19.455244 | 14.163870 | 0.432006988, 0.443144823, 0.428744408, 0.429178202 | 1.033223542, 0.969804441, 1.028399607, 1.037030921 |
| bun / object-1057-min-warm | 0.514674 | 0.697089 | 1.128692 | 0.870362 | 0.688812716, 0.673188941, 0.677078208, 0.684446868 | 1.025390804, 1.002373609, 0.986052972, 0.988210585 |
| node / object-1057-min-warm | 6.015934 | 2.044024 | 6.117054 | 8.108667 | 0.495744795, 0.509171605, 0.498889813, 0.480993703 | 0.995746626, 1.084195487, 0.976968109, 1.066122943 |
| bun / object-4097-max-saturated | 29.417921 | 11.259599 | 22.715433 | 17.770709 | 0.912365192, 0.911919888, 0.927305492, 0.927324198 | 1.003671282, 0.977257281, 1.000801646, 0.991096715 |
| node / object-4097-max-saturated | 41.099123 | 32.667332 | 37.843961 | 26.032269 | 0.887256744, 0.884796170, 0.908985958, 0.898288213 | 1.001587038, 0.991108282, 0.989096139, 0.994067178 |
| bun / object-65-max-ties | 0.040094 | 0.044737 | 0.046965 | 0.038695 | 0.657879264, 0.666715612, 0.668000800, 0.659653549 | 1.002056411, 1.004515256, 0.999808705, 0.992358182 |
| node / object-65-max-ties | 0.088336 | 0.149821 | 0.075518 | 0.072323 | 0.440096217, 0.459690151, 0.445470153, 0.437729710 | 0.993918995, 1.009146265, 0.996929515, 0.998548290 |
| bun / singleton-first-close | 0.000542 | 0.001003 | 0.002255 | 0.002953 | 0.844508431, 0.838789298, 0.842379176, 0.838114416 | 0.980361030, 0.984375338, 0.972432804, 1.045000543 |
| node / singleton-first-close | 0.004990 | 0.002564 | 0.005345 | 0.004545 | 0.570150774, 0.580899349, 0.572494984, 0.605055754 | 1.010318123, 1.010259043, 0.989137976, 0.963145977 |
| bun / singleton-full | 0.000614 | 0.000414 | 0.000509 | 0.000703 | 0.753008544, 0.760111362, 0.763240137, 0.757557664 | 1.001265433, 0.988911788, 1.007771489, 0.994542904 |
| node / singleton-full | 0.001656 | 0.001943 | 0.001996 | 0.002178 | 0.556213562, 0.558630244, 0.561281477, 0.554602783 | 0.988830978, 1.002780227, 1.003076567, 1.009766420 |
| bun / string-33-min | 0.182510 | 0.043216 | 0.052817 | 0.040513 | 0.650099265, 0.677807154, 0.671602503, 0.694110356 | 1.009800392, 0.974873199, 1.018716887, 1.015878035 |
| node / string-33-min | 0.139998 | 0.090875 | 0.160516 | 0.098566 | 0.512220451, 0.523367778, 0.519083691, 0.523161997 | 0.964798264, 0.993511075, 0.982148717, 0.983966746 |
| bun / string-4097-min-ties | 13.660197 | 15.940731 | 40.412523 | 19.889070 | 0.902479954, 0.918745363, 0.925988452, 0.904403917 | 0.957457167, 0.991785003, 0.992901087, 1.009572484 |
| node / string-4097-min-ties | 31.030492 | 23.288915 | 32.352481 | 30.638550 | 0.752266387, 0.783741523, 0.784979373, 0.789494171 | 0.987410635, 1.027291864, 0.972686679, 0.983071083 |

</details>

## Sources, identities, and evidence limits

Public sources: [measurement run](https://github.com/natanelia/zerocopy/actions/runs/37873278465), [raw Actions artifact](https://github.com/natanelia/zerocopy/actions/runs/37873278465/artifacts/11592629063), [frozen protocol](https://github.com/natanelia/zerocopy/blob/cdcbab425fb6b3ff2f648f9d222e965dc5682783/proofs/heap-entry-performance.md). The proof commit is [cdcbab425fb6b3ff2f648f9d222e965dc5682783](https://github.com/natanelia/zerocopy/commit/cdcbab425fb6b3ff2f648f9d222e965dc5682783); its reviewed tree is `3ed54c7f4d873b5a033b0950ddee867f8a382df0`. It adds the measurement workflow and harness above the frozen runtime candidate. A read-only remote check matched all ten added proof files to the reviewed blobs. The draft PR does not include those benchmark-only files.

The raw measurements and historical check logs are in the Actions artifact `heap-entry-attempt1-x64`. Download and extract its ZIP, then extract `heap-entry-attempt1.tar.gz`. Within that tar, `heap-entry-evidence/result.json` contains the full run result; `processes/` contains subject requests, stdout/stderr, and receipts; `prerequisites/` contains source/build inventories and check logs; and `harness/` plus `workflow/` retain the measurement code and workflow. These raw files are in the Actions artifact, not beside this document. GitHub reports artifact expiry on 2026-11-08.

| Identity | SHA-256 |
|---|---|
| Actions artifact ZIP | `632c3ffa32f326ed805414396ede2704a3b03d96f4e6fe65ff9a29fa4f39c768` |
| Inner tar.gz | `22bc7b8b58f8a80c74ec99065be93c287aa185326c842c3845d22f37372e8607` |
| Raw `result.json` | `c4d21c7cf662b92642752c7d2ceaef2ab60e9c6ee31f7c56858746d3d3539fff` |
| Candidate `shared-priority-queue.ts` | `934ae7e08eee789b1fb922d944484ffb2072a5848d7fb6ee5ecba3683c2a21bc` |
| Candidate `heap-entry-views.test.ts` | `00ec4e02ebedcdbc29f94d92936139dd4c38ed3669e617e6e0c11d2993271cdf` |
| Independent audit report | `a85ff2b89983f69698354a02c8289b99beda176c329913482b30220099a8f11c` |
| Independent per-cell CSV | `7be70e3bd76a3b4581e8eb2e1eb6a6267e5127030aa2c0dc8266232fb8fc8e2f` |

The last two hashes identify the audit inputs used for this document. Those derived audit files are not claimed to be part of the original Actions artifact. This document carries their per-cell results, work counts, flags, process dispersion, and quartet effects; the linked artifact holds the raw source evidence.

Runtime executable bytes and full compiler package contents were not archived for independent rehash. Their identities are receipt-backed. Available source bytes, emitted WASM and dist files, inventory aggregates, and package manifests were rehashed. Temporary neutral-package and installed-consumer copies were not retained, so their historical bytes cannot be rehashed now. Only the candidate retained the installation-generated `bun.lock`; both arms used the same shared dependency tree.

The measured runtime remains unchanged. Final-head PR CI is a separate pending check. The four unresolved controls and the original gate outcome must remain visible in any review or later scope decision.
