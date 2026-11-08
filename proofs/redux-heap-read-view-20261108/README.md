# Reusing memory views while encoding priority queues

The final V3 candidate reduces time for the measured complete public priority-queue encoding and stringification operations: **37.0–66.2% on Node and 19.3–43.1% on Bun**, using the paired estimates below. All eight primary workload/runtime intervals are below 1; 47 of 48 primary pairs improved. These calls use a pre-created `createZerocopyCodec()` instance. Codec factory creation is outside timing.

**The change has a measured cost outside heap encoding.** The native identity needed to preserve custom Arena behavior adds one private reference to every Arena. In the public fresh-Arena control (`resetSharedList()` plus `new SharedList('number')`), Node takes **35.995 → 43.127 µs**, a **26.1% paired slowdown**, with all six pairs slower and a 95% ratio interval of **1.0121–1.5715**. The Bun estimate is 11.4% slower with an interval spanning 1. This report accepts the encoding improvement together with that constructor tradeoff. The A/A diagnostic does not cancel, adjust, or explain away the Node slowdown.

This is a comparison with baseline `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`, measured on November 8, 2026. It does not establish a speedup for every workload or an absence of regressions. Earlier V1/V2 measurements remain below as separate historical evidence; only V3 supports the final claims.

## What changes

The original [`readReduxHeap`](../../redux-heap-codec.ts) obtains `arena.dv` four times per node to read children, value and priority. Each access refreshes the memory view. Published heap nodes are immutable, and growth of their shared memory does not detach a view that already covers those nodes.

For native numeric or boolean heaps containing at least 32 nodes, V3 captures one DataView for the traversal. It retains the original breadth-first row order, child indexes, primitive decoding and value/priority encoding order. It still invokes `arena.decode` for each value. Small heaps, generic values, custom readers and unsupported owners use the unchanged dynamic loop.

The guard first requires numeric root/size descriptors, avoiding extra user-defined coercions. Its first Arena-specific check is the native-WASM private brand in [`arena.ts`](../../arena.ts), before any prototype or own-property reflection. A Proxy therefore falls back without invoking new reflection traps. Subsequent checks require the exact built-in Arena prototype and original decode/view/refresh methods with no own overrides. The native identity also rejects replacement WASM exports. The same Arena helper is used by the separately measured primitive-compaction improvement; this record measures the helper with heap encoding alone.

There are no dependency, WASM, binary-layout or wire-format changes. The global extra Arena field is why the final experiment includes a fresh-Arena control.

## Final V3 results

All times are microseconds per complete public call. Before/after columns are medians of process medians. The ratio is the geometric mean of matched after/before ratios, so it need not equal the ratio of those displayed time columns. A ratio below 1 means less time. Intervals are unadjusted 95% Student-t intervals on paired log ratios; they do not include a correction for testing multiple workloads.

| Runtime | Workload | Before, µs | After, µs | Paired after / before | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | `min-4096-number-encode` | 813.920 | 229.504 | 0.3375 | 0.2277–0.5003 | 6/6 |
| Node | `max-4096-boolean-encode` | 697.401 | 290.634 | 0.3868 | 0.3053–0.4901 | 6/6 |
| Node | `min-32768-number-encode` | 7850.397 | 3505.635 | 0.4349 | 0.3566–0.5305 | 6/6 |
| Node | `min-4096-number-stringify` | 1109.900 | 676.186 | 0.6297 | 0.5785–0.6855 | 6/6 |
| Node | `min-32-number-boundary` | 5.426 | 1.923 | 0.3762 | 0.2967–0.4769 | 6/6 |
| Node | `min-8-number-control` | 1.669 | 1.836 | 1.1073 | 0.9043–1.3558 | 1/6 |
| Node | `min-256-object-control` | 592.459 | 645.479 | 1.0253 | 0.8396–1.2519 | 3/6 |
| Node | `reset-empty-list-control` | 35.995 | 43.127 | 1.2612 | 1.0121–1.5715 | 0/6 |
| Bun | `min-4096-number-encode` | 387.700 | 288.416 | 0.7660 | 0.6906–0.8496 | 6/6 |
| Bun | `max-4096-boolean-encode` | 377.573 | 304.568 | 0.8072 | 0.6709–0.9713 | 5/6 |
| Bun | `min-32768-number-encode` | 2655.214 | 1529.690 | 0.5688 | 0.4361–0.7418 | 6/6 |
| Bun | `min-4096-number-stringify` | 802.518 | 529.637 | 0.7702 | 0.5963–0.9949 | 6/6 |
| Bun | `min-32-number-boundary` | 4.962 | 2.806 | 0.6117 | 0.4489–0.8335 | 6/6 |
| Bun | `min-8-number-control` | 1.323 | 1.247 | 0.9756 | 0.9372–1.0156 | 4/6 |
| Bun | `min-256-object-control` | 603.793 | 653.120 | 1.0355 | 0.7441–1.4410 | 3/6 |
| Bun | `reset-empty-list-control` | 1090.722 | 1216.347 | 1.1143 | 0.9773–1.2703 | 2/6 |

