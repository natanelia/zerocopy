# Rejected SharedMap bulk-read experiment

**Rejected; no optimization PR.** The candidate improves several Node cases, but causes large, repeated slowdowns in Bun. This branch preserves the tested code and evidence for review and reproduction; it is not a recommended optimization.

The six-pair confirmation shows 13.1% less time for 128 warm numeric reads, 32.5% less for 1,024 warm numeric reads and 31.3% less when alternating two retained roots in Node. Bun moves in the opposite direction: 184.7% more time for 128 numeric reads, 104.2% more for 1,024, 249.4% more for strings and 155.8% more for alternating roots. Its mixed-hit and all-miss cases also take 30.9% and 20.7% more time. Every one of those six Bun cases is slower in all six pairs, with its entire 95% interval above 1. The hosted pilot independently shows the same direction in every pair.

The [independent review](validation/independent-review.json) confirms rejection after reconstructing all 440 processes and 3,960 measured batch samples across all five retained records. It recomputes semantic fixture digests, medians, paired ratios, intervals, schedules, counters and source identities without invoking the JavaScript verifier or rerunning timings. Passing correctness checks does not resolve the performance regressions.

## Candidate and scope

The measured baseline is `a4265a0608ec25eec5719496225212db6b251989`; the measured candidate is `0f6f19844349a48cd2ad20e570953b9279778871`. Only `arena.ts` and `shared-map.ts` change at runtime. WASM, the wire format, public API signatures and cache capacity stay the same.

The candidate computes the primitive type code once in `getMany`, then uses an existing bounded cache when root and type match. Its miss branch calls the original `readPrimitive` path directly; other cases use the scalar reader. It keeps `keys.map` traversal and result construction, resolves native owner/get/value hooks for each visited key, and keeps no memory view across a key accessor. Custom callbacks, species, sparse arrays, subclasses, retained snapshots and memory growth are covered by correctness checks.

These measurements cover one Linux x64 host and the declared operations. There is no browser performance claim, no arena-allocation reduction and no measured JavaScript heap reduction. The rejection does not identify which compiler or code-generation decision caused the runtime difference.

## Complete hosted confirmation

All times below are microseconds per complete returned array. Before/after columns are medians of process medians; the paired ratio is the geometric mean of corresponding after/before ratios, so it need not equal the quotient of the two displayed time columns. A ratio below 1 means less time. Intervals are unadjusted Student-t intervals on paired log ratios; no multiple-comparison correction or A/A normalization was applied.


| Runtime | Case | Before µs | After µs | Paired ratio [95% CI] | Faster pairs |
|---|---|---:|---:|---|---:|
| node | `number-hit-128` | 2.240 | 1.963 | 0.8692 [0.8440, 0.8952] | 6/6 |
| node | `number-hit-1024` | 23.750 | 16.589 | 0.6750 [0.6124, 0.7440] | 6/6 |
| node | `number-mixed-1024` | 60.595 | 59.975 | 0.9527 [0.8672, 1.0466] | 4/6 |
| node | `number-miss-128` | 8.723 | 8.283 | 0.9884 [0.9273, 1.0535] | 4/6 |
| node | `string-hit-128` | 1.884 | 1.876 | 0.9656 [0.8806, 1.0588] | 3/6 |
| node | `object-hit-128` | 7.461 | 7.620 | 1.0235 [0.9563, 1.0956] | 3/6 |
| node | `scalar-number-control` | 2.007 | 1.986 | 1.0174 [0.9421, 1.0988] | 2/6 |
| node | `cold-number-1024` | 202.206 | 205.168 | 1.0252 [0.8634, 1.2172] | 3/6 |
| node | `changing-root-1024` | 35.530 | 25.118 | 0.6867 [0.6427, 0.7338] | 6/6 |
| bun | `number-hit-128` | 1.791 | 5.026 | 2.8465 [2.4130, 3.3579] | 0/6 |
| bun | `number-hit-1024` | 15.923 | 30.517 | 2.0418 [1.6567, 2.5163] | 0/6 |
| bun | `number-mixed-1024` | 47.298 | 62.002 | 1.3086 [1.1977, 1.4298] | 0/6 |
| bun | `number-miss-128` | 8.040 | 9.729 | 1.2066 [1.1682, 1.2462] | 0/6 |
| bun | `string-hit-128` | 1.608 | 5.585 | 3.4938 [2.9921, 4.0797] | 0/6 |
| bun | `object-hit-128` | 4.294 | 3.939 | 0.9654 [0.8365, 1.1140] | 4/6 |
| bun | `scalar-number-control` | 1.775 | 1.572 | 0.9324 [0.5965, 1.4572] | 4/6 |
| bun | `cold-number-1024` | 205.151 | 222.367 | 1.0691 [0.9653, 1.1841] | 2/6 |
| bun | `changing-root-1024` | 19.512 | 49.126 | 2.5581 [2.2113, 2.9593] | 0/6 |


