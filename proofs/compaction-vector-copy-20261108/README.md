# Primitive vector compaction: 8 November 2026

## Change

`compact()` and `compactMany()` rebuild live immutable data in a new writable arena. Previously, numeric and boolean lists and queues read each scalar into a temporary JavaScript array, then wrote that array into the new arena. Tree values also crossed the JavaScript/WASM boundary once per scalar.

This change copies complete live byte spans for native numeric and boolean vectors with at least 32 values. It validates source spans first, then copies up to 32 values per span and builds the same target index. Consumed queue prefixes are excluded. The source arena remains untouched. Raw copies preserve numeric value semantics, including NaN, negative zero, infinities and subnormal numbers. No promise is made that an arbitrary NaN payload has the same byte representation as the previous read/array/write path.

Small vectors, strings, JSON, nested values, linked lists, custom descriptors, custom Arena views and replaced WASM kernels retain their existing path. A private original-WASM reference adds one field to each Arena; the standalone reset/empty-list control measures complete Arena construction and publication. Descriptor identities are captured in their defining modules, including for later compaction imports. Bounds preflight and the original fallback retain errors for the malformed descriptors covered by the tests. No public API, serialized layout, WASM code or dependency changes.

## Results

The confirmation used Linux x64 on an AMD EPYC 9V74 80-Core Processor, CPU 2, Node 24.22.1 and Bun 1.4.2. It measured one complete `compact(source)` operation, including fresh Arena/WASM construction. The candidate uses the same WASM bytes and target payload allocation as the baseline for valid inputs.

**All three large Node targets improved in all 18 paired comparisons, with 56.9–65.1% less time and all three 95% intervals below parity.** The Bun offset-queue target used 10.6% less time (five of six pairs faster, interval 0.815–0.981). Bun's numeric and boolean list targets remain inconclusive; their intervals cross parity.

**Small and generic controls do not establish absence of regressions.** The 33-item list estimates **49.5% slower on Node** (ratio interval 0.730–3.062) and **22.5% slower on Bun** (0.638–2.352). The string fallback is slower in five of six pairs in both runtimes: **21.5% slower on Node** (0.785–1.881) and **2.8% slower on Bun** (0.895–1.180). Every interval in this paragraph crosses parity; none establishes equivalence or a guaranteed slowdown. These unfavorable observations are preserved without additional tuning or timing reruns.