The four primary workloads are the 4,096-node numeric min-heap, 4,096-node boolean max-heap, 32,768-node numeric min-heap, and 4,096-node numeric stringification. All include ties, special numeric values and complete output retention. The 32-node case measures the activation boundary, which improves in all six pairs on each runtime.

The eight-node numeric fallback has a Node estimate of 10.7% more time (five of six pairs slower), with a wide interval spanning 1. JSON fallback estimates are 2.5% slower on Node and 3.6% slower on Bun, also with wide intervals spanning 1. These results do not establish equivalence or the absence of a fallback regression. The fresh-Arena control has the separately disclosed Node slowdown.

### Final A/A diagnostic

These are four pairs of the unchanged baseline against itself, collected after V3 confirmation. All six intervals span 1. They show substantial process variability; they are not used to adjust the A/B results or dismiss the constructor cost.

| Runtime | Workload | Before, µs | After, µs | Paired after / before | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | `min-4096-number-encode` | 752.939 | 760.106 | 1.0077 | 0.6176–1.6443 | 2/4 |
| Node | `min-256-object-control` | 724.630 | 591.250 | 0.8451 | 0.5560–1.2845 | 2/4 |
| Node | `reset-empty-list-control` | 45.685 | 36.413 | 0.8243 | 0.5775–1.1767 | 3/4 |
| Bun | `min-4096-number-encode` | 398.068 | 371.419 | 0.8986 | 0.6425–1.2569 | 3/4 |
| Bun | `min-256-object-control` | 540.684 | 523.156 | 0.9754 | 0.8043–1.1829 | 3/4 |
| Bun | `reset-empty-list-control` | 1124.910 | 1167.184 | 1.0358 | 0.9388–1.1429 | 1/4 |

## Measurement method

The [prospective plan](PLAN.md) declares the fixtures, selection, warmup, pair counts, controls and later correctness-driven revisions. The [driver](paired-benchmark.mjs) is copied from the existing checkpoint-validation paired study with the common lock path changed. The original [workloads](workloads.mjs) are preserved; [V3 workloads](workloads-v3.mjs) retain the seven original fixtures and add the fixed 32-repetition constructor control.

