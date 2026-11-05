# Rejected portable queue encoding study

**Evidence only; no optimization PR.** The final variant reduced numeric queue encoding and stringifying time in every confirmation pair, but a recurring Bun JSON fallback cost left the fixed conservative acceptance gate unmet. No further queue variant or timing run follows this decision. The final archive branch restores active production and tests to baseline; exact measured variants remain in this proof directory.

## Decision and scope

For 4,096 numeric items, V3 reduced paired geometric latency by **54.8% on Node and 68.4% on Bun** for `codec.encode`, and by **45.9% and 38.9%** for `codec.stringify`. The 34-item offset queue also improved in all six pairs on both engines. These are complete-operation results for the recorded workloads, not a general codec speedup.

The mandatory **256-item JSON queue control on Bun was slower in five of six pairs**, across both A/B orders: paired ratio **1.0699 [0.9952, 1.1502]**. Its marginal median increased from **2.327606 to 2.465196 ms**, a **0.137590 ms** difference. The interval barely spans parity; it does not establish equivalence or absence of a regression. The fixed plan requires rejecting a recurring material fallback cost. The strong numeric gains are preserved without forcing a PR.

The empty-queue concern from screening was also retained. Node's paired ratio is **1.0147 [0.6037, 1.7055]**, with four adverse pairs; its marginal medians are **431.844 and 479.099 ns** (+47.254 ns). Bun's paired ratio is **0.9718 [0.8274, 1.1412]**, with three adverse pairs; marginal medians are **334.818 and 343.686 ns** (+8.868 ns). These wide/mixed results do not prove neutrality. Marginal median differences and paired geometric effects are different statistics, so their direction or percentage need not agree.

No gain is claimed for unchanged stack/plain-state or string/JSON fallback controls. All controls, including the Bun JSON cost, remain in the tables below. The decision is conservative; it is not a claim that the control regression has been proved on every engine or workload.

## What was measured

The original portable encoder calls public `peek()` and `dequeue()` for every queue item. Each dequeue creates and freezes a temporary immutable queue handle; committed-prefix peeks resolve the vector path repeatedly. The candidate scans immutable blocks, resolves one committed leaf per at most 32 values, and keeps the existing decoder and recursive value encoder.

Only number/boolean queues with at least **32 live items**, unchanged `peek`, `dequeue` and `isEmpty` descriptors, and an exact base Arena with its original unshadowed decoder take the direct path. Other types, smaller queues, replaced read methods, custom decoders and Arena subclasses use the existing public-operation loop. Original identities are captured in their defining modules, so replacement getters are not invoked by the guard and pre-Redux-import replacements are detected. Exact built-in queue recognition is unchanged; unsupported subclasses remain unsupported. This is not a general promise about arbitrary changes to other internals, WASM exports or language intrinsics.

V3 moves the traversal and guards into `appendQueueItems`, a codec-local helper. It receives the existing output array, recursive walker and child depth directly; it creates no extra callback or intermediate result array. Portable result arrays/envelopes, normal JavaScript allocation/GC and small descriptor objects still exist. There is no allocation-free claim, public export, binary format or checkpoint change.

The [fixed plan](PLAN.md) records the threshold, all ten cases, correctness amendment and final structural amendment before their respective new measurements. V1's correctness failure and V2's adverse controls remain in separate exact archives. No earlier variant is treated as a final gain estimate.

## Final confirmation: every workload

Times are milliseconds per complete public call. Before/after columns are marginal medians of six process medians; effects are geometric means of the six within-pair candidate/baseline ratios. Nominal 95% log-t intervals use df 5. Lower ratios are faster. “Slower pairs” counts observed ratios above one.

