# Rejected experiment: look up exact tree bits before list copying

**Decision: no improvement PR for this final list design.** All three tree no-op targets improved in every formal pair in both runtimes, and their shared allocation fell to zero. Ordinary-write and read controls still carried material costs or uncertainty. The fixed gate rejected this source; no additional timing or source design followed. This archive restores tracked runtime, tests and CI to the fixed baseline and adds only this proof folder.

## Decision and complete controls

The clearest continuing concern was Node changed-tail writes: paired latency ratio **1.123817 [0.992319, 1.272739]**, with **all six pairs slower**, after both screening pairs were also adverse. Bun changed-boolean tree writes were **1.182689 [0.891872, 1.568333]**, five of six slower, following two adverse screening pairs. Bun unchanged tail no-ops were **1.155385 [0.969827, 1.376445]**, five of six slower. Node reads were **1.117212 [0.949302, 1.314823]**, four of six slower. These nominal intervals crossing one do not establish neutrality.

The three no-op tree latency reductions were large: 76.5–82.2% in Node and 83.0–87.1% in Bun, using the paired estimates. They did not resolve the cost of other common operations. The unchanged source of the tail path does not prove unchanged speed; the cause of its measured difference was not established. No speculative explanation is used to excuse it, and no source variants, screening observations or control rows are pooled or dropped.

## Exact candidate and boundaries

Only exported `vecSet()` in `persistent-core.as.ts` changed. It walked the existing path iteratively, stopped before dereferencing any zero pointer, and returned the existing root only when the nonzero leaf contained exactly the requested `u64` bits. Every changed or missing-path write delegated to the original copy helper. This added a read traversal before changed tree writes; its cost was a declared risk.

The private `vecSetAt()` routine, ancestor-before-child allocation order, `tailSet()`, public `SharedList.set()` wrapper and original 192-byte partial-failure fixture stayed byte-identical to baseline. The driver checked that stripping exported `vecSet()` made the complete before/after WASM source identical. That source constraint is not a claim about identical generated machine code or timing.

The public method still encoded valid-index inputs, enforced type/read-only checks, and returned a new frozen wrapper. Invalid indices returned the original wrapper. Exact bits distinguish positive/negative zero and NaN payloads; missing zero-valued paths still allocate. JSON/nested encoding side effects remain, and a new encoded pointer still takes the copy path. Interned-string benefits require encoding to reuse the existing pointer. Same-value tail writes remain the baseline copy, including their bounded-memory failure behavior.

| Archived file | Role |
|---|---|
| [persistent-core.as.ts.txt](measured-source/persistent-core.as.ts.txt) | Exact measured rejected candidate |
| [shared-list.ts.txt](measured-source/shared-list.ts.txt) | Unchanged public wrapper |
| [allocation-failure.test.ts.txt](measured-source/allocation-failure.test.ts.txt) | Unchanged original failure fixture |
| [list-set-lookup.test.ts.txt](measured-source/list-set-lookup.test.ts.txt) | New focused tests outside active discovery |
| [Measured-source manifest](measured-source/manifest.json) | Exact lengths and SHA-256 identities |

## Final formal results

All times are milliseconds per complete operation of **1,024 public calls**. Writes thread the returned snapshots and return the final snapshot; reads return all 1,024 values. Before/after columns are marginal medians of six process medians. The paired ratio is the geometric mean of the six candidate/baseline process ratios and need not equal the ratio of those marginal medians. Lower ratios are faster. Intervals use six independent process pairs and five degrees of freedom; they are nominal log-t intervals, not equivalence tests or simultaneous intervals.

