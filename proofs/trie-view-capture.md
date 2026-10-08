# Trie iterator view capture

Baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`. This is independent of sorted projections, list-block view capture, and the rejected trie scratch-allocation candidates. No latency measurements have been performed. The exact runtime tree is published as `47402ad2ec2ac7226831a577e6e224c555710af8`; the gate is a separate prospective proof commit.

## Runtime change and semantic argument

Only `Arena.leaves` and `Arena.radixLeaves` change. Each captures `this.dv` during its already-existing nonzero-root header read. All subsequent immutable node and journal-metadata reads in that invocation use the captured view. Each recursive journal-base iterator captures separately.

The definite-assignment assertion on `let dv!: DataView` expresses a local invariant: a nonzero root initializes the view before either traversal branch can use it; a zero root skips that read and the existing empty stack prevents any use. It does not add an eager getter, early return, allocation, or branch. The original stack expressions, HAMT lane/patch arrays, radix pending array, generator methods/prototypes, yields and initial `next()` laziness remain unchanged.

Every address reachable from a published root existed when the root was published. An arena is append-only, published bytes are immutable, and shared WebAssembly memory growth leaves old buffer views valid for their original length. A caller may grow memory before first `next()` or while a traversal is paused. Capturing happens after the former; the latter needs no newly appended addresses. Readers constructed from copied payloads also use shared WebAssembly memory internally. Existing raw WASM methods, root graphs, public map/set wrappers, decoding and caches are unchanged.

Executed allocation-expression counts do not measure generator-frame memory; adding a captured local may change its size or retention.

This proof assumes valid library snapshots and supported shared arenas. It makes no compatibility claim for externally corrupted roots, mutation of published memory, or instrumentation/overrides whose only purpose is observing the number of getter calls.

## Untimed validation

- `trie-view-capture.test.ts`: 14 new cases. Exact baseline-generator differential plus an independent recursive pointer-order oracle cover canonical HAMT/radix roots, collisions, overlays, ordinary and nested journals, overwrite/delete/reinsert histories, retained forks, Unicode, primitive/object/nested values, ordinary/natural/custom-sorted public projections and ordinary/sorted sets.
- Growth coverage: caller growth before first `next()`, actual writer allocation/growth while paused, two interleaved iterators, journal yields before recursive traversal, callback reentry, early `return()`/`throw()`, and read-only copied/shared attachments.
- `proofs/trie-view-mechanism.ts`: extracts the exact pinned baseline/candidate generator methods, instruments allocation expressions, and counts actual `dv` getter and `refresh` calls. Its complete-source guard admits only the listed capture substitutions. Across 32 fixtures and four consumption modes (128 observations), output pointer sequences, executed allocation expressions, source payload bytes and shared allocator positions match. Array-expression counts are not heap measurements.
- `proofs/trie-view-workers.mjs`: actual Node/Bun workers, both shared/copy transports, 18 structures, three arenas, two interleaved readers per map, caller growth before first read and actual writer growth while paused, source-byte checks, reader mutation rejection and zero reader allocation. Shared-mode readers exercise survival across memory growth; copy-mode readers demonstrate isolation while their writer grows. It also passes against the pinned main build.
- Bun: 148 focused tests across nine files pass. Node: all 14 new tests pass. WASM/browser/declaration builds; ordinary, post-declaration strict public worker-consumer, typed-value (both exact-optional modes), Redux and geometry type checks; installed-package Node/Bun exports, immutable-snapshot, Node-worker and TypeScript-consumer checks pass.
- All 12 rebuilt WASM files are byte-identical to the exact-main baseline build. Core WASM SHA-256 is `b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4`.

The strict worker command has 12 matching existing source diagnostics before declarations and passes on both builds after declarations; the gate requires the latter real public-consumer pass. The full standard Bun application suite and the explicitly scoped supplemental Node suite remain required in clean CI. Browser execution has not been run for this candidate. The baseline-only loader failure and precise Node exclusion are documented in [trie-view-gate.md](trie-view-gate.md). Focused success is not a full-suite or portable-performance claim.

### Mechanism counts

Each table cell is baseline → candidate getter calls; refresh counts are identical to getter counts. Full traversal of the named fixed fixtures:

| Trie / root | 0 entries | 1 entry | 32 entries | 4096 entries |
| --- | ---: | ---: | ---: | ---: |
| HAMT canonical | 0 → 0 | 2 → 1 | 50 → 1 | 5502 → 1 |
| Radix canonical | 0 → 0 | 2 → 1 | 40 → 1 | 4916 → 1 |
| HAMT + 3 journal edits | 6 → 1 | 9 → 2 | 88 → 2 | 9604 → 2 |
| Radix + 3 journal edits | 6 → 1 | 8 → 2 | 46 → 2 | 4922 → 2 |

Collision-two is 4 → 1. The 512-entry HAMT overlay fixture is 666 → 1. Nested journals each add one independently captured nonempty invocation. Generator creation and return/throw before first `next()` call neither getter in both builds.

All original array allocation expressions remain. For example, even empty/singleton HAMT traversal still executes one stack, one 16-element lane array, and one patch array. Canonical radix executes one stack. No shared allocation is introduced or removed. These are mechanism findings only; fewer refreshes do not prove lower latency.

## Prospective clean-CI gate

The first implemented gate is specified in [trie-view-gate.md](trie-view-gate.md). The frozen runtime is published commit `47402ad2ec2ac7226831a577e6e224c555710af8`, whose tree exactly matches the locally reviewed runtime. No local latency measurements have occurred. The gate retains the originally proposed 20 public-API cases and historical-risk controls, exact-source/bundle/WASM guards, full clean-CI prerequisites, physical neutral package paths, both-build pilots, fixed common work, four balanced A/B and baseline A/A quartets, 21 batches, pointwise 95% Student-t df3 intervals and a 2% loss margin.

Before timing, the prospective calibration was fixed at 40 ms target batches and 500 ms target warmup with 10 ms / 150 ms actual validity floors. All plans freeze before measured processes. A/A drift uses the geometric point outside [1/1.02,1.02] plus its interval excluding 1. Drift invalidates inference; it never normalizes A/B. No adaptive measured extensions, retries or sample exclusions are allowed. Complete/partial outputs and hidden workflow evidence are archived.

Initial scope is Node 22.23.3 and Bun 1.4.2 on x64. Inconclusive cells remain inconclusive; target improvements cannot offset control losses. ARM64 and separate Chromium/Firefox/WebKit correctness require review afterward. x64 evidence cannot resolve the historical Bun ARM risk or imply browser performance.

## Preserved adverse history and limitations

The older combined lazy-scratch candidate `5c8b066` was rejected after Node x64 patched-32 latency +5.18%, interval +4.39%..+5.98%, all eight pairs adverse. The narrowed empty/singleton-only candidate `04227cf` remained held: Bun ARM collision-two +2.40%, interval +1.18%..+3.63%, all quartets adverse, despite unchanged nontrivial loop bytes. Those studies, their original raw data and limitations remain applicable historical evidence. This candidate restores neither change and offers no retroactive reinterpretation of those results.

Initial validation failures are retained separately: a test used direct iteration on `SharedList` instead of `toArray()`; worker introspection initially relied on Bun's copy-default export; the first package check used an unavailable default npm-cache path. The corrected public API, explicit introspection transport and writable temporary npm cache pass. No production change was made to accommodate them.
