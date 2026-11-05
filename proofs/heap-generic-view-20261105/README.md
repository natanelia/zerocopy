# Rejected: scope heap view reuse to booleans and JSON

**Rejected after the fixed pilot; no performance PR or confirmation run.**
The scoped version improves boolean and cached-JSON estimates, but introduces
or retains adverse results elsewhere. Empty and early-close cases were slower
in both pairs in both engines. Bun's 4,097-number max/tie traversal was slower
in both pairs, and Node's new JSON/cache-overflow control was slower in both
pairs. Large numeric and materialization results remain highly variable.
This evidence does not justify shipping the branch or running another tuned
variant. All observations remain available.

This is a **proof-only archive**. Live production and tests are restored to the
fixed baseline. The exact measured candidate implementation and tests are
preserved as text under [measured/](measured/candidate-shared-priority-queue.ts.txt).
The original measurement paths in raw metadata describe the earlier source
freeze, not the current runtime in this archive checkout.

## Candidate and prior investigation

The [candidate source](measured/candidate-shared-priority-queue.ts.txt) keeps
`entries()` a generator method. Boolean/object heaps get a branch-local existing
`DataView`; all other types use the original per-node-view loop verbatim. Empty
requests no view. Generic decoding, priority/value/child-read order, tuple
allocation and suspension points remain the same. There is no extra delegation
layer. This avoids the observable generator-kind/prototype/lazy-error changes
that an ordinary function dispatch to separate generators would introduce.

The [baseline source](measured/baseline-shared-priority-queue.ts.txt),
[exact production patch](measured/candidate.patch.txt), and
[fallback identity check](results/fallback-identity.txt) are retained. The old
fallback loop including its method ending has SHA-256
`6f4f04b29b956e17b6885a8229c9e29c8fce1c3603d05af92e0f0aa79984289f`
in both files. A different generator-state/liveness effect was only a hypothesis;
this study does not establish the compiler-level cause of either gains or costs.

