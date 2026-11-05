# Rejected experiment: exact-bit no-op list writes

**Decision: do not open an improvement PR for this child-first design.** In the final formal study, all four no-op workloads improved in every pair in both runtimes and their shared allocation fell to zero. Changed-write and read-control costs prevented acceptance. This branch restores the original runtime and active tests; its net change is this proof folder. The exact tested candidate remains in `measured-source/` as text artifacts. No additional timing or source tuning followed the confirmation.

## Why it was rejected

The main control concern is Node changed numeric tree writes: paired latency ratio **1.1149**, nominal 95% interval **[0.9857, 1.2611]**, with **all six pairs slower**. Both screening pairs were also slower, but screening and confirmation are kept separate. Bun changed-string writes were **1.0926 [0.9878, 1.2085]**, five of six slower; unchanged Bun reads were **1.1267 [0.9007, 1.4094]**, four of six slower, after both screening pairs were adverse. Intervals crossing one do not establish neutrality. The conservative gate rejected this candidate because those common operations still carried material cost or uncertainty.

The no-op target gains were substantial: Node paired latency reductions ranged from 20.4% for a one-element tail to 82.5% for the deep numeric tree; Bun ranged from 17.4% to 83.3%. These are workload-specific observations, not readiness for a general `set()` change. Bun JSON re-encoding reversed its adverse screen result and improved in confirmation; it does not cancel a different control. No observations are dropped and no variants are pooled.

## Candidate and semantics

The change used exact `u64` equality at a nonzero vector leaf or tail. An unchanged vector child returned its existing immutable parent, so unchanged paths needed no shared-storage allocation. Changed writes recursively allocated a child before its ancestors. The public TypeScript `SharedList.set()` method stayed byte-identical: it still validated and encoded valid-index values, rejected writes through read-only attachments, and returned a new frozen snapshot. Invalid indices still returned the original object.

This was bit equality, including signed zero and NaN payloads. Generic JSON/nested re-encoding still serialized and could allocate a different pointer even for equal logical content. Interned strings benefited only when encoding reused the same stored pointer. The experiment changed no API, descriptor or binary layout. Allocation order on a failing changed write did change; the partial-failure test used 320 bytes of headroom so both orders consumed some unpublished memory before failure and retained the smaller recovery write. The original 192-byte fixture is restored in the active tree.

| Archived file | Purpose |
|---|---|
| [persistent-core.as.ts.txt](measured-source/persistent-core.as.ts.txt) | Exact rejected WASM source |
| [shared-list.ts.txt](measured-source/shared-list.ts.txt) | Unchanged public wrapper used in the study |
| [list-set-noop.test.ts.txt](measured-source/list-set-noop.test.ts.txt) | New correctness cases, kept outside test discovery |
| [allocation-failure.test.ts.txt](measured-source/allocation-failure.test.ts.txt) | Exact adjusted partial-failure fixture |
| [Source manifest](measured-source/manifest.json) | Bytes and SHA-256 for these files |

## Final formal results

Each latency is milliseconds per complete operation of **1,024 public calls**. The four no-op cases use repeated same-bit `set()` calls; changed cases change the selected value on every call; the read control performs 1,024 predetermined public `get()` calls. Displayed before/after values are marginal medians across the six process medians. The paired ratio is the geometric mean of the six candidate/baseline ratios and need not equal the ratio of the displayed marginal times. Lower ratios are faster. Intervals use the six independent process pairs, five degrees of freedom; they are nominal log-t intervals, not equivalence tests or simultaneous intervals.