- Host: Linux x64, kernel 6.18.57, AMD EPYC 9V74 80-Core Processor; every subject pinned to CPU 2.
- Runtimes: Node 24.22.1 and Bun 1.4.2. Both variants use portable bundles built with the same existing dependencies and byte-identical WASM. The driver verifies the baseline source matches its declared commit and only the declared candidate production files differ.
- Each variant/runtime/workload runs in a fresh process, loading one build at the same neutral import path. AB/BA order alternates by pair; runtime and case orders reverse by pair.
- Confirmation has six pairs per runtime/workload, at least 500 ms of actual timed warmup, at least eight warmup batches, and nine measured batches per process. The pilot has two pairs and 150 ms minimum warmup. A/A has four pairs and 500 ms minimum warmup.
- Timed work is the complete public `codec.encode(source)` or `codec.stringify(source)` call and assignment into a preallocated retention array. These exercise the public shared-state encoder and serializer. Codec creation, source construction, imports, oracle preparation, retention-array allocation and output verification are outside timing. The constructor control instead times the complete reset plus public empty-list construction.
- Every output in every warmup and measured batch is retained and fully verified after the timer stops. An independent plain-JavaScript leftist heap and wire encoder determine all expected values, priority tags and child indexes. The source descriptor, allocated byte count and entire used source prefix must remain unchanged. The JSON fixture represents normal warmed decode-cache reads.
- Fixed repetitions per batch are 32 for each 4,096-node encoding, 4 for the 32,768-node encoding, 16 for stringification and JSON fallback, 1,024 for the 32-node boundary, 4,096 for the eight-node control, and 32 for construction. Constructor verification checks the empty public descriptor, used bytes, writable returned owner and retained empty snapshot.
- A common exclusive `/tmp/zerocopy-perf-20261108.lock` covers every study. Other builds, tests and benchmark work were kept out of the timing periods. CPU frequency and activity outside this workspace are not controlled.

Final confirmation ran from `2026-11-08T10:12:57.429Z` to `2026-11-08T10:17:32.751Z`. Per-process medians, every warmup/sample batch, retained-output counts, runtime versions, fixture identities and source/build hashes are stored in the recordings. Fixed short batches are retained rather than filtered: 119 of 1,728 final confirmation batches and 65 of 432 final A/A batches were below 2 ms. There is no enforced 2 ms minimum and no claim that short constructor batches are noise-free. All unfavorable cases remain in the tables.

This experiment measures warmed public operations on this host, not overall application latency, browser performance, ARM performance, peak memory, or worker-transfer time. The recorded A/A variability and broad control intervals limit small-effect conclusions. CI verifies correctness and saved statistics; it does not use a timing threshold.

## Source identity and complete evidence

The baseline is `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`. Candidate measurements were taken from uncommitted production edits while Git HEAD still identified that baseline. Consequently, the candidate Git HEAD alone is not its implementation identity. Every record embeds the full before/after changed source texts and their hashes, plus all runtime-source, build-script, configuration, portable-bundle and WASM hashes. The final committed production files match the V3 embedded source.

| Final artifact | SHA-256 |
| --- | --- |
| `arena.ts` | `7d250dc3452ad047b6b2e38cd4dd0983ddc6808d9402077512710eacd331b55d` |
| `redux-heap-codec.ts` | `56684a4f521b876ccfda10c4f042196ef0f40a7674b4c6c2cbe2e3209b5baa9c` |
| `workloads-v3.mjs` | `79ce98762ced1e2b8eb29b2657b19bd2a15f59f74745eaa507c166b18df805a0` |
| `paired-benchmark.mjs` | `f77dd2f9476cd00a2db5b2e5f67daa350df586c08150e7fb9218226e662e3cb6` |

The five recordings below preserve **488 completed processes and 4,392 measured batches**. Gzip compression preserves each original JSON byte-for-byte; the [manifest](manifest.json) records both compressed and uncompressed digests and byte counts. The [independent Python verifier](verify.py) checks identities, embedded source text, exact experiment order, warmup minima, every batch/median, fixture and output checks, pair counts and the reported estimates. [Its saved result](validation/evidence-verification.txt) validates all five records.

| Record | Candidate | Processes | Measured batches | Batches below 2 ms | Console log |
| --- | --- | ---: | ---: | ---: | --- |
| [pilot.json.gz](pilot.json.gz) | V1 | 48 | 432 | 11 | [pilot.log](pilot.log) |
| [formal-v2.json.gz](formal-v2.json.gz) | V2 | 168 | 1,512 | 25 | [formal-v2.log](formal-v2.log) |
| [aa-v2.json.gz](aa-v2.json.gz) | Baseline / baseline | 32 | 288 | 0 | [aa-v2.log](aa-v2.log) |
| [formal-v3.json.gz](formal-v3.json.gz) | V3 | 192 | 1,728 | 119 | [formal-v3.log](formal-v3.log) |
| [aa-v3.json.gz](aa-v3.json.gz) | Baseline / baseline | 48 | 432 | 65 | [aa-v3.log](aa-v3.log) |

