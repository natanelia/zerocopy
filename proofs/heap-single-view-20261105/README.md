# Heap entries: reuse one existing view for the traversal

**Not accepted for a performance PR.** The boolean and cached-JSON traversals
improved in all six confirmation pairs on both engines, but the large numeric
Bun workload had an adverse estimate: **1.154× the baseline time**, with four
of six pairs slower and a 95% interval of **0.951–1.399**. That interval does
not establish neutrality; it leaves a material cost unresolved. The broad
change is retained here as an experiment, with every positive and negative
result. It is not recommended for merging on this evidence.

## What changes

[`SharedPriorityQueue.entries()`](../../shared-priority-queue.ts) gets the arena's
existing `DataView` once when a nonempty generator starts. Previously it asked
for that view at every node, repeating the shared-memory buffer refresh check.
All reachable nodes belong to the immutable snapshot and already fit the first
view. Shared-memory growth preserves the old bytes and does not detach it.

The iterator keeps its own view and traversal stack. It still reads the value
through the same generic decoder before reading child pointers, visits nodes
in the same heap preorder, and yields newly allocated detached tuples at the
same points. An empty or unstarted generator requests no view. The API, stored
layout and WASM are unchanged. This change removes repeated getter/refresh
checks; the previous implementation did not allocate a new `DataView` at every
node. Cold generic decoding can still request its own refreshed views.

The earlier [heap-entry view report](../heap-entry-view-results.md) describes
the already merged reduction from four getter requests to one per node. This
new study measures the separate reduction from one request per node to one per
complete nonempty traversal. Historical reports and recordings are untouched.

## Complete confirmation results

Times are microseconds per complete operation, shown as the median of the six
process medians for each side. The ratio is the geometric mean of the six
paired after/before ratios: below one is faster. Its interval is a per-case
95% Student-t interval on six log ratios, not a guarantee for other workloads
or machines. A full traversal consumes the entire named heap; `singleton-close`
performs one `next()` plus `return()`, and `unchanged-peek` performs 256
`peek()` / `peekPriority()` pairs. Empty is an overhead control.

| Engine | Case | Before µs | After µs | Paired after/before | 95% interval |
| --- | --- | ---: | ---: | ---: | --- |
| Node | empty-full | 0.042 | 0.033 | 0.860 | 0.745–0.994 |
| Node | singleton-close | 0.087 | 0.087 | 1.007 | 0.776–1.308 |
| Node | number-small | 2.242 | 1.093 | 0.500 | 0.394–0.634 |
| Node | number-large | 9556.112 | 5801.550 | 0.621 | 0.389–0.993 |
| Node | max-ties | 258.035 | 130.917 | 0.505 | 0.479–0.533 |
| Node | boolean-full | 231.802 | 152.437 | 0.595 | 0.433–0.818 |
| Node | string-overflow | 1418.109 | 1298.500 | 0.880 | 0.817–0.947 |
| Node | object-warm | 80.783 | 48.446 | 0.610 | 0.531–0.701 |
| Node | materialize | 320.335 | 196.916 | 0.610 | 0.492–0.757 |
| Node | unchanged-peek | 17.553 | 18.138 | 1.016 | 0.910–1.133 |
| Bun | empty-full | 0.011 | 0.011 | 0.937 | 0.778–1.128 |
| Bun | singleton-close | 0.051 | 0.050 | 0.965 | 0.739–1.261 |
| Bun | number-small | 0.970 | 1.045 | 0.956 | 0.744–1.229 |
| Bun | number-large | 10560.355 | 12867.100 | 1.154 | 0.951–1.399 |
| Bun | max-ties | 145.773 | 104.591 | 0.765 | 0.557–1.050 |
| Bun | boolean-full | 139.283 | 97.883 | 0.775 | 0.649–0.926 |
| Bun | string-overflow | 904.374 | 967.847 | 1.040 | 0.853–1.269 |
| Bun | object-warm | 47.251 | 39.953 | 0.809 | 0.701–0.935 |
| Bun | materialize | 206.208 | 168.848 | 0.976 | 0.627–1.517 |
| Bun | unchanged-peek | 5.445 | 5.808 | 1.065 | 0.799–1.420 |