| Runtime | Case | Before ms | After ms | Paired ratio | 95% interval | Slower pairs |
|---|---|---:|---:|---:|---|---:|
| node | tail-number-noop | 0.101409 | 0.080031 | 0.795796 | [0.726261, 0.871987] | 0/6 |
| node | tree-number-noop | 0.544870 | 0.091122 | 0.175080 | [0.147962, 0.207168] | 0/6 |
| node | tree-boolean-noop | 0.466771 | 0.109123 | 0.239902 | [0.203563, 0.282729] | 0/6 |
| node | tree-string-noop | 0.438112 | 0.094171 | 0.227856 | [0.192946, 0.269082] | 0/6 |
| node | tail-number-changed | 0.098731 | 0.101910 | 1.094943 | [0.967770, 1.238828] | 4/6 |
| node | tree-number-changed | 0.462984 | 0.523014 | 1.114886 | [0.985658, 1.261058] | 6/6 |
| node | tree-boolean-changed | 0.408805 | 0.414590 | 1.008453 | [0.854219, 1.190536] | 4/6 |
| node | tree-string-changed | 0.419723 | 0.426867 | 1.032290 | [0.872149, 1.221835] | 3/6 |
| node | tree-json-reencode | 1.051464 | 1.065583 | 1.034695 | [0.858174, 1.247525] | 4/6 |
| node | get-control | 0.027819 | 0.028170 | 1.011531 | [0.878247, 1.165043] | 3/6 |
| bun | tail-number-noop | 0.057387 | 0.046881 | 0.826464 | [0.802376, 0.851275] | 0/6 |
| bun | tree-number-noop | 0.377829 | 0.059901 | 0.167715 | [0.129859, 0.216606] | 0/6 |
| bun | tree-boolean-noop | 0.332197 | 0.053473 | 0.166976 | [0.148129, 0.188221] | 0/6 |
| bun | tree-string-noop | 0.323685 | 0.055853 | 0.179591 | [0.154578, 0.208652] | 0/6 |
| bun | tail-number-changed | 0.063129 | 0.067543 | 1.055809 | [0.831257, 1.341021] | 3/6 |
| bun | tree-number-changed | 0.390128 | 0.383317 | 0.976518 | [0.867578, 1.099137] | 2/6 |
| bun | tree-boolean-changed | 0.319028 | 0.319649 | 1.070342 | [0.851980, 1.344669] | 3/6 |
| bun | tree-string-changed | 0.306317 | 0.334529 | 1.092583 | [0.987788, 1.208495] | 5/6 |
| bun | tree-json-reencode | 1.417962 | 1.240253 | 0.888745 | [0.816549, 0.967325] | 1/6 |
| bun | get-control | 0.018947 | 0.022633 | 1.126689 | [0.900665, 1.409433] | 4/6 |

Every paired observation is shown below in recorded pair order. Baseline-first and candidate-first alternate; case order rotates.

| Runtime | Case | Pair 1 | Pair 2 | Pair 3 | Pair 4 | Pair 5 | Pair 6 |
|---|---|---:|---:|---:|---:|---:|---:|
| node | tail-number-noop | 0.787637 | 0.914850 | 0.781990 | 0.842029 | 0.746329 | 0.717257 |
| node | tree-number-noop | 0.235594 | 0.169270 | 0.146975 | 0.163907 | 0.165488 | 0.181161 |
| node | tree-boolean-noop | 0.193836 | 0.250667 | 0.201451 | 0.267859 | 0.256359 | 0.283629 |
| node | tree-string-noop | 0.230775 | 0.192826 | 0.207931 | 0.234488 | 0.212136 | 0.304055 |
| node | tail-number-changed | 1.028240 | 1.241329 | 1.099537 | 1.279756 | 0.992575 | 0.966646 |
| node | tree-number-changed | 1.015337 | 1.373020 | 1.128734 | 1.163138 | 1.008497 | 1.040398 |
| node | tree-boolean-changed | 0.808125 | 1.007215 | 1.126143 | 1.262883 | 0.898866 | 1.010839 |
| node | tree-string-changed | 1.046515 | 1.393476 | 0.880260 | 0.929637 | 1.032257 | 0.982319 |
| node | tree-json-reencode | 1.018659 | 0.907896 | 1.022596 | 0.872489 | 1.446528 | 1.028057 |
| node | get-control | 0.827420 | 1.250152 | 0.956937 | 0.996551 | 1.055759 | 1.028584 |
| bun | tail-number-noop | 0.815106 | 0.797516 | 0.818696 | 0.819114 | 0.851305 | 0.858692 |
| bun | tree-number-noop | 0.150683 | 0.149644 | 0.142940 | 0.198099 | 0.255400 | 0.136474 |
| bun | tree-boolean-noop | 0.170534 | 0.149757 | 0.154357 | 0.206177 | 0.159363 | 0.167330 |
| bun | tree-string-noop | 0.167029 | 0.180076 | 0.175948 | 0.146764 | 0.191730 | 0.225302 |
| bun | tail-number-changed | 0.778882 | 1.359938 | 0.987047 | 1.328989 | 1.148628 | 0.867926 |
| bun | tree-number-changed | 0.903832 | 0.962440 | 0.996405 | 1.003035 | 0.845836 | 1.179186 |
| bun | tree-boolean-changed | 1.210589 | 1.070592 | 0.886638 | 1.539412 | 0.861743 | 0.986359 |
| bun | tree-string-changed | 1.120669 | 0.957115 | 1.077194 | 1.065089 | 1.073974 | 1.287096 |
| bun | tree-json-reencode | 0.833912 | 0.882160 | 0.819550 | 0.925771 | 1.021758 | 0.864109 |
| bun | get-control | 1.466582 | 0.967618 | 1.418803 | 0.854964 | 1.136292 | 1.045812 |

## Shared allocation and full-output checks

