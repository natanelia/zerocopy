# Superseded V2 pilot

V2 used a separate copy helper for numeric lists of at least 65,536 values, but kept the dispatch inside the generic vector method. Its unchanged Node boolean-list control slowed in both pilot pairs (1.301/1.175). V2 did not proceed to confirmation. Independent review also found a real invalid-descriptor issue: subarray silently clamps an invalid span. V3 uses an exact-length view and moves dispatch to snapshot(), leaving vector() byte-for-byte equal to the baseline.

All nine cases and both runtimes remain in this complete pilot. No V1/V2/V3 timing observations are pooled. Exact archived code, tests, driver, plan and worker proof match [archive-manifest.json](archive-manifest.json). The frozen local commit is `8fa98cf855e0775fda6d17ec04329f9a1d6e1fc5`; public reproduction uses these archived files and source hashes, not a presumed remotely available local Git object.

| Runtime | Case | Before ms | After ms | Paired ratio | Both ratios |
| --- | --- | ---: | ---: | ---: | --- |
| node | list-number-large | 3.903355 | 0.889168 | 0.2271 | 0.2540, 0.2031 |
| node | list-number-boundary | 1.828545 | 0.770439 | 0.4216 | 0.4194, 0.4238 |
| node | list-number-small | 0.058175 | 0.074790 | 1.2944 | 1.6353, 1.0246 |
| node | list-boolean | 0.483206 | 0.592426 | 1.2361 | 1.3008, 1.1746 |
| node | queue-number | 0.433910 | 0.294916 | 0.7974 | 1.3479, 0.4718 |
| node | queue-boolean | 0.182181 | 0.136238 | 0.7466 | 0.7822, 0.7126 |
| node | list-empty | 0.046007 | 0.046387 | 1.0212 | 1.2067, 0.8641 |
| node | list-string | 0.708505 | 0.710294 | 1.0079 | 0.6493, 1.5645 |
| node | list-object | 0.140423 | 0.118156 | 0.8467 | 0.7549, 0.9498 |
| bun | list-number-large | 4.484469 | 1.882915 | 0.4269 | 0.3523, 0.5173 |
| bun | list-number-boundary | 2.270631 | 1.535557 | 0.6833 | 0.5759, 0.8106 |
| bun | list-number-small | 1.101158 | 1.106117 | 1.0051 | 0.9866, 1.0239 |
| bun | list-boolean | 1.200246 | 1.192979 | 1.0020 | 0.9329, 1.0763 |
| bun | queue-number | 1.315691 | 1.296468 | 0.9876 | 0.9473, 1.0297 |
| bun | queue-boolean | 1.124048 | 1.193646 | 1.0627 | 1.0771, 1.0485 |
| bun | list-empty | 0.998976 | 1.114427 | 1.1207 | 1.0430, 1.2043 |
| bun | list-string | 1.920456 | 2.146590 | 1.1319 | 1.4461, 0.8860 |
| bun | list-object | 1.376140 | 1.163974 | 0.8505 | 0.7344, 0.9848 |

[Complete original recording, losslessly compressed](results/pilot-v2.json.gz), [archive hashes](results/archive-manifest.json), and all build/focused/worker logs are retained. V2 passed 82 focused tests; that is not approval of its performance or malformed-span behavior.
