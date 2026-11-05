# Rejected experiment: reusable UTF-8 scratch for numeric map keys

**Rejected after the complete two-pair Node/Bun screen; no runtime PR.** All six numeric Unicode workloads improved in both Node pairs, but every one was slower in both Bun pairs. The unchanged JSON control was also slower in both pairs on each engine. The candidate did not meet the cross-runtime performance goal, so no six-pair confirmation or further variant was run. The final branch contains evidence only; active production, tests and CI match the baseline.

The strongest Node result was the 1,024-key short-Unicode insertion operation: 0.650187 to 0.354039 ms, paired ratio **0.5438**. Bun moved in the opposite direction: 0.274519 to 0.315355 ms, ratio **1.1492**. Bun ordered insertion moved from 0.264158 to 0.389256 ms, ratio **1.4637**. These complete-operation observations do not establish a general ranking of the encoding APIs.

## What was tried

Only two non-ASCII numeric-key branches in `Arena.setNumber` and `Arena.writeNumber` changed. Keys with at most **16,381 UTF-16 code units** used the existing `encodeUtf8ForWrite` helper; longer keys retained `TextEncoder.encode`. Both 49,144-byte checks and all generic fallback arguments stayed intact. The generic helper, ASCII loop, WASM, storage format and public API were unchanged.

The threshold was declared before timing: UTF-8 replacement encoding requires at most three bytes per UTF-16 unit, so 16,381 units need at most 49,143 bytes. Surrogate pairs consume two units for four bytes; lone surrogates keep their existing replacement semantics. This bound avoids an added partial encoding pass for long or oversized controls. See the exact [runtime source](source/arena.ts.txt), unchanged [UTF-8 helper](source/utf8.ts.txt), [regression tests](source/numeric-key-scratch.test.ts.txt), and [prospective plan](PLAN.md).

The helper already owns a lazy **49,152-byte ordinary buffer per module**. First use can allocate it, including in numeric-only workloads that previously did not activate this buffer. Eligible calls avoid a fresh temporary payload buffer but still create a small view and copy bytes into the existing shared scratch. No JavaScript heap/RSS saving, zero-allocation write, removal of that copy or cold-start benefit was measured or claimed. Using ordinary scratch preserves engines that reject shared encoder destinations and the existing missing-`encodeInto` fallback.

## Full screen

Each row has two independent process pairs. Times are marginal medians of process medians in **milliseconds per complete operation**, not per individual `set`, except the one-write case. Ratios are candidate/baseline geometric means of paired process-median ratios; lower is faster. AB then BA are shown separately. Marginal percentage changes need not equal the paired percentage. These are screening estimates, not a six-pair confirmation; no inferential confidence interval was calculated from two pairs.

| Runtime | Workload | Before ms | Candidate ms | Paired ratio | AB ratio | BA ratio |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node | `map-unicode-short` | 0.650187 | 0.354039 | 0.5438 | 0.5085 | 0.5814 |
| Node | `map-unicode-medium` | 0.718550 | 0.544617 | 0.7583 | 0.7657 | 0.7510 |
| Node | `map-unicode-one` | 0.000505048 | 0.000283037 | 0.5601 | 0.5430 | 0.5777 |
| Node | `map-unicode-replace` | 0.672891 | 0.441095 | 0.6553 | 0.6612 | 0.6495 |
| Node | `ordered-unicode-short` | 0.670467 | 0.451648 | 0.6728 | 0.7002 | 0.6465 |
| Node | `sorted-unicode-short` | 0.688379 | 0.417596 | 0.6068 | 0.6018 | 0.6118 |
| Node | `map-ascii-control` | 0.252468 | 0.252077 | 0.9990 | 1.0584 | 0.9429 |
| Node | `map-long-fitting-control` | 1.174676 | 1.239488 | 1.0552 | 1.1306 | 0.9848 |
| Node | `map-oversized-control` | 1.973824 | 1.890487 | 0.9631 | 0.8789 | 1.0552 |
| Node | `map-json-control` | 0.364536 | 0.396169 | 1.0857 | 1.1221 | 1.0504 |
| Bun | `map-unicode-short` | 0.274519 | 0.315355 | 1.1492 | 1.1862 | 1.1133 |
| Bun | `map-unicode-medium` | 0.391049 | 0.401334 | 1.0264 | 1.0307 | 1.0221 |
| Bun | `map-unicode-one` | 0.000192478 | 0.000256557 | 1.3559 | 1.0703 | 1.7176 |
| Bun | `map-unicode-replace` | 0.327837 | 0.375996 | 1.1445 | 1.0731 | 1.2207 |
| Bun | `ordered-unicode-short` | 0.264158 | 0.389256 | 1.4637 | 1.2626 | 1.6969 |
| Bun | `sorted-unicode-short` | 0.306397 | 0.387531 | 1.2662 | 1.1883 | 1.3492 |
| Bun | `map-ascii-control` | 0.180501 | 0.183205 | 1.0225 | 0.8998 | 1.1619 |
| Bun | `map-long-fitting-control` | 2.887179 | 2.906613 | 1.0070 | 0.9974 | 1.0167 |
| Bun | `map-oversized-control` | 1.383678 | 1.490006 | 1.0766 | 1.0904 | 1.0629 |
| Bun | `map-json-control` | 0.322494 | 0.362599 | 1.1231 | 1.1793 | 1.0696 |