| No-op operation | Source size | Baseline shared bytes / 1,024 calls | Candidate shared bytes / 1,024 calls |
|---|---:|---:|---:|
| One-element numeric tail | 1 | 8,192 | 0 |
| Deep numeric tree | 65,537 | 655,360 | 0 |
| Boolean tree | 1,057 | 524,288 | 0 |
| Interned-string tree | 1,057 | 524,288 | 0 |

These are exact asserted deltas, not timing estimates. Changed writes had the same predicted shared allocation on both builds; the JSON case included every encoded blob. JavaScript snapshot wrappers still allocate. This is not a claim of zero JavaScript or total-process allocation.

Each complete operation returns its final snapshot, and every final result escapes into the retained output array. Intermediate snapshots from the 1,024-call loop are not retained. After timing, every output is materialized and every element checked against native-array inputs; lengths, wrapper ownership/frozen state, root reuse, and exact shared-allocation totals are also checked. Each batch checks the entire original source before and after, plus a SHA-256 of its published bytes from `HEAP_START` to the original used position. The lower WASM scratch area is excluded from that published-byte hash.

The 240 measured confirmation processes checked **1,720,366 complete results**, **8,845,947,094 output elements**, and **1,160,355,436 original-source elements**. These counts include each recorded initial check and warm-up/measured batches. Calibration records copied from the screen remain available but are not counted as new confirmation processes.

## Fixed measurement method and limitations

The host was Linux x64, `AMD EPYC 9V74 80-Core Processor`, with timing controller and child processes pinned to CPU 2 under the shared `perf.lock`. Runtimes were Node 24.22.1 and Bun 1.4.2. One build and one workload ran per fresh process. Before every process the complete build was copied to the same neutral pathname; all imported JavaScript chunks and core/legacy WASM aliases were hashed. Source, tests, build inputs and driver identities were checked again at completion.

The [screen plan](PLAN.md) fixed all ten cases before timing. Screening used two balanced process pairs per runtime/case, seven batches, and at least 150 ms actual timed warm-up plus eight batches. The full [screen table](pilot-summary.md) retains all twenty estimates and forty pair ratios, including adverse Node changed-string, Bun JSON and Bun read results. No screening confidence intervals are inferred.

The proof-only [confirmation declaration](CONFIRMATION.md) retained every case, the exact runtime/driver and the common repeat plans selected by disposable calibration from both builds. Confirmation used six balanced pairs per runtime/case, at least 500 ms actual timed warm-up plus eight batches, and eleven measured batches. The warm-up cap stayed 2,048 batches. There was no recalibration, A/A extension, selective rerun or further source variant within this experiment.

Actual confirmation warm-up ranged from 500.001723 to 548.971648 ms; the largest count was 548 warm-up batches. All **2,640 measured batches** are retained, including **1,630 below the 20 ms target**; the minimum was **0.690199 ms**. Common caps limited each batch to 65,536 complete operations, 1,048,576 output elements and 16 MiB worst-case baseline shared allocation. The same caps applied to zero-allocation candidate cases. Short batches and only six pairs limit precision; the intervals are not proof of unchanged controls.

Each batch built a fresh private Arena and source outside timing to bound append-only shared memory. That is a repeated-update workload on a newly constructed source, not a long-lived mixed production history. The previous blackboxed Arena could remain live while the next source was built; the batch caps are not peak-memory or RSS bounds. Timing included the outer retained-results array, public caller loops, encoding, WASM work, fresh wrappers and natural garbage collection. Source construction, requested-value preparation, hashing and complete validation were outside timing. No forced GC was used. Native inputs and ordinary string-intern cache setup were symmetric; no persistent cross-build cache existed.

## Correctness and independent review

- WASM and browser builds, the three focused suites (73 tests), and TypeScript checking passed; see [validation log](results/focused-validation-01.txt) and [manifest](results/focused-validation-manifest.json).
- An untimed smoke check exercised all ten workloads on both builds in Node and Bun (40 rows), including full values and exact allocation totals: [script](check-workloads.mjs), [log](results/workload-check-01.txt). It imported both builds in one process and is correctness evidence only.
- [Real Node worker proof](worker.mjs) passed four groups: current and unchanged-baseline readers, each with shared/copied attachments. It checked old/no-op/changed snapshots, read-only same-value writes, signed zero, suspended iterators and concurrent reads during writer growth, subsequent attachments, forks and reset. See [worker log](results/worker-01.txt) and [manifest](results/worker-manifest.json).
- A separate [Python audit](independent-audit.py) reconstructed native expected digests and allocation formulas, and independently recomputed all process medians, ratios and intervals. Both [screen audit](results/independent-pilot-audit-01.txt) and [formal audit](results/independent-formal-audit-01.txt) passed, including frozen source/build/driver identities while the measured checkout was still intact.

