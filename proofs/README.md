> Delivery status: the complete candidate runtime and proof programs are now
> integrated in GitHub PR #1. The earlier upload failure is resolved. Historical
> local measurements below apply to the recorded engine hash. Check the Actions
> run for the current commit for remote verification results.

# Immutable performance proof

This report describes a v0.2 candidate, not a claim that every operation is faster.
The pinned reference is `7aea44447177d37a303ab5c1b26d7c5e00e1c1f7`.
The implementation replaces unsafe shared-node updates with persistent data structures.
Some operations become much faster. Several write operations become slower.
Do not merge this as an unreviewed, binary-compatible patch.

## Measured results

The table shows median milliseconds. `Matched base` means the original source
compiled with exactly the candidate's AssemblyScript compiler and compiler flags.
A speed ratio above 1 means the candidate is faster. A ratio below 1 is a regression.
All 14 measured cases are included.

| Operation | Work units | Original base, ms | Matched base, ms | Candidate, ms | Matched base / candidate |
|---|---:|---:|---:|---:|---:|
| `list.pushMany` | build 4096 numbers | 0.734 | 0.867 | 0.085 | 10.24x |
| `list.toArray` | 20 scans of 4096 numbers | 0.861 | 0.822 | 0.278 | 2.96x |
| `list.push` | 4096 scalar pushes | 0.755 | 0.921 | 1.020 | 0.90x |
| `map.setMany` | build 1024 key/number entries | 0.288 | 0.187 | 0.316 | 0.59x |
| `map.get` | 4096 hits over 1024 keys written in setup | 0.357 | 0.369 | 0.481 | 0.77x |
| `linked.randomGet` | 4096 permuted indexed reads | 14.481 | 14.812 | 0.700 | 21.17x |
| `linked.append` | 4096 scalar appends | 0.326 | 0.319 | 1.241 | 0.26x |
| `doubly.randomGet` | 4096 permuted indexed reads | 7.978 | 7.518 | 0.725 | 10.38x |
| `doubly.append` | 4096 scalar appends | 0.293 | 0.305 | 1.327 | 0.23x |
| `ordered.set` | 1024 scalar writes | 0.224 | 0.235 | 0.737 | 0.32x |
| `sorted.set` | 1024 scalar writes | 0.338 | 0.313 | 0.554 | 0.57x |
| `priority.enqueue` | 1024 numeric enqueues | 0.533 | 0.568 | 0.321 | 1.77x |
| `queue.build` | 4096 numeric insertions | 0.325 | 0.363 | 1.214 | 0.30x |
| `stack.build` | 4096 numeric insertions | 0.318 | 0.322 | 0.194 | 1.66x |

The largest matched-build gains are 10.24x for bulk vector creation, 21.17x for
indexed singly linked list reads, 10.38x for indexed doubly linked list reads,
and 2.96x for vector scans. Numeric heap insertion is 1.77x faster. Numeric stack
creation is 1.66x faster. These are specific workloads, not whole-application gains.

The linked list names retain their public sequence operations, but their v0.2
storage is an indexed AVL tree. They are no longer physical linked lists. This
change explains both the indexed-read gains and the append regressions. Ordered
map writes and queue creation also regress. Map lookup and `setMany` are **not**
faster than the matched old implementation in this experiment.

### Raw evidence and reproducibility

- [Full local measurements, all raw samples and hashes](results/local.json)
- [Immutable scalar versus fused batch allocation](results/allocation.json)
- [Real Node worker result](results/node-worker.json)
- [Original snapshot counterexamples](results/baseline-regressions.json)
- [Candidate results for the same counterexamples](results/candidate-regressions.json)

The full experiment used Bun 1.4.2, AssemblyScript 0.28.20, Linux x64, and an
Intel Xeon Platinum 8573C. The report timestamp is 2026-09-13T02:39:46.235Z.
There were three independent process rounds per variant. Each operation had its
own process, 20 warm-up runs, and 15 measured runs per round: 45 raw samples per
operation and variant. Variant order changed between rounds. Setup and full
result validation are outside the timed region. Every measured output is checked.

The three variants are the original source with its original flags, the original
source with the candidate flags, and the candidate. Both baseline builds use the
same installed compiler version as the candidate. This separates compiler changes
from data structure changes. The harness is copied unchanged to the baseline.
Its production source digest must match the pinned commit before the run starts.
The candidate is rebuilt before measurement.

These are numeric, in-process microbenchmarks. They do not measure application
latency, peak RSS, JavaScript heap use, browser performance, or worker transfer
latency. The machine had no CPU pinning or frequency controls. The raw sample
spread matters. A median is not a confidence interval. There is no wall-clock
performance gate in CI on a shared runner.

Each sample uses a fresh logical arena. Candidate reset creates a new WASM
instance outside the timed region; baseline reset reuses its instance. This
models separate arena lifetimes, not every long-running steady-state application.
Old map auto-GC is disabled because it can reclaim a still-reachable snapshot.
The old implementation does not meet the candidate's full persistence contract.
Thus the timing comparison does not claim equal semantics for all possible uses.