This final variant follows the rejected broad single-view experiment. Broad
V1 captured one view for every type and had an unresolved adverse large-number
Bun result in its six-pair confirmation. Its complete source and records are
[archived separately](https://github.com/natanelia/zerocopy/blob/ba069cae250e8d36eabd0bc616f3a4da015e7a5c/proofs/heap-single-view-20261105/README.md);
none of those numbers are V2 measurements. The fixed [plan](PLAN.md)
retained all ten V1 cases and added JSON cache overflow before the new screen.
No source or workload was tuned after this pilot.

## Complete pilot results

Times are microseconds per complete operation, shown as medians of the two
process medians per side. The after/before estimate is the geometric mean of
the two paired ratios; below one is faster. These are exploratory two-pair
results, not confirmed effects. Each full operation consumes its entire heap;
`singleton-close` performs one `next()` plus `return()`, and `unchanged-peek`
performs 256 `peek()` / `peekPriority()` pairs.

| Engine | Case | Before µs | After µs | Paired after/before | Pair 1 | Pair 2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | empty-full | 0.034 | 0.041 | 1.197 | 1.289 | 1.111 |
| Node | singleton-close | 0.088 | 0.106 | 1.205 | 1.240 | 1.172 |
| Node | number-small | 1.823 | 1.759 | 0.965 | 0.975 | 0.956 |
| Node | number-large | 6629.371 | 6964.536 | 0.996 | 0.736 | 1.347 |
| Node | max-ties | 234.578 | 238.566 | 1.017 | 1.023 | 1.012 |
| Node | boolean-full | 257.356 | 146.148 | 0.561 | 0.411 | 0.765 |
| Node | string-overflow | 1400.954 | 1334.008 | 0.948 | 0.823 | 1.093 |
| Node | object-warm | 96.247 | 51.688 | 0.541 | 0.589 | 0.497 |
| Node | object-overflow | 2582.597 | 2827.329 | 1.090 | 1.017 | 1.169 |
| Node | materialize | 334.673 | 299.316 | 0.897 | 0.751 | 1.072 |
| Node | unchanged-peek | 16.636 | 17.161 | 1.031 | 1.041 | 1.022 |
| Bun | empty-full | 0.009 | 0.012 | 1.319 | 1.423 | 1.222 |
| Bun | singleton-close | 0.052 | 0.062 | 1.203 | 1.333 | 1.085 |
| Bun | number-small | 0.939 | 1.184 | 1.240 | 0.949 | 1.620 |
| Bun | number-large | 10119.841 | 13391.652 | 1.306 | 0.922 | 1.850 |
| Bun | max-ties | 112.948 | 129.426 | 1.146 | 1.132 | 1.159 |
| Bun | boolean-full | 115.514 | 101.670 | 0.876 | 0.989 | 0.776 |
| Bun | string-overflow | 901.986 | 813.417 | 0.901 | 0.966 | 0.840 |
| Bun | object-warm | 42.063 | 39.458 | 0.938 | 0.965 | 0.911 |
| Bun | object-overflow | 3520.680 | 3847.463 | 1.090 | 1.691 | 0.702 |
| Bun | materialize | 205.665 | 229.170 | 1.132 | 0.643 | 1.993 |
| Bun | unchanged-peek | 6.122 | 4.958 | 0.821 | 0.940 | 0.716 |

Empty and early-close costs are small in absolute time, and are not the sole
reason for rejection. Bun's max/tie workload has ratios 1.132/1.159, and Node's
JSON overflow has ratios 1.017/1.169. The large numeric Bun pairs span
0.922–1.850; the materialization pairs span 0.643–1.993. Those ranges do not
establish neutral fallback performance. The unchanged Bun peek control's
apparent improvement is not attributed to the candidate. No slow process or
batch is removed, and the noisy controls are not presented as confirmed
regressions or improvements.

## Method and limits

The exact [pilot driver](pilot.mjs) ran 11 cases in each engine: **44 process
pairs, 88 measured subjects and 616 measured batches**. Each subject loads one
build and one workload in a fresh process at the same neutral import path.
Before/after order is AB in round one and BA in round two, with rotated case
order. Every subject performs seven measured batches after at least 500 ms of
actual timed warm-up plus eight batches. Empty has a recorded 256-batch bound.

The private retained heap, native input records and independent stored-tree
oracle are prepared outside timing. The oracle never calls the candidate
iterator. It checks every input identity once, both values and priorities, and
the exact traversal order. Each operation's actual yield count is reset and
verified; complete output buffers are checked after every batch so stale
values cannot hide skipped writes. Full materialization creates and retains
all returned tuple arrays inside timing. Caller buffer preparation, count
reset and result verification are excluded; public iterator work, normal
allocations/GC and result writes remain timed. Shared-arena allocation must
be zero in every batch.

Ordinary bounded caches stay active across batches. The 1,057 JSON records fit
the 2,048-entry cache. The 4,097 distinct strings and added 4,097 JSON records
exceed it; their repeated reads mix cached values with repeated decode misses.
The extra case does not measure wholly cold attachment or first reads.

Disposable 100 ms coarse and 150 ms fixed-count probes select a common before/
after repetition count per engine/case, targeting an 8 ms batch. Retention is
capped at 524,288 values, or 131,072 for JSON/full materialization. Calibration
is not a guaranteed batch-duration minimum. All heavy work uses the common
benchmark lock; measured processes inherit CPU 2 affinity. No forced GC or
runtime flags are used. Results describe this one x64 host and fixed repeated
read workloads, not an application-wide guarantee.

Node: nonempty timed warm-up **500.362–527.371 ms**; shortest nonempty measured batch **4.252 ms**; empty cap hits **0**.

Bun: nonempty timed warm-up **500.023–514.894 ms**; shortest nonempty measured batch **3.419 ms**; empty cap hits **0**.

## Identity and correctness

| Item | Exact identity |
| --- | --- |
| Baseline | `77599337867dbf785a5f0311d34637d0b36678fc` |
| Local measured source/plan/driver freeze | `442f6a58138c00de0951d7f4592da997700a474e` |
| Candidate runtime SHA-256 | `9dd91242e8e73774146c5f104bf7c24fd0d863a616f78178048b25dfacbbd863` |
| New measured test SHA-256 | `7327d3ab6a08b81bc7fb97cd813903f3d7b114db562244514a6972f4b7fa4554` |
| Driver SHA-256 | `25175a6f6aabcc2345086c1f7bc429d0197b4af4a17551fe77fdab9d53547e84` |
| Worker proof SHA-256 | `4abd00244e9ca1a8199548bd0bbfc4cb0a2336a6e46cdfb4a70af29c77be9678` |
| Engines | Node 24.22.1; Bun 1.4.2 |
| Host | Linux x64, AMD EPYC 9V74; eight-core quota, timings on CPU 2 |

The freeze commit is local. Published evidence is tied to exact archived source
and artifact hashes rather than requiring that local commit to exist remotely.
Each raw record retains all 86 source/WASM/build/bundle inputs per side, driver
hash, candidate diff, versions, environment, calibration, warm-up and measured
samples. The driver checks identities at both ends of each engine run.

The [complete validation log](results/focused-worker-01.log) records the portable
build, **38 focused tests in four files**, the full project type check and
**two real Node worker tests** passing on the candidate before measurement.
The [existing heap-view tests](measured/heap-entry-views.test.ts.txt) remain
unchanged, including generator kind, iterator prototype, lazy empty behavior
and numeric per-node view requests. The [three new tests](measured/heap-entry-generic-view.test.ts.txt)
check scoped view requests separately from decoder-internal requests; complete
cold/warm owner/shared/copy output; unchanged numeric/string/nested fallback
requests; frozen JSON; decoder receiver, reentry, growth, throws and old bytes.
All fixtures use private Arenas.

The [worker proof](worker.mjs) pauses numeric, boolean, string, JSON, nested-list,
empty and fork iterators on shared and copied transports. The writer grows both
the owner and explicit nested dependency, then a fresh attachment and default
owner resets occur before the old iterators resume. Complete values/priorities,
read-only failures, frozen JSON, unchanged old bytes and zero shared allocation
are checked. The dependency owner and exact two-arena payload are asserted.

## Preserved evidence and reproduction

The [Node raw record](results/node-pilot-01.json.gz) and
[Bun raw record](results/bun-pilot-01.json.gz) are compressed without loss.
[The archive manifest](archive-manifest.json) records original/compressed byte
counts and SHA-256 hashes, plus every archived source/test input. The two
original records total **2,722,410 bytes**, compressed to **200,720 bytes**;
exact decompressed bytes were verified.

The [saved-data verifier](verify.mjs) checks both archives, all 22 result rows,
44 pair ratios, 616 measured batches, counts/warm-up, exact case/process order,
all source identities and the unchanged original fallback. It checks archived
sources by default, without pinning current production to this rejected version.
The [pre-restoration verification log](results/verify-original-trees-01.txt)
also compares every original source/bundle input against the measured builds.
The [archive-only replay](results/verify-archived-only-01.txt) passed after
restoring production, and the strict [documentation check](results/docs-01.log)
passed with all 72 historical rows and prior recorded evidence unchanged.

```sh
node proofs/heap-generic-view-20261105/verify.mjs
```

For a fresh run, create separate baseline and candidate checkouts from the
fixed baseline. Copy the archived candidate source to `shared-priority-queue.ts`
in the candidate only; copy the archived new test to its original root filename
if repeating its focused gate. Use the same dependency installation and Bun
1.4.2 for both builds (`bun run build:wasm`, then `bun run build:browser`).
`package.json` pins direct development versions; no committed lockfile pins
transitive resolutions. Use Node 24.22.1 for the controller, and new output
paths because existing records are never overwritten:

```sh
flock /tmp/zerocopy-perf.lock taskset -c 2 node proofs/heap-generic-view-20261105/pilot.mjs /path/to/before /path/to/after /path/to/bun /tmp/heap-scoped-node-new.json node
flock /tmp/zerocopy-perf.lock taskset -c 2 node proofs/heap-generic-view-20261105/pilot.mjs /path/to/before /path/to/after /path/to/bun /tmp/heap-scoped-bun-new.json bun
```

Restoring the source is essential: this archive's live runtime is the baseline.
New builds/runs retain their own provenance and are separate evidence.