Node's 65,537-entry case also has substantial variability: one of its six
pairs was slower, despite the lower aggregate estimate. Bun's large numeric
case reverses the direction of its pilot estimate. String/cache-overflow has
four slower Bun pairs and an inconclusive interval; cached JSON is a different
workload and does not establish a cold or overflow-JSON benefit. Several other
Bun controls, including small numbers, max/ties, materialization and unchanged
peek, have wide intervals crossing parity. No universal or all-target claim is
made. The unchanged peek method's apparent Node pilot gain does not persist
in the confirmation estimate and is not attributed to this change.

### Every confirmation pair

The six ratios appear in round order; AB and BA alternate. They are never
trimmed, reordered by speed, or pooled as independent within-process batches.

| Case | Node paired ratios | Bun paired ratios |
| --- | --- | --- |
| empty-full | 0.938, 0.860, 0.800, 1.009, 0.684, 0.910 | 0.805, 0.793, 1.183, 1.152, 0.860, 0.903 |
| singleton-close | 1.019, 1.555, 0.744, 1.012, 0.853, 1.028 | 1.399, 0.898, 0.840, 0.665, 1.064, 1.083 |
| number-small | 0.417, 0.486, 0.445, 0.767, 0.430, 0.527 | 0.893, 1.158, 0.682, 1.283, 1.059, 0.798 |
| number-large | 0.366, 0.838, 0.483, 1.216, 0.454, 0.703 | 0.963, 1.349, 1.225, 0.877, 1.243, 1.361 |
| max-ties | 0.501, 0.462, 0.506, 0.512, 0.513, 0.541 | 0.620, 1.171, 0.529, 1.004, 0.664, 0.783 |
| boolean-full | 0.586, 0.723, 0.469, 0.744, 0.373, 0.810 | 0.872, 0.654, 0.896, 0.721, 0.930, 0.632 |
| string-overflow | 0.810, 0.978, 0.904, 0.847, 0.835, 0.917 | 1.127, 1.297, 0.738, 1.094, 1.081, 0.995 |
| object-warm | 0.581, 0.515, 0.762, 0.595, 0.582, 0.652 | 0.629, 0.895, 0.794, 0.920, 0.793, 0.862 |
| materialize | 0.572, 0.627, 0.619, 0.440, 0.633, 0.835 | 1.156, 0.648, 0.788, 1.150, 1.925, 0.659 |
| unchanged-peek | 0.890, 0.920, 1.037, 0.997, 1.142, 1.137 | 1.194, 0.736, 1.283, 1.094, 1.481, 0.800 |

There are **120 process pairs, 240 measured subjects and 2,160 measured
batches** in this confirmation. Actual nonempty timed warm-up totals were
**500.034–546.523 ms in Node** and **500.016–523.708 ms in Bun**. The shortest
nonempty measured batches were **2.537 ms** and **3.242 ms** respectively;
calibration did not guarantee an 8 ms batch. Every empty subject also reached
500 ms, so the 256-batch cap was not hit.

### Pilot results retained

These are two-pair exploratory estimates with their observed pair ranges;
they are not confirmation intervals. The original seven-batch driver, all
calibration/warm-up samples and an [arithmetic/control audit](results/pilot-audit-01.txt)
remain available. Source and workloads were unchanged for confirmation;
only predeclared replication and measured warm-up settings increased.

| Case | Node ratio (pair range) | Bun ratio (pair range) |
| --- | --- | --- |
| empty-full | 1.010 (0.944–1.081) | 1.244 (0.992–1.561) |
| singleton-close | 0.992 (0.977–1.007) | 1.123 (1.106–1.141) |
| number-small | 0.580 (0.558–0.603) | 0.829 (0.737–0.933) |
| number-large | 0.490 (0.414–0.580) | 0.896 (0.839–0.956) |
| max-ties | 0.681 (0.556–0.833) | 0.766 (0.752–0.780) |
| boolean-full | 0.539 (0.511–0.569) | 0.698 (0.586–0.831) |
| string-overflow | 1.010 (0.931–1.096) | 1.111 (0.920–1.341) |
| object-warm | 0.605 (0.567–0.644) | 0.938 (0.922–0.955) |
| materialize | 0.637 (0.618–0.656) | 0.917 (0.748–1.126) |
| unchanged-peek | 0.666 (0.635–0.698) | 1.080 (1.042–1.119) |