| Runtime | Case | Baseline ms | Candidate ms | Paired ratio [95% interval] | Slower pairs | All six ratios |
|---|---|---:|---:|---:|---:|---|
| node | queue-empty | 0.000432 | 0.000479 | 1.0147 [0.6037, 1.7055] | 4/6 | 1.2873, 1.8685, 0.6899, 1.2996, 0.4731, 1.0694 |
| node | queue-one | 0.000734 | 0.000644 | 0.8927 [0.8066, 0.9880] | 1/6 | 0.7978, 1.0536, 0.9380, 0.8747, 0.8680, 0.8456 |
| node | queue-tail31 | 0.005807 | 0.005453 | 0.8998 [0.7459, 1.0854] | 2/6 | 0.8098, 0.8595, 0.6844, 0.9498, 1.0798, 1.0861 |
| node | queue-offset34 | 0.005026 | 0.002571 | 0.4888 [0.3811, 0.6271] | 0/6 | 0.3820, 0.5426, 0.6446, 0.5284, 0.5527, 0.3497 |
| node | queue-number4096 | 0.554230 | 0.244242 | 0.4515 [0.4148, 0.4915] | 0/6 | 0.4365, 0.4751, 0.5042, 0.3982, 0.4607, 0.4417 |
| node | queue-stringify4096 | 0.723096 | 0.379733 | 0.5412 [0.4812, 0.6087] | 0/6 | 0.5166, 0.5627, 0.6534, 0.5321, 0.4649, 0.5346 |
| node | queue-unicode1024 | 0.140239 | 0.123675 | 0.8991 [0.7263, 1.1131] | 2/6 | 1.0172, 0.7514, 0.8833, 0.8895, 0.7098, 1.2395 |
| node | queue-json256 | 3.335562 | 3.286856 | 0.9619 [0.9101, 1.0166] | 2/6 | 0.9440, 1.0232, 1.0239, 0.9337, 0.8968, 0.9565 |
| node | stack-number4096-control | 0.694343 | 0.736475 | 1.0505 [0.9285, 1.1884] | 3/6 | 1.3024, 1.0141, 0.9315, 0.9981, 1.0974, 0.9971 |
| node | plain-array4096-control | 1.813351 | 1.748581 | 0.9831 [0.8273, 1.1683] | 2/6 | 1.0438, 0.8241, 0.8877, 0.9923, 1.3128, 0.9076 |
| bun | queue-empty | 0.000335 | 0.000344 | 0.9718 [0.8274, 1.1412] | 3/6 | 0.9647, 0.7221, 1.0607, 1.0384, 1.1053, 0.9929 |
| bun | queue-one | 0.000384 | 0.000372 | 0.9384 [0.7862, 1.1200] | 1/6 | 1.2921, 0.9217, 0.8218, 0.9648, 0.8264, 0.8749 |
| bun | queue-tail31 | 0.002888 | 0.002693 | 0.9623 [0.8261, 1.1210] | 1/6 | 0.9452, 0.9731, 0.8693, 0.9450, 0.8325, 1.2624 |
| bun | queue-offset34 | 0.003137 | 0.001718 | 0.5226 [0.4454, 0.6132] | 0/6 | 0.5509, 0.5933, 0.4067, 0.4655, 0.5509, 0.5978 |
| bun | queue-number4096 | 0.282754 | 0.089968 | 0.3158 [0.2556, 0.3902] | 0/6 | 0.2663, 0.2861, 0.3942, 0.2435, 0.3696, 0.3672 |
| bun | queue-stringify4096 | 0.413818 | 0.249312 | 0.6110 [0.5785, 0.6454] | 0/6 | 0.5983, 0.5721, 0.6637, 0.6278, 0.5909, 0.6174 |
| bun | queue-unicode1024 | 0.085271 | 0.084436 | 0.9904 [0.9399, 1.0437] | 2/6 | 0.9961, 1.0533, 0.9780, 0.9595, 1.0399, 0.9221 |
| bun | queue-json256 | 2.327606 | 2.465196 | 1.0699 [0.9952, 1.1502] | 5/6 | 0.9973, 1.0480, 1.1010, 1.2122, 1.0322, 1.0415 |
| bun | stack-number4096-control | 0.298147 | 0.280536 | 0.9144 [0.8242, 1.0146] | 1/6 | 0.7783, 0.8542, 0.9334, 1.0150, 0.9363, 0.9914 |
| bun | plain-array4096-control | 2.308195 | 2.246261 | 0.9749 [0.9130, 1.0411] | 1/6 | 0.9570, 0.9316, 1.0862, 0.9912, 0.9854, 0.9080 |

The confirmation contains **240 measured processes, 120 pairs and 2,640 measured batches**, with all end-of-run source/build/driver guards passing. Actual timed warm-up ranged from **500.002 to 3647.414 ms**, over **8–26 batches**. The shortest measured batch was **11.148 ms**; **169** batches fell below the 20 ms calibration target and **108** subjects used a repeat cap. None were excluded. Subjects verified **94,966,338 complete calls** and **1,680,931,960 counted output elements** outside timing; counts exclude their initial one-shot checks.

## Method and limits

Recorded on 2026-11-05 with **Node 24.22.1 and Bun 1.4.2**, Linux x64 on an AMD EPYC 9V74. Controllers and children were pinned to CPU 2, with heavy work serialized using the shared performance lock. Each fresh measured process imports one complete portable build at the same neutral pathname and runs one workload. This measures those packaged portable builds on these engines, not browser or cold-start performance.

