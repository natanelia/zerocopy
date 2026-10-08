# Bit-identical persistent list updates

Status: local candidate on `3773c6e519c7c0958da13727ed1082f449f3ee25`; no throughput measurements or publication. Runtime and correctness files remain frozen at local `c9209b1a40887a77ac2ce3259a37a4581fe377bb`, with their SHA256 values enforced independently of the final publication commit identity.

## Mechanism and scope

Only `vecSetAt` and `tailSet` in `persistent-core.as.ts` change. The existing leaf word is compared with `reinterpret<u64>(value)`, retaining signed zero and NaN payload distinctions in the f64 value received by WASM. JavaScript engines can canonicalize NaNs before that boundary; the candidate does not promise cross-engine JavaScript Number payload preservation. An identical leaf or tail returns its existing pointer. Branch recursion happens before allocation, so an unchanged child propagates to the original root without a second traversal. Changed updates still copy the leaf and every ancestor.

`SharedList.set` remains unchanged. Valid writes still encode and validate first and return a fresh frozen public handle, even if storage is shared. Invalid indices keep returning the original handle before validation. Read-only writes still fail in `Arena.encode` before entering WASM. Number, Boolean and already-interned string updates can benefit. JSON, nested snapshots and uncached strings still perform their original serialization and record allocation.

There is no new cache, public API, wire format, data representation, SIMD flag, or short-copy implementation. Published bytes remain immutable. A reused frontier tail may later be extended only beyond its published length, under the existing tail-append rule.

## Ordinary-write cost and observable details

Every changed leaf/tail update gains a 64-bit load, exact-bit comparison and branch. Every internal vector level gains a child-pointer equality check; it does not gain another tree walk. Changed writes allocate the same number of arena bytes. Vector allocation order becomes child-before-parent rather than parent-before-child, so fresh pointer addresses and allocation-failure intermediate state are not byte-for-byte baseline equivalents. No JavaScript callback runs during these WASM operations. Existing vector readers, links and compaction do not require parents to precede children.

No-op updates deliberately change storage identity. Their descriptors now equal their source descriptors. The existing `compactMany` descriptor-keyed cache therefore coalesces these handles where baseline fresh pointers did not. This is consistent with `docs/api.md`'s warning that wrapper identity is not general value equality; the direct `set()` result remains a separate handle. No stronger preservation of incidental compacted alias distinctions is claimed. Binary checkpoints also pass through that compaction rule. Existing shared-state/session change detection compares descriptors, so identical list writes now retain the current state handle and skip publication, version increments and subscriber callbacks; signed-zero changes still publish. This follows the documented descriptor-based rule in `docs/worker-sessions.md`.

## Deterministic checks

- `shared-list-noop-set.test.ts`: leaf/tail/depth boundaries; exact arena-byte savings and unchanged changed-write byte cost; retained source bytes and forks; signed zero and multiple NaN payloads; missing WASM nodes; frontier appends; growth and cached old views; validation and invalid indices; shared/copied read-only attachments; exhausted string interning; JSON/nested encoding; reentrant serialization; seeded historical updates.
- `proofs/noop-sequence-invariants.mjs <absolute dist/shared.js> baseline|reuse`: actual portable package, exact no-op arena deltas and source bytes, descriptors, handle identity and compaction coalescing. Run against both pinned builds.
- `proofs/noop-sequence-worker.mjs <absolute dist/shared.js>`: actual Node shared/copy workers, retained old/no-op handles, subsequent changed writes, forks, actual writer growth, compaction and read-only rejection in each transport.

Allocation reports count append-only shared-arena bytes, not JavaScript heap, RSS, peak backing buffers or recovered memory. Existing string interning remains bounded and equal uncached strings need not avoid allocation.

## Local correctness results

Bun 1.4.2 and Node 24.19.0 were used. WASM/portable/declaration builds and the main, Redux, value (both exact-optional-property settings), and geometry typechecks passed. The corrected focused Bun/Vitest run passes 109 tests; eight additional existing regression files pass 197 tests. This is 306 tests across 11 files, not a full-suite claim. All 53 new list tests also pass under Node/Vitest. The installed tarball consumer check passes Node/Bun exports, retained immutable snapshots, actual Node worker sharing, and strict TypeScript imports. Its first attempt could not create the unavailable default npm cache directory; the bounded retry used a writable `/tmp` cache and passed.

The first focused run had two test-assumption failures: Bun canonicalizes a noncanonical NaN even in a plain DataView getFloat64/setFloat64 round trip. Those failed logs remain preserved. Public setter expectations now use the unchanged WASM cons store as a same-engine boundary oracle. Separate test-only WASM i64-to-f64 adapters pass raw payloads directly into vecSet/tailSet and independently verify signed zeros and positive/negative quiet/signaling NaN payloads. A second independent static review found no masked semantic failure or adapter defect.

Both pinned baseline and candidate pass 75 public-package allocation fixtures under both Node and Bun. Baseline no-op updates allocate 8–640 shared-arena bytes per operation in those fixtures; all candidate deltas are zero. Both builds also pass actual Node shared/copy worker checks with retained old snapshots and actual writer growth. The separate state frame-count test uses the existing in-memory protocol harness and is not described as an actual worker test.