## Correctness and compatibility

The [17 new regressions](../../redux-heap-read-view.test.ts) also pass on the unchanged baseline. They cover empty and small heaps; the 31/32/33-node boundary; larger min/max heaps; tied priorities; booleans and special numbers; complete independent wire topology; retained forks; unchanged old source bytes; external memory growth; exact invalid-size and codec-budget errors; JSON/nested values; and read-only shared/copy attachments.

Custom-reader cases exercise own and prototype overrides, exact getter invocation counts and error identities, late decoder changes, custom Arena subclasses, coercible root/size descriptors, Proxy interception and throwing reflection traps. They verify the original dynamic fallback behavior, including changes installed during decoding.

The final [preflight log](validation/final-preflight-v3.txt) records all 17 tests passing on baseline, and 26 tests across the new suite and existing Redux regression suite passing on each of Node and Bun. Main and Redux typechecks pass after declaration generation. It also records:

- [Actual Node workers](node-workers.mjs) with shared and copy transports, numeric/boolean/JSON/nested heaps, retained old/new snapshots after owner growth and edits, unchanged source bytes and rejected allocating writes on attachments.
- Six [late-import checks](late-import.mjs): Node/Bun portable bundles and Bun source, each testing decoder and view overrides installed before importing the optional Redux integration.
- [Chromium 153.0.8010.0](browser-check.mjs), with cross-origin isolation and actual shared/copy workers, full independent numeric/boolean wire rows, ties and special values, retained old/new snapshots after owner growth, and rejected writes. This is correctness evidence without browser timing.
- All eight final workloads checked once against baseline and candidate in both runtimes; see the [workload smoke log](validation/workload-smoke-v3.txt) and [smoke script](smoke-v3.mjs).

The [verification workflow](../../.github/workflows/redux-heap-read-view.yml) repeats focused tests, builds/types, worker/browser and late-import checks, workload oracles and all saved evidence verification. It does not collect performance measurements. Broader repository and installed-package checks are recorded separately by the final integration review.

## Combined correctness validation

Both final changes were also applied together with the identical shared Arena helper. [The full record](combined-validation/README.md) reports **59 files / 1,178 tests passing** with `bun run test --isolate --testTimeout 15000`, plus all 31 new regressions on Node, portable/declaration builds, five typecheck groups, actual Node/Chromium workers, late imports, installed-package Node/Bun and TypeScript consumers, documentation preservation, and verification of all eight saved timing records.

The initial default suite failed: two existing allocation tests exceeded five seconds, and an existing fake-Arena fixture leaked between files under `isolate:false`. The fixture failure reproduces on the untouched baseline; the timeout cases were not separately reproduced there. Both failed and successful attempts are preserved. Recovery changed only the test invocation; production source, tests, and test configuration stayed unchanged. This validates compatibility of the changes together and makes no combined speed claim.

## Preserved candidate history

The sequence below records correctness findings, not performance tuning. No earlier measurement was overwritten, pooled into the final estimate, or rerun to replace an unfavorable row. The source and fixture for each version remain identifiable.

### V1 pilot

The initial candidate cached a view without requiring primitive root/size descriptors. Review found that a manually constructed heap can use a coercion callback to replace the Arena view accessor during reading. V1 could bypass the replacement while baseline honors it. The [counterexample](validation/coercion-counterexample.txt) and [expected failing V1 regression](validation/v1-coercion-regression.txt.gz) are preserved, together with the [exact V1 source](candidate-v1/redux-heap-codec.ts.txt). V1 is not the published implementation.

