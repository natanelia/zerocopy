# Prospective sorted-map deletion screen

Status: accepted prospective plan, revision 1, 2026-10-09. Revision 1 fixes untimed minimum to literal ladder[0] before any execution; the original plan is preserved as PLAN.original.md. No implementation, build, gate, untimed subject, calibration, performance clock, or GitHub write has been run for this screen. The cases below are selected from the reviewed mechanism and its adverse paths, without latency observations. Nine workload cases produce 18 runtime/case cells. The ninth case, cold large hits, is explicitly retained because it exercises a central changed path.

This is a bounded exploratory public-API screen, not a performance acceptance, release, merge, browser/ARM claim, or substitute for final PR CI and independent review. Its first deliverable after any authorized execution is the complete original result, including losses, floors, failures, and inconclusive cells.

## 1. Exact source and prior evidence

| Role | Commit | Tree |
| --- | --- | --- |
| Baseline, pinned main | `2e88bc4a53871476da9ca1ec4e6c374b61512436` | `11ad61e759f07f69fac6a5c6fa34ccb283a7563b` |
| Repaired runtime, provenance | `c3f6d9949f93982a5958c044adb2e23c148d601f` | `9032fcaeb5d286f36fcbca0cd580457881ff516e` |
| Candidate execution source, repaired runtime plus final regression tests | `b8de24177667cb3d674256a01ee82619129fe1a6` | `8868209153a7c62d369f2a0ead9b290ee09eb443` |

Use the final candidate test head as the candidate arm for fresh builds, full gates, and measurement. Record its repaired-runtime ancestor separately. Do not describe a gate of an earlier runtime/test head as a gate of this arm. Later main changes require separate integration review and cannot silently relabel either pinned arm.

Read source:

- `/workspace/scratch/e7ec22ef2609/zerocopy-sorted-delete-fusion-20261009/{arena.ts,persistent-core.as.ts,shared-sorted-map.ts,shared-map.ts,compaction.ts,read-cache.ts,shared.ts,memory.ts,sorted-delete.test.ts,package.json,vitest.config.ts}` and the exact Git diff against baseline.
- `/workspace/shared/zerocopy-sorted-delete-validation-20261009/repair/REPORT.md` and `MANIFEST.json`.
- `/workspace/shared/zerocopy-sorted-delete-fusion-review-20261009/REPORT.md`.
- Accepted measurement/admission packet at `/workspace/scratch/e7ec22ef2609/zerocopy-native-key-ci-20261009/proofs/native-key-ci/`: `README.md`, `protocol.json`, `subject.mjs`, `math.mjs`, `controller.py`, `ci.py`, and `report.mjs`.

No applicable repository `AGENTS.md` or `.agents/skills`/`.codex` skill file was found in these checkouts. The original shared checkout and accepted packet remain unmodified.

The reviewed mechanism changes three runtime files: a canonical-root fused WASM removal, its JavaScript/cache adapter, and returned-size plumbing. Normal cold/warm hits have two exported calls versus one; stale/known-token hits have three versus one. A cold absent lookup has **zero versus one**, and is intentionally adverse. Exact-root negative cache hits remain zero versus zero. Counts are mechanism evidence, not speed estimates.

The original candidate caused a real deep-prefix exception/cache regression. Preserve its source, failed output, and the unchanged independent reproducer alongside the repaired evidence. The repair recovers lookup state with iterative `radixFind` only on a caught fused failure. Do not delete, relabel, rerun to replace, or weaken that evidence. Do not change tests, worker settings, or timeouts to obtain admission.

The prior artifacts cost +761 core WASM bytes and +2,778 portable-JS bytes. They are shipped-file sizes, not heap, RSS, allocation savings, or startup measurements. Preserve those costs in any result summary.

## 2. Reuse the accepted packet

Create a separate proof directory/workflow only after this plan is accepted for implementation. Proposed names are `proofs/sorted-delete-ci/` and `proof/sorted-delete-fusion-screen-20261009`; these are prospective names, not existing or published objects.

Reuse `controller.py` and `math.mjs` byte-for-byte. Reuse the report's paired-block formulas, A/A diagnostics, per-cell flags, and whole-run admission requirement. Adapt only case metadata/units/provenance. Adapt `subject.mjs` for the fixed public deletion fixtures below; preserve its lifecycle, clock guard, calibration/measurement rows, diagnostics, and fresh-chunk cleanup. Do not invent another scheduler, statistical package, pooling model, process manager, or failure retry path.