| Runtime | Case | Before ms | After ms | Paired ratio | 95% interval | Slower pairs |
|---|---|---:|---:|---:|---|---:|
| node | tail-number-noop | 0.107083 | 0.101865 | 0.955952 | [0.836276, 1.092754] | 2/6 |
| node | tree-number-noop | 0.448398 | 0.083169 | 0.178050 | [0.146291, 0.216705] | 0/6 |
| node | tree-boolean-noop | 0.411650 | 0.082483 | 0.207582 | [0.140063, 0.307648] | 0/6 |
| node | tree-string-noop | 0.407985 | 0.097414 | 0.234661 | [0.195121, 0.282213] | 0/6 |
| node | tail-number-changed | 0.097357 | 0.101731 | 1.123817 | [0.992319, 1.272739] | 6/6 |
| node | tree-number-changed | 0.450507 | 0.439920 | 0.979952 | [0.817254, 1.175039] | 4/6 |
| node | tree-boolean-changed | 0.399683 | 0.397736 | 0.988222 | [0.838360, 1.164873] | 4/6 |
| node | tree-string-changed | 0.428981 | 0.441490 | 0.994241 | [0.889062, 1.111865] | 4/6 |
| node | tree-json-reencode | 1.064918 | 1.241140 | 1.047715 | [0.855995, 1.282375] | 3/6 |
| node | get-control | 0.025741 | 0.028959 | 1.117212 | [0.949302, 1.314823] | 4/6 |
| bun | tail-number-noop | 0.057468 | 0.066527 | 1.155385 | [0.969827, 1.376445] | 5/6 |
| bun | tree-number-noop | 0.385215 | 0.047928 | 0.129458 | [0.102037, 0.164249] | 0/6 |
| bun | tree-boolean-noop | 0.330474 | 0.047278 | 0.169092 | [0.123828, 0.230902] | 0/6 |
| bun | tree-string-noop | 0.358645 | 0.054535 | 0.169656 | [0.149101, 0.193045] | 0/6 |
| bun | tail-number-changed | 0.056993 | 0.068202 | 1.128284 | [0.962626, 1.322450] | 4/6 |
| bun | tree-number-changed | 0.407947 | 0.382856 | 1.008170 | [0.883897, 1.149914] | 2/6 |
| bun | tree-boolean-changed | 0.287749 | 0.372968 | 1.182689 | [0.891872, 1.568333] | 5/6 |
| bun | tree-string-changed | 0.306193 | 0.325952 | 1.017960 | [0.978662, 1.058835] | 3/6 |
| bun | tree-json-reencode | 1.324523 | 1.295750 | 0.991125 | [0.897621, 1.094369] | 2/6 |
| bun | get-control | 0.020237 | 0.019673 | 0.965338 | [0.734157, 1.269316] | 4/6 |

All paired observations appear below in recorded pair order. Baseline-first/candidate-first order alternates, and case order rotates.

| Runtime | Case | Pair 1 | Pair 2 | Pair 3 | Pair 4 | Pair 5 | Pair 6 |
|---|---|---:|---:|---:|---:|---:|---:|
| node | tail-number-noop | 0.959822 | 1.035433 | 1.139551 | 0.927388 | 0.934129 | 0.777861 |
| node | tree-number-noop | 0.168069 | 0.151764 | 0.217249 | 0.213156 | 0.195684 | 0.137843 |
| node | tree-boolean-noop | 0.191059 | 0.303150 | 0.211497 | 0.188332 | 0.111890 | 0.309945 |
| node | tree-string-noop | 0.238888 | 0.198759 | 0.309858 | 0.245605 | 0.243932 | 0.189433 |
| node | tail-number-changed | 1.036285 | 1.224162 | 1.008849 | 1.362737 | 1.121489 | 1.029962 |
| node | tree-number-changed | 1.041767 | 0.763862 | 1.123169 | 1.078747 | 0.811904 | 1.131287 |
| node | tree-boolean-changed | 0.803806 | 1.225679 | 1.044334 | 1.020847 | 0.842065 | 1.053059 |
| node | tree-string-changed | 1.132906 | 1.025465 | 0.912451 | 1.068513 | 0.846147 | 1.007862 |
| node | tree-json-reencode | 0.992519 | 0.777232 | 1.073938 | 1.316863 | 0.963744 | 1.258024 |
| node | get-control | 1.089541 | 1.331976 | 0.903891 | 0.981134 | 1.313837 | 1.149976 |
| bun | tail-number-noop | 1.369851 | 1.423864 | 1.039372 | 1.188207 | 1.063089 | 0.928934 |
| bun | tree-number-noop | 0.195622 | 0.109745 | 0.120336 | 0.144756 | 0.114350 | 0.110080 |
| bun | tree-boolean-noop | 0.132182 | 0.235595 | 0.116137 | 0.239765 | 0.172775 | 0.156014 |
| bun | tree-string-noop | 0.134111 | 0.183372 | 0.171769 | 0.180470 | 0.187620 | 0.166722 |
| bun | tail-number-changed | 1.082801 | 1.335549 | 0.980337 | 1.199935 | 0.926627 | 1.308771 |
| bun | tree-number-changed | 0.994656 | 1.243657 | 0.895476 | 0.924097 | 1.096632 | 0.935398 |
| bun | tree-boolean-changed | 0.687901 | 1.252798 | 1.392274 | 1.258089 | 1.369334 | 1.323945 |
| bun | tree-string-changed | 0.997061 | 0.972226 | 1.066705 | 0.995838 | 1.062356 | 1.017165 |
| bun | tree-json-reencode | 1.121313 | 0.956563 | 0.969335 | 1.096373 | 0.951028 | 0.874388 |
| bun | get-control | 1.016386 | 0.741431 | 1.040446 | 0.686912 | 1.392265 | 1.079208 |

