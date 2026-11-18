# Ordinary-read performance follow-up — November 18, 2026

The exploratory screens in this directory use baseline commit
`1242908762b554e3574365c486d5a6c52d5e568f`. After those screens, the earlier
accepted PRs #81 and #83 merged into main at
`4c69aef6e37b6bc955fc708d671e33b5a066ac7a`. Final ASCII byte-load confirmation
separately compared that newer main with candidate
`10bebf25d2a6ad01bb8203a19facc33c75c03190`. Its report retains these separate
identities; do not pool it with the older screens. The original screen evidence and patches remain
byte-for-byte unchanged, and this archive branch stays based on `1242908`.

This branch changes evidence files only. Applying an archived patch is an
explicit experimental step; none of its runtime changes is enabled by this
archive.

The completed three-pair screens were exploratory comparisons, not accepted
performance claims. Their purpose was to reject changes that improved a narrow
case while slowing another supported runtime or ordinary workload. A ratio
below `1` means the candidate took less time; a ratio above `1` means it took
more time. Ratios are medians of the paired candidate/baseline elapsed times,
not ratios of separately calculated medians.

## Decisions

| Candidate | Frozen source | Decision and reason |
| --- | --- | --- |
| Delay the Map lookup directory until a second query | `72d9ad0a421fbc72c4380667d08a3511819c53cb` | Rejected. One-query sessions improved, but multi-query sessions regressed. |
| Inline the delayed Map-directory decision | `5a00e4fa391e5eea1d4aeb92d3e5c395b5780335` | Rejected. Inlining retained the same tradeoff and did not resolve the multi-query regressions. |
| Decode short ASCII strings with four-byte DataView reads | `8144fbd39d486ce04f7d935011be978f81c6848d` | Rejected. Node improved in several cases, while Bun slowed in important List and Map-key cases. |
| Allocate Arena scalar scratch only when used | `5c155970f9354894c5a613612e69ad00d14404ce` | Rejected. Public attachment timings were mixed; avoiding three JavaScript allocations did not establish a reliable general latency improvement. |
| Decode Boolean List.get results directly | `333db44292d62b4660c7695d2e445efc5bd85c70` | Not promoted; no reliable broad benefit established by the initial 36-case screen and longer eight-case follow-up. |
| Decode short ASCII strings with grouped byte reads | `639335f59306ff532371cd84ad31c453f0680b56` for exploration; `10bebf25d2a6ad01bb8203a19facc33c75c03190` for current-main confirmation | Rejected. The four Node primary gates passed, but both Bun Unicode controls met the predeclared rejection rule. |

No candidate from this round was promoted, and no new runtime optimization PR was opened.
The earlier accepted PRs #81 and #83 remain separate, already merged work.

## Final confirmation: rejected on current main

The [fixed current-main plan](plans/ascii-current-confirmation-PLAN.md) required
seven alternating pairs per runtime, all 13 cases, eight warmups, and batch scale
2. Both the controller and every measurement process were restricted to CPU 2.
The A/A comparison used identical `4c69aef` artifacts; A/B compared those artifacts
with `10bebf2`. The candidate's Arena implementation and focused test exactly
match the earlier `639335f` donor. No further runtime variant was introduced.

All four primary Node workloads met the declared requirements: a median paired
ratio at most 0.90 and at least six faster pairs out of seven. The control rule
also applied to both runtimes: a ratio above 1.10 with at least six slower pairs
rejected the candidate. Bun's Unicode List and Map-key reads both crossed that
threshold. Their minimum batches exceeded 120 ms, so these failures were not
short-batch warnings. [Raw A/B report](results/ascii-current-confirmation.json.gz)
and [independent verification](results/ascii-current-confirmation-verified.json.gz).

| Confirmed workload | Runtime | Median paired ratio | Pair direction |
| --- | --- | ---: | --- |
| Fresh List reads, 16-byte ASCII | Node | 0.5706 | 7/7 faster |
| Fresh List reads, 32-byte ASCII | Node | 0.5627 | 7/7 faster |
| Fresh Map keys, 16-byte ASCII | Node | 0.7347 | 6/7 faster |
| Fresh Map keys, 32-byte ASCII | Node | 0.3432 | 7/7 faster |
| Fresh List reads, Unicode | Bun | 1.1110 | 6/7 slower |
| Fresh Map keys, Unicode | Bun | 1.2598 | 6/7 slower |

The separate [A/A report](results/ascii-current-aa.json.gz) also retained a
validity concern for Bun's warm 16-byte ASCII List reads: the nominal candidate
side was slower in six of seven pairs, with ratio **1.147499** and batches below
20 ms. A/B's corresponding warm row was **1.166951**, slower in five of seven
pairs, also with short batches. These observations remain visible; A/A was never
subtracted from or divided into the A/B results.

