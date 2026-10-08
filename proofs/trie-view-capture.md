# Trie iterator view capture

Baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`. This is independent of sorted projections, list-block view capture, and the rejected trie scratch-allocation candidates. No timings or publication have been performed for this candidate.

## Runtime change and semantic argument

Only `Arena.leaves` and `Arena.radixLeaves` change. Each captures `this.dv` during its already-existing nonzero-root header read. All subsequent immutable node and journal-metadata reads in that invocation use the captured view. Each recursive journal-base iterator captures separately.

The definite-assignment assertion on `let dv!: DataView` expresses a local invariant: a nonzero root initializes the view before either traversal branch can use it; a zero root skips that read and the existing empty stack prevents any use. It does not add an eager getter, early return, allocation, or branch. The original stack expressions, HAMT lane/patch arrays, radix pending array, generator methods/prototypes, yields and initial `next()` laziness remain unchanged.

Every address reachable from a published root existed when the root was published. An arena is append-only, published bytes are immutable, and shared WebAssembly memory growth leaves old buffer views valid for their original length. A caller may grow memory before first `next()` or while a traversal is paused. Capturing happens after the former; the latter needs no newly appended addresses. Readers constructed from copied payloads also use shared WebAssembly memory internally. Existing raw WASM methods, root graphs, public map/set wrappers, decoding and caches are unchanged.

This proof assumes valid library snapshots and supported shared arenas. It makes no compatibility claim for externally corrupted roots, mutation of published memory, or instrumentation/overrides whose only purpose is observing the number of getter calls.

## Untimed validation

- `trie-view-capture.test.ts`: 14 new cases. Exact baseline-generator differential plus an independent recursive pointer-order oracle cover canonical HAMT/radix roots, collisions, overlays, ordinary and nested journals, overwrite/delete/reinsert histories, retained forks, Unicode, primitive/object/nested values, ordinary/natural/custom-sorted public projections and ordinary/sorted sets.
- Growth coverage: caller growth before first `next()`, actual writer allocation/growth while paused, two interleaved iterators, journal yields before recursive traversal, callback reentry, early `return()`/`throw()`, and read-only copied/shared attachments.
- `proofs/trie-view-mechanism.ts`: extracts the exact pinned baseline/candidate generator methods, instruments allocation expressions, and counts actual `dv` getter and `refresh` calls. Its complete-source guard admits only the listed capture substitutions. Across 32 fixtures and four consumption modes (128 observations), output pointer sequences, executed allocation expressions, source payload bytes and shared allocator positions match. Array-expression counts are not heap measurements.
- `proofs/trie-view-workers.mjs`: actual Node/Bun workers, both shared/copy transports, 18 structures, three arenas, two interleaved readers per map, caller growth before first read and actual writer growth while paused, source-byte checks, reader mutation rejection and zero reader allocation. Shared-mode readers exercise survival across memory growth; copy-mode readers demonstrate isolation while their writer grows. It also passes against the pinned main build.
- Bun: 148 focused tests across nine files pass. Node: all 14 new tests pass. WASM/browser/declaration builds; ordinary, strict worker, typed-value (both exact-optional modes), Redux and geometry type checks; installed-package Node/Bun exports, immutable-snapshot, Node-worker and TypeScript-consumer checks pass.
- All 12 rebuilt WASM files are byte-identical to the exact-main baseline build. Core WASM SHA-256 is `b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4`.

Full application suite and browser execution have not been run for this candidate. Focused success is not a full-suite or portable-performance claim.

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

## Prospective clean-CI gate proposal

Freeze the runtime, workloads, source/bundle/WASM/compiler hashes, protocol and acceptance rules before execution. Both exact-source builds must first pass full application tests, types, package, differential mechanism and actual-worker checks in clean CI. Initial screen: Node 22.23.3 and Bun 1.4.2 on x64, 20 public-API cells per runtime:

1. Ordinary/natural-sorted numeric map `entries()` at 0 and 1 entries: four controls.
2. Ordinary/sorted set `values()` at 0 and 1 values: four controls.
3. HAMT collision-two and patched-32 map `entries()`: two historical-risk controls.
4. Ordinary/natural-sorted 4096-entry map first `next()` then `return()`: two early-exit controls.
5. Ordinary/natural-sorted 4096-entry map warmed existing-key `get()`: two unchanged-path controls.
6. Four full-entry targets: 4096-entry canonical HAMT, patched HAMT, canonical radix, and radix with four pending journal edits.
7. Ordinary/natural-sorted object map `keys()` at 4096 entries: two targets with unchanged decode behavior.

Use one build and one operation per fresh process, physically identical neutral package/import paths and context, exact guarded bundles, default JIT flags/randomness, common iterations and warmup work frozen from both-build pilots, and no instrumentation in timed bundles. Keep workloads/output checksums and immutable-byte/allocation checks outside timing. Record every process, batch, error, plan and build receipt, including partial results on failure.

Run four balanced ABBA/BAAB quartets for A/B, independent baseline A/A and candidate A/A. Use process-summary quartet log latency ratios, exponentiated mean and pointwise two-sided 95% t intervals (df=3); batches are not independent replicates. Report absolute latency and A/A directly; never divide A/B by A/A. Use a prospectively fixed 2% material-loss margin: upper interval ≤1.02 is within margin; lower interval >1.02 is detected material loss; otherwise inconclusive. Do not count inconclusive cells as passes or trade control losses against target gains. Report multiplicity/precision limits.

Pilot for at least 40 ms estimated measured batches and 300 ms equal warmup work, with fixed maxima before pilots; require every actual measured batch ≥20 ms and actual warmup ≥200 ms. Any floor/cap/subject/integrity failure invalidates that cell's acceptance without erasing its data. A/A drift is flagged when its 95% interval is entirely outside [1/1.02, 1.02]; no result-driven rerun or retuning. This is a proposal, not an implemented or dispatched benchmark.

Only after the initial screen is reviewed should the exact same 20 cells be considered on ARM64 and separate Chromium/Firefox/WebKit correctness (shared/copy actual workers, growth and interruption) be run. ARM evidence is required before claims covering the earlier Bun ARM risk; broader browser performance needs separately declared browser timing. Do not automatically expand or treat an x64 screen as portable acceptance.

## Preserved adverse history and limitations

The older combined lazy-scratch candidate `5c8b066` was rejected after Node x64 patched-32 latency +5.18%, interval +4.39%..+5.98%, all eight pairs adverse. The narrowed empty/singleton-only candidate `04227cf` remained held: Bun ARM collision-two +2.40%, interval +1.18%..+3.63%, all quartets adverse, despite unchanged nontrivial loop bytes. Those studies, their original raw data and limitations remain applicable historical evidence. This candidate restores neither change and offers no retroactive reinterpretation of those results.

Initial validation failures are retained separately: a test used direct iteration on `SharedList` instead of `toArray()`; worker introspection initially relied on Bun's copy-default export; the first package check used an unavailable default npm-cache path. The corrected public API, explicit introspection transport and writable temporary npm cache pass. No production change was made to accommodate them.