Adapt `ci.py` narrowly for this proof's namespace and exact source/build identities. Its native-key-specific assertions cannot simply be copied: the candidate now changes three runtime files plus `sorted-delete.test.ts`, is not a direct child of baseline, and deliberately changes the persistent-core WASM. Replace those assumptions with the exact commit/tree chain and reviewed file-diff allowlist. Preserve all fresh-gate, receipts, envelopes, cleanup, deadlines, tool equality, source freeze, and run-admission checks.

Fresh build verification must account for nine aliases of the changed core and unchanged optional WASMs. Reviewed unique core hashes are baseline `b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4` and candidate `b3ddc5838d9b5c56fa60cc33fc211528df0c970717089da8558321cca9163a3a`. Freeze all fresh emitted JS/WASM/declarations. An unexplained mismatch against the reviewed core with the pinned compiler is an admission blocker to investigate, not permission to adjust the expected digest during a run.

Both runtimes import their arm's official portable `dist/shared.js`; do not benchmark Bun's source export against Node's built export. Use Linux x64, Node **22.23.3** and Bun **1.4.2**, with exact binary/compiler/library hashes. Node uses the accepted `--expose-gc` option, not a reduced stack, in performance subjects.

## 3. Fixed cases and units

Initial values are finite numbers equal to their deterministic input indices; the explicit stale/journal updates below use fixed different numbers. Keys and query arrays are constructed before timing and frozen/hash-checked. No random input, adaptive key choice, input parsing, output traversal, cache inspection, source construction, compaction, or explicit GC is inside a timed body.

The primitive timed body indexes prebuilt source handles and query arrays, calls public `.delete(query)`, and stores the returned snapshot in a preallocated output array. Cyclic cases use the fixed index rule rather than allocating one tuple/record per call; the cached-miss case needs only 16 query strings regardless of its work count. It does not read or traverse output roots, chain results, call `has`/`get`, or inspect `size` inside the clock. All output root/size use is afterward. Units are **nanoseconds per public delete call**, including common loop/index/reference-store overhead; do not subtract a separately timed loop or divide by tree size. Record total body milliseconds and public-call count too. Setup time and process wall time are not delete latency.

The fixed work ladders count calls, not maps, nodes, bytes, or batches. `untimed-minimum` must use that case’s literal first ladder entry, and `untimed-maximum` must use its literal last entry. A hard-coded one-call minimum is forbidden. Timed work must use an exact ladder entry.

| ID | Retained source / query state | Fixed work ladder | Purpose |
| --- | --- | --- | --- |
| `sorted-cold-hit-16` | Canonical size 16; 16 distinct keys queried once per root, initially unseen in its owner | 16, 256, 2,048, 16,384, 65,536 | Small cold-key hit including ordinary staging and cache population |
| `sorted-cold-hit-4096` | Canonical size 4,096; all 4,096 distinct keys queried once per owner, then another fresh owner | 256, 1,024, 4,096, 16,384, 65,536 | Large cold-key hit; central changed traversal path |
| `sorted-warm-hit-4096` | Canonical size 4,096; 1,024 positive exact-root cache slots primed via public `has` | 64, 512, 4,096, 16,384, 65,536 | Repeated normal hit at an unchanged source root |
| `sorted-stale-hit-4096` | Two canonical size-4,096 roots in one owner; same 1,024 keys exist in both; alternate roots for each key | 64, 512, 4,096, 16,384, 65,536 | Every call sees a positive slot for the other retained root |
| `sorted-cold-miss-4096` | Canonical size 4,096; 2,048 distinct never-seen absent keys per fresh owner | 256, 1,024, 4,096, 16,384, 65,536 | Intentionally adverse staging/export cost; no cached token or read slot for the queried key |
| `sorted-cached-miss-4096` | Canonical size 4,096; 16 exact-root negative slots with retained positive key-leaf addresses | 1,024, 8,192, 65,536, 524,288, 4,194,304 | Fast identity-return control distinct from new misses |
| `sorted-journal-hit-4096` | Size 4,096; four pending changed-value keys over a canonical base; target is another existing key, warmed on journal root | 16, 64, 512, 4,096, 16,384 | Unchanged journal materialization/removal route |
| `sorted-long-hit-16` | Canonical size 16; target length exactly 16,385 UTF-16 units; one positive exact-root slot | 16, 64, 512, 4,096, 32,768 | Unchanged long-key guard/fallback route |
| `map-delete-control-4096` | Unrelated canonical `SharedMap` size 4,096; fixed 1,024 existing targets, unchanged short-key deletion path | 64, 512, 4,096, 16,384, 32,768 | Meaningful unchanged shared-core operation/code-layout control |

