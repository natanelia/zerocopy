# Complete fixed no-op list screen

Frozen local source/driver/plan: `11c73280eeaa636894851a48411fcbb5957dac54`. Baseline `77599337867dbf785a5f0311d34637d0b36678fc`. Both runtimes completed all ten cases, two balanced fresh-process pairs each; source and driver end guards passed. No confirmation data is included here.

Each reported latency is milliseconds per complete operation of 1,024 public calls. The ratio is the geometric mean of the two paired candidate/baseline latency ratios, rather than the ratio of the displayed marginal medians.

| Runtime | Case | Before ms | After ms | Paired ratio | Both pair ratios |
|---|---|---:|---:|---:|---|
| node | tail-number-noop | 0.129152 | 0.088679 | 0.686057 | 0.715223, 0.658079 |
| node | tree-number-noop | 0.443742 | 0.105740 | 0.239836 | 0.228881, 0.251315 |
| node | tree-boolean-noop | 0.358956 | 0.090936 | 0.253001 | 0.256920, 0.249142 |
| node | tree-string-noop | 0.432427 | 0.093246 | 0.220209 | 0.179056, 0.270820 |
| node | tail-number-changed | 0.109216 | 0.113318 | 1.027523 | 1.088274, 0.970162 |
| node | tree-number-changed | 0.443272 | 0.462268 | 1.044259 | 1.089764, 1.000654 |
| node | tree-boolean-changed | 0.358121 | 0.359306 | 1.002889 | 1.023436, 0.982754 |
| node | tree-string-changed | 0.406880 | 0.451062 | 1.112828 | 1.028888, 1.203615 |
| node | tree-json-reencode | 1.188492 | 1.055704 | 0.890549 | 0.861780, 0.920277 |
| node | get-control | 0.029378 | 0.027007 | 0.916218 | 0.942873, 0.890317 |
| bun | tail-number-noop | 0.059202 | 0.047856 | 0.809313 | 0.831368, 0.787843 |
| bun | tree-number-noop | 0.369527 | 0.093579 | 0.252968 | 0.245252, 0.260927 |
| bun | tree-boolean-noop | 0.308638 | 0.053165 | 0.171950 | 0.159935, 0.184868 |
| bun | tree-string-noop | 0.329647 | 0.092726 | 0.279721 | 0.299959, 0.260847 |
| bun | tail-number-changed | 0.061044 | 0.058002 | 0.949746 | 0.988304, 0.912693 |
| bun | tree-number-changed | 0.376534 | 0.397241 | 1.054980 | 0.990716, 1.123411 |
| bun | tree-boolean-changed | 0.352141 | 0.379607 | 1.079747 | 1.137939, 1.024531 |
| bun | tree-string-changed | 0.371770 | 0.287181 | 0.766097 | 0.847211, 0.692750 |
| bun | tree-json-reencode | 1.279471 | 1.434699 | 1.114928 | 1.064221, 1.168052 |
| bun | get-control | 0.019054 | 0.023210 | 1.207269 | 1.092894, 1.333614 |

All four no-op targets improved in both pairs in both runtimes. Exact shared allocation per 1,024-call no-op operation fell from 8,192 bytes for the one-element tail, 655,360 bytes for the deep numeric tree, and 524,288 bytes for the boolean/string trees to zero. Fresh JavaScript wrappers still allocate; this is not a zero-allocation JavaScript claim.

Controls remain unresolved. Node changed-string writes were 11.3% slower (both pairs adverse); Bun JSON re-encoding was 11.5% slower and unchanged reads were 20.7% slower (both pairs adverse). Bun changed numeric/boolean paths were also slower in the point estimate. These observations cannot be dismissed merely because some corresponding source is unchanged. The large no-op gains justify at most one fixed six-pair confirmation on the same source; they do not establish overall readiness.

All 560 measured batches are retained, including 344 below the 20 ms target; the minimum was 0.726163 ms. The common output/allocation caps cause short batches. Warm-up used at most 154 batches; scaling each subject's observed mean warm batch to a 500 ms floor projects at most 512.0 batches, below the already fixed 2,048 cap. This projection is only a feasibility check, not a guarantee about a future process.

Measured-process validation checked 274,986 complete operations and 916,985,122 output elements, including each recorded initial check plus warm-up and measured batches. Every batch also checked its full source before/after and exact shared allocation. Calibration-process checks are separately retained in the raw data.

Raw JSON: 2,468,512 bytes; SHA-256 `38149259eacaa7d0f7cbd78d7aed7569a87ca8d1e29f10d50582f4e4b751a920`.
