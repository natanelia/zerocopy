# Linked callback traversal: complete measured evidence

The synchronous block visitor makes the tested numeric/boolean linked scans and
edited numeric array conversion substantially faster in both runtimes. All six
process pairs improve for every one of the five nonempty main targets.
For 65,537 numbers, paired latency falls **76.9% in Node and 55.2% in Bun**.
Edited linked-list `toArray()` falls **48.8% and 53.1%**, respectively.
These claims use the confirmation study, not the initial screen.

String/JSON decoding, tail-only scans and the unchanged generator controls have
intervals that include parity. This evidence does **not** establish a universal
speedup or prove every payload/workload free of regressions. The empty case is
an optimized overhead control and is excluded from headline claims.

## What changes

`SharedLinkedList.forEach`, `SharedDoublyLinkedList.forEach`, and
`SharedDoublyLinkedList.forEachReverse` previously advanced `Arena.blocks` once
per value. [Arena.visitBlocks](../../arena.ts) now walks the same immutable tree
synchronously and calls an internal visitor once per contiguous block. Each
public wrapper decodes the block and invokes the user callback directly for
every value. The ordinary block capacity is 32; edited blocks can be shorter.
Their existing array conversions benefit through these public callback methods.

The helper uses explicit little-endian reads and a stack local to each scan.
It captures each node's next child before invoking the block visitor. The
captured DataView remains valid for already published bytes during shared-memory
growth. Callback order, indices, generic decoding, exceptions, nested scans,
old snapshots and read-only attachments remain covered by regression tests.
Empty input still accepts an unused invalid callback without throwing.

The existing `Arena.blocks` generator and tail loops are unchanged. `SharedList`
(including `toArray`, `values` and `pushMany`), the binary layout and all WASM
files are unchanged. This is independent of the earlier SharedList array and
bulk-tail improvements.

## Source identity and environment

| Item | Identity |
| --- | --- |
| Fixed before commit | `09b1a385a7c2ac9b027a4055335ae2f9449abe6e` |
| Local frozen source/test commit | `fb3accc651323a85079a27d2c5dc4b953aa67db3` |
| Candidate `arena.ts` SHA-256 | `8a7ef01428a12833569a8f8d002911347184217beb116862b05c8fa800f47a5f` |
| Candidate `shared-linked-list.ts` SHA-256 | `12e50b36e2e5e458dd3ff6fc82e3461c62f1d44f17e186a3029244de179559b1` |
| Candidate `shared-doubly-linked-list.ts` SHA-256 | `4baf5bd675059f79e0f38b11b03f6bc7777fa648741182947d1b38b3efdfec67` |
| Confirmation driver SHA-256 | `fcc2a83366fb762493ad0cc2f3e1577476cbb6e54718d916657c73a1b13a0e04` |
| Runtime versions | Node 24.22.1; Bun 1.4.2 |
| Machine | Linux 6.18.57, x64, AMD EPYC 9V74 |
| CPU arrangement | Eight-core cgroup quota; timing controller and children pinned to CPU 2; shared `perf.lock` |
| Confirmation window (UTC) | November 5, 2026, 00:39:55–00:45:53 |

The source commit above is a local measurement identity; publishing can assign a
different Git commit to the same reviewed files. Each raw record contains the
full candidate patch and SHA-256 manifests for **86 files per build**, including
all root runtime sources, every WASM input, the package/build scripts, and every
portable JavaScript module and imported chunk. Source and driver guards pass at
both the beginning and end of each runtime run. Only the three stated production
files differ; all WASM hashes match the baseline.

## Confirmation results: every case

Times are microseconds per **complete scan**, including callback value/index
writes or complete array/iterator materialization. Before/after columns are
medians of the six process medians. The ratio is the geometric mean of six
paired after/before medians; it is not the quotient of the two marginal columns.
Lower ratios are faster. Intervals are unadjusted two-sided 95% Student-t
intervals on the six paired log ratios (five degrees of freedom).

### Node

| Case | Before (µs/scan) | After (µs/scan) | Paired after/before | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| linked-empty (overhead control) | 0.032531 | 0.001750 | 0.054 | [0.049, 0.060] |
| linked-tail | 1.089 | 1.107 | 0.964 | [0.817, 1.139] |
| linked-first-block | 1.128 | 0.312 | 0.280 | [0.230, 0.341] |
| linked-large | 2402.287 | 511.560 | 0.231 | [0.174, 0.307] |
| doubly-forward | 128.921 | 30.225 | 0.236 | [0.201, 0.278] |
| doubly-reverse | 115.820 | 35.179 | 0.317 | [0.283, 0.355] |
| string-uncached | 1096.916 | 956.142 | 0.900 | [0.667, 1.215] |
| object-uncached | 3354.243 | 2888.664 | 0.868 | [0.643, 1.172] |
| edited-array | 145.600 | 74.310 | 0.512 | [0.446, 0.589] |
| unchanged-values | 97.747 | 101.291 | 0.960 | [0.718, 1.284] |