The cached-miss maximum is large because it allocates no result snapshots or arena nodes. Its preallocated output references consume about 32 MiB at eight bytes each, before runtime-specific array overhead; the 512 MiB process cap still applies. The fallback and unrelated allocating maxima are lower than the main hit maxima.

This is nine targeted workload cases, not the complete size × cache × key/value factorial. Keep every case separate in both raw data and interpretation. Do not combine journal with long-key results, pool warm with cold, or let an aggregate improvement cancel a cold-miss loss.

## 4. Fixture and cache protocol

### Common source and key shape

For ordinary sorted fixtures, use ASCII keys `gGGGG/kIIII`, with uppercase placeholders replaced by lowercase hexadecimal digits padded to four characters. There are 11 UTF-16/UTF-8 units per key. `GGGG` identifies a small-map group; `IIII` is its index. Small maps contain indices 0–15. Large maps contain indices 0–4,095 at group zero. Input order is ascending index; query order is ascending index unless an explicit alternate-root sequence is specified below. This fixed shallow, shared-prefix shape is not a pathological deep-prefix or randomized-key claim.

Build immutable source templates through public constructors and `set` before any body. Use public `compact` or `compactMany` to construct each measured chunk's canonical writable owners. Source inspection shows why this gives truthful cold state: every compactor creates a fresh `Arena`; it copies leaves and constructs indexes without `Arena.key`, `radixFind`, `has`, or `get` on the target. New target `keys` is empty and `reads` is undefined. Constructor size comes from the descriptor. Source-side reads and caches do not transfer into the compacted target.

Read-only diagnostic access to an owner's tag, used bytes, key-token map, and `ReadCache` is allowed outside timing to verify the label, as in the accepted subject. Diagnostics must not call a lookup to establish coldness. No test hook, internal cache clear, private field assignment, direct WASM call, manually fabricated root, or scratch/heap mutation may create a measured fixture. Public APIs perform all state construction and measured work.

### Cold small hits

Prebuild one template of 128 independent 16-entry maps with group IDs 0–127. `compactMany` puts one copy of this template, or the required prefix of it, into a fresh cohort owner. Query each root's 16 keys once from that retained root. Root keys are disjoint inside a cohort, so earlier maps cannot warm later maps. One cohort contains at most 2,048 unique queried keys; this stays within the 2,048 key-token limit, 16,384 read-slot limit, 262,144 retained token-byte limit, and 131,072 read-cache character limit. Larger chunks use fresh independently compacted cohorts, at most 32 at 65,536 calls.

This is **cold-key deletion in a batch of small retained maps**, not a new WASM instance for every delete. Only the first call per cohort pays first `ReadCache` construction. Template creation, instantiation, compaction, and pooled-owner setup are excluded from the body. At a smaller ladder entry build only the required complete 16-entry roots/cohorts; do not allocate a maximum pool for every level.

### Cold large hits

Each owner is a fresh public compaction of the same size-4,096 template. Call `source.delete(k)` once for each distinct source key, retaining the original source for every call. Work below 4,096 uses the fixed ascending prefix. Larger work uses complete 4,096-key sweeps in fresh owners, up to 16 owners.

Every queried key is unseen before its one operation. The first call per owner allocates the `ReadCache`; this is amortized across its sweep. The ordinary 2,048-token retention cap is reached halfway through a complete sweep. Later key tokens are newly computed but not retained; positive read slots continue to populate, reaching 4,096 slots / 45,056 characters. Record this normal cap behavior explicitly. Do not claim all 4,096 tokens were retained or covertly enlarge the cache. This case therefore includes the shipped large-cold-sweep budget transition.

### Warm large hits

