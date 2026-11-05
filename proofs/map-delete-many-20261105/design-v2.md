# V2: preserve the scalar path for short batches and all misses

The complete V1 pilot is retained in `pilot-v1.json`, with source snapshots embedded in the recording and copied in `archive/`. Its large-delete targets improved, but it is rejected:

| Runtime | 1,024 removals | 4,096 removals | Four removals | All misses | Unchanged scalar delete |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node | 0.797 | 0.653 | 1.146 | 1.139 | 1.079 |
| Bun | 0.746 | 0.484 | 1.846 | 1.150 | 1.117 |

These are paired after/before time ratios from only two process pairs, not confidence bounds. Both unchanged scalar controls also slowed in the estimate. They are retained as adverse observations rather than attributed entirely to noise. The first-operation allocation smoke also found four removals used 164 rather than 120 bytes, while large deletion reduced allocation by 53% and 69%.

V2 leaves the native patch unchanged. Its JavaScript loop uses the original scalar `Arena.delete` for the first four keys and continues using it until at least one key is actually removed. The private ownership watermark is acquired only when the next key enters the batch path. This avoids the extra dense-copy allocation for short batches and the new native recursion for all-missing input. No input length or property descriptors are examined, and iterator/getter/validation order is preserved.

The pilot workload matrix, repetitions, driver, oracle and verifier remain byte-identical to V1. No adverse control is removed. V2 must pass focused regressions and a new complete pilot before a final study is considered. Unchanged scalar performance remains a declared control, and a material unresolved regression still blocks acceptance.

Before any Unicode timing, the two ASCII batch sizes are designated primary acceptance targets. Unicode is a secondary target: encoding work may dilute the saved path copying, and its result will be retained and reported regardless. All six boundary/fallback/control workloads remain in the final matrix. Allocation observations count append-only WASM bytes consumed by the operation; they do not measure JavaScript heap, peak memory or RSS.
