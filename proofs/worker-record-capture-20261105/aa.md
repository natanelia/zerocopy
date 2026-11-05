# Same-baseline A/A controls

These are separate baseline-only comparisons. They estimate process/host variation and are not subtracted from the A/B results. Four pairs per case/runtime, with the same warm-up, batch, output-check and ordering protocol as confirmation.

Both sides load byte-identical baseline sources and bundles. Medians are microseconds per operation. All intervals cross parity; they are not equivalence bounds.

| Runtime | Case | Before µs | After µs | Paired ratio | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| node | publish-record-128 | 165.487 | 164.042 | 0.9876 | 0.7538–1.2940 | 3/4 |
| node | publish-single | 2.369 | 2.685 | 1.0805 | 0.8514–1.3711 | 2/4 |
| bun | publish-record-128 | 67.554 | 78.156 | 1.1023 | 0.9020–1.3471 | 1/4 |
| bun | publish-single | 1.481 | 1.444 | 0.9314 | 0.6763–1.2826 | 3/4 |

## Raw pair ratios

- node publish-record-128: 0.988934, 0.873145, 0.877828, 1.255062.
- node publish-single: 0.981291, 1.266918, 0.925074, 1.185010.
- bun publish-record-128: 1.150825, 0.950664, 1.278627, 1.055530.
- bun publish-single: 0.823698, 0.777810, 1.219427, 0.963114.

[Raw A/A recording](aa.json.gz) · [Process log](aa.log) · [Confirmation](formal.md).