The ten cases are: empty/one/31-item numeric queues; a 65-item queue after 31 dequeues (34 live values, crossing a prefix/tail boundary); numeric encode and stringify at 4,096 items; 1,024 Unicode strings; 256 nested JSON values; an unchanged 4,096-number stack; and an unchanged 4,096-value plain array. Number inputs include NaN, infinities and negative zero. Native inputs determine the complete expected envelope/text; the optimized traversal never creates the oracle.

Every subject first performs the same measured operation once and verifies it. String and JSON inputs fit the ordinary 2,048-entry/2 MiB decode cache and are warmed symmetrically. No cache clearing or forced GC occurs. Fresh and read-only readers are separate correctness checks, not a cold-reader performance claim.

The three exploratory pilots each use two balanced process pairs per case/runtime, seven measured batches and at least 150 ms actual timed warm-up. Only the unchanged V3 pilot's prospective common repetition plans feed the six-pair confirmation, with eleven batches after at least 500 ms actual timed warm-up, eight batches and 32,768 output/bookkeeping units. Pair order alternates; case order rotates. Warm-up floors are measured elapsed time, not a promise that all runtime tiers have reached steady state.

Timing includes the outer result-retention array and every complete encode/stringify result. Every output escapes through a global blackbox and is fully checked after timing, alongside unchanged shared bytes, capacity and allocation position. Construction, native oracle work, memory hashing and verification are excluded. Temporary snapshot removal is part of the real operation; normal GC remains timed.

Common repetitions are calibrated from both builds. Caps are 65,536 calls, 1,048,576 estimated materialized slots and an estimated 32 MiB returned storage per batch. The estimate is not heap, RSS or peak memory; the prior retained batch may remain live while the next is created. The 20 ms target is not a guaranteed minimum. A 512-batch warm-up limit fails visibly instead of relaxing the floor.

Independent observations are process-pair medians, not individual batches or calls. Intervals are nominal per-case intervals, with no multiple-comparison correction. Small differences and wide intervals on a shared runner are not performance guarantees. Neither the earlier variants nor the pilots are pooled into the formal estimates.

## All exploratory outcomes

Each entry shows the geometric two-pair ratio followed by both ratios. These screening estimates have no inferential confidence interval.

### V1: superseded for correctness

This broad traversal could ignore queue-method changes made during nested reconstruction or a custom decoder. Its complete successful timing run does not validate the implementation. No V1 result contributes to the final estimate.

| Case | Node ratio (both pairs) | Bun ratio (both pairs) |
|---|---:|---:|
| queue-empty | 1.2883 (0.8412, 1.9729) | 0.9244 (1.0006, 0.8540) |
| queue-one | 0.9919 (1.0222, 0.9625) | 1.1274 (1.2728, 0.9987) |
| queue-tail31 | 1.2131 (1.0686, 1.3772) | 0.9788 (0.9174, 1.0444) |
| queue-offset34 | 0.6546 (0.6230, 0.6878) | 0.3986 (0.3968, 0.4005) |
| queue-number4096 | 0.3498 (0.1394, 0.8779) | 0.3759 (0.3709, 0.3810) |
| queue-stringify4096 | 0.5954 (0.6249, 0.5673) | 0.6713 (0.4725, 0.9538) |
| queue-unicode1024 | 0.2576 (0.2846, 0.2331) | 0.3842 (0.3508, 0.4207) |
| queue-json256 | 0.9610 (0.9237, 0.9998) | 0.9999 (1.0312, 0.9696) |
| stack-number4096-control | 0.9076 (0.8309, 0.9915) | 0.9854 (1.4029, 0.6921) |
| plain-array4096-control | 1.1206 (1.1057, 1.1358) | 1.0598 (1.0967, 1.0243) |

### V2: repaired primitive scope, adverse controls

The primitive/native-decoder repair passed its regressions, but Node empty/Unicode and Bun empty/stack controls were adverse in both pilot pairs. These results motivated one final structural hypothesis; they are not pooled into confirmation.

| Case | Node ratio (both pairs) | Bun ratio (both pairs) |
|---|---:|---:|
| queue-empty | 1.7156 (2.2449, 1.3111) | 1.0589 (1.0342, 1.0842) |
| queue-one | 0.9566 (0.8187, 1.1178) | 1.0173 (0.9441, 1.0961) |
| queue-tail31 | 0.9812 (0.8341, 1.1541) | 0.8322 (0.8544, 0.8107) |
| queue-offset34 | 0.2419 (0.2198, 0.2662) | 0.5358 (0.4389, 0.6542) |
| queue-number4096 | 0.6568 (0.5921, 0.7286) | 0.3762 (0.3914, 0.3616) |
| queue-stringify4096 | 0.5636 (0.5773, 0.5502) | 0.5409 (0.4629, 0.6320) |
| queue-unicode1024 | 1.1005 (1.0039, 1.2065) | 0.8809 (0.9157, 0.8475) |
| queue-json256 | 0.9917 (1.0479, 0.9385) | 1.0050 (0.8977, 1.1251) |
| stack-number4096-control | 1.0821 (0.8543, 1.3705) | 1.1926 (1.2059, 1.1794) |
| plain-array4096-control | 0.8059 (1.0344, 0.6278) | 1.0115 (0.8165, 1.2530) |