### Bun

| Case | Before (µs/scan) | After (µs/scan) | Paired after/before | 95% interval |
| --- | ---: | ---: | ---: | ---: |
| linked-empty (overhead control) | 0.022005 | 0.000271 | 0.013 | [0.011, 0.017] |
| linked-tail | 0.426 | 0.377 | 0.845 | [0.688, 1.038] |
| linked-first-block | 0.601 | 0.273 | 0.484 | [0.402, 0.583] |
| linked-large | 1108.183 | 480.052 | 0.448 | [0.376, 0.534] |
| doubly-forward | 63.966 | 26.121 | 0.445 | [0.374, 0.531] |
| doubly-reverse | 59.753 | 30.583 | 0.487 | [0.374, 0.634] |
| string-uncached | 695.046 | 708.391 | 0.975 | [0.848, 1.121] |
| object-uncached | 3756.338 | 3191.710 | 0.945 | [0.826, 1.081] |
| edited-array | 75.750 | 36.787 | 0.469 | [0.364, 0.604] |
| unchanged-values | 55.458 | 55.985 | 1.011 | [0.924, 1.106] |

The [fixed case plan](PLAN.md) gives collection, type, size and operation for
each row. `linked-large` contains 65,537 numbers; doubly forward/reverse contain
4,097 numbers/booleans. The edited 4,097-number fixture applies 16 interior
insert/remove operations, keeps its old root and materializes the result.
`string-uncached` and `object-uncached` are **cache-overflow** controls: 4,097
unique values exceed the 2,048-entry decode cache, but they are not wholly cold
or uncached after warm-up. JSON includes nested arrays/objects. `unchanged-values`
fully consumes the untouched 4,097-number SharedList generator.

No string/JSON benefit is claimed from these estimates. Some individual fallback
pairs are slower, including Node string ratio 1.341 and Node JSON ratio 1.436.
The unchanged Node values control still varies widely (0.672–1.417 per pair);
its interval includes parity. The much larger and consistent main-target gains
are the reason to accept the change, while these controls limit broader claims.

## Measurement and verification method

The [confirmation plan](FORMAL-PLAN.md) was fixed before the confirmation run;
[benchmark.mjs](benchmark.mjs) implements it. Source was committed and frozen
before either engine's run, with no subsequent runtime changes or case tuning.

There are **120 independent process pairs, 240 measured subject processes and
2,160 measured batches** across both engines. Each case has six balanced AB/BA
pairs and nine batches per subject. A subject loads one build and one workload
at a neutral import path. The controller replaces the complete bundle directory
between subjects. No process imports both implementations. Each runtime uses a
separate lock acquisition. All observations are retained.

Fixture creation happens outside timing. Disposable coarse calibration selects
a common before/after repetition count, targeting 12 ms per batch, capped at
524,288 retained values (131,072 for JSON). A second disposable calibration warms
at the exact common count. These 80 calibration processes are separate from the
240 measured subjects. Every nonempty subject then performs at least **500 ms
of timed warm-up and eight batches** at that count. Warm-up counts can differ
between the two sides; measured repetitions are identical within every pair.

Caller output buffers and callbacks are prepared once per repetition count and
reused between batches. Before timing, each callback cursor and generator count
is reset. After timing, **every operation's actual count, complete values and
complete callback indices** are checked against native expected arrays. Stale
slots therefore cannot hide missing writes. JSON outputs are also checked for
recursive freezing. Each operation is a full traversal; no count-only result
stands in for content correctness. Edited fixtures retain and check the old
snapshot. Every batch asserts zero shared-arena allocation.

Library `toArray()` allocations stay inside timing. String/JSON decoding keeps
its ordinary cache behavior. Normal library allocation and any garbage
collection during the timed interval remain part of the result; no GC is forced.
The benchmark does not measure JavaScript heap/RSS allocation savings. The main
claim concerns latency, not allocation-free traversal.

| Actual timing property | Node | Bun |
| --- | ---: | ---: |
| Nonempty warm-up scan time | 500.020–520.052 ms | 500.126–516.634 ms |
| Nonempty warm-up batches | 18–143 | 22–163 |
| Nonempty measured batch range | 2.979–29.190 ms | 2.665–30.991 ms |
| Empty candidate warm-up when cap hit | 231.8–299.6 ms | 87.4–167.3 ms |
| Empty candidate subjects hitting cap | 6 of 6 | 6 of 6 |
| Shortest empty measured batch | 0.852 ms | 0.142 ms |