## Exact shared allocation and escaped results

| Same-bit operation | Source size | Baseline shared bytes / 1,024 calls | Candidate shared bytes / 1,024 calls |
|---|---:|---:|---:|
| Tail numeric control | 1 | 8,192 | 8,192 |
| Numeric tree target | 65,537 | 655,360 | 0 |
| Boolean tree target | 1,057 | 524,288 | 0 |
| Interned-string tree target | 1,057 | 524,288 | 0 |

Every batch asserted these deltas exactly. Changed and generic writes had the same predicted shared allocation on both builds; the generic case included every JSON blob. JavaScript wrappers still allocate. These are shared-storage claims, not zero total allocation or peak-memory claims.

Each complete operation’s final result escapes into the retained-results array. Intermediate wrappers from the 1,024-call chain are not retained. After timing, every final snapshot is materialized and every element checked against native-array inputs. Validation also checks wrapper identity, frozen state, owner, size/depth, root/tail reuse, and exact allocation. Each batch checks its complete original source before/after and hashes the published bytes from `HEAP_START` through the original used position. The lower WASM scratch area is excluded.

The 240 measured confirmation processes checked **1,686,371 complete results**, **9,593,622,731 output elements**, and **1,259,595,304 source elements**. These counts include each recorded initial check and warm-up/measured batches. The forty calibration records copied from the screen remain available but are not new confirmation processes.

## Frozen method and limits

Measurements used Linux x64 on `AMD EPYC 9V74 80-Core Processor`, Node 24.22.1 and Bun 1.4.2. All heavy work used the shared `perf.lock`; timing controllers and children were pinned to CPU 2. Each fresh process imported exactly one build and workload. The complete build was copied to the same neutral pathname before every subject. All root source/tests/support files, complete imported JavaScript chunks, WASM/legacy aliases and frozen driver files were hashed; identities were rechecked at completion.

The [screen plan](PLAN.md) retained all ten prior operation definitions and sizes; only the tail no-op was relabeled as an unchanged control. This was a fresh screen with new calibration and data. It used two balanced process pairs per runtime/case, seven measured batches, and at least 150 ms actual timed warm-up plus eight batches. The [complete screen table](pilot-summary.md) preserves all twenty estimates and forty pair ratios, including Node changed-tail 1.2635, Bun changed-boolean 1.1642, and mixed Node reads 1.1412. No screening confidence intervals are inferred.

The separate [confirmation declaration](CONFIRMATION.md) retained the exact source/driver, all ten cases and this screen’s common repeats without recalibration. Confirmation ran six balanced pairs per runtime/case, at least 500 ms actual timed warm-up plus eight batches, and eleven measured batches: 120 pairs, 240 processes and 2,640 measured batches. No A/A extension, selected rerun or further source design followed.

Actual confirmation warm-up ranged from **500.006169 to 546.949747 ms**, with at most **631 batches**, below the fixed 2,048 cap. All **1,627 measured batches below the 20 ms target** are retained; the minimum was **0.561108 ms**. Common caps limited each batch to 65,536 complete operations, 1,048,576 checked output elements and 16 MiB worst-case baseline shared allocation, including the zero-allocation target. Short batches and six process pairs limit precision; actual warm-up floors are not a universal steady-state guarantee.

Each batch constructed a fresh private Arena and source outside timing to bound append-only storage. This measures a repeated-update consumer on freshly prepared sources, not an arbitrary long-lived mixed workload. Ordinary string-intern caches were populated identically during source construction. The previous blackboxed Arena could remain live while the next source was built, so the caps are not RSS/peak-memory limits. Timing includes the outer retained-results array, public loops, encoding, WASM work, fresh wrappers and natural garbage collection. Fixture/input preparation, hashing and full verification are outside timing. No forced GC was used.

## Correctness and independent audit

The [validation log](results/validation-01.txt) and [manifest](results/validation-manifest.json) record successful WASM/browser builds, three focused files / 73 tests, TypeScript checking, four real Node worker groups and forty untimed build/runtime/workload checks. No full combined integration gate was run for this rejected candidate. Correctness failures did not cause the rejection.

The focused tests cover tree/tail boundaries and multiple depths; fresh wrappers and exact tree-root reuse; original snapshots, forks and frontier appends; signed zero and infinities; distinct NaN payloads through a WASM-to-WASM i64 bridge; zero roots and missing children; tree-only boolean/interned-string reuse with unchanged tail copies; JSON/nested encoding callbacks and growth; invalid indices and wrong types; read-only shared/copy readers; full-capacity unchanged trees versus tail/changed-write failures; and the unchanged partial-failure/recovery fixture.

