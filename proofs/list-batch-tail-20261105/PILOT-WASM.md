# WASM V2 pilot

All 14 workloads from the original matrix were retained. Each runtime/workload has four balanced fresh-process pairs and seven measured batches per subject. Ratios are candidate/baseline elapsed time: below 1 favors the candidate. The ratio is the geometric mean of the four paired process medians; the range is the observed pair range, not a confidence interval.

| Runtime | Workload | Before µs/op | After µs/op | Paired ratio | Observed pair range | Before shared bytes/op | After shared bytes/op |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| node | number/1 | 1098.47 | 548.30 | 0.550 | 0.478–0.695 | 601,728.00 | 62,320.00 |
| node | number/4 | 335.54 | 193.61 | 0.571 | 0.421–0.751 | 208,512.00 | 65,344.00 |
| node | number/8 | 171.12 | 102.39 | 0.671 | 0.571–0.922 | 142,976.00 | 69,376.00 |
| node | number/16 | 107.54 | 80.54 | 0.739 | 0.704–0.795 | 110,208.00 | 77,440.00 |
| node | number/31 | 74.51 | 65.19 | 0.883 | 0.848–0.904 | 79,152.00 | 77,640.00 |
| node | number/32 | 71.18 | 72.90 | 0.974 | 0.862–1.084 | 93,824.00 | 93,312.00 |
| node | number/33 | 69.33 | 60.13 | 0.884 | 0.836–0.915 | 76,464.00 | 76,456.00 |
| node | number/interleaved | 245.39 | 232.98 | 0.943 | 0.859–1.002 | 212,480.00 | 212,480.00 |
| node | number/large | 271.94 | 263.94 | 0.921 | 0.738–1.029 | 532,864.00 | 532,864.00 |
| node | boolean/8 | 205.40 | 185.30 | 0.801 | 0.613–0.933 | 142,976.00 | 69,376.00 |
| node | string/repeated | 354.47 | 203.70 | 0.592 | 0.467–0.741 | 142,979.29 | 69,379.29 |
| node | string/unique | 758.09 | 679.42 | 0.842 | 0.572–1.026 | 196,157.33 | 162,482.67 |
| node | object/8 | 664.06 | 551.53 | 0.870 | 0.676–1.024 | 73,344.00 | 73,344.00 |
| node | number/forks | 316.87 | 276.15 | 0.902 | 0.851–1.065 | 262,144.00 | 262,134.81 |
| bun | number/1 | 2083.34 | 528.95 | 0.256 | 0.196–0.297 | 601,728.00 | 62,320.00 |
| bun | number/4 | 611.08 | 241.59 | 0.375 | 0.311–0.424 | 208,512.00 | 65,344.00 |
| bun | number/8 | 468.43 | 246.95 | 0.524 | 0.501–0.552 | 142,976.00 | 69,376.00 |
| bun | number/16 | 334.73 | 266.94 | 0.800 | 0.597–1.079 | 110,208.00 | 77,440.00 |
| bun | number/31 | 212.90 | 194.96 | 0.919 | 0.826–1.048 | 79,152.00 | 77,640.00 |
| bun | number/32 | 258.37 | 258.94 | 1.001 | 0.938–1.161 | 93,824.00 | 93,312.00 |
| bun | number/33 | 231.66 | 225.12 | 0.976 | 0.824–1.166 | 76,464.00 | 76,456.00 |
| bun | number/interleaved | 641.70 | 674.83 | 1.047 | 0.919–1.149 | 212,480.00 | 212,480.00 |
| bun | number/large | 468.54 | 523.27 | 1.118 | 0.844–1.485 | 532,864.00 | 532,864.00 |
| bun | boolean/8 | 511.00 | 293.98 | 0.575 | 0.447–0.769 | 142,976.00 | 69,376.00 |
| bun | string/repeated | 529.36 | 274.46 | 0.541 | 0.476–0.611 | 142,979.61 | 69,379.61 |
| bun | string/unique | 991.97 | 990.11 | 0.908 | 0.745–1.062 | 197,500.44 | 164,846.22 |
| bun | object/8 | 489.60 | 495.46 | 1.006 | 0.963–1.024 | 73,344.00 | 73,344.00 |
| bun | number/forks | 848.03 | 855.80 | 1.017 | 1.008–1.034 | 262,144.00 | 262,136.25 |

The small-batch targets remain promising, and the two consistent Node penalties in V1 (33-value batches and forks) now have favorable aggregate ratios. The Bun fork control is 1.7% slower in all four pairs. Bun large-batch results remain noisy, with an adverse aggregate and a 0.844–1.485 observed pair range. These observations motivate the longer, fixed [formal plan](FORMAL-PLAN.md), not a universal no-regression claim.

The shared-byte reductions match V1. Timings include any growth or garbage collection inside the append loop. Both pilot drivers use the phrase “result-array allocation” in their excluded-work metadata; this refers only to the outer batch-output array. The per-operation fork-result array is allocated inside the timer. The formal driver makes that distinction explicit.

All source/bundle hashes, the candidate patch and raw calibration/warm-up/measured observations are retained in [pilot-wasm-v2-01.json.gz](results/pilot-wasm-v2-01.json.gz). The driver remains [pilot-wasm.mjs](pilot-wasm.mjs), separate from the unmodified V1 driver and recording.