Exact evidence identifiers:

```
baseline engine SHA256: 8dfcd6c936b4875ebfcd6e13dd214d5b84d2d6301f1c5f6c68704a2f357352fa
candidate engine SHA256: c408c5a71c9a3e8fb57fd4c010e197d8b4856201e72a677f36dbf6cb8508fba6
candidate WASM SHA256: 7f042cfbb224e7021e98c26289dcfb166286a12127931d0f2ed5d51419d0375f
benchmark SHA256: c8609253121a9d181ff893f882ef9d7120312bdcb3ed814080471b9d7f7c3c93
```

The engine digest includes the sorted source paths listed in the raw report,
with NUL-delimited names and contents. It excludes documentation, test code, and
build wrappers. Compiler flags are recorded in the same report. Candidate flags:

```
--importMemory --sharedMemory --initialMemory 2 --maximumMemory 65536
--enable threads --runtime stub --optimizeLevel 3 --shrinkLevel 0
```

## Why these changes help

### Prefix-fused HAMT updates

`setMany` removes duplicate encoded keys with last-write-wins semantics, creates
fresh leaves, then partitions a private pointer array by five hash bits per level.
The WASM engine updates all affected children together. It copies each affected
old branch once for that batch instead of once per key. No transient owner tag
is stored in a published node. No ownership counter can wrap and grant permission
to edit an old version.

This uses known persistent trie and radix partition techniques in a combination
specific to this code. It is not a claim of a new published algorithm.

The deterministic allocation ablation starts with 32,768 entries and changes
4,096 existing keys. Both sides use this candidate's immutable implementation:

| Candidate update method | Allocated WASM bytes |
|---|---:|
| 4,096 persistent scalar updates | 1,841,408 |
| One prefix-fused batch | 347,240 |

The batch uses **81.14% fewer arena bytes**. All original and new values are
checked, and the old allocated payload is byte-for-byte unchanged. This is not
an 81% speed claim, not a total-memory claim, and not a comparison with the old
unsafe transient batch implementation.

### Dense block vectors and leaf scans

A vector leaf stores 32 numeric slots in 256 bytes. `pushMany` fills a fresh range
and copies each affected leaf and branch once. Building 4,096 values allocates
66,176 arena bytes, including input staging, versus 2,052,112 bytes in the original
vector: **96.78% fewer arena bytes**. The used prefix including each implementation's
header is 131,712 bytes versus 2,117,712 bytes. Neither figure is peak RSS.
`toArray` resolves one leaf for each block of 32 values instead of traversing the
trie and crossing into WASM once per value.

### Stable encoded key tokens

An append-only arena never reuses a published key address. A bounded cache can
therefore use an existing leaf's bytes and hash for later lookups. Repeated key
lookups need no shared scratch write. ASCII insertion avoids a temporary UTF-8
array when possible. Pointer caches use full addresses, not overlapping packed
bit fields. These optimizations do not make the measured map lookup faster than
the old implementation overall; frozen handles and safe lifetime rules have costs.

### Specialized immutable storage

The queue uses a vector and a read offset. A dequeue can return a descriptor
without editing an old node. Ordered maps combine a HAMT with a persistent
insertion-order index. The stack and leftist heap store primitive numeric values
inline, avoiding an unnecessary blob allocation. Indexed AVL sequences give the
linked list interfaces logarithmic reads while keeping all prior roots valid.

## Correctness evidence

### Six unchanged tests expose old failures

The same [counterexample program](snapshot-regressions.ts) runs against both
versions. All six cases fail on the pinned original and pass on the candidate:
queue forks, singly linked list forks, doubly linked list forks, ordered map
forks, a mutable input object retained by a stack, and mutation of a cached map
object. The JSON files show expected and actual values, not only pass labels.

### Unit and invariant checks

The local unit suite passes **280 tests in 13 files**, including the 246 existing
tests and 34 new proof tests. The new tests cover all 12 public collection types.
They check frozen handles, old byte prefixes, retained branching versions,
deterministic reference models, HAMT sizes and hash paths, AVL balance and sizes,
and leftist heap rank and priority invariants.

Boundary cases include vector depths through 32,769 elements, the exact FNV-1a
collision `costarring` / `liquid`, empty keys, prefix deletion, 1,400 retained maps,
large keys and values above 64 KiB, arenas above 1 MiB, a 4,500-entry batch, Unicode
surrogates, BOM preservation, nested structures, JSON cache isolation, and
reentrant or interleaved iteration during writes and memory growth.

### Real worker check

[The Node worker proof](node-worker.mjs) uses an actual `worker_threads` worker,
not only a same-thread serializer. All 12 structures and nested values survive
transport. It checks 10,000 old snapshot reads while the writer creates newer
versions and grows memory. Repeated attachment and reset preserve old snapshots.
Attached worker views reject allocating writes. An atomic marker in reserved
header scratch confirms both workers have the same backing memory. The local
Node 22.16.0 run passed.