The [real worker proof](worker.mjs) passed with both current and unchanged-baseline readers using shared and copied attachments. It checked retained old/no-op/changed snapshots, signed zero, read-only same-value writes, suspended iterators and concurrent reads during writer growth, repeated attachments, forks and reset. The [untimed workload smoke script](check-workloads.mjs) imported both builds in one process for correctness checks only; its rows are in the same validation log and are not timing evidence.

The separate [Python audit](independent-audit.py) reconstructed native digests/allocation formulas and recomputed every process median, paired ratio and interval. Both the [screen audit](results/independent-pilot-audit-01.txt) and [formal audit](results/independent-formal-audit-01.txt) passed, including source/build/driver identities while the measured checkout was intact. The final audit checked all 240 medians, 120 ratios, twenty intervals and 2,640 measured batches, plus the inherited calibration records and all correctness counters.

## Evidence and reproduction

Fixed baseline: `77599337867dbf785a5f0311d34637d0b36678fc`. Local measured runtime/source/driver commit: `ca20cb2bb4310c74a73ef0dc8623ab9b6f039191`. Local confirmation provenance commit: `a9be81a6e728c5cb379c1de25be81da92a7e2e2c`, which added only the full pilot summary and confirmation declaration. Publication may recreate identical file trees under different commit IDs; these local IDs need not be fetchable. Archived bytes and recorded hashes identify the measured candidate.

| Study | Uncompressed bytes | Uncompressed SHA-256 |
|---|---:|---|
| [pilot-01.json.gz](results/pilot-01.json.gz) | 2,763,377 | `66f0cb0a8908bc45809269df7fb86ef607c8df70fd0aee8c365f18cbeae866db` |
| [formal-01.json.gz](results/formal-01.json.gz) | 13,312,596 | `42a3e74e824357a6d1cbc6648c3976ef3c47db41a45add1e25a6c5e05efa1c99` |

The first archive-only validation attempt found a missing decision field in the new packaging manifest. That metadata omission was corrected; the [initial manifest](results/archive-manifest-01.json) and [failed packaging log](results/archive-gate-01.txt) are retained. The corrected [saved-verifier and documentation gate](results/archive-gate-02.txt) passed. No measured source, driver or raw observation changed.

Both studies are losslessly gzipped and round-trip checked. The [artifact manifest](artifact-manifest.json) seals compressed/uncompressed identities and immutable source/driver/plan/report/validation files. The [saved-evidence verifier](verify.mjs) checks these hashes and arithmetic without importing or timing a library build. It verifies archived measured source, not all live production files, so combining independent changes does not invalidate historical proof.

Verify this saved archive without rebuilding:

```sh
node proofs/list-set-lookup-20261105/verify.mjs
python3 proofs/list-set-lookup-20261105/independent-audit.py \
  proofs/list-set-lookup-20261105/results/pilot-01.json.gz \
  proofs/list-set-lookup-20261105/results/formal-01.json.gz
```

To rebuild the rejected design, create a separate baseline worktree at the fixed commit. Use the published evidence checkout as the candidate and copy its measured source/test text artifacts into the active paths. The wrapper and failure fixture already match baseline. Run the repository-documented `bun install` in each checkout: direct dependency versions are pinned, but this baseline has no committed transitive dependency lockfile.

```sh
git worktree add ../zerocopy-lookup-baseline 77599337867dbf785a5f0311d34637d0b36678fc
cp proofs/list-set-lookup-20261105/measured-source/persistent-core.as.ts.txt persistent-core.as.ts
cp proofs/list-set-lookup-20261105/measured-source/list-set-lookup.test.ts.txt list-set-lookup.test.ts
```

Build both trees with `node scripts/build-wasm.mjs` and `bun scripts/build-browser.ts`, serialized under the same performance lock. Run the focused tests and worker proof on the rebuilt candidate, passing the baseline `dist/shared.js` as the worker proof’s second path. Use the recorded Node/Bun versions and new result paths:

```sh
flock /tmp/zerocopy-perf.lock taskset -c 2 node \
  proofs/list-set-lookup-20261105/benchmark.mjs pilot \
  /absolute/zerocopy-lookup-baseline /absolute/candidate /absolute/bun \
  /absolute/new-pilot.json
flock /tmp/zerocopy-perf.lock taskset -c 2 node \
  proofs/list-set-lookup-20261105/benchmark.mjs formal \
  /absolute/zerocopy-lookup-baseline /absolute/candidate /absolute/bun \
  /absolute/new-formal.json /absolute/new-pilot.json
```

The driver asserts the baseline HEAD and source scope. The published candidate need only match the archived runtime/driver hashes; neither local candidate commit ID is required. Reproduction creates new observations and must not overwrite these archived results.
