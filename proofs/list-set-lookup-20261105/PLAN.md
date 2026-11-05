# Fixed screen: look up exact tree bits before copying

Declared before timing on 2026-11-05. Fixed baseline: `77599337867dbf785a5f0311d34637d0b36678fc`, built in the immutable round-four baseline checkout. This is a separate final design after the rejected child-first list experiment; none of its timing is reused or pooled here.

## Hypothesis and scope

Leave the baseline `vecSetAt()` copy helper, `tailSet()`, public `SharedList.set()` wrapper and 192-byte partial-failure fixture byte-identical. Only exported `vecSet()` changes: iteratively walk the existing path, stopping before any zero pointer; compare the existing leaf's exact `u64` bits to the supplied `f64`; return the existing root on equality. Otherwise call the original copy helper, with its original ancestor-before-child allocation order.

This can eliminate shared storage allocation for unchanged tree slots while preserving the original changed-write algorithm and tail behavior. It also adds a read-only traversal to changed tree writes; that cost is a risk to measure, not assumed harmless. The earlier child-first design was rejected after adverse changed-number, changed-string and read controls despite strong no-op gains. Its complete evidence remains separate. This final design will also be rejected if meaningful control costs persist. No later source tuning or additional design follows its data in this round.

Exact equality preserves signed zero and NaN payload distinctions. Missing roots/children must allocate even when the requested bits are zero. The unchanged public wrapper still encodes valid-index values, enforces read-only/type checks, and returns a fresh frozen snapshot. JSON/nested encoding side effects and allocation remain. Interned strings benefit only when encoding returns the existing pointer. Invalid indices still return the original object. Tail writes remain the original copying operation, including same-value tails and their full-capacity failures.

The benchmark preflight asserts that removing the exported `vecSet()` text makes baseline and candidate WASM sources identical. The whole root production inventory must differ only in `persistent-core.as.ts`; core WASM and its nine legacy aliases may change, while unrelated WASM and build inputs must match. This source constraint does not prove unchanged machine code or performance elsewhere.

## Unchanged ten-case workload matrix

Retain the earlier ten operation definitions, sizes and inputs. Relabel only the tail no-op as an unchanged control. Each write operation threads **1,024 public `set()` calls** and returns its final snapshot. Only each complete operation's final snapshot escapes and is retained; intermediate wrappers may be collected. The read control returns all 1,024 public `get()` outputs. This measures repeated-update consumers, not isolated single-call latency.

| Case | Source and index | Requests | Role |
|---|---|---|---|
| tail-number-noop | One numeric element, index 0 | Original value 1,024 times | Unchanged tail-copy control |
| tree-number-noop | 65,537 numbers, index 32,768 | Original value 1,024 times | Tree target |
| tree-boolean-noop | 1,057 booleans, index 511 | Original value 1,024 times | Tree target |
| tree-string-noop | 1,057 strings from eight interned Unicode values, index 511 | Original value 1,024 times | Tree target |
| tail-number-changed | Same one-element numeric shape | A distinct numeric value each call | Unchanged tail-copy control |
| tree-number-changed | Same deep numeric shape | A distinct numeric value each call | Added-traversal control |
| tree-boolean-changed | Same boolean shape | Toggle on every call | Added-traversal control |
| tree-string-changed | Same interned-string shape | Cycle eight values, differing on every call | Added-traversal control |
| tree-json-reencode | 1,057 small JSON records, index 511 | Same logical object on every call | Generic encoding/control |
| get-control | 65,537 numbers | 1,024 predetermined scattered public reads | Unchanged read control |

Inputs, requests and full expected results come from native arrays outside timing. Changed booleans/strings can end at the original logical value, but every request changes the previous raw value; exact allocation checks confirm this. Generic JSON encodes a new blob and pointer on every call.

## Symmetric preparation and complete checks

Every batch builds a fresh private Arena and source outside timing, then performs the same source-content check on both builds. String interning is populated identically by source construction. There is no persistent cross-build cache. Timing includes the retained-results array, public caller loops, encoding, WASM, snapshot creation and natural garbage collection. Fixture/input preparation, hashing and complete output verification stay outside timing. No forced GC is used.

Every final snapshot is fully materialized after timing, with every element compared against the native oracle; wrapper identity, frozen state, owner, size/depth, root/tail reuse and exact allocation are checked too. Every batch verifies its original source before/after and hashes the complete published storage range from `HEAP_START` through its original used position. The lower WASM scratch area is excluded. Candidate same-bit tree writes allocate zero shared bytes; tail writes and changed/generic writes must allocate the same predicted total as baseline. JavaScript wrappers still allocate.

This fresh-source-per-batch setup bounds append-only shared storage but does not model an arbitrary long-lived mixed history. The previous blackboxed Arena can remain live while the next one is constructed. Batch caps are not RSS or peak-memory guarantees.

## Fixed measurement and decision

Use Node 24.22.1 and Bun 1.4.2. All builds/tests/benchmarks use the shared `/workspace/scratch/83f1d4baba1f/perf.lock`; timing controllers and child processes use CPU 2. Copy exactly one complete build to the same neutral pathname before each fresh subject process. Balance before/after order and rotate cases as already implemented.

Run a fresh screen with **two process pairs per runtime/case**, seven measured batches, at least 150 ms actual timed warm-up and at least eight warm-up batches. Disposable calibration from both current builds chooses a single common repeat per case/runtime. Do not reuse the earlier experiment's repeat plans. Keep the 20 ms batch target and caps of 65,536 complete operations, 1,048,576 checked output elements, and 16 MiB worst-case baseline shared allocation. The same caps apply to both builds, including zero-allocation tree targets. Preserve short/capped batches. The 2,048-batch warm-up cap fails visibly if the elapsed floor is unmet; each child has a 300-second timeout.

Keep every initial, warm-up, calibration and measured batch, process, allocation/source check and failure. The initial recorded one-shot check does not count toward warm-up or summaries. Hash source, tests, support/build files, all imported JavaScript chunks, WASM files and drivers before/after. Freeze source/driver/plan before the first screen measurement. No selective retiming or case removal is allowed.

Advance only if the complete screen supports worthwhile repeatable tree gains with acceptable tail, changed-write, generic and read controls. If justified, predeclare exactly one confirmation with all ten cases and the unchanged runtime/driver, at least six balanced fresh process pairs, at least 500 ms actual timed warm-up plus eight batches, and eleven measured batches. Report process-pair geometric latency ratios and nominal log-t intervals, not batch-level inferential intervals. Controls whose intervals include parity are not thereby proven equivalent. Reject if material costs or readiness uncertainty persist; do not tune this final design after measurement.

## Correctness before measurement

Use private Arenas. Cover tree/tail boundaries and depths; exact root reuse with fresh wrappers; old roots, frontier appends and forks; signed zero, infinities and exact NaN payloads using a WASM-to-WASM i64 bridge; zero roots and missing paths; boolean/interned-string tree reuse and unchanged tail allocation; JSON/nested encoding callbacks and growth; invalid indices and type errors; read-only shared/copied readers; full-capacity unchanged trees versus unchanged-tail/changed-write failure; and the original partial-failure/recovery fixture. Run a real Node worker proof with both current and unchanged-baseline readers for shared/copy attachment, retained old snapshots, suspension/concurrent reads during writer growth, repeated attachment, forks and reset.
