# Rejected experiment: queue front leaf cache

**Rejected; this source branch is retained as experiment evidence and should not
be merged as a performance improvement.** No confirmation run was performed.

The one-line candidate makes the committed-tree branch of `SharedQueue.peek()`
use the existing Arena vector-leaf cache. Five new regressions and the existing
queue suite pass (27 tests). In a 1,057-value drain, it reduces committed leaf
lookups to 33 and preserves complete FIFO output, old snapshots, shared/copy
readers, growth and decoder reentry. The optimization mechanism works, but its
end-to-end performance is not acceptable across the tested workloads.

Switching between four queue roots costs **41.0% more latency in Node and 21.2%
more in Bun**. Both process pairs are adverse in each engine. Repeated peeks
improve, but Node deep-drain latency is essentially unchanged and other complete
drains are mixed. We do not use repeated-peek gains to excuse the alternate-root
regression. The untouched stack also moves in the Node pilot, so small/variable
results should be treated cautiously.

## Frozen source and method

Baseline: `77599337867dbf785a5f0311d34637d0b36678fc`.
Local measured commit: `2d5429f8601932c8407bdf649dcddb283c1d0476`.
Only production change: [shared-queue.ts](../../shared-queue.ts), SHA-256
`cef2005c166e4e1bc5f34131cfebc7d9f7aa55d16b9cbfc4c2c2a2c65a5000bc`.
The [tests](../../queue-front-cache.test.ts), [fixed plan](PLAN.md) and
[exact driver](pilot.mjs) remain alongside all recordings.

Both engines use the portable bundle: Node 24.22.1 and Bun 1.4.2, Linux 6.18.57,
x64 AMD EPYC 9V74, CPU 2 affinity and shared perf.lock. Every subject is a fresh
process with one workload/build at the same neutral import path. All imported
bundle chunks are replaced between subjects. Each runtime has ten cases and two
balanced AB/BA pairs per case, with seven measured batches. The raw records
include both disposable calibration stages and actual warm-up durations.
Nonempty measured subjects warm for at least 150 ms and eight batches. Empty has
a 256-batch cap. Common repetition counts target 8 ms with fixed retained-output
caps; actual batch durations remain recorded even when shorter.

Each complete drain includes all public peek/dequeue or peek/pop calls and
snapshot construction/freezing. Repeated-peek operations contain 256 peeks; empty
contains one. All full output values and actual counts are checked after every
batch against independent native expected arrays, using reused caller buffers.
String/JSON decoding uses ordinary bounded caches; strings exceed the cache,
JSON fits it. No forced GC or internal cache reset is used. Shared arena usage
must remain unchanged. All source/bundle/driver start/end guards passed.

## Every pilot case

Times are microseconds per complete operation, not per individual dequeue.
Before/after columns are medians of process medians; the ratio is the geometric
mean of paired after/before medians. Two pairs are a screening result, not a
confirmation study. Computed exploratory intervals in the raw driver output are
not used to claim a performance gate passed.

| Case | Node before→after µs | Node ratio (two pairs) | Bun before→after µs | Bun ratio (two pairs) |
| --- | ---: | ---: | ---: | ---: |
| empty-peek | 0.006→0.007 | 1.085 (1.187, 0.993) | 0.001→0.002 | 1.045 (0.996, 1.097) |
| tail-drain | 2.983→2.935 | 0.984 (0.964, 1.005) | 1.160→1.160 | 0.999 (0.959, 1.040) |
| first-block-drain | 2.165→2.098 | 0.971 (0.924, 1.021) | 1.025→1.002 | 0.977 (0.988, 0.967) |
| tree-drain | 343.368→255.975 | 0.774 (1.017, 0.589) | 140.120→135.539 | 0.969 (1.000, 0.939) |
| deep-drain | 4285.572→4324.585 | 1.009 (0.987, 1.032) | 2333.676→2132.935 | 0.914 (0.918, 0.910) |
| repeat-peek | 3.118→2.443 | 0.779 (0.864, 0.703) | 2.093→1.839 | 0.878 (0.877, 0.880) |
| alternating-roots | 326.980→461.183 | 1.410 (1.404, 1.416) | 155.672→188.538 | 1.212 (1.159, 1.269) |
| string-drain | 1330.172→1337.955 | 1.004 (0.973, 1.036) | 1002.857→758.723 | 0.761 (0.646, 0.896) |
| object-drain | 96.097→91.925 | 0.955 (1.052, 0.868) | 60.935→61.701 | 1.014 (0.957, 1.075) |
| unchanged-stack | 466.878→561.502 | 1.178 (0.962, 1.443) | 169.578→173.292 | 1.022 (1.032, 1.011) |

## Retained evidence

- [Node full raw record](results/node-pilot-01.json.gz) and [console log](results/node-pilot-01.log).
- [Bun full raw record](results/bun-pilot-01.json.gz) and [console log](results/bun-pilot-01.log).
- [Portable build and 27-test focused log](results/focused-01.log).
- [Archive manifest](archive-manifest.json), including original/compressed bytes and SHA-256 hashes.

Every original JSON byte survives lossless gzip compression; both decompression
round trips were checked. All 20 case estimates, 40 process pairs and 560 measured
batches remain, including unfavorable observations. The source and driver were
not tuned after viewing the pilot. An independent priority-queue view-capture
candidate will use a different worktree, source and proof directory.
