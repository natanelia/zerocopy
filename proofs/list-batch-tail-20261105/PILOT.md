# First completed pilot

This is an exploratory screen, not the final performance study. All 14 workloads and both runtimes are reported. Ratios are candidate/baseline elapsed time: below 1 favors the candidate. Each row has four balanced fresh-process pairs; the ratio is the geometric mean of paired process medians. Individual process medians use seven batches. The range shows the four observed pair ratios, not a confidence interval.

| Runtime | Workload | Before µs/op | After µs/op | Paired ratio | Observed pair range | Before shared bytes/op | After shared bytes/op |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| node | number/1 | 1133.27 | 771.01 | 0.653 | 0.557–0.832 | 601,728.00 | 62,320.00 |
| node | number/4 | 316.24 | 219.30 | 0.748 | 0.637–0.895 | 208,512.00 | 65,344.00 |
| node | number/8 | 165.73 | 129.88 | 0.787 | 0.719–0.844 | 142,976.00 | 69,376.00 |
| node | number/16 | 106.47 | 95.48 | 0.836 | 0.685–0.945 | 110,208.00 | 77,440.00 |
| node | number/31 | 69.71 | 73.91 | 1.040 | 0.944–1.194 | 79,152.00 | 77,640.00 |
| node | number/32 | 82.42 | 79.34 | 0.929 | 0.803–1.051 | 93,824.00 | 93,312.00 |
| node | number/33 | 68.44 | 73.17 | 1.109 | 1.021–1.286 | 76,464.00 | 76,456.00 |
| node | number/interleaved | 245.03 | 256.65 | 0.947 | 0.728–1.069 | 212,480.00 | 212,480.00 |
| node | number/large | 272.98 | 285.42 | 1.042 | 0.970–1.142 | 532,864.00 | 532,864.00 |
| node | boolean/8 | 224.18 | 162.27 | 0.754 | 0.636–1.043 | 142,976.00 | 69,376.00 |
| node | string/repeated | 276.35 | 226.33 | 0.778 | 0.609–0.898 | 142,979.61 | 69,379.61 |
| node | string/unique | 760.16 | 800.67 | 1.064 | 0.953–1.212 | 197,500.44 | 164,846.22 |
| node | object/8 | 591.42 | 537.04 | 0.988 | 0.749–1.529 | 73,344.00 | 73,344.00 |
| node | number/forks | 318.45 | 336.10 | 1.090 | 1.020–1.197 | 262,144.00 | 262,131.60 |
| bun | number/1 | 2517.49 | 639.93 | 0.269 | 0.203–0.303 | 601,728.00 | 62,320.00 |
| bun | number/4 | 618.91 | 311.33 | 0.500 | 0.396–0.641 | 208,512.00 | 65,344.00 |
| bun | number/8 | 429.84 | 269.57 | 0.595 | 0.461–0.746 | 142,976.00 | 69,376.00 |
| bun | number/16 | 268.55 | 257.30 | 1.005 | 0.816–1.246 | 110,208.00 | 77,440.00 |
| bun | number/31 | 179.67 | 233.31 | 1.181 | 0.998–1.583 | 79,152.00 | 77,640.00 |
| bun | number/32 | 259.75 | 233.43 | 0.971 | 0.816–1.150 | 93,824.00 | 93,312.00 |
| bun | number/33 | 178.69 | 178.45 | 1.084 | 0.900–1.386 | 76,464.00 | 76,456.00 |
| bun | number/interleaved | 607.96 | 611.45 | 1.011 | 0.930–1.097 | 212,480.00 | 212,480.00 |
| bun | number/large | 395.87 | 492.62 | 1.131 | 0.976–1.295 | 532,864.00 | 532,864.00 |
| bun | boolean/8 | 391.90 | 241.15 | 0.627 | 0.567–0.804 | 142,976.00 | 69,376.00 |
| bun | string/repeated | 545.98 | 339.33 | 0.638 | 0.565–0.696 | 142,978.95 | 69,378.95 |
| bun | string/unique | 959.16 | 816.27 | 0.841 | 0.658–0.995 | 196,963.20 | 163,900.80 |
| bun | object/8 | 464.12 | 466.47 | 1.013 | 0.901–1.140 | 73,344.00 | 73,344.00 |
| bun | number/forks | 866.86 | 841.82 | 0.981 | 0.940–1.021 | 262,144.00 | 262,136.25 |

The small numeric batches (1, 4, 8), boolean batches and repeated-string batches show promising wins in both engines. Shared allocation reductions are deterministic: for the 4,096-number stream in one-value batches, 601,728 becomes 62,320 allocated bytes (89.64% fewer). These byte counts include arena allocation, including persistent storage later made unreachable; they do not measure JavaScript heap or RSS. Timing includes any memory growth and garbage collection inside the append loop, so those effects are not separable from reduced copying.

The controls require caution. Node number/33 is slower in all four pairs (1.109 aggregate ratio), and the Node retained-root fork control is also slower in all four (1.090). Bun number/31 and the large empty-prefix control have adverse aggregate ratios with broad ranges; number/16 shows no established Bun win. Other controls are noisy, including an object pair as high as 1.529. No row is dropped or declared universally regression-free.

Raw samples, disposable calibration, fixed repetition and warm-up counts, all imported bundle chunk hashes, source hashes, the exact uncommitted candidate patch and timestamps are in [pilot-02.json.gz](results/pilot-02.json.gz). The unchanged driver is [pilot.mjs](pilot.mjs). The initial queued trial was canceled before any sample while a length-coercion reentrancy guard was added; its patch/driver and cancellation note remain under `exploration/` and `results/`.
