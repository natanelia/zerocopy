# Reuse the memory view in sorted-map index walks

This change captures one DataView when a nonempty sorted-map index walk starts. The walk reuses that view for immutable index nodes. A DataView is JavaScript's view for reading bytes in an arena. Only `Arena.radixLeaves` changes production code.

For the index walk over 4,096 entries in a complete radix tree, memory-view requests change from **4,916 to one**. Key and value decoding keep their existing work. This is an executed-call count, not a claim about JavaScript heap size or process memory.

The current x64 study establishes lower latency for large number-entry traversals. It does **not** clear the whole performance gate. Fifteen cells remain statistically inconclusive, and one Node same-version control triggers the declared drift rule. The empty sorted-map Bun control is estimated **2.765% slower [0.708%, 4.864%]**. Its interval crosses the declared 2% slowdown limit, so it remains unresolved.

## Correctness and source identity

- Baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`.
- Measured runtime: `c79c803bf7c59a2fc559e43ce7cc74aa4dacde15`.
- The PR updates this evidence document and removes a Git-history dependency from the test fixture. Production code, regression-test assertions, WASM inputs and the public API remain unchanged from the measured runtime.
- [Sealed correctness run](https://github.com/natanelia/zerocopy/actions/runs/37873312900): pristine baseline 753/753, pristine candidate 768/768, and the same 15 semantic tests added to baseline all pass. The artifact contains 46 complete command receipts, builds, type and package checks, actual workers, and exact sources. Existing five-second test timeouts were retained.
- [Timing run](https://github.com/natanelia/zerocopy/actions/runs/37875343311) imports those exact complete builds. It does not relabel the prior suites as newly run tests.

The generator keeps its method shape, lazy first access, yield order and early return/throw behavior. Each recursive journal walk captures its own view. Shared memory can grow while iteration is paused because every published pointer already fits in the captured view. Empty roots keep their prior behavior. Tests cover immutable bytes, forks, callback reentry, interleaved iterators, growth before and during iteration, natural/custom key order, Unicode keys, values and nested snapshots, plus shared/copied workers.

The first normal PR checks at `0ef7afd` exposed a fixture integration error: shallow checkouts could not load the pinned baseline commit through `git show`. The fixture now stores the exact baseline generator methods and checks each method SHA-256 before use. All 15 semantic tests pass in a source archive with no Git repository under both Node 22.23.3 and Bun 1.4.2. The method bytes and existing assertions are unchanged. This is a test setup fix; no workflow, timeout or production code was changed. The original [failed integration job](https://github.com/natanelia/zerocopy/actions/runs/37878466423/job/113652368776) remains recorded.

ARM and browser performance have not yet been measured for this candidate. A future portability diagnostic cannot replace this complete x64 study or erase its unresolved cells. Normal PR checks apply to the actual PR head and are separate from the evidence below.

## Reproduce and interpret the study

The benchmark uses Node 22.23.3 and Bun 1.4.2 on Linux x64, AMD EPYC 7763. The [frozen method and recovery adapter](https://github.com/natanelia/zerocopy/blob/ac7f07a139422bd2fd6e8637c2792c38ece9c4a3/proofs/radix-timing-recovery.md) pin the subjects, source archives, bundles, dependency/compiler identities and sealed input. The [original fixed catalogue](https://github.com/natanelia/zerocopy/blob/ac7f07a139422bd2fd6e8637c2792c38ece9c4a3/proofs/radix-view-plan.json) includes all 20 workloads, including controls.

The complete audited outcome follows. A negative latency change means less time. These pointwise confidence intervals do not give a simultaneous guarantee for every workload. No same-version control adjusts a baseline/candidate result, and no large gain offsets a possible control slowdown.

# Radix-only timing recovery: complete execution, inconclusive acceptance

Run: https://github.com/natanelia/zerocopy/actions/runs/37875343311
Published proof: `ac7f07a139422bd2fd6e8637c2792c38ece9c4a3`
Reviewed tree: `834d9e35e2343332ebf30beecd8317e81b6e84e4`
Runtime pair: main `3773c6e519c7c0958da13727ed1082f449f3ee25` versus radix-only `c79c803bf7c59a2fc559e43ce7cc74aa4dacde15`

The frozen all-cell x64 performance gate does not pass. Node is `control-drift-inconclusive`; Bun is `statistical-inconclusive`. Both complete studies pass their execution/integrity validators. The target gains below do not override control drift or cells whose intervals cannot exclude a material loss. There is no basis here to label the whole change within the declared 2% margin.

## Main findings

- Node: baseline A/A canonical HAMT full entries drifted +2.107%, pointwise 95% interval [+1.301%, +2.920%], invalidating inference for that cell. Six other cells remain inconclusive against the 2% loss margin.
- Bun: all A/A checks passed; nine cells remain inconclusive against the 2% loss margin.
- No usable cell establishes a material loss. This is not equivalent to proving every cell within margin.
- All batch/warmup validity floors passed. There were no failed subjects, command timeouts, interruptions or live cleanup survivors.
- Every target is within the material-loss margin. All three Node targets and two Bun targets establish lower latency; iterating keys in a sorted map with object values does not establish a gain on Bun.

## Targets

Changes below are candidate latency relative to baseline; negative means lower latency. Intervals are pointwise two-sided 95%, unadjusted across the catalogue.

| Runtime | Workload | Baseline absolute | Candidate absolute | Latency change [95% interval] | Gain established |
|---|---|---:|---:|---:|---|
| node | `map/radix/object/4096/canonical/keys` | 4.088 ms | 3.927 ms | -3.899% [-4.518%, -3.276%] | yes |
| node | `map/radix/number/4096/journal/entries` | 1.238 ms | 1.067 ms | -13.657% [-15.106%, -12.183%] | yes |
| node | `map/radix/number/4096/canonical/entries` | 985.650 µs | 840.567 µs | -14.596% [-15.633%, -13.546%] | yes |
| bun | `map/radix/object/4096/canonical/keys` | 3.706 ms | 3.688 ms | -0.770% [-1.983%, +0.458%] | no |
| bun | `map/radix/number/4096/journal/entries` | 630.491 µs | 601.167 µs | -3.366% [-5.625%, -1.053%] | yes |
| bun | `map/radix/number/4096/canonical/entries` | 470.241 µs | 420.212 µs | -12.264% [-17.656%, -6.518%] | yes |

Absolute values are medians of process medians for one complete named public operation, not per entry. Paired quartet log ratios determine the relative estimate and interval, so the displayed absolute medians need not divide to the reported ratio.

## Every cell, retained without selection

### node: control-drift-inconclusive

| Workload | Role | A/B latency change [95% interval] | Baseline A/A change [95% interval] | Outcome |
|---|---|---:|---:|---|
| `map/hamt/number/4096/canonical/get` | control | -0.001% [-0.038%, +0.036%] | +0.034% [-0.091%, +0.158%] | evidence within margin |
| `map/hamt/object/4096/canonical/keys` | control | +0.119% [-0.217%, +0.456%] | -0.884% [-3.090%, +1.372%] | evidence within margin |
| `map/hamt/number/4096/canonical/first` | control | -0.721% [-1.345%, -0.094%] | -1.745% [-3.783%, +0.336%] | evidence within margin |
| `set/hamt/number/0/canonical/values` | control | +0.288% [-2.908%, +3.589%] | -0.738% [-2.273%, +0.821%] | inconclusive |
| `map/radix/object/4096/canonical/keys` | target | -3.899% [-4.518%, -3.276%] | -0.371% [-1.498%, +0.769%] | evidence within margin |
| `set/hamt/number/1/canonical/values` | control | -1.696% [-7.339%, +4.290%] | -0.531% [-3.036%, +2.039%] | inconclusive |
| `map/hamt/number/4096/canonical/entries` | control | +0.808% [-0.087%, +1.712%] | +2.107% [+1.301%, +2.920%] | A/A drift; inference unusable |
| `map/radix/number/0/canonical/entries` | control | +3.536% [-7.353%, +15.705%] | +1.156% [-1.400%, +3.778%] | inconclusive |
| `map/radix/number/1/canonical/entries` | control | -8.600% [-11.811%, -5.273%] | +0.086% [-2.629%, +2.878%] | evidence within margin |
| `map/hamt/number/0/canonical/entries` | control | -0.243% [-2.854%, +2.438%] | +0.837% [-1.500%, +3.230%] | inconclusive |
| `map/radix/number/4096/canonical/get` | control | -0.233% [-1.001%, +0.541%] | -0.015% [-0.081%, +0.051%] | evidence within margin |
| `set/radix/number/0/canonical/values` | control | -0.262% [-1.047%, +0.528%] | +0.145% [-2.369%, +2.724%] | evidence within margin |
| `map/hamt/number/2/collision/entries` | control | -1.882% [-12.859%, +10.477%] | -0.164% [-4.072%, +3.902%] | inconclusive |
| `set/radix/number/1/canonical/values` | control | -6.760% [-8.277%, -5.219%] | -0.080% [-1.217%, +1.070%] | evidence within margin |
| `map/hamt/number/32/patched/entries` | control | -0.583% [-1.246%, +0.084%] | +1.134% [-0.816%, +3.122%] | evidence within margin |
| `map/radix/number/4096/journal/entries` | target | -13.657% [-15.106%, -12.183%] | +0.753% [-1.674%, +3.239%] | evidence within margin |
| `map/hamt/number/4096/patched/entries` | control | -3.059% [-7.698%, +1.813%] | -0.939% [-2.929%, +1.092%] | evidence within margin |
| `map/radix/number/4096/canonical/entries` | target | -14.596% [-15.633%, -13.546%] | -1.392% [-5.474%, +2.867%] | evidence within margin |
| `map/radix/number/4096/canonical/first` | control | -13.461% [-15.135%, -11.754%] | -1.949% [-5.108%, +1.317%] | evidence within margin |
| `map/hamt/number/1/canonical/entries` | control | +1.672% [-0.473%, +3.863%] | -0.137% [-3.432%, +3.271%] | inconclusive |

### bun: statistical-inconclusive

| Workload | Role | A/B latency change [95% interval] | Baseline A/A change [95% interval] | Outcome |
|---|---|---:|---:|---|
| `map/hamt/number/4096/canonical/get` | control | -0.311% [-1.590%, +0.985%] | -0.658% [-3.547%, +2.317%] | evidence within margin |
| `map/hamt/object/4096/canonical/keys` | control | -1.215% [-2.531%, +0.119%] | -0.016% [-1.784%, +1.783%] | evidence within margin |
| `map/hamt/number/4096/canonical/first` | control | +0.416% [-3.309%, +4.284%] | -0.640% [-1.886%, +0.622%] | inconclusive |
| `set/hamt/number/0/canonical/values` | control | +0.391% [-0.824%, +1.622%] | +0.537% [+0.037%, +1.039%] | evidence within margin |
| `map/radix/object/4096/canonical/keys` | target | -0.770% [-1.983%, +0.458%] | -0.530% [-2.145%, +1.112%] | evidence within margin |
| `set/hamt/number/1/canonical/values` | control | -0.180% [-3.033%, +2.756%] | +1.628% [-3.658%, +7.204%] | inconclusive |
| `map/hamt/number/4096/canonical/entries` | control | -0.753% [-3.268%, +1.828%] | +0.028% [-2.205%, +2.311%] | evidence within margin |
| `map/radix/number/0/canonical/entries` | control | +2.765% [+0.708%, +4.864%] | +1.848% [-2.571%, +6.469%] | inconclusive |
| `map/radix/number/1/canonical/entries` | control | -1.835% [-4.039%, +0.420%] | +1.148% [-2.163%, +4.570%] | evidence within margin |
| `map/hamt/number/0/canonical/entries` | control | -0.431% [-1.463%, +0.610%] | -0.152% [-3.342%, +3.143%] | evidence within margin |
| `map/radix/number/4096/canonical/get` | control | +0.132% [-1.302%, +1.587%] | +0.045% [-0.003%, +0.093%] | evidence within margin |
| `set/radix/number/0/canonical/values` | control | -2.544% [-9.988%, +5.515%] | +0.886% [-3.836%, +5.840%] | inconclusive |
| `map/hamt/number/2/collision/entries` | control | -1.213% [-5.024%, +2.751%] | -0.477% [-0.911%, -0.041%] | inconclusive |
| `set/radix/number/1/canonical/values` | control | -2.339% [-10.686%, +6.789%] | +0.853% [-3.268%, +5.150%] | inconclusive |
| `map/hamt/number/32/patched/entries` | control | +0.974% [-2.593%, +4.670%] | -1.783% [-7.971%, +4.821%] | inconclusive |
| `map/radix/number/4096/journal/entries` | target | -3.366% [-5.625%, -1.053%] | +0.325% [-3.981%, +4.823%] | evidence within margin |
| `map/hamt/number/4096/patched/entries` | control | +2.007% [-3.306%, +7.611%] | -2.141% [-8.272%, +4.400%] | inconclusive |
| `map/radix/number/4096/canonical/entries` | target | -12.264% [-17.656%, -6.518%] | -0.254% [-1.199%, +0.701%] | evidence within margin |
| `map/radix/number/4096/canonical/first` | control | -5.975% [-8.431%, -3.454%] | -0.321% [-1.309%, +0.677%] | evidence within margin |
| `map/hamt/number/1/canonical/entries` | control | -1.155% [-7.184%, +5.265%] | +0.920% [-0.632%, +2.496%] | inconclusive |

## Independent audit

Each lane contains all 20 frozen cases, 40 pilots, 640 measured subjects and 13,440 measured batches: 1,360 total subjects and 26,880 measured batches across both runtimes. All 680 children per lane exited successfully and have verified cleanup with zero live survivors. All raw stdout/stderr hashes, original command chronology, physical-package manifests, output oracles, immutable-byte guards and zero-reader-allocation checks validate. Default runtime flags remained intact.

The original record verifier accepts both records. A separate Python implementation recomputed process medians, adjacent-pair log ratios, four independent quartet means, df=3 Student-t intervals, floor flags, A/A drift and final gate labels directly from the archived raw subject JSON. It agrees with every saved cell and both final conclusions. No batch was dropped or treated as an independent replicate.

The ZIP digests and inner tar sidecars verify. The complete 488-file timing-proof source archive matches the published Git tree, including executable modes. The exact sealed correctness input and every extracted byte, all 46 receipts, full source maps, bundles, WASM/compiler pins and baseline semantic overlay revalidate in both lanes. Its original failed-study history has identical SHA-256 `8e813b37829366c99b9b074dbf208a56bca6403c778a9b3a15f0aafddf4abf6c` in both artifacts.

Original run 37867002724 remains failed/cancelled before timing. Successful correctness recovery run 37873312900 remains the imported source of 753/753 baseline, 768/768 candidate and 15/15 overlay results; those suites were not rerun for timing. The earlier combined-trie adverse evidence remains in that retained history.

## Artifact identities

| Runtime | Artifact ID | ZIP SHA-256 | Inner tar SHA-256 |
|---|---:|---|---|
| node | 11592627895 | `6817b302cd433e719e97b57824c7333accec66e501d30003ffb1d6a83caa5c25` | `07e079b4b1a1d7bc3f7eb890a33b207db615f1e41c8bceaa8332a3885618130b` |
| bun | 11592144067 | `a10390ccb4406b8154597b67bbbf3f2e8780776aa09ec9c0231f85a91bd0dfe5` | `5d21615280edebb9c7cf6ac21989d8ea7d722162839f5d5debb7cefe38a64032` |

Raw inputs and process records are available in the linked Actions artifacts. Complete audit copies are retained separately. No reruns, source tuning, public mutations or local latency measurements were performed during monitoring/audit. This x64 evidence does not establish ARM or browser performance.


<details>
<summary>Historical preparation record, before the successful CI recovery</summary>

The following record is preserved as history. Its then-pending checks and environment descriptions are superseded by the current results above. Earlier failures remain failures.

# Radix-only iterator view capture

This is one structural narrowing of the held combined candidate. The runtime is pinned main `3773c6e519c7c0958da13727ed1082f449f3ee25` with only the exact `Arena.radixLeaves` method from `47402ad2ec2ac7226831a577e6e224c555710af8`. `Arena.leaves` and every other production byte stay at main. No local latency collection, CI dispatch, push, or pull request belongs to this preparation.

## Scope and semantic argument

The original nonzero-root header read captures one `DataView` per radix generator invocation. That invocation uses it for immutable node and journal metadata. Recursive journal-base generators capture independently. Zero roots retain their existing empty stack, with no eager getter. Published reachable pointers existed before capture; append-only shared WASM growth preserves the old view for its original length. A new iterator captures after any growth before its first `next()`.

The generator method, prototype, initial laziness, yield order, journal pending-array sort/merge, existing stack allocation and recursive control flow are exact held bytes. The HAMT implementation, including its empty-path stack/lane/patch allocation and getter sites, is fully restored. This is not a flag, layout, early-return, threshold, scratch, helper, or loop-tuning experiment. It assumes valid immutable library snapshots and supported shared arenas, including internally shared memory used for copied attachments; corrupted or externally rewritten published nodes are outside that contract.

`radix-view-source.mjs` verifies all 450 pinned-main tracked files and admits exactly this method substitution plus the explicitly named test/proof additions. `trie-view-mechanism.ts` independently pins the entire arena source to the same substitution, instruments the extracted baseline/candidate methods, and requires identical HAMT call counts and all executed allocation expressions. These expression counts are not JS-engine heap-allocation measurements and imply no latency result.

## Untimed verification

The reused fixtures cover 32 root shapes and four consumption modes (128 observations), including empty/singleton/canonical roots, HAMT collisions/overlays as unchanged controls, edited roots, ordinary and nested journals, forks, and completion/first-next/return-before-next/throw-before-next. Every complete radix traversal asserts exactly one getter/refresh per nonempty recursive invocation. Full canonical radix getter/refresh counts at 0, 1, 32 and 4096 entries are respectively 0→0, 2→1, 40→1 and 4916→1. HAMT counts are baseline→same-baseline in every observation. All pointer sequences, original executed array expressions, published bytes and shared allocation positions match.

The semantic suite retains the exact baseline-generator differential and an independent recursive pointer oracle. It checks generator descriptors/prototypes, creation and initial return/throw laziness, early close, callback reentry, interleaved iterators, growth before first `next()` and while paused, recursive journals, public ordinary/natural/custom projections, primitives, objects, nested maps/lists and sets. One added independent UTF-8 test checks natural byte ordering, empty/NUL/BOM/multibyte keys and lone-surrogate replacement in journal and flushed canonical roots.

The original actual-worker helpers are retained byte-for-byte. They cover shared and copied transport, 18 structures across three arenas, two interleaved readers per map, writer growth before first read and actual writer allocation/growth while paused, read-only rejection, published-byte preservation and zero reader shared allocation. Shared readers survive growth; copied readers stay isolated.

Local validation uses Bun 1.4.2 and Node v24.19.0. Node v22.23.3 is not installed here and remains a future exact-CI prerequisite. Full standard Bun means `bun run test`, never Bun's built-in test runner or full source Vitest under Node. Build/type/package/worker receipts and initial failures are retained separately in the durable preparation evidence. Validation is recorded in the final exact manifest; no browser execution, ARM correctness or performance claim is made.

### Local outcomes and open correctness prerequisite

- Passed: 139 focused tests across nine trie/map/set/UTF-8/immutable/nested files, including all 15 candidate semantic tests; 128 mechanism observations; exact-source proof; WASM/browser/declaration builds; ordinary, strict post-declaration worker, typed-value (both exact-optional modes), Redux and geometry types; installed-package Node/Bun exports, immutable snapshot, actual Node worker and TypeScript consumers.
- Passed: the two actual trie-worker transports under both Node and Bun, plus existing built Node worker, Redux and typed-JSON worker proofs. The same trie-worker helpers also pass against the existing pinned-main build under Node and Bun. All 12 rebuilt WASM hashes and all four complete compiler-package hashes equal the prior pinned-main identities.
- Full standard Bun attempt: 763 passed, five 5-second timeouts in unchanged tests: geometry attached snapshots after growth; numeric-spatial attached snapshots after growth; typed JSON worker reconstruction/compaction; Redux checkpoint writable set restoration; and Redux checkpoint writable ordered-set restoration.
- One bounded recheck of those four files: 84 passed, six 5-second timeouts. The first three repeated, while the Redux timeouts moved to writable map, linked-list and doubly-linked-list restoration. Both raw logs remain intact. No cause is assigned from this alone, and no timeout was tuned. A queued broad repeat was cancelled before it started. Package validation interrupted during that cancellation was rerun once as a separately named final check and passed.

The full suite is therefore not a pass. Focused and worker success do not waive the outstanding clean-CI full-standard-Bun prerequisite on both exact builds before any timing pilots or PR. No local latency experiment was collected; ordinary command/test durations in validation receipts are execution metadata.

## Preserved adverse evidence

The combined runtime and all prior artifacts remain untouched. Its Bun x64 run `37850139130`, gate `d7e097270fe80e785c6b7740f73f366d1ad3cb83`, has independently recomputed empty HAMT entries +3.779% latency, pointwise 95% interval [+3.330%, +4.231%], approximately 58.2→60.3 ns, with valid floors and baseline A/A. That detected material loss is retained. Canonical radix full entries improved 10.572%, interval [8.204%, 12.879%], but those are results of the combined runtime, not this narrower one.

Six other combined cells were inconclusive against the 2% loss margin: HAMT warmed get; empty HAMT set values; radix object keys; empty radix map entries (+4.503%, interval [+0.720%, +8.429%]); singleton radix map entries; and empty radix set values. They remain in the catalogue. The old Node job failed at the supplemental baseline source-loader worker test and never reached pilot/timing. The earlier rejected lazy-scratch and held empty/singleton candidates and their raw artifacts also remain unchanged. Structural restoration does not prove that the HAMT control regression disappears: generated package layout and engine context can still affect unchanged methods.

## Prospective full-catalogue gate sketch

`radix-view-plan.json` records all 20 original cases in their original order, descriptions, construction, operation, sizes and shapes. It preserves the prior gate's exact configuration and two modes, A/B and independent baseline A/A. Only the three former HAMT targets (canonical full entries, patched full entries and object keys) become unchanged controls. All HAMT cells are labeled unchanged controls; the radix warmed get remains an unchanged-path control. The resulting catalogue has 17 controls and three radix targets. Keep all rows and all failed, partial, slow or inconclusive observations; do not choose favorable radix cells.

Retain four balanced ABBA/BAAB quartets per mode, 21 batches per process, process-median paired latency ratios averaged in log space within each quartet, exponentiated mean and pointwise two-sided 95% Student-t intervals with df=3. Batches are not independent replicates. Keep the 2% material-loss margin and the original A/A drift rule; never normalize A/B by A/A or trade a control loss against a target gain. Retain 40 ms batch planning target, 500 ms warmup planning target, actual 10 ms batch and 150 ms warmup validity floors, original pilot/calibration/call caps, fixed common work from both-build pilots, default JIT flags and all integrity checks. The old draft's different floors and candidate-A/A proposal were not the executed protocol and are not silently substituted here.

Before any future run, explicitly name and freeze the prerequisite repair: remove the unsupported full Node-source Vitest invocation and retain the full standard Bun suite for both builds, post-declaration strict worker consumers, installed-package validation and actual built Node/Bun worker proofs. If a targeted supplemental source suite is retained, declare its supported loader scope prospectively rather than adding exclusions after results. The already prepared Node-scope repair `ee7bcf4daaf192836f2b31dba635d0e7e92c66b5` is prior work, not a measurement of this candidate. Changing any timings, controls, validity floors, statistics or acceptance rules would be a separate protocol change requiring its own rationale before dispatch.

A future gate must pin the new runtime/test/proof commit, both exact source trees, neutral package paths, bundles, WASM/compiler identities, retained workload/oracle bytes, the relabeling above, prerequisite scope and acceptance rules before any pilot. No gate harness or workflow has been published for this narrowing. The parent task owns publication and any subsequent review decision; portable claims still require separately declared ARM and browser evidence.

</details>