The focused tests cover tail/leaf/vector-depth boundaries, fresh wrappers, old snapshots and frontier appends, signed zero/infinities, exact NaN payloads passed through a WASM-to-WASM i64 bridge, missing zero-valued nodes, JSON/nested encoding side effects and growth, read-only shared/copy readers, invalid indices and wrong types, full-capacity no-ops, and changed-write failure/recovery. No full combined integration suite was run for this rejected candidate; no correctness failure caused rejection.

## Evidence identities

Local measured runtime/source/driver commit: `11c73280eeaa636894851a48411fcbb5957dac54`. Local confirmation provenance commit: `9582516e478f2db9f7b1d7cb27edd18b68f2336b`, which added only proof/worker files. Fixed baseline: `77599337867dbf785a5f0311d34637d0b36678fc`. The local candidate commit IDs may be rewritten by publication and are not required to be fetchable; the archived source and driver hashes define the measured candidate.

| Study | Uncompressed bytes | Uncompressed SHA-256 |
|---|---:|---|
| [Screen JSON.gz](results/pilot-01.json.gz) | 2,468,512 | `38149259eacaa7d0f7cbd78d7aed7569a87ca8d1e29f10d50582f4e4b751a920` |
| [Confirmation JSON.gz](results/formal-01.json.gz) | 12,657,575 | `e4b493c93a4cbfd430497b4aff0cf61d2c9d0f72f4d7af07766fc6d03beda87d` |

The two gzip files contain 97,673 and 440,384 bytes respectively: 538,057 stored bytes preserve all 15,126,087 original JSON bytes. The [artifact manifest](artifact-manifest.json) seals both compressed and uncompressed hashes, all archived measured files, frozen drivers/plans, reports and original run/audit logs. It also records the experiment sequence and rejection. Compression is lossless and round-trip checked. Its immutable input list excludes the packaging logs produced by verification itself.

[verify.mjs](verify.mjs) checks the packaged hashes and arithmetic using only saved evidence; it never benchmarks or compares all live production files, so independent future changes do not invalidate historical results. After restoring the active runtime/tests to the baseline, both saved-data audits and strict documentation checks passed: [archive verification](results/archive-verification-01.txt), [independent archived audit](results/independent-archived-audit-01.txt), and [documentation check](results/docs-01.txt). No runtime tests or performance measurements were repeated during packaging.

## Reproduce

To verify the saved record from this evidence checkout (no install or benchmark required):

```sh
node proofs/list-set-noop-20261105/verify.mjs
python3 proofs/list-set-noop-20261105/independent-audit.py \
  proofs/list-set-noop-20261105/results/pilot-01.json.gz \
  proofs/list-set-noop-20261105/results/formal-01.json.gz
```

To rebuild the rejected experiment, first make a separate baseline worktree at the fixed baseline commit. Use this published evidence checkout as the candidate, then restore the archived candidate files into it. Run the repository-documented `bun install` in each checkout; direct development dependency versions are pinned, but this baseline has no committed transitive dependency lockfile. Use the recorded Node/Bun versions for comparison.

```sh
git worktree add ../zerocopy-noop-baseline 77599337867dbf785a5f0311d34637d0b36678fc
cp proofs/list-set-noop-20261105/measured-source/persistent-core.as.ts.txt persistent-core.as.ts
cp proofs/list-set-noop-20261105/measured-source/list-set-noop.test.ts.txt list-set-noop.test.ts
cp proofs/list-set-noop-20261105/measured-source/allocation-failure.test.ts.txt allocation-failure.test.ts
```

Build both trees with `node scripts/build-wasm.mjs` and `bun scripts/build-browser.ts`, serialized with the same performance lock. Run the focused tests and worker proof against the rebuilt candidate; pass the baseline `dist/shared.js` as the worker proof’s second path. Then use absolute baseline/candidate paths and a new result filename:

```sh
flock /tmp/zerocopy-perf.lock taskset -c 2 node \
  proofs/list-set-noop-20261105/benchmark.mjs pilot \
  /absolute/zerocopy-noop-baseline /absolute/candidate /absolute/bun \
  /absolute/new-pilot.json
flock /tmp/zerocopy-perf.lock taskset -c 2 node \
  proofs/list-set-noop-20261105/benchmark.mjs formal \
  /absolute/zerocopy-noop-baseline /absolute/candidate /absolute/bun \
  /absolute/new-formal.json /absolute/new-pilot.json
```

The baseline HEAD is checked by the driver. The candidate may be a published revision with the exact archived runtime/driver hashes; it need not have either local measured commit ID. Reproduction is a new study and must not replace these saved observations.