WASM imports/exports are unchanged. Numeric scalar/SIMD and geometry WASM are byte-identical to baseline. Core WASM grows 26,118 to 26,296 bytes (+178). The 12 portable JavaScript modules grow 227,310 to 227,550 bytes (+240, approximately 0.106%). Only persistent-core.as.ts differs among production/build sources.

## Prospective performance gate

No local timing until coordinated. A throughput study must pin the exact baseline/candidate sources and built package context, use the same neutral import path for each sequential fresh-process subject, retain matched direct baseline A/A, and execute exactly balanced ABBA/BAAB quartets. Independent quartet log latency ratios are the units for geometric-mean ratios and small-sample 95% t intervals; timed batches are not independent replicates. No A/A normalization, sample exclusion or favorable retries.

Predeclared material margin: candidate latency ratio 1.02. Upper interval bound at or below 1.02 supports within-margin behavior; lower bound above 1.02 detects a material slowdown; crossing the threshold is inconclusive. Retain absolute times, raw samples, source/package hashes, runtime versions, timing-floor flags, allocation/GC and bounded arena-capacity details. No-op gains cannot offset ordinary changed-write losses. Include tiny and full tails, multiple tree depths, changed and mixed updates, interned and uninterned strings/objects, and unchanged construction/read controls. Local Node 24 is not CI Node 22 equivalence.

### First x64 screen, frozen before timing

The first clean-CI screen is deliberately narrower than that broader study. It covers exactly 16 cells under Node 22 and Bun 1.4.2 on one x64 runner:

- Ten ordinary changed-write controls: numbers at tail lengths 1 and 32 and tree depths 0–3; Booleans and interned strings at tail length 32 and tree depth 2.
- Four repeated-write targets: numbers at tail length 1 and tree depth 3; Booleans at tree depth 1; interned strings at tail length 32.
- Two mixed targets: 50% number no-ops at depth 2 and 90% interned-string no-ops at depth 1.

No result from this screen establishes construction/read, uninterned-string/object, browser, ARM, whole-application or universal performance behavior. The broader coverage is a separate decision after this first screen, not an implied claim or automatically authorized rerun.

Every process has one build, one workload and one role. Sequential subjects copy their original package.json and portable modules into the same neutral package path. Exact source hashes, frozen runtime/test blobs, expected core WASM hashes, unchanged optional WASM and core import/export lists are enforced. A complete one-to-one module graph comparison allows only replacement of the expected embedded core WASM and the resulting content-addressed chunk references. A build receipt records both successful WASM and portable build commands, AssemblyScript 0.28.20, Bun 1.4.2, Node's version, build flags, build-script hashes and final module hashes. The final proof source hashes must equal the tested commit.

Each batch starts with a fresh arena and fixture. Both strings are interned before timing. The old source handle and newest result are retained through validation; previous batch handles are cleared, the current arena is replaced, and explicit GC runs outside timing. The timed loop repeatedly assigns the newest handle. Automatic GC, fresh public wrapper allocation and any WASM memory growth during that loop remain included. The initial fixture payload plus baseline bytes for every write is capped at 128 MiB, with at most 1,000,000 writes, rounded down to a multiple of 20. These are shared repeat limits even for a candidate that allocates no arena payload. Reserved backing size is reported separately and may exceed the payload cap; neither cap measures JS heap or RSS.

Separate baseline and candidate pilots pick a single common repeat count and common warmup batch count for A/A and A/B. Every measured subject then performs exactly that warm work followed by 11 batches. Warm timed work below 100 ms, any measured batch below 10 ms, or a pilot that hits the shared repeat cap before 10 ms makes the cell timing-inconclusive. A fast target cannot bypass its baseline allocation cap to clear the floor. There is no result-driven repeat extension or sample deletion.

For each comparison, four independent quartets execute exactly two ABBA and two BAAB orders. A/A and A/B ordering alternates by quartet. The geometric mean of quartet-mean paired log latency ratios is the estimand; two-sided 95% Student t intervals use df=3. These are unadjusted per-cell intervals, with no joint all-cases coverage claim. Process pairs and individual batches remain descriptive records. Direct A/A is never subtracted or used to normalize A/B. If the A/A role-ratio point estimate lies outside [1/1.02, 1.02] and its interval excludes 1, A/B is control-drift-inconclusive regardless of its nominal interval classification. All raw pilots, warmups, batches, allocation/backing-byte records and flags are retained, including partial output on failure.

The dedicated workflow builds both cores independently, checks declarations and all type configurations, runs the installed tarball check, full existing Vitest discovery, the explicit Node proof test, 75 invariant cases per build/runtime and actual Node shared/copy workers before timing. Its baseline checkout lives outside the repository, so there is no new global Vitest exclusion. The standalone test file is named `proofs/noop-sequence-tests.node.mjs` and is invoked with `node --test` explicitly.

Workflow success means that the diagnostic completed and its correctness checks passed. It does not mean that performance met the margin: material-loss and inconclusive classifications remain in the artifacts and require review before promotion. No-op gains cannot offset a changed-write loss.