Node's other six rows are inconclusive: their intervals include 1. In particular, the apparent string gain in the pilot does not repeat clearly in confirmation. Node object, scalar and cold-read point estimates are slightly slower, with wide enough intervals to include both directions.

Bun object, scalar and cold-read intervals also include 1. Its unchanged scalar control is noisy (individual ratios range from 0.5153 to 1.8315), so no scalar improvement is claimed. The cold-read point estimate is 6.9% slower and remains inconclusive. These qualifications do not remove the six consistent Bun regressions listed above.

## Complete hosted A/A control

Both labels below use the exact same baseline source, WASM and portable bundles. Every interval includes 1; that does not prove equivalence or zero measurement error. All samples remain in the record, and the A/A results were not subtracted from the candidate comparison.


| Runtime | Case | Before µs | After µs | Paired ratio [95% CI] | Faster pairs |
|---|---|---:|---:|---|---:|
| node | `number-hit-128` | 2.262 | 2.335 | 1.0445 [0.8828, 1.2358] | 1/4 |
| node | `number-mixed-1024` | 60.922 | 60.842 | 0.9727 [0.8657, 1.0928] | 2/4 |
| node | `scalar-number-control` | 1.979 | 1.976 | 1.0010 [0.9385, 1.0676] | 2/4 |
| node | `cold-number-1024` | 197.671 | 208.456 | 1.1025 [0.9846, 1.2344] | 1/4 |
| bun | `number-hit-128` | 2.038 | 2.046 | 1.0863 [0.8939, 1.3201] | 1/4 |
| bun | `number-mixed-1024` | 46.048 | 47.648 | 1.0549 [0.9088, 1.2246] | 1/4 |
| bun | `scalar-number-control` | 1.630 | 1.542 | 0.9740 [0.7879, 1.2040] | 2/4 |
| bun | `cold-number-1024` | 192.104 | 203.810 | 1.0431 [0.8775, 1.2399] | 2/4 |


## Complete hosted pilot

The pilot used two pairs with 500 ms warmup. It is descriptive and has no confidence interval. All nine planned cases were retained in the subsequent confirmation; no case was selected after seeing these results.