The one-write case is explicit: Node 505.05 to 283.04 ns, Bun 192.48 to 256.56 ns. Bun's two ratios were 1.0703 and 1.7176. Its small absolute duration does not remove the adverse observation. Node JSON had ratios 1.1221 and 1.0504; Bun JSON 1.1793 and 1.0696. Bun's oversized native-fallback control was also adverse twice (1.0904, 1.0629). No slower case or sample was removed. The unchanged source paths' observed costs are unresolved; they are not labelled equivalent or explained away by a claimed JIT cause.

## Method and limits

Recorded on 2026-11-05 with Node **24.22.1**, Bun **1.4.2**, Linux x64, AMD EPYC 9V74. The controller and children used CPU **2**, while the common performance lock serialized builds, tests and benchmark jobs. Each fresh child imported exactly one portable build and one workload from the same neutral copied pathname. The source-entry Bun package path and browsers were not benchmarked.

The fixed matrix has six targets and four controls: short Unicode insertion (1,024 writes), medium Unicode insertion (256), one write, changed-value replacement (1,024), ordered and sorted insertion (1,024 each); ASCII numeric insertion (1,024), long-but-byte-fitting Unicode (16), oversized Unicode (8), and generic JSON values (256). [Fixtures](fixtures.mjs) define all exact inputs. Input strings, native expected maps and replacement bases were prepared outside timing. Ill-formed-key correctness oracles normalize through native UTF-8.

Every batch started with a fresh writer Arena outside timing. Repetitions forked from the same base within that batch, using the same prepared strings. Writer caches can warm within a batch; the module's UTF-8 scratch is warm by measured samples. Untimed validation cannot warm the next batch's new Arena. This is warm repeated-write throughput, not cold setup or arbitrary mixed long-lived histories.

Timing includes the complete public immutable `set` sequence, intermediate wrappers, WASM allocation/growth, retaining each final and middle snapshot, and the outer retained-results array. Setup, full verification, hashing and process startup are outside timing. Every final/middle key and value is checked against the independent input model, including map order where defined. The original base is rechecked, its published bytes must stay unchanged, and complete post-batch heap/descriptor hashes and allocation results must match exactly across repetitions and builds. Writer scratch below `HEAP_START` is excluded from the cross-write immutability assertion.

The [controller](benchmark.mjs) records disposable calibration for both builds, chooses one common repetition count, and uses seven measured batches per process after at least 150 ms actual timed warm-up and eight batches. Pair order is balanced; workload order rotates. The completed screen has **40 calibration processes plus 80 measured processes, 40 measured pairs, 20 rows and 560 measured batches**. All measured-process warm-up sums were **150.235–787.719 ms**. Measured batches were **4.643–114.840 ms**; **306/560** were below the 20 ms target and **68/80** measured processes used capped repetitions. The elapsed warm-up floor is observed, not a guarantee of steady-state compilation or universal performance.

Repetitions are capped by 65,536 operations, 131,072 public writes and an estimated 16 MiB of new shared allocation; the actual allocation cap is checked. The same cap applies to both builds. This is not peak heap/RSS: intermediates, uncollected buffers and memory reservations can coexist. There is no forced GC. Across measured subjects, including their warm-up, the proof verified **5,038,820 operations, 33,090,560 public writes and 54,295,480 final/middle elements**, plus retained bases. Initial one-operation checks and calibration checks are additional and excluded from those counts and timing summaries.

## Correctness and provenance

The [initial validation log](validation/initial-01.txt) and [manifest](validation/initial-01.json) record all three builds, general typecheck and **83 passing tests in three files**, including 12 new private-Arena regressions. Coverage includes all three map kinds, UTF-16 replacement collisions, both length/byte boundaries, interleaved helper reuse, old roots/forks, growth, allocation failure/retry, input validation and read-only attachments.