Use one fresh canonical owner per chunk. Prime the first 1,024 source keys with `source.has(key)` before timing; verify positive leaf addresses and each slot's root equals the retained source. Cycle those keys during the body. Every call uses the same retained source, and deletion primes/preserves that source's slot rather than the returned result's slot. Do not query returned versions until after timing.

### Stale large hits

Prepare public templates A and B of size 4,096 that differ only in the numeric value of sentinel key index 4,095: A contains 4,095 and B contains 8,191. Use public `compactMany({A, B})` each chunk to place both canonical roots in one fresh owner. The two roots must be distinct; target indices 0–1,023 must exist with identical values in both. Prime all target slots using A's public `has`.

The body sequence is `B.delete(k0), A.delete(k0), B.delete(k1), A.delete(k1), ...`, cycling keys after 1,024 pairs. Each slot starts on A, then each call changes the slot's root to its source. Thus every measured call is stale relative to that key's prior cache root, without an intervening timed read or cache mutation. Returned versions remain separate. After timing verify both sentinels and retained snapshots still have their expected values, as well as deleted-key absence in results.

### Intentionally adverse cold misses

Use a fresh compaction of the large canonical template for every group of at most 2,048 misses. Query `g0000/k0/HHH`, where `HHH` is a three-digit lowercase hexadecimal counter 0–2,047. These 12-unit keys are absent and have `/` at the first varying radix byte of the fixed existing-key shape. The expected missing branch must be established by read-only tree inspection in untimed admission. This deliberately makes the baseline's JS miss short while the candidate stages bytes and enters fused WASM.

Every query is unique within its owner and no query appears in the source. It therefore has neither a pre-existing token nor a read slot at entry. Unrelated misses are never inserted in `ReadCache`; the 2,048 unique token count stays within its own retention budget. Work greater than 2,048 uses fresh owners, at most 32, with no owner reused by another chunk. Every returned value must be the exact source object. This is not a repeated same-key token-warm miss disguised as a cold miss.

### Exact-root cached misses

Start with a canonical 4,112-entry source containing the ordinary 4,096 keys plus doomed keys `'doomed' + hex4(i)` for i = 0–15, with values 4,096 + i. Prime the doomed keys through public `has`. Delete them in ascending i through a public chain outside timing to produce a canonical size-4,096 source. Call that final source's `has` for every doomed key outside timing. Verify each existing slot has the final root, leaf zero, and a nonzero immutable `keyLeaf` from when the key existed. New misses alone cannot create these slots.

The body cycles the 16 doomed keys against the same final source. All results must be the exact same object, no arena bytes may be allocated, and the exact-root negative slots must remain intact. Do not model this as repeated new-key misses.

### Journal and long-key fallbacks

Journal: compact the ordinary large template, then update the values of existing keys i = 0–3 to 8,192 + i through four ascending public `set` calls. Verify the resulting root's tag is `0xffffffff`, its pending count is exactly four, and size is 4,096. Warm target key index 256 through public `has` on that journal root. Repeatedly delete this target from the same original journal snapshot. Each result must be canonical and have size 4,095; the original journal root/pending payload must remain unchanged. No operation may carry a materialized result into the next call. This measures repeated public fork deletion and its unavoidable per-call journal fold, not amortized chain deletion.

Long key: construct 16 distinct keys as `'L'.repeat(16381) + hex4(index)`, producing exactly 16,385 UTF-16/ASCII units each. Compact the map to make its root canonical, then warm only key zero with public `has`. Repeatedly delete that key from the retained source. The query exceeds the 16,384-unit guard by one, so every call takes the established fallback. One cached long key uses 16,385 characters, below the character budget; do not prime all 16 and accidentally introduce another cache-cap regime.

### Unrelated control

Build and compact a numeric `SharedMap` with the same 4,096 ordinary short keys, then repeatedly delete targets 0–1,023 in ascending cyclic order from the retained root. This uses unchanged HAMT deletion in the same built shared-core artifact, with real immutable result allocation. Its short-key adapter stages the key and calls `mapDeleteBytes` regardless of read-cache state; do not call it a warmed sorted-cache path or add irrelevant public reads. Record its actual cache state before and after without forcing it into sorted-map semantics. This is solely a control inside this packet, not a reopening or publication of held HAMT work.

## 5. Ownership, correctness, and chunk lifecycle

