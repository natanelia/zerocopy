# Rejected: bounded Map miss cache

**Rejected; no performance PR.** This automatic change to existing `SharedMap.get`
and `SharedMap.has` calls improves repeated longer-key misses, but introduces
substantial costs for first-time misses, streaming queries, a filled cache and
alternating snapshots. Those costs affect callers without an opt-in API. The
candidate remains on an archive branch and is not proposed for merging.

The hosted formal study measured these paired latency changes:

| Existing-call workload | Node latency change | Bun latency change |
| --- | ---: | ---: |
| `get-cold-misses` | +38.2% | +39.4% |
| `get-short-cold-misses` | +85.1% | +46.3% |
| `get-streaming-misses` | +17.7% | +17.0% |
| `get-over-budget-misses` | +23.0% | +28.1% |
| `get-alternating-roots` | +47.4% | +33.0% |
| `get-short-repeated-misses` | +54.8% | -30.5% |

The first five workloads regress in both runtimes, with their pointwise 95%
intervals entirely above 1. Node also regresses on repeated short-key misses by
54.8%, while Bun improves that case. The pilot shows the same adverse directions.
Longer repeated ASCII/Unicode misses and the mixed fixture improve; those gains
do not satisfy the acceptance requirement for a general automatic cache when
these other existing calls become slower. All cases remain visible below.

## Frozen evidence and provenance