The [predeclared addendum](plans/ascii-current-warm-validity-ADDENDUM-20261118.md)
allowed a fixed longer warm-cache block only if the other gates stayed eligible.
The confirmed Unicode regressions disqualified it. **The extra warm-cache A/A
and A/B block was not run.** Its validity question remains unresolved, and it
cannot rescue the candidate's independent control failures. The preserved
addendum transcribes the earlier A/A ratio as 1.1468; the complete verified raw
report recomputes it as 1.147499. This small transcription difference changes
neither the validity HOLD nor the rejection, and the original addendum bytes
have not been edited.

### Examples that determined the rejected decisions

These selected rows explain the decisions. All cases, raw samples, warmup
settings, and slower cases remain in the reports below. Short batches are
explicitly flagged in those reports and should not support precise speedup
claims.

| Experiment and workload | Runtime | Median paired ratio | Interpretation |
| --- | --- | ---: | --- |
| Delayed Map directory, 100,000 entries, one query | Bun | 0.292 | Faster in the screen; batches were short. |
| Delayed Map directory, 100,000 entries, four queries | Bun | 1.190 | Slower in all three pairs. |
| Inline delayed directory, 100,000 entries, one query | Bun | 0.314 | Faster in the screen; batches were short. |
| Inline delayed directory, 100,000 entries, four queries | Bun | 1.235 | Slower in all three pairs. |
| DataView ASCII, fresh List reads of 16-byte strings | Node | 0.611 | Faster in this runtime and workload. |
| DataView ASCII, fresh List reads of 16-byte strings | Bun | 1.355 | Slower in all three pairs. |
| Lazy scalar scratch, one shared Arena attachment | Node | 1.125 | Slower in all three pairs. |
| Lazy scalar scratch, 32 shared Arenas plus first gets | Bun | 1.161 | Slower in all three pairs. |

Sources: `results/map-screen-v2.json.gz`, `results/map-inline-screen.json.gz`,
`results/ascii-screen.json.gz`, and `results/attach-screen.json.gz`.

## Preserved evidence

`results/` contains losslessly compressed copies of every original JSON report,
summary output, smoke run, failed run, independent-verifier output, and captured
formal-validation log. An empty or failed summary is preserved as originally written;
it is not silently replaced with a successful run. Original bytes and compressed
bytes have separate SHA-256 entries in each numbered inventory.

`harness/` contains the controller, workload modules, historical workload
versions, and independent report verifiers. The formal controller and verifier
are preserved under the distinct names `benchmark-ascii-formal.mjs` and
`ascii-verify-formal.mjs`; the original screen versions are untouched.
Each raw report records the exact
controller and workload hashes used for that run. `capture.mjs` refuses to finish
if any referenced harness version is absent.

`patches/` contains exact full-index, base-relative Git patches for each frozen
exploratory candidate, including its tests. They reconstruct the candidate from
the shared `1242908` baseline without depending on unpublished candidate commits.
The separate `ascii-byte-loads-current-10bebf2.patch` applies only the exact
`arena.ts` and `arena-string.test.ts` changes to baseline `4c69aef`. The measured
candidate commit also contains proof files; their evidence is archived separately
instead of repeating it inside the runtime/test patch. Whole source trees and
duplicate generated bundles are not copied into this archive; report source
and bundle manifests retain their exact measured hashes.

`plans/` preserves the original unrun confirmation plan, its current-main
replacement fixed before formal execution, and the conditional warm-cache
addendum. Their bytes are unchanged. Formal setup logs preserve both the
interrupted custom single-worker test attempt and the later ordinary successful
test run; an interrupted attempt is not counted as a successful validation.

Each `inventory-NNN.json` is a separate capture. Later captures may add new
reports, but the capture script refuses to replace any archived bytes that
differ from an existing file.

### Report history