### V3: final helper extraction screen

The same guarded traversal moved outside the recursive walker. Empty remained adverse/noisy in this pilot, and every case was carried unchanged into the fixed confirmation. Moving the code was a hypothesis about frame/code size, not an established cause of timing differences.

| Case | Node ratio (both pairs) | Bun ratio (both pairs) |
|---|---:|---:|
| queue-empty | 1.2588 (0.8791, 1.8024) | 1.1264 (1.0436, 1.2157) |
| queue-one | 0.7697 (0.8691, 0.6817) | 0.9616 (1.2537, 0.7376) |
| queue-tail31 | 0.7160 (0.5708, 0.8981) | 0.9785 (0.9229, 1.0376) |
| queue-offset34 | 0.6414 (0.7569, 0.5435) | 0.5303 (0.5541, 0.5076) |
| queue-number4096 | 0.4166 (0.4239, 0.4093) | 0.4430 (0.4531, 0.4331) |
| queue-stringify4096 | 0.5798 (0.5602, 0.6002) | 0.5037 (0.4256, 0.5963) |
| queue-unicode1024 | 1.0542 (0.9869, 1.1262) | 1.0374 (0.9830, 1.0948) |
| queue-json256 | 1.0041 (0.9668, 1.0428) | 0.9675 (0.9243, 1.0128) |
| stack-number4096-control | 1.0231 (1.0533, 0.9937) | 0.8704 (0.9788, 0.7741) |
| plain-array4096-control | 0.9758 (0.8603, 1.1067) | 0.9955 (0.9504, 1.0426) |

## Correctness and retained failures

V3 passed the portable browser/declaration builds, general and Redux type checks, **86 focused tests across four files**, **eight fresh-process pre/post-import compatibility cases**, and **two actual Node workers** using shared and copied transport. This is focused validation; no default full-suite or package-gate success is claimed for the rejected variant.

Tests cover FIFO offsets/tails and vector levels, special numbers, booleans, UTF-8/surrogate normalization, JSON and nested values, retained snapshots/forks, read-only readers, memory growth during captured-view reads, and exact node/depth/collection/text-limit failures. The custom queue-method/decoder cases preserve getter counts and changes made during nested reconstruction. Actual workers verify fresh/warm exports and old snapshots after owner/dependency growth and default resets.

- [Initial V1 validation](validation/initial-01.txt) passed its then-existing checks. A later peer review found that a nested reconstruction or custom decoder could change queue methods after the one-time guard.
- [Repair validation](validation/repair-02.txt) first runs the new custom-decoder regression against the exact archived V1 build and expects the demonstrated failure (65 values instead of one), then rebuilds V2 and passes the full focused/compatibility/worker checks. Its JSON record includes old bundle identities and source guards.
- [Structural preflight failure](validation/structural-03.txt) is retained: the wrapper omitted Bun's directory from child PATH, so the package script exited 127 before building. There was no source change.
- [Corrected V3 validation](validation/structural-04.txt) uses the same source hashes with the corrected child PATH and passes all checks. This environment repair is not a new source variant.

An [independent Python review](review/independent-audit-map.py) and its [recorded result](review/independent-audit-map.json) recomputed all 240 formal process medians, 120 pair ratios, 20 intervals, 2,640 measured batches, verification counts and 297 original source/driver identities. It confirmed both the numeric gains and the unresolved Bun JSON risk. That historical script assumes the original frozen checkout; use the saved-evidence verifier below after active sources are restored.

The successful correctness checks do not clear the performance acceptance gate.

## Provenance and saved evidence

Baseline is public commit `77599337867dbf785a5f0311d34637d0b36678fc`. The final measured local commit is `21172d84b71be2df0000b68757560e8d50f86381`. Local commit IDs identify the original measurement checkout; they need not be remotely fetchable after publication recreates a Git tree.