Each chunk owns its new writable compaction arena(s). No reader attachment is made writable, no arena addresses are reset/reused, no data from one arm enters the other, and no process runs both arms. Templates may be retained across chunks as immutable setup sources; measured owners and outputs may not. Keep every measured source live through post-body validation, and release all measured outputs/owners before cleanup. Public reset replaces a default arena only after its templates/holders are released; it never resets a live owner's allocator.

Apply the accepted explicit GC before a body after setup/pool creation and after releasing the chunk; it is outside timing. Record RSS and arena capacity/used bytes outside timing. Bound **each arena at 64 MiB**, subject RSS at **512 MiB**, controller RSS at **256 MiB**, and subject output at **8 MiB**. Also record summed capacity across live measured owners so per-arena limits cannot conceal a large pool. A resource cap violation is a failure, not permission to reduce work after calibration results are seen.

For each chunk:

1. Prepare the required pool and preallocated result array, establish the case's public cache state, perform GC, and assert preconditions. Hash retained published payload bytes `[65536, usedBefore)` and immutable inputs; scratch below 65536 is deliberately excluded. Record owner count, root kind/size, selected-query digest, retained bytes/capacity, token counts/bytes, and relevant cache-root/leaf state.
2. Only explicit `calibrate` or `measure` mode reads the performance clock around the fixed public-call loop. `untimed` has no performance-clock reads. No timer wraps setup/compaction as a delete result.
3. Before any validating lookup can alter cache state, capture post-body cache diagnostics. Check every returned handle's size and identity relation and, for allocating cases, its owner relation. Check every deleted query is absent from its result using public APIs after timing. For all miss results, check exact source identity; after identity is established for every call, repeated equal source/query pairs may share one absence check, so the cached-miss case needs only 16 such lookups. Keep the result array until this check finishes so calls/results remain observable. Its retained references and all live result snapshots count against the same resource ceilings.
4. Validate retained source contents and payload hashes, plus source/result full-entry models at fixed positions (first, middle, and last result of the chunk, deduplicating equal positions). Small-map sources can be validated fully because their total source entry count is bounded by public-call count. Avoid a quadratic full traversal of a 4,096-entry result for every call. Check result order for sampled sorted results against an independent sorted JavaScript model. Check representative retained no-op set identity only after all cache diagnostics are recorded.
5. Check input digests, budgets, and no growth for misses, emit bounded summary/digests, release output/owner references, and collect. Keep full per-call metadata only when necessary for a failed assertion; do not emit millions of duplicate success records.

Untimed admission executes minimum and maximum work once for all nine cases in all four arm/runtime combinations, using the same setup/body/validation code as timed subjects. It must verify the true cache labels and root kinds, not merely matching final sizes. Include small untimed fallback-miss, old-root, empty/singleton, Unicode/BOM/surrogate, and read-only rejection assertions in the subject's correctness prelude or an existing exact reviewed fixture; none becomes a tenth timed case. Preserve the accepted actual deep-trap evidence separately. A new replay of that reproducer, if desired for fresh admission, requires a predeclared exact one-pass command/cap and must not replace the original evidence.

Do not instrument or wrap WASM exports in the timed subject. Existing accepted call-count receipts explain the mechanism. If an additional call-count check is needed during implementation review, it must be a separate untimed instance and must not mutate the instance later measured.

## 6. Source-only practicality and finite budgets

The design avoids a new arena per call. At each maximum the cold-small case has 65,536 total source entries across 32 cohorts; cold-large has 65,536 across 16 owners; cold-miss has 131,072 across 32 owners. Templates need at most 2,048 small-map entries or one large map and are reused as immutable construction sources. Warm/stale/fallback/control cases use one measured owner per chunk. No pool scales with the 4.2-million cached-miss call count.

The chosen ordinary keys are short and have at most four varying hexadecimal positions; cold-hit pools and retained roots do not contain the prior 16,000-level trap shape. With radix nibbles and at most 17 child bits, a branch consumes at most 88 aligned bytes. For the fixed size-4,096 hex shape, at most six varying high/low nibble decisions occur on a path, so a conservative six-branch deletion bound is 528 bytes per call before existing payloads/other fixed overhead. At 65,536 calls this is about 33 MiB of new branch storage, distributed among owners for cold cases. The four-entry journal fold plus deletion is bounded by the same fixed shallow shape and its lower 16,384-call maximum. This is a source-derived sizing rationale, not a measured allocation or peak-memory claim; the exact maximum fixture must pass unchanged untimed caps before clocks.