| Files before the `.json.gz` suffix | Purpose and status |
| --- | --- |
| `map-smoke` | One-pair correctness smoke with the first Map workload. |
| `map-screen` | Incomplete first screen, retained with its error and any completed samples. Its directory-size assertion required all identical sessions to retain the same backing size and failed with `2 !== 1`; it is not performance evidence. |
| `map-screen-v2` | Completed three-pair screen after correcting that workload assertion; original workload retained as `map-workloads-v1.mjs`. |
| `map-inline-screen` | Completed three-pair screen of the inlined refinement using the corrected Map workload. |
| `ascii-smoke` | Failed first smoke on the baseline with `Cannot convert object to primitive value`; not performance evidence. |
| `ascii-smoke-v2` | Successful replacement smoke; the original workload remains as `ascii-workloads-v1.mjs`. |
| `ascii-screen` | Completed three-pair DataView ASCII screen. |
| `attach-smoke`, `attach-screen` | One-pair correctness smoke and three-pair lazy-scratch screen. |
| `boolean-smoke`, `boolean-screen` | Correctness smoke and initial 36-case Boolean-get screen. |
| `boolean-long-screen` | Longer eight-case Boolean-get follow-up, retained separately from the initial screen. It did not establish a reliable broad benefit. |
| `ascii-bytes-screen` | Three-pair byte-load refinement screen against `1242908`; retained separately from current-main confirmation. |
| `ascii-current-aa` | Seven-pair identical-artifact comparison on `4c69aef`, CPU 2, all 13 cases. Includes the unresolved short warm-cache validity HOLD. |
| `ascii-current-confirmation` | Seven-pair comparison of `4c69aef` with `10bebf2`, CPU 2, all 13 cases. Verified and rejected by the declared Unicode-control gate. |
| `ascii-current-validation-*` | Frozen build, typecheck, source/artifact identity, test, and worker-validation evidence from the measured source branch. |

Every corresponding summary and available verifier output is preserved too.
Consult the raw report's `complete`, `config`, `samples`, `harness`, and `variants`
fields before interpreting it. Do not pool different workloads, batch sizes,
revisions, or runtimes into a single claimed result.

## What the measurements cover

The shared controller runs baseline/candidate pairs serially in fresh Node and
Bun processes, alternates variant order, and rotates workload order. Both
runtimes import frozen portable `dist/shared.js` bundles rather than choosing
different source entry points. The source, WASM, bundle, dependency, and harness
manifests are captured before measurement. No original report path is reused.

The Map workload separates first-query, multi-query, warmed-reader, alternate-root,
missing-key, Unicode-key, and attachment-plus-read cases. The string workload
separates fresh and warmed readers, cache-overflow access, short ASCII boundaries,
Unicode, longer strings, ordinary List gets, and Map key iteration. The attachment
workload measures public `initWorker()` with one or 32 Arenas, shared or copied
payloads, with and without first gets; private `prepare()` controls are explicitly
labeled diagnostics. The Boolean workload separates sequential, shuffled, and
tail-boundary gets, fresh and primed readers, and number/string/object controls.

Actual timed values are retained in ordinary Arrays and checked afterward with
`Object.is`, including primitive leaves of complete object results. Object
controls also verify recursive freezing. Every distinct reader Arena has its
private used/capacity state checked; immutable byte checks deduplicate only shared
backing memory. The corrected harnesses check independent WASM instances too.
Historical workload versions retain their original checks, including failed
assertions; see their exact source and matching report hashes.

Construction, priming, explicit GC, and verification are outside the read timers.
Public attachment cases intentionally include `initWorker()` inside timing.
Attached readers run in the writer process; these results do not measure worker
launch, message transport, process startup, peak RSS, or application latency.
Integrity snapshots may warm CPU caches. Three-pair screens and batches below
20 ms are especially unsuitable for precise claims on a shared host. Formal
confirmation used seven pairs and fixed CPU affinity, as declared in its separate
plan; the old screen results retain their original scheduling and configuration.

## Reproduce an experiment

The recorded tool versions are Node **24.22.3**, Bun **1.4.2**, and Rust **1.100.0**.
The Rust toolchain and direct build dependencies are pinned by the baseline.
Use the recorded package versions, including its Binaryen build tool, and compare
the regenerated source/bundle hashes before attributing a different run to the
same source. The project has no JavaScript lockfile at this baseline, so the
recorded direct dependency versions alone do not pin every transitive package.

The commands below reconstruct an exploratory screen. For final confirmation,
use the separate instructions below. Create
two isolated worktrees from the baseline, and apply one archived patch to the
candidate. For example, from a checkout containing this archive:

```sh
archive_dir="$PWD/proofs/performance-followup-20261118"
git worktree add --detach ../followup-base 1242908762b554e3574365c486d5a6c52d5e568f
git worktree add --detach ../followup-candidate 1242908762b554e3574365c486d5a6c52d5e568f
git -C ../followup-candidate apply "$archive_dir/patches/map-directory-72d9ad0.patch"
```

Run the baseline's documented setup in each checkout, using the pinned Bun and
Rust versions: `bun install`, `bun run build:wasm`, and `bun run build:browser`.
The original experiments reused the same already-built baseline WASM for these
JavaScript-only changes. Rebuilding both through the audited `build:wasm` script
is also valid for a new comparison; preserve and compare the resulting hashes.
Raw Cargo intermediate output is not a replacement for that build script.

