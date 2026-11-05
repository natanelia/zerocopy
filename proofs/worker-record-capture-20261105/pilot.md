# Pilot: worker record capture

This complete pilot is retained separately from any confirmation. It is a screen, not a standalone acceptance decision. All 80 fresh subjects and 720 measured batches are present. No sample or slower case was dropped.

Times are microseconds per complete operation. Before/after columns are medians of process medians. The paired ratio is the geometric mean of the two matching after/before ratios, so it need not equal the ratio of the displayed time columns. Ratios below one are faster.

| Runtime | Case | Before µs | After µs | Paired ratio | Pair 1 | Pair 2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| node | publish-record-512 | 814.364 | 745.975 | 0.9073 | 0.7868 | 1.0463 |
| node | publish-record-128 | 170.760 | 129.863 | 0.7611 | 0.7382 | 0.7848 |
| node | publish-same-record-128 | 185.431 | 160.025 | 0.8602 | 0.8763 | 0.8443 |
| node | publish-frozen-record-128 | 208.431 | 145.473 | 0.6968 | 0.8206 | 0.5916 |
| node | create-record-128 | 182.502 | 148.481 | 0.8182 | 0.6272 | 1.0673 |
| node | update-key-record-128 | 237.451 | 197.096 | 0.8301 | 0.8319 | 0.8283 |
| node | publish-small-record-4 | 8.116 | 8.828 | 1.0887 | 1.1181 | 1.0601 |
| node | publish-empty-record | 1.838 | 1.157 | 0.6295 | 0.6397 | 0.6195 |
| node | publish-single | 2.357 | 2.593 | 1.1015 | 1.0413 | 1.1652 |
| node | worker-data-record-128 | 27.642 | 25.675 | 0.9290 | 0.9216 | 0.9365 |
| bun | publish-record-512 | 514.353 | 553.595 | 1.0887 | 0.7646 | 1.5500 |
| bun | publish-record-128 | 74.428 | 59.157 | 0.7932 | 0.8153 | 0.7717 |
| bun | publish-same-record-128 | 92.696 | 55.991 | 0.6489 | 0.9007 | 0.4674 |
| bun | publish-frozen-record-128 | 82.248 | 70.516 | 0.8627 | 0.7101 | 1.0480 |
| bun | create-record-128 | 94.874 | 96.265 | 1.0230 | 1.1277 | 0.9281 |
| bun | update-key-record-128 | 125.897 | 75.851 | 0.5920 | 0.4619 | 0.7586 |
| bun | publish-small-record-4 | 5.454 | 3.944 | 0.7689 | 1.1564 | 0.5113 |
| bun | publish-empty-record | 0.481 | 0.369 | 0.7682 | 0.7335 | 0.8046 |
| bun | publish-single | 1.376 | 1.360 | 0.9890 | 0.9961 | 0.9820 |
| bun | worker-data-record-128 | 38.605 | 30.013 | 0.8137 | 1.1975 | 0.5529 |

## Observations

Changed 128-name records improved in both pairs on both runtimes. The wider 512-name target did not establish repeatable improvement: its second pair slowed in both runtimes. Node four-name publication slowed in both pairs; the unchanged single-collection path also slowed in both Node pairs. Bun state creation was inconclusive. These outcomes remain part of the decision and must not be obscured by the favorable 128-name target.

One unchanged-source confirmation and a separate baseline A/A study are planned to assess the target and these control concerns. The source and workload matrix are not changed between pilot and confirmation.

## Resolution diagnostics

- node: minimum measured batch 2.827606 ms; 0 / 360 measured batches below 2 ms; minimum actual timed warm-up 150.103692 ms.
- bun: minimum measured batch 1.865885 ms; 1 / 360 measured batches below 2 ms; minimum actual timed warm-up 150.046912 ms.

[Raw recording](pilot.json.gz) · [Full process log](pilot.log) · [Frozen plan](PLAN.md).