Compaction and validation are real process costs even though excluded from body latency. The maximum cold-miss pool copies twice as many source entries as the cold-hit pools. It could still make a calibration/measurement subject hit its wall/RSS cap, or the body could remain below the duration floor. Keep that result as failure/inconclusive. Do not silently expand maxima, lower chunk floors, trim correctness checks, cut warmups, shorten the screen, or rerun a selected case. Source/preparation defects found before any latency execution may be repaired and reviewed with an explicit plan revision; preserve the original plan and failed preparation.

Reuse these accepted bounds:

- Entire hosted job: 90 minutes. Work deadline: 82 minutes after preflight, reserving artifact time.
- Runtime setup actions: two minutes each; fresh dependency/Chromium setup stage: six minutes.
- Fresh full standard gate: 15 minutes per exact arm, plus only the fixed two-second cleanup grace.
- Source/tool freeze and each pre-screen admission pass: two minutes within the work deadline.
- All four untimed subjects: six minutes aggregate; each subject also has the accepted 90-second process cap.
- Calibration plus all 32 measurement subjects: the full original 35-minute controller budget. Calibration subject cap 180 seconds; measurement subject cap 90 seconds; two seconds for owned-group termination.
- Start the screen only if its complete 35-minute budget plus cleanup fits the remaining work deadline. No shortened attempt.

Nine cases share each subject process, so the 90-second measurement cap is for all nine cases, their 32 warmup chunks and seven samples each, plus setup/validation/cleanup. It is not 90 seconds per cell. Runtimes/arms are run sequentially by the controller. No concurrent benchmarking or unrelated build workload is admitted in the measurement job.

## 7. Fresh gates before any performance clocks

Both exact execution commits require separate clean worktrees, fresh installs using the same frozen dependency lock snapshot, and fresh official WASM, browser/portable JS, declaration, and type builds. No symlink to the current local worktree's dependencies or accepted artifacts is an admission shortcut. The pinned standard gate and the accepted adapter cover:

- Full Vitest unit/integration suite with repository testTimeout 5,000 ms, teardownTimeout 1,000 ms, thread pool, isolation, parallelism, and worker settings unchanged.
- Generic, Redux, typed-value (both optional-property settings), geometry, and public worker-task type checks.
- Actual Node worker task lifecycle, list query and regression, and lazy memory proofs.
- Documentation link/data tests, preservation check against the pinned baseline, Markdown examples, Chromium documentation/worker correctness, and typed worker examples.
- Built Node worker/Redux/typed-JSON entry points, installed npm-tarball validation, and historical-evidence verification.

Use installed compiler/Playwright CLIs, preserving the accepted non-resolving command paths. A passed full gate must have every expected exact command, source directory, exit-zero receipt, verified log hash, complete stage envelope, and verified owned-process-group cleanup. A prior gate, another arm's pass, a focused repair test, a historical timeout exception, or a later rerun cannot admit this run.

Only after both gates and source/tool/build freeze pass may untimed subjects run. Only after all four original untimed subjects and a fresh admission verification pass may calibration read the performance clock. Source/tool/build identity is checked before and after the screen. Missing whole-run final verification blocks all supported gain/loss/exclusion decisions while retaining raw ratios.

## 8. Fixed design, uncertainty, and decisions

Reuse four fresh paired process blocks per runtime, each with two independently fresh baseline and two independently fresh candidate processes. Block orders are ABBA, BAAB, ABBA, BAAB; runtime orders alternate Node/Bun then Bun/Node as in the accepted packet. This gives 32 measurement processes overall, not four samples treated as 32 independent observations. Case rotation by block is inherited unchanged.

Common calibration uses all predeclared ladder levels in both arms, 32 warmup chunks at maximum work and three samples per level. For each runtime/case choose the smallest common call count whose median body is at least 12 ms in **both** arms; otherwise keep the common maximum and flag the floor. Never choose work separately by arm or stop collecting a ladder when one arm looks favorable. Calibration is not inferential evidence and cannot select/drop cases.