The empty case has a predeclared 256-batch warm-up cap and can compile toward a
no-op. Its sub-nanosecond Bun amortized time is shown with enough precision to
avoid an apparent zero, but it is not a headline speedup claim. Output caps also
keep some nonempty batches below the 12 ms calibration target. The raw records
contain every actual duration rather than treating that target as a guarantee.

## Initial screen and why the measurement setup changed

The [screen driver](screen.mjs) and both original raw records remain intact.
The screen used two balanced pairs per runtime and seven batches, with the
same ten cases and exactly the same production source. All screen content and
shared-allocation checks passed. Its complete ratio table follows; observed
ranges are the two pairs, not confidence intervals.

| Case | Node paired ratio (observed range) | Bun paired ratio (observed range) |
| --- | ---: | ---: |
| linked-empty | 0.056 (0.053–0.060) | 0.010 (0.010–0.010) |
| linked-tail | 1.017 (0.988–1.046) | 0.563 (0.526–0.602) |
| linked-first-block | 0.298 (0.253–0.350) | 0.573 (0.565–0.581) |
| linked-large | 0.286 (0.278–0.294) | 0.406 (0.367–0.450) |
| doubly-forward | 0.247 (0.240–0.255) | 0.336 (0.271–0.418) |
| doubly-reverse | 0.304 (0.302–0.306) | 0.373 (0.311–0.447) |
| string-uncached | 0.566 (0.559–0.574) | 1.028 (0.918–1.150) |
| object-uncached | 1.120 (0.984–1.275) | 0.741 (0.639–0.858) |
| edited-array | 0.389 (0.357–0.424) | 0.478 (0.463–0.493) |
| unchanged-values | 0.604 (0.550–0.664) | 1.043 (0.908–1.197) |

The original screen allocated fresh caller output buffers and callback closures
outside every timed batch. Its Node unchanged-values row appeared 39.6% faster
despite an unchanged algorithm. The [bundled-module comparison](results/unchanged-values-module.diff)
shows only the imported Arena chunk filename changed in that control module.
Large alternating timing spikes suggested sensitivity to GC/JIT state and the
untimed preparation allocations; this is an inference, not an instrumented
attribution to one cause.

The confirmation protocol reused caller buffers/callbacks, added explicit counts
to prevent stale-value false positives, lengthened warm-up and expanded to six
pairs. It kept every workload and preserved all screen results, including the
adverse JSON/string observations. The unchanged-control confirmation estimates
are now compatible with parity, but Node's interval is still broad. Neither the
screen's control movement nor its empty-input ratio supports a production claim.

## Correctness and compatibility evidence

The standalone portable build and **41 tests in three focused files** passed:
the [12 new regressions](../../block-callback-traversal.test.ts), existing block
traversal tests and primitive sequence tests. See the
[focused validation log](results/initial-validation.log).
Coverage includes empty/tail/tree boundaries, NaN/signed-zero/infinities,
interior edits and retained roots, callback order/indices, exact thrown values,
recursive scans, a simultaneously suspended generator, memory growth,
shared/copy read-only attachments, and deeply frozen/nested values.

The unchanged [real-worker proof](../block-traversal-worker-check.mjs) passed all
six linked/doubly forward/reverse and shared/copy combinations against the
standalone build. Workers pause inside a public callback while the writer grows
two arenas and appends, then verify full values/indices, forks, nested snapshots,
compaction and rejected writes. See [worker results](results/workers-01.log).
A dedicated step now runs that proof and the saved-evidence verifier in normal CI.

A **separate combined correctness/package validation** also passed at local
commit `78cf62ff48e39d4c9e8f04e6ef4dafd555f80d82`, based on main
`77599337867dbf785a5f0311d34637d0b36678fc`. It combines prior PRs #50/#51 and
four round-three changes, including this exact block visitor and wrappers,
SharedCollection values, checkpoint base64, and **ordered-map candidate V1**.
That map candidate's subsequent revisions are outside this recorded scope.
The combined result is not a standalone list test or a combined performance run.

All 19 steps passed: WASM/browser/declaration builds; all recorded public type
checks; the default **58-file, 1,126-test suite (40.62 s)**; worker/compatibility
proofs; preserved historical documentation data; and the actual installed npm
package consumer on Node/Bun/TypeScript (143 files, 215,986 bytes).
The [combined manifest](results/integration-manifest.json) and
[complete combined log](results/integration-validation.txt) are copied unchanged.
Both wrapper hashes match the measured files; the visitor text also matches
exactly within the combined Arena, which includes other independent changes.
Future combined revisions need their own validation evidence.

The final standalone [documentation check](results/docs-01.log) preserved all
72 historical numerical rows, changed no historical evidence files, and passed
links/structure across 60 Markdown files.

## Raw evidence, integrity and reproduction