The original Boolean candidate checkout omits historical WASM aliases when
reusing the four canonical baseline artifacts. Its verifier recognizes only
`shared-map.wasm`, `shared-list.wasm`, `linked-list.wasm`,
`singly-linked-list.wasm`, `doubly-linked-list.wasm`, `ordered-map.wasm`,
`sorted-tree.wasm`, and `priority-queue.wasm` as optional aliases. Every present
alias must match that variant's `persistent-core.wasm` hash exactly. Canonical
artifacts and all other runtime sources remain strictly checked.

Then reproduce a three-pair screen with a new output filename:

```sh
node "$archive_dir/harness/benchmark.mjs" \
  --workloads "$archive_dir/harness/map-workloads.mjs" \
  --baseline ../followup-base --candidate ../followup-candidate \
  --bun /absolute/path/to/bun-1.4.2 \
  --pairs 3 --warmups 8 --batch-scale 1 \
  --output /absolute/path/to/new-map-screen.json
```

Choose the matching workload module and read each raw report's `config` to
reproduce its exact case selection and batch scale. A smoke run uses one pair,
zero warmups, and scale `0.015625`; it verifies execution and outputs, not speed.
Do not use the failed historical workloads as a replacement for their corrected
versions when evaluating a new candidate.

### Reconstruct the current-main confirmation

Create baseline and candidate worktrees at
`4c69aef6e37b6bc955fc708d671e33b5a066ac7a`, then apply
`patches/ascii-byte-loads-current-10bebf2.patch` only to the candidate. Build both
with the pinned tools as above. These source checkouts reproduce the runtime
and focused test; the preserved formal harness and plans remain in this archive.

The two formal studies used the following configuration, with distinct new
output paths. The second command is the candidate comparison; the first compares
the baseline with itself.

```sh
taskset -c 2 node "$archive_dir/harness/benchmark-ascii-formal.mjs" \
  --workloads "$archive_dir/harness/ascii-workloads.mjs" \
  --baseline ../followup-current-base --candidate ../followup-current-base \
  --bun /absolute/path/to/bun-1.4.2 \
  --pairs 7 --warmups 8 --batch-scale 2 \
  --output /absolute/path/to/new-ascii-current-aa.json

taskset -c 2 node "$archive_dir/harness/benchmark-ascii-formal.mjs" \
  --workloads "$archive_dir/harness/ascii-workloads.mjs" \
  --baseline ../followup-current-base --candidate ../followup-current-candidate \
  --bun /absolute/path/to/bun-1.4.2 \
  --pairs 7 --warmups 8 --batch-scale 2 \
  --output /absolute/path/to/new-ascii-current-confirmation.json
```

This is a reproducibility recipe, not a request for another attempt to promote
the rejected candidate. Do not normalize A/B against A/A or replace the recorded
decision with a selected favorable repetition.

The independent Map, ASCII, and Boolean verifiers accept `.json` or `.json.gz`
reports. For a completed Map report, for example:

```sh
node "$archive_dir/harness/map-verify.mjs" \
  "$archive_dir/results/map-screen-v2.json.gz" \
  --driver "$archive_dir/harness/benchmark.mjs" \
  --workloads "$archive_dir/harness/map-workloads.mjs" \
  --manifest-only
```

`--manifest-only` validates report structure, recorded manifest digests, harness
hashes, workload dimensions, and recomputed summaries. It does not prove that
files in a reconstructed checkout match the recorded source or bundles. Pass
`--baseline` and `--candidate` checkout paths without `--manifest-only` for those
additional content checks. Incomplete reports must remain rejected by the
performance verifiers.

For the formal ASCII reports, use `harness/ascii-verify-formal.mjs` with
`--driver harness/benchmark-ascii-formal.mjs` and the unchanged
`--workloads harness/ascii-workloads.mjs`; use paths rooted at this archive.
That verifier also enforces recorded CPU 2 affinity. The earlier screen verifier
is retained for the screen reports.

## Capture and archive validation

Only run `capture.mjs` when the measurement owner has released the CPU and stopped
writing reports. It copies small scripts and plans, compresses reports and logs
without modifying their original bytes, records hashes, checks harness-version
coverage, and records seven patches with their respective baselines. The initial
capture helper is preserved as `capture-v1.mjs`; numbered inventory 001 retains
its exact original files. Capture does not build, test, benchmark, commit,
publish, or create a PR.

`validate-archive.mjs` checks every numbered inventory, decompressed originals,
report-to-harness identities, and base-relative patch reconstruction using a
temporary Git index. It also checks that the current-main runtime/test patch
matches the earlier donor bytes, and that archive changes stay inside this proof
directory. Its recorded result is in `archive-validation.json`.

```sh
node "$archive_dir/validate-archive.mjs" --repo "$PWD"
```

Pass `--source /path/to/perf-harness-followup` to additionally compare archived
originals with the retained measurement directory. No runtime or test patch is
applied to the archive branch itself, and no source tree is duplicated here.