**Related setup-cost evidence:** the separate [priority-queue encoding study](https://github.com/natanelia/zerocopy/blob/perf/redux-heap-read-view-20261108/proofs/redux-heap-read-view-20261108/README.md) uses the identical `arena.ts` change. Its final standalone reset/empty-list control measured Node medians of **35.995 → 43.127 µs**, with a **26.1% paired slowdown** (ratio 1.261, 95% interval 1.012–1.572; all six pairs slower). Its Bun estimate was 11.4% slower, with an interval crossing parity. This separate observation must be considered alongside this report's uncertain setup control; it is not a combined performance measurement and neither study adjusts the other. The large compaction results above already include fresh Arena construction.

### Complete confirmation matrix

| Runtime | Complete public operation | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| Node | compact numeric list · 65,536 | 3,581.078 | 1,646.329 | 0.431 (0.358–0.519) | 6/6 |
| Node | compact boolean list · 65,536 | 3,619.712 | 1,225.976 | 0.349 (0.268–0.454) | 6/6 |
| Node | compact numeric queue · 65,536 after 37 dequeues | 3,600.216 | 1,138.204 | 0.363 (0.276–0.478) | 6/6 |
| Node | compact numeric list · 33 | 47.017 | 101.909 | 1.495 (0.730–3.062) | 2/6 |
| Node | compact numeric list · 8 (control) | 50.067 | 48.827 | 0.710 (0.375–1.344) | 4/6 |
| Node | compact string list · 1,024 (control) | 1,110.740 | 1,316.770 | 1.215 (0.785–1.881) | 1/6 |
| Node | reset + empty-list construction (control) | 38.341 | 36.802 | 0.687 (0.282–1.674) | 4/6 |
| Bun | compact numeric list · 65,536 | 6,078.509 | 7,065.817 | 1.061 (0.888–1.268) | 2/6 |
| Bun | compact boolean list · 65,536 | 7,315.998 | 5,961.001 | 0.873 (0.687–1.110) | 4/6 |
| Bun | compact numeric queue · 65,536 after 37 dequeues | 6,382.734 | 5,525.328 | 0.894 (0.815–0.981) | 5/6 |
| Bun | compact numeric list · 33 | 2,773.424 | 3,006.084 | 1.225 (0.638–2.352) | 3/6 |
| Bun | compact numeric list · 8 (control) | 3,415.487 | 2,866.355 | 0.958 (0.825–1.114) | 4/6 |
| Bun | compact string list · 1,024 (control) | 8,673.153 | 7,999.947 | 1.028 (0.895–1.180) | 1/6 |
| Bun | reset + empty-list construction (control) | 4,185.639 | 3,994.188 | 0.994 (0.694–1.424) | 3/6 |

The displayed medians and paired ratios summarize different aspects of the same matched processes. Percentage reductions above use the paired ratios, not a ratio of the two displayed medians.

**Short batches:** 208 of 1,512 measured confirmation batches were shorter than two milliseconds, all in Node's 33-item, 8-item and reset controls. All were retained and flagged. The primary large-case batches were not in this group. The fixed 32-output calibration bounded live Arena counts across runtimes; it did not guarantee a minimum duration for every Node control batch.

### Identical-baseline diagnostics

These are four fresh A/A process pairs per selected case/runtime, using the final batch lengths. All intervals cross parity. They show substantial variability in three of the four estimates and are not subtracted from the A/B results.

| Runtime | Complete public operation | Before µs | After µs | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| Node | compact numeric list · 65,536 | 1,721.484 | 2,348.253 | 1.155 (0.794–1.680) | 2/4 |
| Node | reset + empty-list construction (control) | 38.500 | 48.265 | 1.019 (0.445–2.335) | 1/4 |
| Bun | compact numeric list · 65,536 | 2,791.796 | 2,763.789 | 0.920 (0.515–1.641) | 2/4 |
| Bun | reset + empty-list construction (control) | 1,115.878 | 1,127.856 | 1.004 (0.969–1.041) | 2/4 |

The A/A recording also retains all 64 measured batches below two milliseconds (out of 288).

### Preserved pilot

The pilot used the earlier guard ordering and 128-output small/reset batches. It is kept separate from confirmation, including Bun's slower 33-item list in both pilot pairs. No pilot results were pooled into final estimates.

| Runtime | Complete public operation | Before µs | After µs | Paired after/before | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| Node | compact numeric list · 65,536 | 2,577.240 | 714.966 | 0.277 | 2/2 |
| Node | compact numeric queue · 65,536 after 37 dequeues | 2,690.857 | 1,164.796 | 0.430 | 2/2 |
| Node | compact numeric list · 33 | 111.823 | 104.430 | 0.935 | 2/2 |
| Node | reset + empty-list construction (control) | 82.262 | 86.333 | 1.044 | 1/2 |
| Bun | compact numeric list · 65,536 | 6,616.460 | 5,664.016 | 0.842 | 2/2 |
| Bun | compact numeric queue · 65,536 after 37 dequeues | 6,159.331 | 4,894.580 | 0.822 | 2/2 |
| Bun | compact numeric list · 33 | 7,088.419 | 7,893.722 | 1.124 | 0/2 |
| Bun | reset + empty-list construction (control) | 8,102.264 | 6,646.342 | 0.829 | 1/2 |

[Compressed pilot](results/pilot.json.gz), [confirmation](results/confirmation.json.gz) and [A/A recordings](results/aa.json.gz) retain every raw batch, source/build hash, embedded changed source, output-oracle identity and runtime/host record. [manifest.json](manifest.json) gives compressed and uncompressed checksums. Independent verification covers **232 processes and 2,088 measured batches** across all three studies.


## Method

- Frozen baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e` (`main`). Four changed runtime sources are embedded and hashed in each recording. The measured candidate retained that Git HEAD with uncommitted source edits; its exact embedded text and SHA-256 hashes identify the measured implementation.
- Complete public `compact(source)` calls, including new Arena/WASM construction and returned-snapshot creation, are timed. The reset control times `resetSharedList()` plus `new SharedList('number')`. No implementation-only loop or synthetic replacement baseline is used.
- Separate fresh processes for every build, case, runtime and pair; alternating AB/BA order; case/runtime order reverses on alternate pairs; neutral identical import path; CPU 2; exclusive `/tmp/zerocopy-perf-20261108.lock` shared with all task builds, tests and timing studies.
- Six confirmation pairs per runtime/case, at least 500 ms actual timed warmup and eight warmup batches, then nine retained measured batches. Ratios are geometric means of matched process medians; 95% intervals use Student-t intervals on paired log ratios. Displayed before/after times are medians of those process estimates and need not reproduce the paired ratio exactly.
- The two-pair pilot used 128 retained outputs for small/reset cases and eight for larger cases. Bun produced unusually long small/reset batches with 128 simultaneously retained outputs. Before confirmation, a separate frozen [confirmation workload](confirmation-workloads.mjs) set those cases to 32 outputs for both runtimes, retaining eight for the other cases. It pins the original [workload](workloads.mjs) hash. Before confirmation, two guard-only production repairs moved the native-WASM private-brand check ahead of reflection and rejected coercible queue offsets before arithmetic. Proxy-owned arenas therefore fall back without invoking reflection traps, and numeric-coercible queue offsets keep the original coercion order/count. New baseline-pass regressions cover both repairs, and the public list boundary test explicitly crosses into vector depth three at 32,801 values. The pilot embeds the earlier source; confirmation embeds the repaired source. Operations and activation threshold did not change. Pilot and confirmation results remain separate.
- Four predeclared identical-baseline pairs for the large numeric list and standalone reset control measure control variability using the confirmation batch lengths. A/A estimates are not subtracted from the A/B results.
- Setup, imports, expected-value construction, output-retention array allocation and complete result verification are excluded from timing. Output assignment is included. Every returned snapshot is retained through its batch and verified afterward; all raw warmup and measurement batches are saved.
- Every primitive output value is compared with an independent plain-JavaScript oracle by following the returned wire descriptor's vector pointers. This avoids allocating 65,536 temporary immutable queue handles just to inspect a result. Public boundary reads, complete string `toArray()` results, frozen state, size/type, exact target allocation, separate target memory and writable result edits are also checked. Unit tests and real Node/Chromium workers separately read complete values through public APIs.
- Sources contain unreachable earlier history. A source-byte digest and descriptor check after each batch ensure compaction neither copies dead history into its exact-size target nor changes the source. Valid vector allocation is independently calculated from live values and index-node counts; the change does not claim a smaller WASM payload than the baseline.

## Correctness

[Focused regressions](../../compaction-vector-copy.test.ts) cover vector boundaries through 32,801 values, partial and exhausted queue prefixes, numeric edge values, forks, nested aliases, both worker transports, target/source growth, writable targets, custom Arena views, replacement kernels/getters, proxy-owned arenas, descriptor getter order/counts, malformed descriptor errors, and string/JSON/nested fallbacks. All fourteen tests pass the unchanged baseline and candidate on both Node and Bun.

[Node worker](node-worker.mjs) and [Chromium worker](browser-check.mjs) checks cover actual shared and copied attachments, 4,097-element numeric/boolean lists and consumed queues, old and edited snapshots, owner and target memory growth, nested `compactMany()` aliases, read-only source rejection, writable results and source-byte immutability. Their checked output is saved in [node-worker-result.json](node-worker-result.json) and [browser-result.json](browser-result.json). These are browser correctness checks; browser performance was not measured.

The first test attempts hit Vitest's five-second limit while its negated `toBe` matcher attempted deep-equality advice on distinct Arena objects with large buffers. They reported no wrong values. Tests now use `assert.notStrictEqual` for Arena identity and isolated fixture arenas; the final focused suite completes below one second per runtime on this host. The unsuccessful attempts and final checks are retained in the [validation archive](archive/validation).

## Combined correctness validation

Both final changes were also applied together with the identical shared Arena helper. [The full record](combined-validation/README.md) reports **59 files / 1,178 tests passing** with `bun run test --isolate --testTimeout 15000`, plus all 31 new regressions on Node, portable/declaration builds, five typecheck groups, actual Node/Chromium workers, late imports, installed-package Node/Bun and TypeScript consumers, documentation preservation, and verification of all eight saved timing records.

The initial default suite failed: two existing allocation tests exceeded five seconds, and an existing fake-Arena fixture leaked between files under `isolate:false`. The fixture failure reproduces on the untouched baseline; the timeout cases were not separately reproduced there. Both failed and successful attempts are preserved. Recovery changed only the test invocation; production source, tests, and test configuration stayed unchanged. This validates compatibility of the changes together and makes no combined speed claim.

## Reproduce

Build baseline and candidate in separate directories using the repository's pinned dependencies. Use the same WASM binaries; this is a JavaScript-only optimization. The driver rejects source changes outside the declared four files and verifies the baseline against Git.

```sh
bun run build:wasm
bun run build:browser
bun run build:types
bun run typecheck
node node_modules/vitest/vitest.mjs run compaction-vector-copy.test.ts --maxWorkers=1
bun --bun node_modules/vitest/vitest.mjs run compaction-vector-copy.test.ts --maxWorkers=1
node proofs/compaction-vector-copy-20261108/smoke.mjs
bun proofs/compaction-vector-copy-20261108/smoke.mjs
node proofs/compaction-vector-copy-20261108/node-worker.mjs
bunx playwright install --with-deps chromium
node proofs/compaction-vector-copy-20261108/browser-check.mjs
```

Use a free permitted CPU instead of `2` when necessary, supply absolute directory/executable paths, and choose a new output filename for each run. The driver holds the timing lock itself; do not wrap it in another `flock` for the same path.

```sh
taskset -c 2 node proofs/compaction-vector-copy-20261108/paired-benchmark.mjs \
  proofs/compaction-vector-copy-20261108/confirmation-workloads.mjs \
  /absolute/baseline /absolute/candidate /absolute/bun \
  /new/output/confirmation.json formal

taskset -c 2 node proofs/compaction-vector-copy-20261108/paired-benchmark.mjs \
  proofs/compaction-vector-copy-20261108/confirmation-workloads.mjs \
  /absolute/baseline /absolute/candidate /absolute/bun \
  /new/output/aa.json aa
```

Verify saved evidence independently, without collecting new timings:

```sh
python3 proofs/compaction-vector-copy-20261108/verify.py \
  proofs/compaction-vector-copy-20261108/results/pilot.json.gz \
  proofs/compaction-vector-copy-20261108/results/confirmation.json.gz \
  proofs/compaction-vector-copy-20261108/results/aa.json.gz
```

The dedicated CI workflow performs this evidence check; normal CI executes the new semantic regression tests with the complete project suite. Measurements apply to the recorded Linux x64 host and runtimes. Shared-runner noise, garbage collection and fresh WebAssembly-memory lifetimes can affect the results. No ARM, browser-timing, global throughput or universal no-regression guarantee is claimed.