## Study design

The [screen plan](PLAN.md), [confirmation plan](FORMAL-PLAN.md), exact
[pilot driver](pilot.mjs) and [confirmation driver](benchmark.mjs) are preserved.
The ten cases cover an empty heap, early close after one item, 32 and 65,537
numeric entries, a max heap with tied priorities, booleans, Unicode strings
beyond the decode-cache entry limit, cached nested JSON, complete array
materialization and unchanged `peek()` / `peekPriority()` calls.

Each subject retains one immutable heap. Native input records establish expected
values and priorities; an independent read of the unchanged stored tree
establishes traversal order. The oracle does not call the candidate iterator.
Unique priorities identify generic records and unique values identify tied
numeric records. The oracle verifies every input identity exactly once.

Every timed complete traversal writes all values and priorities into reused
caller buffers. Each operation's actual count is reset and checked, followed by
a complete content check, so stale output cannot hide missing yields. The array
consumer instead materializes and retains every tuple array inside timing.
Every batch asserts zero shared-arena allocation. Fixture construction, buffer
preparation, counter reset and complete result verification are outside timing;
all iterator work, tuple creation, caller writes and natural GC remain timed.

Ordinary bounded decode caches stay active across batches. The JSON case's
1,057 records fit the cache; the string case's 4,097 distinct values exceed its
2,048-entry limit. These are repeated reads of retained snapshots, not cold
attachment, heap construction or priority-ordered dequeue measurements.

One fresh process loads one build and one workload at a neutral import path.
The entire portable build, including content-hashed chunks, is replaced before
the next subject. Node and Bun run separately under the shared benchmark lock,
pinned to CPU 2. Before/after use a common repetition count per engine/case.
Disposable coarse and fixed-count calibration target an 8 ms batch, bounded by
524,288 retained values, or 131,072 for JSON and full materialization. This is a
calibration target, not a guaranteed batch minimum.

The pilot used two balanced process pairs and seven measured batches. The
confirmation keeps the same source, matrix and work, with six balanced pairs
(three AB, three BA), nine measured batches per process, at least 500 ms of
actual timed warm-up and at least eight warm-up batches. Empty retains its
256-batch cap. Case order rotates between rounds. Each process contributes its
median; the reported estimate is the geometric mean of six paired after/before
ratios, with a two-sided 95% Student-t interval on those six log ratios. The nine
batches within a process are not nine independent subjects.

Small effects on this shared runner are not a stable guarantee. Empty,
early-close, generic decode and unchanged-method controls remain in the report;
an apparent change in unchanged code is not attributed to this optimization.
No results, processes or batches are discarded.

## Source and environment

| Item | Identity |
| --- | --- |
| Fixed baseline | `77599337867dbf785a5f0311d34637d0b36678fc` |
| Local implementation/test freeze | `c8feca5172fdaa6ffe5dda6964d99ef8af1f770f` |
| Local confirmation-plan/driver freeze | `9d6e299e6888a50276d43c765ec1390da7301052` |
| Candidate `shared-priority-queue.ts` SHA-256 | `813507737e0d69e65dd61268c60bf1d7151f0530541453d4784e62cb7be0bb03` |
| Measured heap-view test SHA-256 | `6f8aa380eedb3c93f72158a9483953546c8b736561527f11919ebab7df8a3f27` |
| Pilot driver SHA-256 | `d28fe12153aa356299d85f2ae2a69545f2885260d267b76e9a4988f7b4334fbb` |
| Confirmation driver SHA-256 | `658954e80725728717ea39cfe764abec87360f7a48727f10655d21aec780cc70` |
| Engines | Node 24.22.1; Bun 1.4.2 |
| Machine | Linux x64, AMD EPYC 9V74; eight-core CPU quota; measured subjects pinned to CPU 2 |

The source freezes above are local commits. Published source can be checked by
the exact file hashes; publication need not preserve local commit IDs. Each raw
record contains the full before/after source and bundle manifests, the complete
production diff, runtime versions, hardware, driver checksum, all calibrations,
warm-up batches and measured batches. Identity guards run before and after each
engine's study.