The pilot measured the six declared pilot cases; the 32,768-node fixture was reserved for confirmation. Two pairs do not receive confidence intervals in this driver.

| Runtime | Workload | Before, µs | After, µs | Paired after / before | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | `min-4096-number-encode` | 1537.331 | 584.728 | 0.4057 | Not estimated | 2/2 |
| Node | `max-4096-boolean-encode` | 1023.642 | 254.174 | 0.2653 | Not estimated | 2/2 |
| Node | `min-4096-number-stringify` | 1193.306 | 752.847 | 0.6310 | Not estimated | 2/2 |
| Node | `min-32-number-boundary` | 4.922 | 3.371 | 0.6784 | Not estimated | 2/2 |
| Node | `min-8-number-control` | 2.326 | 1.784 | 0.7615 | Not estimated | 2/2 |
| Node | `min-256-object-control` | 1011.119 | 963.295 | 0.9392 | Not estimated | 1/2 |
| Bun | `min-4096-number-encode` | 411.274 | 304.319 | 0.7399 | Not estimated | 2/2 |
| Bun | `max-4096-boolean-encode` | 406.949 | 262.622 | 0.6456 | Not estimated | 2/2 |
| Bun | `min-4096-number-stringify` | 786.987 | 630.985 | 0.8162 | Not estimated | 2/2 |
| Bun | `min-32-number-boundary` | 3.410 | 2.785 | 0.8150 | Not estimated | 2/2 |
| Bun | `min-8-number-control` | 1.382 | 1.184 | 0.8567 | Not estimated | 2/2 |
| Bun | `min-256-object-control` | 569.343 | 540.000 | 0.9483 | Not estimated | 2/2 |

### V2 confirmation and A/A

V2 added the primitive `typeof` guards before comparing size, keeping coercible descriptors on the original path without an extra coercion. The workload and driver remained unchanged. Its [source](candidate-v2/redux-heap-codec.ts.txt), [preflight](validation/final-preflight.txt.gz), complete confirmation and A/A records are preserved.

Later review found that a transparent Proxy can intercept `dv` or `decode` while presenting native property descriptors, or throw from a newly introduced `getPrototypeOf` trap. V2 read the Proxy view once for 65 nodes where baseline reads it 260 times. The [expected failing V2 regression](validation/v2-proxy-regression.txt.gz) preserves that mismatch. V3 therefore added the native private-brand check before reflection and the global constructor control, then ran one new complete confirmation and A/A study. The original seven workload fixtures did not change, and V3 had no new pilot.

These V2 tables include its inconclusive Bun stringification and slower Bun JSON fallback estimate. They do not describe the final implementation.

| Runtime | Workload | Before, µs | After, µs | Paired after / before | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | `min-4096-number-encode` | 2023.396 | 743.186 | 0.3878 | 0.2727–0.5514 | 6/6 |
| Node | `max-4096-boolean-encode` | 1333.595 | 545.884 | 0.3852 | 0.3077–0.4822 | 6/6 |
| Node | `min-32768-number-encode` | 15503.265 | 6287.064 | 0.4788 | 0.3575–0.6413 | 6/6 |
| Node | `min-4096-number-stringify` | 1993.787 | 1172.092 | 0.5720 | 0.4709–0.6950 | 6/6 |
| Node | `min-32-number-boundary` | 6.161 | 3.100 | 0.4603 | 0.3999–0.5299 | 6/6 |
| Node | `min-8-number-control` | 2.386 | 2.943 | 1.0458 | 0.8138–1.3440 | 2/6 |
| Node | `min-256-object-control` | 1147.282 | 963.674 | 0.9500 | 0.8226–1.0971 | 3/6 |
| Bun | `min-4096-number-encode` | 564.503 | 446.994 | 0.7270 | 0.5298–0.9977 | 5/6 |
| Bun | `max-4096-boolean-encode` | 628.922 | 452.469 | 0.6530 | 0.4620–0.9229 | 6/6 |
| Bun | `min-32768-number-encode` | 2763.507 | 1853.572 | 0.6731 | 0.5390–0.8406 | 6/6 |
| Bun | `min-4096-number-stringify` | 877.125 | 844.693 | 1.0176 | 0.9200–1.1256 | 2/6 |
| Bun | `min-32-number-boundary` | 7.816 | 6.452 | 0.8393 | 0.7090–0.9935 | 5/6 |
| Bun | `min-8-number-control` | 2.810 | 3.079 | 1.0214 | 0.8107–1.2869 | 2/6 |
| Bun | `min-256-object-control` | 858.440 | 1387.385 | 1.2478 | 0.8987–1.7325 | 2/6 |