Browser tests use real Chromium module workers and the same bundled engine.
The local browser cannot access localhost under the environment's browser policy,
so no local browser pass is claimed. The complete candidate is now uploaded,
and its GitHub workflow runs the browser suite. Remote browser results must be
checked against the Actions run for the specific commit; historical local evidence
is not a claim of a browser pass.

### Invariant argument, not a machine-checked proof

The public persistence claim rests on these invariants:

1. Every update allocates new payload nodes beyond the current arena end.
2. A published node's fields and payload never change. References may point to
   older nodes in the same arena or to explicitly retained nested arenas.
3. Each snapshot stores a fixed root and size in a frozen handle. Its owning arena
   cannot be replaced through the public collection API.
4. Reset creates a different arena. It never rewinds the old allocator.
5. Iterators keep their continuation state locally. Readers do not share writer
   staging. Decoded JSON objects are deeply frozen before they enter the cache.

By induction, a newly constructed version can add fresh nodes and reference an
older version without changing that older version's reachable payload. The tests
check this argument at the byte level and against independent logical models.
They are executable evidence, not a formal verification of WASM, JavaScript,
all possible inputs, the runtime, or the entire dependency chain.

## Memory, concurrency, and migration limits

The published **collection values** are immutable through supported APIs. The
allocator, caches, staging arrays, transport buffers, and application controller
state are internal mutable mechanisms, not additional persistent collections.
Fresh unpublished construction is allowed to write. Returned entry tuples and
`toArray()` containers are detached mutable copies; modifying them cannot edit a
snapshot. Values decoded from the `object` codec are deeply frozen JSON values.

There is one allocating writer per arena. Worker attachments are read-only.
This is not a multi-writer allocator. A raw `SharedArrayBuffer` is writable by
any code that holds it. Immutability is **not a security boundary** against a
caller that writes arbitrary memory, invokes raw WASM exports, or supplies
malformed root pointers. Use trusted producers and the public transport API.
Custom comparators must be pure and consistent. They remain local and cannot
be serialized to a worker.

The arena is append-only and has an allocation ceiling below 2 GiB. There is no
per-node reclamation. A live snapshot pins its entire arena, including unreachable
intermediate versions and staging bytes. Nested descriptors retain dependent
arenas. Queues can retain consumed prefixes; ordered maps retain tombstones.
Whole arenas become collectible only after all references, including worker and
transport references, are gone. JavaScript GC timing is not guaranteed. For a
long-lived write workload, rotate application lifetimes or explicitly rebuild
into a fresh arena. Compaction and a safe concurrent reclamation protocol are
not implemented in this change.

`reset*()` selects a fresh default arena for future empty collections, without
invalidating existing snapshots. `dispose()` and `configureAutoGC()` are deprecated
no-ops. Repeated use without arena rotation can consume more memory than v0.1.
This tradeoff is part of the PR, not a hidden consequence of the speed numbers.

Wire format 2 and the node layout are breaking changes. Do not mix v0.1 roots,
WASM files, workers, or stored pointer descriptors with v0.2. Rebuild all consumers
and recreate data. The retained legacy `getInfo` scratch export is only for
serialized direct-reader examples; it is not the new concurrent reader API.
The legacy exported `sharedBuffer` can be stale after memory growth. Prefer
`getBuffer()`, `sharedMemory.buffer`, or `getWorkerData()` at the time of use.

Node and supported browsers share `WebAssembly.Memory` through transport. Bun
uses a used-prefix copy by default because its worker memory support differs.
That fallback is **not zero-copy**. Strings and JSON still require decoding and
JavaScript allocation in readers. The default browser bundle embeds WASM and
uses no Node filesystem API.

## Run the checks

Use the pinned direct development dependencies. Install Bun 1.4.2 and Node 22.

```sh
bun install
bun run build:wasm
bun run build:browser
bun run build:types
bun run typecheck
bun run test
node proofs/node-worker.mjs
bun proofs/allocation.ts
EXPECT_PASS=1 LABEL=candidate bun proofs/snapshot-regressions.ts
bunx playwright install --with-deps chromium
bun run test:browser
```

For a complete three-variant comparison, prepare a separate checkout. The runner
writes generated WASM files and a copy of the harness into that checkout, so do
not point it at a worktree with uncommitted changes you need to keep.

```sh
git worktree add --detach ../zerocopy-base 7aea44447177d37a303ab5c1b26d7c5e00e1c1f7
ln -s "$PWD/node_modules" ../zerocopy-base/node_modules
node proofs/run-comparison.mjs ../zerocopy-base proofs/results/ci.json
```

The runner records all samples and metadata. It checks source hashes before
measurement. `RESUME=1` can resume its checkpoint only when source and harness
hashes are unchanged. CI uploads these results without a noisy timing pass/fail
threshold. Correctness and deterministic allocation checks are hard gates.