The four raw JSON files are losslessly compressed: **12,169,642 original bytes
become 838,148 gzip bytes**. The [archive manifest](archive-manifest.json) records
original and compressed byte counts/SHA-256, plus exact decompression checks.
No samples, warm-up batches, calibrations or failed-looking observations were
removed. The historical proof directories were not edited.

- Confirmation: [Node](results/node-formal-01.json.gz), [Bun](results/bun-formal-01.json.gz).
- Original screen: [Node](results/node-screen-01.json.gz), [Bun](results/bun-screen-01.json.gz).
- Console records: [Node confirmation](results/node-formal-01.log), [Bun confirmation](results/bun-formal-01.log), [Node screen](results/node-screen-01.log), [Bun screen](results/bun-screen-01.log).
- Independent arithmetic/integrity checker: [verify.mjs](verify.mjs), [successful output](results/verification-01.log).

The verifier checks all archive hashes and decompression, source inventories,
allowed changes, runtime versions, pairing, common repetitions, recorded content
counts, warm-up conditions, all process medians and all summary ratios/intervals.
It can optionally compare all 86 recorded source/bundle files in each existing
build. The output shows 120 formal pairs, 40 screen pairs and 2,720 measured
batches across the two protocols. Independent peer calculations also reproduced
all 20 formal summaries and all archive hashes.

```sh
node proofs/block-callback-20261105/verify.mjs
node proofs/block-callback-20261105/verify.mjs /path/to/before /path/to/after
```

To remeasure, create a clean worktree at the fixed baseline and a candidate
checkout matching the source hashes above. Use Node 24.22.1/Bun 1.4.2 and the
same dependencies; build WASM and portable JavaScript in both worktrees with
`bun run build:wasm` and `bun run build:browser`. Keep dependency/cache directories
separate. Then run each engine once, with a new output filename and the same
machine free of competing benchmark/build/test work:

```sh
flock /tmp/zerocopy-perf.lock taskset -c 2 node proofs/block-callback-20261105/benchmark.mjs /path/to/before /path/to/after /path/to/bun /tmp/block-node.json node
flock /tmp/zerocopy-perf.lock taskset -c 2 node proofs/block-callback-20261105/benchmark.mjs /path/to/before /path/to/after /path/to/bun /tmp/block-bun.json bun
```

These measurements describe hot repeated scans on this x64 machine. They do not
measure first-import/attachment latency, fully cold decoding, a browser engine,
other CPUs, application callbacks with substantial extra work, or every edit
pattern. The fallback and unchanged-control intervals are deliberately retained
as limits on the result.

## Every confirmation pair

| Runtime / case | Six paired after/before ratios, in round order |
| --- | --- |
| node / linked-empty | 0.046, 0.054, 0.058, 0.054, 0.054, 0.060 |
| node / linked-tail | 0.996, 1.107, 0.964, 1.130, 0.729, 0.919 |
| node / linked-first-block | 0.329, 0.195, 0.269, 0.300, 0.307, 0.303 |
| node / linked-large | 0.260, 0.165, 0.239, 0.226, 0.355, 0.185 |
| node / doubly-forward | 0.242, 0.223, 0.187, 0.230, 0.298, 0.252 |
| node / doubly-reverse | 0.308, 0.289, 0.305, 0.290, 0.385, 0.334 |
| node / string-uncached | 0.603, 1.341, 0.943, 1.121, 0.759, 0.820 |
| node / object-uncached | 0.953, 0.713, 0.874, 0.632, 0.792, 1.436 |
| node / edited-array | 0.439, 0.607, 0.546, 0.464, 0.574, 0.468 |
| node / unchanged-values | 0.724, 1.066, 0.984, 1.081, 0.672, 1.417 |
| bun / linked-empty | 0.021, 0.013, 0.013, 0.012, 0.011, 0.013 |
| bun / linked-tail | 0.863, 0.940, 0.575, 0.969, 0.850, 0.948 |
| bun / linked-first-block | 0.498, 0.385, 0.414, 0.580, 0.466, 0.599 |
| bun / linked-large | 0.407, 0.532, 0.404, 0.555, 0.363, 0.458 |
| bun / doubly-forward | 0.404, 0.533, 0.421, 0.567, 0.387, 0.391 |
| bun / doubly-reverse | 0.412, 0.610, 0.405, 0.639, 0.355, 0.578 |
| bun / string-uncached | 0.917, 1.043, 1.075, 1.019, 0.764, 1.073 |
| bun / object-uncached | 0.788, 0.920, 1.017, 0.896, 0.931, 1.155 |
| bun / edited-array | 0.378, 0.517, 0.534, 0.663, 0.446, 0.345 |
| bun / unchanged-values | 1.004, 1.136, 0.906, 0.927, 1.066, 1.045 |