| Runtime | Case | Before µs | After µs | Paired ratio (individual pairs) | Faster pairs |
|---|---|---:|---:|---|---:|
| node | `number-hit-128` | 2.111 | 1.884 | 0.8921 (0.8838, 0.9003) | 2/2 |
| node | `number-hit-1024` | 25.495 | 17.296 | 0.6832 (0.8126, 0.5744) | 2/2 |
| node | `number-mixed-1024` | 60.217 | 58.944 | 0.9782 (1.0323, 0.9270) | 1/2 |
| node | `number-miss-128` | 8.755 | 8.696 | 0.9915 (0.9293, 1.0579) | 1/2 |
| node | `string-hit-128` | 1.936 | 1.672 | 0.8628 (0.8471, 0.8788) | 2/2 |
| node | `object-hit-128` | 8.808 | 7.836 | 0.8892 (0.8209, 0.9632) | 2/2 |
| node | `scalar-number-control` | 2.078 | 2.042 | 0.9824 (0.9744, 0.9904) | 2/2 |
| node | `cold-number-1024` | 213.643 | 175.434 | 0.8239 (0.9005, 0.7539) | 2/2 |
| node | `changing-root-1024` | 34.290 | 25.507 | 0.7438 (0.7514, 0.7363) | 2/2 |
| bun | `number-hit-128` | 1.807 | 4.831 | 2.6730 (2.7471, 2.6009) | 0/2 |
| bun | `number-hit-1024` | 12.301 | 30.692 | 2.4988 (2.6143, 2.3885) | 0/2 |
| bun | `number-mixed-1024` | 47.876 | 62.611 | 1.3078 (1.3134, 1.3022) | 0/2 |
| bun | `number-miss-128` | 7.765 | 9.885 | 1.2730 (1.2722, 1.2739) | 0/2 |
| bun | `string-hit-128` | 1.481 | 5.140 | 3.4726 (3.6323, 3.3200) | 0/2 |
| bun | `object-hit-128` | 4.062 | 3.766 | 0.9325 (1.0779, 0.8066) | 1/2 |
| bun | `scalar-number-control` | 1.548 | 1.554 | 1.0037 (1.0501, 0.9595) | 1/2 |
| bun | `cold-number-1024` | 201.766 | 230.617 | 1.1431 (1.1449, 1.1413) | 0/2 |
| bun | `changing-root-1024` | 19.514 | 61.279 | 3.0968 (3.8688, 2.4789) | 0/2 |


## Workloads and timing boundaries

Each case starts with a 4,096-entry Map. The complete public read, returned-array creation and assignment into the retention array are timed. Fixture creation, imports, reader attachment, output verification and source-byte checks are outside the timer.

| Case | Requested values | Reader state | Repetitions per batch |
|---|---:|---|---:|
| `number-hit-128` | 128 | Warm hits | 4,096 |
| `number-hit-1024` | 1,024 | Warm hits | 256 |
| `number-mixed-1024` | 1,024 | Half hits, half misses | 128 |
| `number-miss-128` | 128 | All misses | 512 |
| `string-hit-128` | 128 | Warm hits | 4,096 |
| `object-hit-128` | 128 | Warm hits | 1,024 |
| `scalar-number-control` | 128 | Unchanged scalar get loop | 4,096 |
| `cold-number-1024` | 1,024 | Fresh public read-only attachment for each operation | 64 |
| `changing-root-1024` | 1,024 | Alternate two retained roots in one read-only arena | 256 |

Every requested output position is checked against independently generated native-Map values. Frozen JSON values are checked completely once, then every returned reference is checked against the verified immutable object. Successful per-value checks allocate no diagnostic strings. Descriptors, the frontier and original published bytes are checked once per batch; verification does not traverse the entire source Map for each returned array. Root alternation is checked by operation ordinal, preventing an implementation that always returns one root's values from passing.

The cold case creates fresh reader caches outside timing; its underlying memory and query strings are already present and warm. The root-change case alternates two specific retained roots, rather than modeling an arbitrary stream of new writes. Untimed setup and verification can still affect later garbage collection and CPU behavior.

The driver uses one allowed CPU, one build/case per fresh process, an identical neutral import path, alternating AB/BA order and the common lock `/tmp/zerocopy-perf-20261108.lock`. Each hosted process has at least 500 ms of timed warmup and eight warmup batches, followed by nine measured batches. Pilot, confirmation and A/A use 2, 6 and 4 pairs respectively. The confirmation checked 23,736,320 returned arrays in timed warmup/measured batches, plus initial and final probes; every requested position was verified. All source/build manifests and raw samples are retained.

## Earlier local exploration

V1 only hoisted the frozen root/type and bypassed the native `get` dispatch. It used 150 ms warmup and a verifier that eagerly built a diagnostic string for every successful element check. Its full results are retained below; they do not establish a reliable performance conclusion.