V2 A/A, unchanged baseline on both sides:

| Runtime | Workload | Before, µs | After, µs | Paired after / before | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | `min-4096-number-encode` | 808.355 | 657.559 | 0.8797 | 0.7204–1.0741 | 3/4 |
| Node | `min-256-object-control` | 603.849 | 551.920 | 0.8989 | 0.6870–1.1762 | 3/4 |
| Bun | `min-4096-number-encode` | 398.562 | 385.216 | 1.0134 | 0.8090–1.2694 | 3/4 |
| Bun | `min-256-object-control` | 493.744 | 488.130 | 1.0122 | 0.6774–1.5126 | 3/4 |

An early [typecheck failure](validation/preflight-missing-declarations.txt) is also retained: portable builds had not generated `dist/types` yet. Building declarations first resolved it; the final preflight above passed. Expected V1/V2 compatibility failures are intentional historical evidence rather than current test failures.

## Reproduce or verify

To recompute all saved statistics without running timings, from the repository root:

```sh
python3 proofs/redux-heap-read-view-20261108/verify.py \
  proofs/redux-heap-read-view-20261108/pilot.json.gz \
  proofs/redux-heap-read-view-20261108/formal-v2.json.gz \
  proofs/redux-heap-read-view-20261108/aa-v2.json.gz \
  proofs/redux-heap-read-view-20261108/formal-v3.json.gz \
  proofs/redux-heap-read-view-20261108/aa-v3.json.gz
```

For a new measurement, prepare separate baseline and candidate checkouts, with the baseline exactly at the commit above and candidate containing only the two declared production changes. Use Bun 1.4.2, the existing dependencies, and identical WASM build outputs. Run the following in each checkout before starting the study:

```sh
bun install
flock /tmp/zerocopy-perf-20261108.lock bun run build:wasm
flock /tmp/zerocopy-perf-20261108.lock bun run build:browser
flock /tmp/zerocopy-perf-20261108.lock bun run build:types
```

Then, from the candidate root, set absolute paths and select a CPU allowed by `/proc/self/status`. The original run used CPU 2. Output paths must be new; the driver refuses to overwrite an existing record. The driver takes the lock itself, so do not wrap these commands in another `flock`:

```sh
ZC_BASE=/absolute/path/to/baseline
ZC_CANDIDATE=/absolute/path/to/candidate
ZC_BUN=/absolute/path/to/bun
ZC_CPU=2
ZC_PROOF=proofs/redux-heap-read-view-20261108

taskset -c "$ZC_CPU" node "$ZC_PROOF/paired-benchmark.mjs" \
  "$ZC_PROOF/workloads-v3.mjs" "$ZC_BASE" "$ZC_CANDIDATE" "$ZC_BUN" \
  /absolute/new-output/formal.json formal

taskset -c "$ZC_CPU" node "$ZC_PROOF/paired-benchmark.mjs" \
  "$ZC_PROOF/workloads-v3.mjs" "$ZC_BASE" "$ZC_CANDIDATE" "$ZC_BUN" \
  /absolute/new-output/aa.json aa
```

A/A deliberately uses baseline for both labels even when a candidate path is supplied. Preserve all newly generated results separately; do not replace these records. The workflow supplies reproducible correctness commands and the [contribution guide](../../CONTRIBUTING.md) covers the full repository build and package checks.