Measurement uses 32 warmup chunks and seven measured samples per process. Preserve 200 ms minimum warmup body, 5 ms minimum measured body, final two eight-chunk warmup-window drift threshold 10%, and sample relative-MAD threshold 5%. A faster body that falls below a floor stays flagged; do not enlarge work in a rerun.

For block b, compute `L_b = (log(C0) + log(C1) - log(B0) - log(B1)) / 2` from the four process medians. The candidate/baseline latency ratio is `exp(mean(L_b))`, and the pointwise 95% interval is `exp(mean(L_b) ± 3.182446305284263 * sd(L_b) / sqrt(4))`, with **df = 3**. Blocks, not seven chunks or individual deletes, are the inferential units.

Preserve within-arm A/A diagnostics: any block replicate ratio differing by more than 5%, or an A/A four-block interval excluding one, flags that runtime/case. Missing blocks, source/admission failure, resource failure, calibration/warmup floors, drift, variability, and A/A flags remain visible and make that cell inconclusive.

With clean diagnostics and complete original whole-run admission only:

- Interval lower bound above 1.02 supports a material loss in that cell.
- Interval upper bound below 0.95 supports a worthwhile gain in that cell.
- Otherwise an upper bound below 1.02 excludes a 2% loss pointwise, while worthwhile gain remains unresolved.
- All other intervals are inconclusive.

All intervals are exploratory and pointwise. There is no multiplicity correction, omnibus speed claim, browser/ARM inference, or aggregate acceptance score. Report the nine cases for each runtime, absolute latency and ratios, every original flag/failure, selected common counts, owner/cache state, and the adverse cold-miss cell prominently. A control failure is not a result to omit.

## 9. Default-off, original attempt, and preservation

Implementation must start with activation false. Verification/syntax/deterministic proof tests must never reach a performance-clock mode, installation, standard gate, network mutation, or hidden child run. Preserve the native packet's default-off proof and original-attempt checks; extend deterministic tests only for the changed case/provenance assumptions and clock guard.

A separately reviewed packet digest/commit precedes any activation. A separate activation child may change only its activation file to true and reference that reviewed parent/digest. Require the exact repository, new restricted proof branch, clean tracked source, activation-only diff, current source pins, and `GITHUB_RUN_ATTEMPT == 1`. The plan itself authorizes neither implementation execution nor publication/activation. Do not reuse, modify, trigger, or publish PR 24/25, cache, ASCII, HAMT, or other held workflows to obtain a runner.

No automated reruns, reused output directory, failed-slot replacement, resumed incomplete ledger, changed thresholds, or repeated activated push is allowed. Retry/repair of a failed hosted study is a new explicit decision with all original evidence retained, not continuation of attempt 1.

Use `always()` preservation/upload and 30-day retention for full raw JSONL, stdout/stderr, ledgers, original failed/pending slots, gate/source/tool receipts, source archives, exact builds, protocol, inputs/digests, calibration levels, selected work, analysis, and inventory. Preserve the author repair and independent original-failure/deep-trap provenance; link their identities without relabeling them as fresh screen results. If cleanup leaves a writer unresolved, preserve partial logs but mark quiescence/hashes unknown, skip stable-copy claims, and prohibit subsequent subjects. Disclose hard runner termination or storage/upload loss.

## 10. Explicit exclusions and stopping point

This initial screen excludes first import/parse/compile/instantiation, first-ever Arena-read latency as a separate case, first-use allocation per call, browser and ARM latency, read-only/worker transport latency, recursive-trap latency, allocation-failure latency, empty/singleton timing, comparator sorting, Unicode/malformed/long-within-guard staging latency, value-type factorials, changing-root deletion chains, journal/long-key miss timing, known-token-without-read-slot timing, and the full small/large × cold/warm/stale matrix. These are not supported by another cell's result.

Startup/instantiation, fallback misses, Unicode staging, and broader workload/platform coverage remain explicit open controls before any broader performance acceptance. Do not claim this plan clears them. Existing correctness evidence and untimed fallback checks do not establish their latency. No physical-memory or allocation-saving claim is planned.

The current authorized task stops with this prospective plan. A later authorized original screen stops after complete result/preservation or a terminal failed/inconclusive attempt, with no outcome-driven rerun. Any implementation, new preparation revision, further experiment, external publication, promotion, merge, or release requires its own applicable authorization and exact-source review.
