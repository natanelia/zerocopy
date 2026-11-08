# Pilot and baseline repeatability

All phases use the same frozen workload and runner. The pilot uses the same
candidate as confirmation and remains exploratory; its samples are not pooled
with confirmation. In A/A both labels execute the baseline. A/A is a repeatability
diagnostic; it is not subtracted,
used to normalize A/B, or used to cancel an adverse result. All recorded processes
and batches remain included. The main report contains the complete 24-row
[confirmation comparison](README.md#complete-confirmation-results).

Times are microseconds per complete operation. Displayed times are medians of
process estimates; ratios are geometric means of paired estimates. The scalar
control times 256 pushes, and each numeric control times one complete scan.

## Pilot: two pairs, all 18 rows

The pilot showed clear fixed overhead at 32 values, a slightly adverse Bun
4,096-value typed-only estimate, and an adverse Node numeric-box estimate. Those
cases all continued unchanged into confirmation. See the fixed
[decision before confirmation](PRE-CONFIRMATION.md).

| Runtime | Case | Before (µs) | After (µs) | Paired ratio | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| node | `float64-32` | 0.916 | 1.664 | 1.862 | — | 0/2 |
| node | `float64-65536` | 938.658 | 195.010 | 0.208 | — | 2/2 |
| node | `float64-shared-65536` | 1070.913 | 206.543 | 0.194 | — | 2/2 |
| node | `float64-only-4096` | 19.629 | 17.228 | 0.880 | — | 2/2 |
| node | `float64-only-65536` | 232.295 | 202.222 | 0.870 | — | 2/2 |
| node | `array-build-control-32` | 0.570 | 0.517 | 0.898 | — | 2/2 |
| node | `scalar-append-control-2048` | 30.263 | 28.672 | 0.939 | — | 2/2 |
| node | `numeric-range-control-65569` | 36.941 | 30.904 | 0.864 | — | 1/2 |
| node | `numeric-box-control-65538` | 73.187 | 86.690 | 1.207 | — | 1/2 |
| bun | `float64-32` | 0.568 | 1.601 | 2.818 | — | 0/2 |
| bun | `float64-65536` | 368.632 | 305.587 | 0.827 | — | 2/2 |
| bun | `float64-shared-65536` | 390.542 | 306.630 | 0.785 | — | 2/2 |
| bun | `float64-only-4096` | 51.692 | 52.482 | 1.015 | — | 0/2 |
| bun | `float64-only-65536` | 364.888 | 273.866 | 0.753 | — | 2/2 |
| bun | `array-build-control-32` | 0.650 | 0.620 | 0.955 | — | 1/2 |
| bun | `scalar-append-control-2048` | 13.984 | 17.079 | 1.216 | — | 0/2 |
| bun | `numeric-range-control-65569` | 28.423 | 28.229 | 0.993 | — | 1/2 |
| bun | `numeric-box-control-65538` | 80.739 | 62.433 | 0.801 | — | 1/2 |

## Baseline versus baseline: four pairs, all 12 rows

All A/A intervals include 1. Several are wide. Bun's typed-only 65,536-value case
had all four after-label estimates slower (ratio 1.117), while its interval still
included 1. Bun's scalar control had a ratio of 1.211 with a 0.688–2.131 interval;
Node's numeric range control had a 1.015 ratio with a 0.536–1.924 interval. These
observations describe uncertainty in this setup. They do not identify its cause,
prove absence of bias, or remove the confirmed million-value Bun cost in A/B.

| Runtime | Case | Before (µs) | After (µs) | Paired ratio | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| node | `float64-65536` | 970.515 | 916.013 | 0.941 | 0.854–1.036 | 3/4 |
| node | `float64-only-65536` | 273.088 | 268.879 | 0.995 | 0.924–1.071 | 3/4 |
| node | `array-build-control-32` | 0.432 | 0.489 | 1.168 | 0.829–1.648 | 1/4 |
| node | `scalar-append-control-2048` | 23.677 | 23.918 | 1.024 | 0.904–1.159 | 3/4 |
| node | `numeric-range-control-65569` | 36.882 | 37.113 | 1.015 | 0.536–1.924 | 2/4 |
| node | `numeric-box-control-65538` | 62.743 | 61.666 | 0.940 | 0.741–1.192 | 2/4 |
| bun | `float64-65536` | 454.528 | 464.561 | 1.069 | 0.847–1.348 | 2/4 |
| bun | `float64-only-65536` | 333.901 | 397.193 | 1.117 | 0.909–1.372 | 0/4 |
| bun | `array-build-control-32` | 0.724 | 0.698 | 1.027 | 0.877–1.202 | 2/4 |
| bun | `scalar-append-control-2048` | 20.771 | 23.679 | 1.211 | 0.688–2.131 | 1/4 |
| bun | `numeric-range-control-65569` | 30.655 | 31.034 | 1.063 | 0.861–1.313 | 2/4 |
| bun | `numeric-box-control-65538` | 65.423 | 66.069 | 1.113 | 0.818–1.515 | 2/4 |