Six fresh [compatibility](compatibility.mjs) processes passed: native, missing-`encodeInto`, and shared-destination-rejecting encoders on each runtime. Exact full published layouts match between these modes. Both installed engines accepted native shared `encodeInto` in the recorded capability check; the candidate does not require that support. Results are retained for [Node](validation/node-compatibility-01.json) and [Bun](validation/bun-compatibility-01.json). The actual Node [worker proof](worker.mjs) passed shared and copy transport, three map kinds, old/fork/new readers, growth and read-only writes; each worker checked 147 entries across phases. No default full-suite, browser, package or integration gate is claimed for this rejected experiment.

The baseline is `77599337867dbf785a5f0311d34637d0b36678fc`; its [build manifest](validation/baseline-build.json) and [log](validation/baseline-build.txt) are retained. The initial validation ran with the candidate source uncommitted atop that baseline; its recorded file hashes identify the tested code. The pilot used frozen candidate local commit `ee80a1c2353a867f0efda4356d17b949ee16d0be`. This is provenance, not a remotely reachable reproduction prerequisite. The published evidence checkout retains exact measured source copies. Candidate `arena.ts` SHA-256: `b33f8f95e7d2e548bd9471effbb414cbe725d95ceea8208b1d7e6b26806c406f`. Driver SHA-256: `02eb102890ad1ddebe47dbf16de8c2e5541999eee26382048b7c0a151d7c51aa`.

All runtime/test/support, root WASM, complete portable JavaScript chunk and CI identities were captured before the study and rechecked afterward, together with the five driver/fixture/plan files and HEAD. Only `arena.ts` differed between measured runtime sources; support and WASM files matched. All guards passed. There was one completed source candidate and one completed pilot; no failure, discarded timing, selective rerun or later source variant is omitted.

[Raw samples](results/pilot-01.json.gz) are losslessly compressed. The original JSON is **2,048,060 bytes**, SHA-256 `0f3b1cade92e39f53eee64ccd9a672d0e81c5a5a00528856916eaf042a63689c`. The [evidence manifest](evidence-manifest.json) records both stored/raw identities and every immutable artifact. The [saved-evidence verifier](verify.mjs) independently recomputes recorded medians, ratios, warm-up/counts and allocation/hash checks without importing the controller's statistics. It validates archived files; it never requires future active runtime files to retain measured hashes.

A separate read-only [Python audit](review/independent-audit.py) and [result log](review/independent-pilot.txt) recomputed all 80 measured-process medians, 40 ratios, 20 rows and 560 measured batches, plus all 40 calibrations and 2,808 total timed batches. It independently rebuilt native input digests, key lengths and caps, and checked all counters, layouts, common repetitions and process order. Its earlier [live-source audit](review/independent-source-audit.txt) matched 283 recorded existing file hashes, four absent lockfile paths and five frozen driver files before the runtime was restored. Both audits support rejection; neither ran another benchmark.

## Reproduce from the published evidence checkout

The active source in this evidence branch is restored baseline code. Recreate the measured candidate from the archived source, rather than attempting to fetch the local measurement commit. These example paths must be new. Use the same shared lock as other performance work on the machine.

```sh
NUMERIC_PROOF="$PWD/proofs/numeric-key-scratch-20261105"
git worktree add --detach ../numeric-key-before 77599337867dbf785a5f0311d34637d0b36678fc
git worktree add --detach ../numeric-key-after 77599337867dbf785a5f0311d34637d0b36678fc
cp "$NUMERIC_PROOF/source/arena.ts.txt" ../numeric-key-after/arena.ts
cp "$NUMERIC_PROOF/source/numeric-key-scratch.test.ts.txt" ../numeric-key-after/numeric-key-scratch.test.ts
```

In each worktree, run `bun install`, then `bun run build:wasm`, `bun run build:browser` and `bun run build:types`, serially under the shared lock. The baseline has no committed lockfile; direct development versions are pinned, but fresh transitive resolution can differ. Use the recorded Bun version and inspect source, WASM and complete bundle hashes when reproducing. The controller compares current builds and records their identities; a new study with different bundle hashes is not the original artifact.

```sh
node "$NUMERIC_PROOF/verify.mjs"
flock /workspace/scratch/83f1d4baba1f/perf.lock taskset -c 2 \
  node "$NUMERIC_PROOF/benchmark.mjs" pilot \
  ../numeric-key-before ../numeric-key-after /path/to/bun \
  /tmp/numeric-key-new-pilot.json
```

Choose an output path with neither an existing JSON file nor a compressed recording. The confirmation mode remains in the frozen controller as a prospective option, but it was not used for this rejected candidate.