- [V1 exact sources/tests/driver](superseded-reentry/archive-manifest.json), superseded for correctness.
- [V2 exact sources/tests/driver](superseded-inlined/archive-manifest.json), superseded after adverse controls.
- [V3 exact source/test archive](source-v3/archive-manifest.json), including Redux source SHA-256 `c21410fae47d10073cb1e6f888610a28e084583c72d1804b3150c873b851e38d`.
- [Evidence manifest](evidence-manifest.json): stored/decompressed study identities and immutable artifact hashes.
- [Saved-evidence verifier](verify.mjs): verifies archived sources/harness, full case/process order, calibration and warm-up, complete-output counts, medians, all pair ratios and intervals. It does not benchmark or require future live production sources to retain the measured hashes.

All four recordings are losslessly gzipped and round-trip checked. Test-source copies end in `.txt`, so they cannot be discovered as active Vitest files. The raw records retain full production/test/build-support/WASM/imported-bundle manifests. Both builds' support inputs and WASM match, and only the intended production files differ. Across separate recordings there are **480 measured processes, 240 pairs and 4,320 measured batches**; these totals are completeness counts, not a pooled estimate.

| Recording | Measured local commit | Raw bytes | Raw SHA-256 |
|---|---|---:|---|
| [pilot-01](results/pilot-01.json.gz) | `d910db0a5764f74f9d4f27c61e65ed0ac8dfd2f4` | 672,288 | `5ce4cfbdf2fc1782e52e44fb4e38918dbc48dcb105b78b4fd15013ad4b10a22d` |
| [pilot-02](results/pilot-02.json.gz) | `568aa128f31ef90fab2e2ff9e07dcee882864bc4` | 659,258 | `417f69e5c4f2ceffbcf038bc0f522fcbe557a4c8b973803bbcf378b8ebb1d4fe` |
| [pilot-03](results/pilot-03.json.gz) | `21172d84b71be2df0000b68757560e8d50f86381` | 683,019 | `7f486d2196d0d44d91b3209931744fb02a06108c2e5e9922f3b6189a2eb4ddde` |
| [formal-01](results/formal-01.json.gz) | `21172d84b71be2df0000b68757560e8d50f86381` | 1,753,792 | `3a7c9f31a4bb4fb86b2b9ecfc4cd0881073a21f64e66391d9b76e0436cd71930` |

Validate the saved evidence without rerunning timing:

```sh
node proofs/queue-portable-20261105/verify.mjs
```

This rejected evidence-only branch adds no CI step and no active runtime or test change.

## Reproduction

From the published evidence checkout, reconstruct V3 from the public baseline and exact archived files, not a local-only candidate commit. The baseline has no committed dependency lockfile. Its documented `bun install` uses pinned direct versions, but fresh transitive resolutions can differ; recorded source/build hashes identify the measured artifacts. A fresh formal comparison requires the same build inputs as its own fresh pilot.

```sh
QUEUE_ARCHIVE="$PWD/proofs/queue-portable-20261105"
git worktree add --detach ../queue-before 77599337867dbf785a5f0311d34637d0b36678fc
git worktree add --detach ../queue-after 77599337867dbf785a5f0311d34637d0b36678fc
cp -R "$QUEUE_ARCHIVE" ../queue-after/proofs/
for source in arena.ts redux-codec.ts shared-queue.ts redux-queue-traversal.test.ts; do
  cp "$QUEUE_ARCHIVE/source-v3/$source.txt" "../queue-after/$source"
done
for build in ../queue-before ../queue-after; do
  (cd "$build" && bun install && bun run build:wasm && bun run build:browser && bun run build:types)
done
node ../queue-after/proofs/queue-portable-20261105/compatibility.mjs
node ../queue-after/proofs/queue-portable-20261105/worker.mjs
```

Use Node 24.22.1 and Bun 1.4.2. In a shared environment, every build/test/timing command must use the same lock as concurrent jobs; this session used `/workspace/scratch/83f1d4baba1f/perf.lock`. On Linux, pin timing controllers/children to CPU 2 and choose new output paths:

```sh
taskset -c 2 node "$QUEUE_ARCHIVE/benchmark.mjs" pilot   ../queue-before ../queue-after /absolute/path/to/bun /tmp/queue-new-pilot.json
taskset -c 2 node "$QUEUE_ARCHIVE/benchmark.mjs" formal   ../queue-before ../queue-after /absolute/path/to/bun   /tmp/queue-new-formal.json /tmp/queue-new-pilot.json
```

The driver refuses overwrite, records actual source/build identities and checks them again on completion. Reconstruct earlier variants using their archived sources and copy the matching archived driver/fixtures/worker/compatibility/plan together into the original `proofs/queue-portable-20261105/` layout; nested archive worker paths are not standalone package roots. No claim is made for other engines, devices, browsers, cold caches or workload mixes.