## Correctness and validation

The existing [heap view tests](../../heap-entry-views.test.ts) now assert one
getter/refresh request per nonempty numeric traversal. Their fixtures cover
owners and shared/copied read-only attachments, boundaries through 4,097 items,
lazy empty/unstarted generators, early close and thrown errors, interleaved
retained snapshots, memory growth before and during iteration, binary64 special
values and priorities, detached tuples, and custom decoder receiver/order,
reentry and exceptions. The focused build and all 35 tests across three heap
test files passed; see [the complete log](results/focused-01.log).
The strict [documentation check](results/docs-01.log) also passed: all 72
historical benchmark rows and all prior recorded evidence remained unchanged.

The [real-worker proof](worker.mjs) was prepared and reviewed, but **was not
executed after this performance rejection**; it is not claimed as a passing
validation result.
It pauses shared/copied numeric, boolean, string, JSON, nested-list, empty and
fork iterators after their first yield, grows both owner and dependency arenas,
attaches a fresh snapshot and resets default owners, then resumes all old
iterators. It checks complete native-input/order contents, frozen JSON,
read-only mutation failures, zero shared allocation and unchanged old bytes.

## Rejected queue-cache investigation

This heap change followed an independent rejected queue-front cache experiment.
Repeated peeks improved, but alternating four roots was slower in both pilot
pairs on both engines: approximately 41% in Node and 21% in Bun. That candidate
was rejected and is absent here. Its exact source, tests, plans, drivers and all
negative recordings are [durably archived without a PR](https://github.com/natanelia/zerocopy/blob/561130f572e6e819fa1ab52b400a902543ba766a/proofs/queue-front-cache-20261105/README.md).
Those measurements are not combined with this separate heap study.

## Saved evidence and reproduction

The complete raw records are losslessly compressed, with original and gzip
byte counts and SHA-256 hashes in [the archive manifest](archive-manifest.json):

- [Node pilot](results/node-pilot-01.json.gz) and [Bun pilot](results/bun-pilot-01.json.gz).
- [Node confirmation](results/node-formal-01.json.gz) and [Bun confirmation](results/bun-formal-01.json.gz).

The four original records contain **7,405,385 bytes**, compressed to
**541,425 bytes**. Decompression was checked byte-for-byte. The saved
[verifier](verify.mjs) checks archive hashes, the exact ten-case matrix,
all subjects/counts/warm-up, process order, medians, ratios and intervals,
plus optional checks against all 86 original source/bundle files per side.
[Its complete passing log](results/verify-01.txt) includes both original trees.
A separate [Python audit](results/independent-audit.py) independently recomputed
all 240 confirmation medians, 120 pair ratios, 20 summaries and intervals,
2,160 measured batches and 346 source/bundle/driver identity checks; see
[its full passing log](results/independent-formal-01.txt).

Verify the saved data without running timings:

```sh
node proofs/heap-single-view-20261105/verify.mjs
```

For a fresh measurement, build the frozen baseline and the exact candidate
source in separate checkouts using the same dependency installation and Bun
1.4.2. `package.json` pins direct development versions; there is no committed
lockfile pinning transitive resolutions. Run `bun run build:wasm` followed by
`bun run build:browser`. Use Node 24.22.1 for
the controller. From the candidate checkout, run each engine separately and
choose a new output path; the driver refuses to replace an existing recording:

```sh
flock /tmp/zerocopy-perf.lock taskset -c 2 node proofs/heap-single-view-20261105/benchmark.mjs /path/to/before /path/to/after /path/to/bun /tmp/heap-node-new.json node
flock /tmp/zerocopy-perf.lock taskset -c 2 node proofs/heap-single-view-20261105/benchmark.mjs /path/to/before /path/to/after /path/to/bun /tmp/heap-bun-new.json bun
```

The original driver accepts only the fixed baseline commit and checks that
all unrelated production inputs match. Newly built artifacts and new runs must
retain their own identities. The numbers here describe this x64 Linux host and
these fixed repeated-read workloads; they do not certify another architecture,
engine version, cold-attachment scenario or combination with other changes.