| Runtime | Case | Before µs | After µs | Paired ratio (individual pairs) | Faster pairs |
|---|---|---:|---:|---|---:|
| node | `number-hit-128` | 4.313 | 6.507 | 1.5084 (1.5043, 1.5125) | 0/2 |
| node | `number-hit-1024` | 47.771 | 45.418 | 0.9274 (0.7142, 1.2041) | 1/2 |
| node | `number-mixed-1024` | 109.707 | 113.140 | 1.0333 (1.0481, 1.0187) | 0/2 |
| node | `number-miss-128` | 17.235 | 14.723 | 0.8700 (1.0284, 0.7361) | 1/2 |
| node | `string-hit-128` | 4.390 | 4.417 | 0.9976 (0.9644, 1.0321) | 1/2 |
| node | `object-hit-128` | 11.963 | 13.058 | 1.0549 (1.4733, 0.7553) | 1/2 |
| node | `scalar-number-control` | 3.257 | 4.656 | 1.4498 (1.7666, 1.1898) | 0/2 |
| bun | `number-hit-128` | 3.732 | 3.261 | 0.8729 (0.8596, 0.8864) | 2/2 |
| bun | `number-hit-1024` | 29.756 | 36.739 | 1.2242 (1.3056, 1.1480) | 0/2 |
| bun | `number-mixed-1024` | 75.548 | 70.807 | 0.9312 (1.0617, 0.8168) | 1/2 |
| bun | `number-miss-128` | 13.067 | 11.477 | 0.8885 (0.9345, 0.8448) | 2/2 |
| bun | `string-hit-128` | 2.266 | 1.872 | 0.8095 (0.6470, 1.0127) | 1/2 |
| bun | `object-hit-128` | 8.056 | 5.224 | 0.6684 (0.5030, 0.8883) | 2/2 |
| bun | `scalar-number-control` | 1.731 | 2.912 | 1.6812 (1.6672, 1.6953) | 0/2 |

The same-baseline local diagnostic increased warmup to 500 ms while preserving that workload. It still showed substantial movement within and between processes. Baseline source, all WASM files and all portable bundles match the accepted List and Boolean baseline records exactly, as documented in the [baseline audit](validation/pilot-v1-baseline-audit.json).

| Runtime | Case | Before µs | After µs | Paired ratio [95% CI] | Faster pairs |
|---|---|---:|---:|---|---:|
| node | `number-hit-128` | 2.692 | 3.177 | 1.2497 [0.8291, 1.8835] | 0/4 |
| node | `scalar-number-control` | 2.530 | 2.489 | 0.9920 [0.9083, 1.0834] | 2/4 |
| bun | `number-hit-128` | 2.890 | 2.104 | 0.8977 [0.5841, 1.3794] | 2/4 |
| bun | `scalar-number-control` | 2.543 | 3.215 | 1.1691 [0.6860, 1.9925] | 2/4 |

V2 uses a different runtime patch, longer pilot warmup, more repetitions for short cases, efficient verification and a hosted machine. The old records were not overwritten, and changes in stability cannot be attributed to any single one of those differences. Original V1 source, workload, driver and verifier remain in [exploration/v1](exploration/v1/).

## Raw timing diagnostics

Two distinct diagnostics are retained. “Measured trend” counts processes whose median final three measured batches differs by more than 20% from their median first three. The independent review's broader diagnostic also counts movement above 20% between the median final nine warmup batches and the median measured batch. The broader count is a union, not an additional set to add to the first count. Neither diagnostic removes or reweights any sample.

| Record | Processes | Measured trend >20% | Broader late-movement diagnostic | Measured batches <2 ms | Minimum measured batch ms |
|---|---:|---:|---:|---:|---:|
| `pilot-v1` | 56 | 24 | 32 | 39 | 1.036266 |
| `aa-diagnostic-v1` | 32 | 12 | 16 | 2 | 1.618616 |
| `pilot-v2-hosted` | 72 | 6 | 8 | 0 | 2.820086 |
| `formal` | 216 | 21 | 31 | 0 | 2.766654 |
| `aa` | 64 | 4 | 7 | 0 | 4.954505 |