- Baseline: `a4265a0608ec25eec5719496225212db6b251989`.
- Measured candidate: `2671a2b19725758f749280d9b0dedfde645baf2b`.
- Hosted run: [42504549263](https://github.com/natanelia/zerocopy/actions/runs/42504549263),
  job `128804239742`, on 8 November 2026.
- Runtime: Node 24.22.1 and Bun 1.4.2; AMD EPYC 9V45 96-Core Processor, CPU 0.
- Original artifact: `13627760234`; ZIP SHA-256
  `51f06cc7303497970fdcb2e85cb7fa381ee905321aa13b250299dce05fb4d72f`.

The primary records are [pilot](./results/pilot.json.gz),
[formal](./results/formal.json.gz), and [A/A](./results/aa.json.gz).
[provenance.json](./results/provenance.json) records their raw and compressed
hashes. Each gzip archive uses `mtime=0` and was decompressed and compared byte
for byte with the downloaded original. No measurement field or sample was
changed. Source snapshots, all source/WASM/bundle hashes, runtime versions,
process order, affinity, raw batches and oracle digests remain in the records.

| Study | Fresh processes | Measured batches | Verified result arrays, including warmup | Measured batches below 2 ms | Minimum measured batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pilot | 112 | 1,008 | 1,649,472 | 0 | 3.459 ms |
| Formal | 336 | 3,024 | 5,017,344 | 0 | 3.294 ms |
| AA | 224 | 2,016 | 3,256,768 | 0 | 3.317 ms |

There were also zero warmup batches below 2 ms. These are the driver's recorded
result-array counts; each array contains 1,024 verified scalar outputs. The
source, driver, workload and repetition counts remain frozen.

## What the candidate changed

An Arena already caches successful scalar lookups. The candidate adds a lazy,
separately bounded cache of an absent raw query string and the exact immutable
root at which it was absent. A repeated miss on that root can avoid UTF-8
encoding, hashing and HAMT traversal. Existing successful-read paths remain
unchanged in source; their measured performance still needs controls.

The cache retains **at most 256 query strings and 16,384 UTF-16 code units per
Arena**, plus one numeric root per entry and ordinary JavaScript object/Map
overhead. This is an added JavaScript memory cost. Reads allocated zero WASM
bytes before and after; this candidate does not demonstrate a WASM memory
saving. The character limit describes logical retained key length, not actual
JavaScript heap size, RSS or capacity. Negative entries do not consume existing
positive-cache budgets. UTF-8 aliases can occupy separate negative slots within
the same limits.

Each key remembers its most recently admitted missing root. Alternating roots
can therefore replace that entry repeatedly, while first-time misses pay
admission overhead. Unknown keys after either limit is reached remain uncached.
A declared, uninitialized field is appended only after a miss; separate controls
cover warm successful reads before and after that lazy field appears.

The implementation retains dynamic kernel lookup between stages. Observed
custom kernel receivers or substituted views retire the optional cache for that
Arena. Cached reuse/publication excludes accessor-valued WASM exports. Tests
cover custom false misses, a kernel restoring native exports before returning,
changing kernels between stages, stale custom prefix state, and throwing,
nullish or false views. Shared bytes, allocation state, descriptors, WASM ABI and
format 4 remain unchanged.

## Workloads and method

[workloads.mjs](./workloads.mjs) defines the inputs and native-Map oracle. Each
operation makes **1,024 complete public scalar calls**, allocates their result
array and returns it for retention by the driver. All table times are
**microseconds per complete 1,024-call operation**, including result-array
creation and retention. Divide by 1,024 only when explicitly reporting per-query
time. Every returned scalar is verified outside the timer; verification does not
walk unrelated Map entries for each output.

| Case | Source entries | Queries | Read state | Operations per timed batch |
| --- | ---: | --- | --- | ---: |
| `get-repeated-ascii-16` | 4,096 | 16 absent ASCII keys | Primed | 256 |
| `has-repeated-ascii-128` | 4,096 | 128 absent ASCII keys | Primed | 256 |
| `get-repeated-unicode-128` | 32,768 | 128 absent Unicode keys | Primed | 256 |
| `get-short-repeated-misses` | 4,096 | 16 absent three-character keys | Primed | 256 |
| `get-cold-misses` | 4,096 | 1,024 distinct absent keys | Fresh reader per operation | 64 |
| `get-short-cold-misses` | 4,096 | 1,024 distinct absent three-character keys | Fresh reader per operation | 64 |
| `get-cold-hits` | 4,096 | 1,024 distinct existing keys | Fresh reader per operation | 64 |
| `get-streaming-misses` | 4,096 | 65,536 distinct absent keys across a batch | Fresh reader per batch | 64 |
| `get-over-budget-misses` | 4,096 | 1,024 absent keys outside the filled negative budget | Primed | 128 |
| `get-mixed` | 4,096 | 819 hits and 205 misses | Primed | 256 |
| `get-alternating-roots` | 4,096 | 16 absent keys revisiting two immutable roots | Primed | 64 |
| `get-warm-hits` | 4,096 | 1,024 existing keys | No preceding miss | 512 |
| `get-warm-hits-after-miss` | 4,096 | 1,024 existing keys | One preceding miss | 512 |
| `has-warm-hits` | 4,096 | 1,024 existing keys | No preceding miss | 512 |


Warm readers are read-only shared attachments. Cold fixtures derive the same
Arena constructor from that public attachment and construct fresh read-only
readers before each batch, without resetting private caches. Streaming query
strings are prepared outside timing. Both published roots, the writer allocation
frontier and every published source byte are checked after each batch.

[paired-benchmark.mjs](./paired-benchmark.mjs) imports each build from the same
neutral path in a fresh runtime process. The whole study holds one common lock
and pins subprocesses to one CPU. Pair order alternates AB/BA, and case/runtime
order reverse on alternating pairs. All 14 cases appear in each study: two pilot
pairs, six formal pairs and four baseline-versus-baseline A/A pairs. Each process
has at least 500 ms of timed warmup and eight warmup batches, then nine measured
batches.

Before/after times below are medians of process medians. The paired ratio is the
geometric mean of per-pair after/before ratios, so it need not equal the ratio of
the displayed medians. Formal/A/A intervals use Student-t intervals on paired
log ratios. They are pointwise, unadjusted intervals across multiple cases.
Pilot rows have no confidence interval.

## Formal results: all 28 rows

Ratio below 1 means lower latency; above 1 means higher latency. “Inconclusive”
means the pointwise interval contains 1, not proof of equivalent performance.

| Runtime | Case | Before µs | After µs | Paired ratio | 95% interval | Pointwise result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Node | `get-repeated-ascii-16` | 150.894 | 74.478 | 0.484535 | 0.451833–0.519603 | faster |
| Node | `has-repeated-ascii-128` | 147.258 | 67.021 | 0.488829 | 0.412530–0.579240 | faster |
| Node | `get-repeated-unicode-128` | 451.905 | 78.868 | 0.168532 | 0.154567–0.183757 | faster |
| Node | `get-short-repeated-misses` | 45.277 | 69.780 | 1.547698 | 1.431564–1.673254 | slower |
| Node | `get-cold-misses` | 164.107 | 224.118 | 1.381673 | 1.345412–1.418912 | slower |
| Node | `get-short-cold-misses` | 56.755 | 105.376 | 1.851181 | 1.810377–1.892905 | slower |
| Node | `get-cold-hits` | 162.728 | 162.824 | 0.994343 | 0.979322–1.009593 | inconclusive |
| Node | `get-streaming-misses` | 229.548 | 268.068 | 1.176809 | 1.157436–1.196506 | slower |
| Node | `get-over-budget-misses` | 151.101 | 185.797 | 1.229863 | 1.210132–1.249917 | slower |
| Node | `get-mixed` | 49.074 | 32.036 | 0.653527 | 0.629130–0.678871 | faster |
| Node | `get-alternating-roots` | 167.587 | 238.010 | 1.474089 | 1.323504–1.641807 | slower |
| Node | `get-warm-hits` | 20.343 | 20.538 | 1.013218 | 0.950626–1.079932 | inconclusive |
| Node | `get-warm-hits-after-miss` | 20.171 | 20.583 | 1.009839 | 0.980349–1.040217 | inconclusive |
| Node | `has-warm-hits` | 13.810 | 14.093 | 1.117502 | 0.892242–1.399631 | inconclusive |
| Bun | `get-repeated-ascii-16` | 103.358 | 42.174 | 0.414032 | 0.388585–0.441144 | faster |
| Bun | `has-repeated-ascii-128` | 83.304 | 41.605 | 0.499715 | 0.485826–0.514001 | faster |
| Bun | `get-repeated-unicode-128` | 117.453 | 43.972 | 0.371507 | 0.345231–0.399783 | faster |
| Bun | `get-short-repeated-misses` | 61.730 | 42.462 | 0.695231 | 0.655309–0.737585 | faster |
| Bun | `get-cold-misses` | 119.704 | 168.631 | 1.393845 | 1.225573–1.585221 | slower |
| Bun | `get-short-cold-misses` | 92.250 | 129.928 | 1.463394 | 1.309786–1.635017 | slower |
| Bun | `get-cold-hits` | 170.625 | 159.223 | 0.927869 | 0.816372–1.054595 | inconclusive |
| Bun | `get-streaming-misses` | 107.853 | 127.751 | 1.170061 | 1.038573–1.318196 | slower |
| Bun | `get-over-budget-misses` | 77.485 | 99.066 | 1.281245 | 1.219736–1.345857 | slower |
| Bun | `get-mixed` | 28.462 | 17.014 | 0.592563 | 0.539861–0.650410 | faster |
| Bun | `get-alternating-roots` | 174.911 | 231.069 | 1.330027 | 1.307101–1.353356 | slower |
| Bun | `get-warm-hits` | 12.983 | 12.609 | 0.950885 | 0.835742–1.081893 | inconclusive |
| Bun | `get-warm-hits-after-miss` | 12.610 | 12.539 | 1.016087 | 0.981304–1.052104 | inconclusive |
| Bun | `has-warm-hits` | 7.217 | 7.672 | 1.077757 | 0.920236–1.262242 | inconclusive |

## A/A controls and measurement limits

A/A uses the same baseline source, WASM and bundles on both sides. **Three of
28 pointwise intervals exclude 1**: Node streaming misses (ratio 0.993188,
interval 0.986738–0.999681), Bun repeated ASCII misses (0.970351,
0.946812–0.994475), and Bun warm `has` (0.821654, 0.695973–0.970030).
These results expose baseline variability and multiple-comparison risk. In
particular, warm successful controls cannot be claimed unchanged or faster.

The independent review also flags a process when either of two ratios lies
outside [0.8, 1.2]: the median of the nine measured batches divided by the median
of the last up to nine warmup batches, or the median of the last three measured
batches divided by the median of the first three. This **union** flags 40/336
formal, 15/224 A/A and 8/112 pilot processes. It is distinct from counting only
early-to-late measured movement. No flagged process or sample was removed.

**Untimed verification eagerly allocates a diagnostic string for every scalar
check.** Although outside the stopwatch, this allocation traffic can affect heap
state and garbage collection in the next timed batch. Both builds used the same
frozen verifier, but these results are not an allocation-free isolated-call
measurement. The limitations weaken fine-grained interpretations; they do not
provide a basis to ship an automatic change with the large, corroborated
countercase regressions observed here. The decision is rejection, not a
universal speed estimate.

All A/A rows follow; both “before” and “after” are the pinned baseline.

| Runtime | Case | Before µs | After µs | Paired ratio | 95% interval | Interval includes 1 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Node | `get-repeated-ascii-16` | 144.829 | 146.697 | 1.015723 | 0.961517–1.072984 | yes |
| Node | `has-repeated-ascii-128` | 144.797 | 145.398 | 1.003370 | 0.969628–1.038286 | yes |
| Node | `get-repeated-unicode-128` | 397.777 | 389.379 | 1.002813 | 0.929095–1.082381 | yes |
| Node | `get-short-repeated-misses` | 43.436 | 45.347 | 1.014753 | 0.956552–1.076494 | yes |
| Node | `get-cold-misses` | 156.745 | 158.930 | 1.004158 | 0.978470–1.030519 | yes |
| Node | `get-short-cold-misses` | 55.236 | 55.313 | 0.999441 | 0.973227–1.026361 | yes |
| Node | `get-cold-hits` | 160.185 | 162.219 | 1.006175 | 0.957609–1.057203 | yes |
| Node | `get-streaming-misses` | 225.278 | 223.058 | 0.993188 | 0.986738–0.999681 | **no** |
| Node | `get-over-budget-misses` | 149.043 | 145.903 | 0.974782 | 0.946562–1.003844 | yes |
| Node | `get-mixed` | 48.116 | 48.019 | 0.993363 | 0.928494–1.062765 | yes |
| Node | `get-alternating-roots` | 161.980 | 158.140 | 0.984374 | 0.944495–1.025937 | yes |
| Node | `get-warm-hits` | 19.749 | 19.137 | 0.984625 | 0.942594–1.028530 | yes |
| Node | `get-warm-hits-after-miss` | 20.008 | 19.290 | 0.949463 | 0.855283–1.054013 | yes |
| Node | `has-warm-hits` | 10.997 | 8.425 | 0.874474 | 0.518705–1.474257 | yes |
| Bun | `get-repeated-ascii-16` | 96.633 | 93.518 | 0.970351 | 0.946812–0.994475 | **no** |
| Bun | `has-repeated-ascii-128` | 78.752 | 76.436 | 0.971883 | 0.843624–1.119641 | yes |
| Bun | `get-repeated-unicode-128` | 111.687 | 112.748 | 1.005755 | 0.959427–1.054321 | yes |
| Bun | `get-short-repeated-misses` | 59.485 | 57.469 | 0.941228 | 0.845830–1.047386 | yes |
| Bun | `get-cold-misses` | 113.596 | 112.667 | 0.997833 | 0.935122–1.064748 | yes |
| Bun | `get-short-cold-misses` | 84.397 | 85.466 | 1.016874 | 0.989152–1.045373 | yes |
| Bun | `get-cold-hits` | 146.386 | 154.760 | 1.050715 | 0.976707–1.130332 | yes |
| Bun | `get-streaming-misses` | 101.534 | 102.494 | 1.015842 | 0.782884–1.318120 | yes |
| Bun | `get-over-budget-misses` | 74.720 | 72.378 | 0.980484 | 0.931406–1.032148 | yes |
| Bun | `get-mixed` | 25.790 | 27.379 | 1.040859 | 0.797344–1.358745 | yes |
| Bun | `get-alternating-roots` | 165.479 | 167.872 | 1.017886 | 0.947851–1.093095 | yes |
| Bun | `get-warm-hits` | 12.543 | 12.080 | 0.974361 | 0.585732–1.620843 | yes |
| Bun | `get-warm-hits-after-miss` | 12.802 | 12.514 | 1.075190 | 0.771885–1.497676 | yes |
| Bun | `has-warm-hits` | 8.909 | 7.096 | 0.821654 | 0.695973–0.970030 | **no** |

## Pilot results: all 28 rows

The pilot was collected before the formal study with the same frozen source,
workload and repetitions. It supports the adverse countercase directions and is
retained in full, without a separate headline claim.

| Runtime | Case | Before µs | After µs | Paired ratio |
| --- | --- | ---: | ---: | ---: |
| Node | `get-repeated-ascii-16` | 155.931 | 76.050 | 0.487664 |
| Node | `has-repeated-ascii-128` | 147.802 | 67.718 | 0.458053 |
| Node | `get-repeated-unicode-128` | 452.901 | 79.114 | 0.174368 |
| Node | `get-short-repeated-misses` | 46.080 | 66.629 | 1.445502 |
| Node | `get-cold-misses` | 160.551 | 214.232 | 1.334418 |
| Node | `get-short-cold-misses` | 56.144 | 103.601 | 1.845813 |
| Node | `get-cold-hits` | 159.261 | 162.271 | 1.018926 |
| Node | `get-streaming-misses` | 228.750 | 270.518 | 1.182584 |
| Node | `get-over-budget-misses` | 147.272 | 179.417 | 1.218222 |
| Node | `get-mixed` | 47.724 | 31.410 | 0.657823 |
| Node | `get-alternating-roots` | 162.238 | 231.008 | 1.424194 |
| Node | `get-warm-hits` | 21.029 | 21.077 | 1.002428 |
| Node | `get-warm-hits-after-miss` | 19.766 | 19.575 | 0.990018 |
| Node | `has-warm-hits` | 11.234 | 10.922 | 0.972494 |
| Bun | `get-repeated-ascii-16` | 98.119 | 41.264 | 0.420503 |
| Bun | `has-repeated-ascii-128` | 77.385 | 40.962 | 0.528888 |
| Bun | `get-repeated-unicode-128` | 112.255 | 46.821 | 0.414421 |
| Bun | `get-short-repeated-misses` | 64.535 | 41.555 | 0.643922 |
| Bun | `get-cold-misses` | 122.418 | 162.352 | 1.325340 |
| Bun | `get-short-cold-misses` | 85.724 | 121.438 | 1.415692 |
| Bun | `get-cold-hits` | 151.038 | 153.557 | 1.017248 |
| Bun | `get-streaming-misses` | 106.711 | 126.956 | 1.190283 |
| Bun | `get-over-budget-misses` | 77.130 | 102.579 | 1.328806 |
| Bun | `get-mixed` | 29.480 | 17.799 | 0.601777 |
| Bun | `get-alternating-roots` | 176.698 | 230.885 | 1.306296 |
| Bun | `get-warm-hits` | 13.757 | 11.196 | 0.798435 |
| Bun | `get-warm-hits-after-miss` | 14.069 | 11.422 | 0.790032 |
| Bun | `has-warm-hits` | 7.530 | 8.711 | 1.146426 |

## Correctness, audit correction and archive workflow

All hosted correctness steps passed before measurement: builds/declarations,
focused Node and Bun tests (**76 tests each**), package checks, all 14 workload
oracles in both builds/runtimes, and real shared/copied Node workers with current
and baseline readers. Real Chromium **153.0.8010.12** workers passed all eight
value-type/transport combinations with cross-origin isolation. See the retained
[Node tests](./validation/hosted/node-tests.log),
[Bun tests](./validation/hosted/bun-tests.log),
[package checks](./validation/hosted/package.log),
[current workers](./validation/hosted/workers-current.log),
[baseline workers](./validation/hosted/workers-baseline.log), and
[Chromium proof](./validation/hosted/chromium.log).

The original hosted job concluded **failure only at its final offline audit**.
The [original verifier](./archive/verify-before-strategy-fix.mjs) asserted a
`run.strategy` field that the frozen driver does not record. The exact failure is
preserved in [evidence.log](./validation/hosted/evidence.log), with the complete
[job log](./validation/hosted-job.log.gz) also retained. All three studies had
completed before that failure; the always-run upload step then preserved their
original artifacts.

Only offline verification was corrected. [verify.mjs](./verify.mjs) now validates
the recorded method/unit against the frozen specification and reconstructs the
fixture digest. It does not synthesize a field in the records. The corrected
[offline audit](./validation/offline-audit-corrected.log) passes all three records
against the exact current frozen source/WASM/bundle hashes.

A separate [Python audit](./validation/independent-audit.py) independently
reconstructs all input, request and streaming-key digests and recomputes every
schedule, count, median, paired ratio and interval:
[results](./validation/independent-audit.json). A second reviewer independently
checked frozen identities, all 672 processes, statistics, A/A exclusions and late
movement: [review](./validation/independent-spot-review.json) and
[reproducible script](./validation/independent-spot-review.py).

[cache-budget.mjs](./cache-budget.mjs) confirms the logical negative-cache limits,
unchanged positive-cache capacity and zero WASM allocation from reads:
[baseline](./validation/hosted/cache-budget-before.json) and
[candidate](./validation/hosted/cache-budget-after.json). It does not measure
JavaScript heap overhead or process memory.

The final [archive workflow](../../.github/workflows/map-miss-cache.yml) has no
automatic timing or feature-branch collection trigger. It checks current
correctness and rebuilds the historical baseline/recorded candidate with their
own package manifests for evidence audits. It fetches the recorded SHA explicitly
if absent from local history, and it does not freeze unrelated future runtime
changes to this historical bundle hash. Existing records are never retimed or
replaced by CI.

## Audit or reproduce

To audit the saved records without running any timing or building WASM:

```sh
proof=proofs/map-miss-cache-20261108
node "$proof/verify.mjs" "$proof/results/pilot.json.gz"
node "$proof/verify.mjs" "$proof/results/formal.json.gz"
node "$proof/verify.mjs" "$proof/results/aa.json.gz"
python3 "$proof/validation/independent-audit.py" \
  "$proof/results/pilot.json.gz" "$proof/results/formal.json.gz" "$proof/results/aa.json.gz"
```

For an intentional independent reproduction, use the recorded candidate commit
`2671a2b19725758f749280d9b0dedfde645baf2b` and baseline
`a4265a0608ec25eec5719496225212db6b251989`, Node 24.22.1 and Bun 1.4.2. Build both
revisions with their own declared dependencies (`bun install`, `build:wasm`,
`build:browser`); these revisions have no dependency lockfile. Keep the frozen
driver and workload. Use a fresh output directory and one allowed CPU:

```sh
proof=proofs/map-miss-cache-20261108
output_dir="$(mktemp -d /tmp/zerocopy-map-misses-XXXXXX)"
benchmark_cpu="$(awk '/Cpus_allowed_list/ { split($2, ranges, /[,-]/); print ranges[1] }' /proc/self/status)"
for mode in pilot formal aa; do
  taskset -c "$benchmark_cpu" node "$proof/paired-benchmark.mjs" \
    "$proof/workloads.mjs" /path/to/pinned-baseline /path/to/recorded-candidate \
    "$(command -v bun)" "$output_dir/$mode.json" "$mode"
done
```

## Unmeasured follow-up observation

Baseline `Arena.value` appears to perform two unused `reads.slot(key)` lookups
for generic object/nested codecs (`code` 0 or 4), surrounding `find`'s own lookup.
This is a source observation for future investigation only. It was not
implemented or timed in this study and is not presented as an improvement.
