# SharedMap bulk-read experiment

Status: correctness checks pass; the current candidate is awaiting isolated hosted performance evidence. No performance improvement is claimed from the local experiments.

The baseline is `a4265a0608ec25eec5719496225212db6b251989`. Only `arena.ts` and `shared-map.ts` change at runtime. WASM, the wire format, the public API and cache capacity stay the same.

## Candidate

`getMany` specializes primitive reads using the existing bounded value cache. It computes the primitive type code once, then checks the current owner, `get` method and `Arena.value` method for every visited key. An exact nonzero root/code match uses the same cached hit or `readPrimitive` miss branch as the original scalar reader. Other cases use the original scalar path.

The caller's `keys.map` still controls traversal and result construction. Sparse holes, inherited elements, custom map methods, Array species, key accessors, dynamic method replacement and subclasses retain their behavior. No memory view survives a key accessor. The focused tests cover retained roots, actual memory growth, both worker attachment modes, cache limits, presence-only entries, Unicode aliases, custom kernels and empty roots.

## Planned hosted comparison

Every case uses a 4,096-entry source Map. The timing includes the complete public read and allocation/retention of its output array. Setup and verification are outside the timer.

| Case | Request | State | Repetitions per batch |
|---|---:|---|---:|
| number-hit-128 | 128 | Warm hits | 4,096 |
| number-hit-1024 | 1,024 | Warm hits | 256 |
| number-mixed-1024 | 1,024 | Half hits, half misses | 128 |
| number-miss-128 | 128 | All misses | 512 |
| string-hit-128 | 128 | Warm string hits | 4,096 |
| object-hit-128 | 128 | Unchanged JSON path | 1,024 |
| scalar-number-control | 128 | Unchanged scalar `get` loop | 4,096 |
| cold-number-1024 | 1,024 | A fresh public worker attachment for each operation | 64 |
| changing-root-1024 | 1,024 | Alternate two retained roots sharing one reader arena | 256 |

The cold case awaits reader attachment before each batch. Attachment is not timed; each timed operation starts with its own fresh read cache. The changing-root case verifies the expected root by operation ordinal, so always returning one snapshot's values cannot pass.

Every output position is checked against an independently constructed native Map oracle. Frozen JSON values are checked completely once, then each returned value is checked against that verified immutable object. Successful per-value verification allocates no diagnostic strings. Snapshot descriptors, the arena frontier and all original published bytes are checked once per batch; the harness does not traverse the entire Map for every returned array.

The planned pilot uses two pairs, confirmation uses six pairs, and the A/A check uses four pairs on representative target, mixed, cold and scalar cases. All stages use at least 500 ms of timed warmup and eight warmup batches, then nine measured batches per fresh process. Builds run in alternating AB/BA order with one allowed CPU and the common lock `/tmp/zerocopy-perf-20261108.lock`. No sample is removed. The driver records all short batches as well as raw warmup and measurement times.

The dedicated workflow runs source/value types, focused Node/Bun tests, both-build workload checks, real Node workers including a baseline reader, and Chromium readers before collecting timings. It retains partial results and validation artifacts even on failure.

## Earlier local evidence

[V1 pilot](results/pilot-v1.json) measured a simpler dispatch-only change with 150 ms warmup. Several cases and the unchanged scalar control moved substantially, so these numbers do not establish a gain or a reliable code regression.

The [same-baseline diagnostic](results/aa-diagnostic-v1.json) increased warmup to 500 ms. Twelve of its 32 processes still changed by more than 20% between the median first and last three measured batches. Only two of 288 measured batches were shorter than 2 ms. The [raw trend audit](validation/aa-diagnostic-v1-trends.json) preserves every series. Baseline source, WASM and portable bundles [match the accepted List and Boolean evidence exactly](validation/pilot-v1-baseline-audit.json), ruling out a stale baseline build.

V1 also eagerly constructed a diagnostic message for every successfully verified value. The current verifier removes that unnecessary garbage; no causal claim about the old timing variation is made. The original source, workload, driver and verifier remain in [exploration/v1](exploration/v1/). Existing measurement records were not overwritten.

## Reproduction

Use Node 24.22.1 and Bun 1.4.2. Start from this isolated candidate branch, whose runtime diff contains only the two declared files. Use a fresh directory for each collection; the driver refuses to overwrite evidence. The common lock is acquired by the driver itself, so do not wrap it in a second lock for the same path.

```bash
candidate_checkout="$(pwd)"
proof="$candidate_checkout/proofs/map-bulk-reads-20261108"
study_workspace="$(mktemp -d)"
git worktree add --detach "$study_workspace/baseline" a4265a0608ec25eec5719496225212db6b251989
(cd "$study_workspace/baseline" && bun install && bun run build:wasm && bun run build:browser)
bun install
bun run build:wasm
bun run build:browser

node "$proof/smoke.mjs" "$study_workspace/baseline" "$candidate_checkout"
bun "$proof/smoke.mjs" "$study_workspace/baseline" "$candidate_checkout"
study_cpu="$(awk '/Cpus_allowed_list/ { split($2, ranges, ","); split(ranges[1], first, "-"); print first[1] }' /proc/self/status)"
taskset -c "$study_cpu" node "$proof/paired-benchmark.mjs" "$proof/workloads.mjs" "$study_workspace/baseline" "$candidate_checkout" "$(command -v bun)" "$study_workspace/pilot.json" pilot
taskset -c "$study_cpu" node "$proof/paired-benchmark.mjs" "$proof/workloads.mjs" "$study_workspace/baseline" "$candidate_checkout" "$(command -v bun)" "$study_workspace/formal.json" formal
taskset -c "$study_cpu" node "$proof/paired-benchmark.mjs" "$proof/workloads.mjs" "$study_workspace/baseline" "$candidate_checkout" "$(command -v bun)" "$study_workspace/aa.json" aa
node "$proof/verify.mjs" "$study_workspace/pilot.json" "$candidate_checkout"
node "$proof/verify.mjs" "$study_workspace/formal.json" "$candidate_checkout"
node "$proof/verify.mjs" "$study_workspace/aa.json" "$study_workspace/baseline"
```

For retained historical records, use the original verifier:

```bash
node proofs/map-bulk-reads-20261108/exploration/v1/verify.mjs proofs/map-bulk-reads-20261108/results/pilot-v1.json
node proofs/map-bulk-reads-20261108/exploration/v1/verify.mjs proofs/map-bulk-reads-20261108/results/aa-diagnostic-v1.json
```
