# Complete fixed lookup-first screen

Frozen local source/driver/plan: `ca20cb2bb4310c74a73ef0dc8623ab9b6f039191`. Baseline `77599337867dbf785a5f0311d34637d0b36678fc`. All ten cases completed two balanced fresh-process pairs in each runtime, with source and driver end guards passing. These are new measurements; no prior experiment is pooled or reused.

Each latency is milliseconds per complete operation of 1,024 public calls. Paired ratios are geometric means of the two candidate/baseline process ratios; they need not equal the ratio of marginal median times. Tail no-op remains an unchanged-copy control. No screening confidence intervals are inferred.

| Runtime | Case | Before ms | After ms | Paired ratio | Both pair ratios |
|---|---|---:|---:|---:|---|
| node | tail-number-noop | 0.092813 | 0.087537 | 0.942380 | 0.964657, 0.920618 |
| node | tree-number-noop | 0.404257 | 0.087496 | 0.216158 | 0.205216, 0.227683 |
| node | tree-boolean-noop | 0.318834 | 0.099177 | 0.307804 | 0.268515, 0.352842 |
| node | tree-string-noop | 0.325390 | 0.090771 | 0.279004 | 0.283240, 0.274831 |
| node | tail-number-changed | 0.093605 | 0.118425 | 1.263463 | 1.082786, 1.474290 |
| node | tree-number-changed | 0.446435 | 0.409149 | 0.920345 | 0.841634, 1.006418 |
| node | tree-boolean-changed | 0.370900 | 0.370757 | 1.008211 | 1.125501, 0.903144 |
| node | tree-string-changed | 0.350986 | 0.338364 | 0.964797 | 0.936079, 0.994397 |
| node | tree-json-reencode | 1.104423 | 0.943466 | 0.857473 | 0.786436, 0.934926 |
| node | get-control | 0.026011 | 0.029473 | 1.141162 | 0.874838, 1.488562 |
| bun | tail-number-noop | 0.057099 | 0.059232 | 1.024535 | 1.209413, 0.867919 |
| bun | tree-number-noop | 0.372312 | 0.056848 | 0.147878 | 0.186504, 0.117252 |
| bun | tree-boolean-noop | 0.275751 | 0.061502 | 0.215884 | 0.256758, 0.181516 |
| bun | tree-string-noop | 0.337800 | 0.048546 | 0.144143 | 0.120737, 0.172087 |
| bun | tail-number-changed | 0.054365 | 0.054502 | 0.996414 | 1.137741, 0.872643 |
| bun | tree-number-changed | 0.381392 | 0.353355 | 0.926466 | 0.901124, 0.952520 |
| bun | tree-boolean-changed | 0.276052 | 0.321143 | 1.164220 | 1.156013, 1.172486 |
| bun | tree-string-changed | 0.366416 | 0.305172 | 0.826913 | 0.900013, 0.759750 |
| bun | tree-json-reencode | 1.289751 | 1.282790 | 0.993853 | 1.119358, 0.882420 |
| bun | get-control | 0.016901 | 0.018101 | 1.071099 | 1.165699, 0.984175 |

All three tree no-op targets improved in both pairs in both runtimes, with shared allocation falling from 655,360 bytes per deep numeric operation and 524,288 per boolean/string operation to zero. Tail no-ops still allocated 8,192 bytes per operation on both builds, and every changed/generic write matched its baseline allocation. Fresh JavaScript wrappers remain; this is not a claim of zero total allocation.

The control concerns remain: Node changed-tail writes were 26.3% slower (pairs 1.0828 and 1.4743), and Bun changed-boolean tree writes were 16.4% slower (1.1560 and 1.1725). Node reads had a 14.1% adverse point estimate but mixed pairs (0.8748 and 1.4886). Other changed-number/string observations were more favorable, but they cannot cancel or explain away another control. The source identity of an unchanged path does not establish unchanged speed.

The three consistent tree gains justify only one fixed confirmation to resolve these risks; this screen is not an acceptance claim. The final design stays frozen. Every case, existing repeat plan and cap remains unchanged; no source tuning or selected rerun follows the confirmation.

All 560 measured batches are retained, including 356 below the 20 ms target; the minimum was 0.611132 ms. The maximum warm-up count was 179, below the fixed 2,048 cap. Actual warm-up ranged from 150.080661 to 395.206311 ms.

The measured screen processes checked 272,206 complete results and 1,059,845,702 output elements, including recorded initial checks, warm-up and measured batches. Every batch also checked source contents/bytes and exact shared allocation. Calibration checks are separately retained.

Raw JSON: 2,763,377 bytes; SHA-256 `66f0cb0a8908bc45809269df7fb86ef607c8df70fd0aee8c365f18cbeae866db`.