The [raw per-process trend file](validation/raw-sample-trends.json) preserves all measured sequences and case-level counts. The [independent review](validation/independent-review.json) preserves its wider diagnostics. These are observations of variation, not evidence identifying JIT compilation, garbage collection or scheduling as the cause. All 3,168 hosted measured batches are at least 2 ms; the formal minimum is 2.766654 ms.

## Correctness and independent verification

The [hosted run](https://github.com/natanelia/zerocopy/actions/runs/42504561217) passed source/declaration/value types, 66 focused tests in Node and 66 in Bun, and all nine workload checks on both builds in both runtimes. Regression coverage includes dynamic get/value/owner replacement, function-call properties, sparse arrays, inherited indices, Array species, invalid keys, Unicode aliases, presence-only cache entries, cache limits, an empty root from a custom kernel, retained snapshots and actual memory growth.

Current and pinned-baseline Node readers each passed eight real-worker cases (four value types × shared/copied attachments). Chromium 153.0.8010.12 passed the same eight scenarios with real workers and cross-origin isolation. Their independent input oracles cover old/new/forked/compacted snapshots, old misses becoming present only in new roots, read-only behavior, unchanged published bytes and unchanged reader frontiers while writer capacity actually grows. See [current Node readers](validation/hosted/worker-current.json), [baseline Node readers](validation/hosted/worker-baseline.json) and [browser evidence](validation/hosted/browser.json).

The independent audit checks all 70 runtime/source files, 12 WASM files and 12 portable bundles for both current candidate and baseline, and verifies baseline source against pinned Git. It confirms that all archived gzip files decode byte-for-byte to the original records. V1's candidate bundle hashes remain in its manifest; those historical uncommitted candidate bundles were not rebuilt. Binary fixture images were not retained, so the independent audit checks their recorded hashes for consistency rather than reconstructing the original image.

## Provenance and retained data

The hosted measurements ran on Linux x64, Intel Xeon 6973P-C, pinned CPU 0, with Node 24.22.1 and Bun 1.4.2. The pilot began at 2026-11-08 17:22:33 UTC; confirmation ran from 17:23:29 to 17:26:17; A/A finished at 17:27:08. The complete run is job `128804276166`, artifact `13626752507`.

The downloaded ZIP SHA-256 is `c96fc3c1959ad9cd79a2cf7abcab6b6393115f09d725e9f6c94fe585b1971c9a`. Every extracted member matched the ZIP and every raw artifact member is retained. Records use gzip level 9, empty filename and mtime 0, with exact byte roundtrips checked before deleting redundant plain copies. No recorded field was rewritten. The [provenance manifest](validation/hosted-provenance.json) records original and compressed hashes, sizes and member mappings; the [full completed job log](validation/hosted/job.log.gz) is retained too.

| Record | Processes | Original raw SHA-256 |
|---|---:|---|
| [pilot-v1.json.gz](results/pilot-v1.json.gz) | 56 | `c16cdd30dbe65e2a8b975037ed6307b3a718cc3077089f52b80a8cadebaaf07d` |
| [aa-diagnostic-v1.json.gz](results/aa-diagnostic-v1.json.gz) | 32 | `33a2982a37e688b4bff05b3f75a5db8409f9dd3875200c2cac5e47a35513a9a4` |
| [pilot-v2-hosted.json.gz](results/pilot-v2-hosted.json.gz) | 72 | `4ec99306c493bcc393b892c8f6b0a5b5ba1baeb5f05a10cfd2f7231e98823442` |
| [formal.json.gz](results/formal.json.gz) | 216 | `33072092480b0c9d9043d3a85a072629ed0f93dbf7cc4f3c3cf4eaff3ebf4656` |
| [aa.json.gz](results/aa.json.gz) | 64 | `90fda1978cda9969d0122f0a04a42e0b7d6197faf1d37cb18f11b4a424a3ee83` |

The archived workflow contains no timing command or feature-branch timing trigger. It runs correctness checks on the current checkout, rebuilds the candidate SHA from `formal.source.after.commit` in a separate worktree, and checks exact historical hashes against that build. A/A is audited against the pinned baseline. This keeps the old performance evidence attached to the measured code rather than requiring unrelated future changes to reproduce its hashes.

## Reproduce without overwriting evidence

Use Node 24.22.1 and Bun 1.4.2. The independent Python checker also requires SciPy. Start from this archived branch. The primary collection below builds the exact measured candidate and baseline in fresh worktrees and writes new results to a temporary directory. The driver owns the common lock; do not add a second lock around it for the same path. No rerun is needed to accept the rejection.

```bash
archive_checkout="$(pwd)"
proof="$archive_checkout/proofs/map-bulk-reads-20261108"
study_workspace="$(mktemp -d)"
git worktree add --detach "$study_workspace/baseline" a4265a0608ec25eec5719496225212db6b251989
git worktree add --detach "$study_workspace/candidate" 0f6f19844349a48cd2ad20e570953b9279778871
(cd "$study_workspace/baseline" && bun install && bun run build:wasm && bun run build:browser)
(cd "$study_workspace/candidate" && bun install && bun run build:wasm && bun run build:browser)
node "$proof/smoke.mjs" "$study_workspace/baseline" "$study_workspace/candidate"
bun "$proof/smoke.mjs" "$study_workspace/baseline" "$study_workspace/candidate"
study_cpu="$(awk '/Cpus_allowed_list/ { split($2, ranges, ","); split(ranges[1], first, "-"); print first[1] }' /proc/self/status)"
taskset -c "$study_cpu" node "$proof/paired-benchmark.mjs" "$proof/workloads.mjs" "$study_workspace/baseline" "$study_workspace/candidate" "$(command -v bun)" "$study_workspace/pilot.json" pilot
taskset -c "$study_cpu" node "$proof/paired-benchmark.mjs" "$proof/workloads.mjs" "$study_workspace/baseline" "$study_workspace/candidate" "$(command -v bun)" "$study_workspace/formal.json" formal
taskset -c "$study_cpu" node "$proof/paired-benchmark.mjs" "$proof/workloads.mjs" "$study_workspace/baseline" "$study_workspace/candidate" "$(command -v bun)" "$study_workspace/aa.json" aa
node "$proof/verify.mjs" "$study_workspace/pilot.json" "$study_workspace/candidate"
node "$proof/verify.mjs" "$study_workspace/formal.json" "$study_workspace/candidate"
node "$proof/verify.mjs" "$study_workspace/aa.json" "$study_workspace/baseline"
```

The retained records can be verified without collecting timings. These commands use the builds above. The independent checker uses the archived checkout for its retained proof files; its runtime is unchanged from the measured candidate and is checked exactly.

```bash
node "$proof/verify.mjs" "$proof/results/pilot-v2-hosted.json" "$study_workspace/candidate"
node "$proof/verify.mjs" "$proof/results/formal.json" "$study_workspace/candidate"
node "$proof/verify.mjs" "$proof/results/aa.json" "$study_workspace/baseline"
gzip -dc "$proof/results/pilot-v1.json.gz" > "$study_workspace/old-pilot.json"
gzip -dc "$proof/results/aa-diagnostic-v1.json.gz" > "$study_workspace/old-aa.json"
node "$proof/exploration/v1/verify.mjs" "$study_workspace/old-pilot.json"
node "$proof/exploration/v1/verify.mjs" "$study_workspace/old-aa.json" "$study_workspace/baseline"
(cd "$archive_checkout" && bun install && bun run build:wasm && bun run build:browser)
python3 "$proof/validation/independent-review.py" "$proof/results" "$archive_checkout" "$study_workspace/baseline" "$study_workspace/independent-review.json"
```
