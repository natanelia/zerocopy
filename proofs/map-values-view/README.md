# Map value scans with one captured memory view

`SharedMap.values()` now captures the owning arena's `DataView` when iteration starts and passes it to the existing leaf decoder. This removes a repeated memory-view refresh check for every value, while keeping one generator loop and the existing generic decoder. Other `Arena.leafValue` callers keep the refreshed-view default. Booleans use the supplied view's byte read so primitive values do not mix views.

Published leaves are immutable and already fit the captured view. Growing shared WebAssembly memory preserves the old shared buffer, and resets replace the arena instead of recycling its addresses. Iteration state stays local to each generator. The public collection API and persisted/worker formats are unchanged.

## Recorded result

The corrected study supports a clear gain for the targeted scans. At 4,096 entries, numeric/boolean scan time fell **21.1% / 22.0% on Node** and **12.6% / 9.4% on Bun**. Each of those cases was faster in all six independent paired processes, and its 95% interval remained below equal time. At 65,536 entries, Node numeric/boolean scans fell **18.3% / 20.5%**; the corresponding Bun intervals cross equal time, so no large-map Bun gain is established here.

The corrected small-object result was faster in both runtimes; the Bun pilot's adverse small-object result did not repeat under the corrected setup and longer fixed study. That pilot remains archived and excluded, not erased. Warm `get` controls are uncertain: Bun boolean `get` has a **1.5% slower point estimate**, five of six processes slower, with an interval spanning a 6.0% reduction to a 9.7% increase. Browser small booleans and strings have mixed pairs. This is a workload-specific improvement, with all controls and uncertainty shown below.

Read the [compact primary summary](results/primary-summary.json), [complete raw primary record](results/2026-11-04-primary-linux-x64.json.gz), [browser record](results/browser.json), and [evidence checksums](results/evidence-index.json). The primary completed all **152 independent processes**: 120 A/B and 32 A/A. No completed-run samples were discarded.

## Primary Node/Bun method

Recorded on 2026-11-04, Linux x64, AMD EPYC 9V74; Node 24.22.1 and Bun 1.4.2. The driver ran under an exclusive benchmark lock and inherited CPU affinity to logical CPU 2. Both runtimes consumed the portable ESM builds made by Bun 1.4.2, with identical WebAssembly bytes.

Baseline: `501b73819ed7e9bbf7adbb74b03df01045701973`. Measured candidate: `793d68d009806e36b910e7bd8095f87e7aeae192`. Only `arena.ts` and `shared-map.ts` differ among the recorded runtime/build inputs. Complete source, bundle, Wasm and driver SHA-256 identities are in the raw record; the driver checks them again before marking the run complete. The candidate revision is the local commit used for measurement. GitHub publication may assign another commit ID; the recorded source and bundle hashes identify the tested code independently.

The fixed matrix has number and boolean value scans at 4,096 and 65,536 rows, string and object value scans at 1,024 and 4,096 rows, and warm numeric/boolean `get` scans at 4,096 rows. Keys are `key-N`; numbers are `N + 0.25`; booleans are true every third row; strings are `value-N`; objects are `{ n: N, tags: [N & 7, 5] }`. Each timed scan consumes every value with a count and content checksum. Construction, oracle checks and shared-memory digests are outside timing.

Each of six independent processes per case/runtime imports **both** complete builds into neutral temporary directories. Baseline and candidate have separate lexical scan and timer functions. This is six independent paired experiments, not six pairs of single-build processes. Import and construction order alternate across processes; warmup and timed pair order alternate within a process. Each variant receives at least 500 ms of timed warmup and eight warmup pairs. Calibration chooses one common repeat count for both variants, aiming above 15 ms per batch on the faster side. Then 12 alternating measured pairs are retained. These are fixed warmup rules, not a claim that every engine reaches a universal steady state.

Before warmup, both builds perform the same `keys()` reads, verify identical key order, and verify full ordered `values()` arrays against an independent native `Map` model. After timing, they verify the arrays again and assert unchanged published bytes and zero shared-memory allocation. Both key and string value decoding use a bounded cache. At 1,024 rows the key and value strings fit; at 4,096 rows prior key reads fill that cache. Objects have a separate bounded cache, so the 4,096-row object case exceeds it. These are warm repeated scans with that explicit cache history; they do not measure construction or first-read latency.

Within each process, the estimator is the geometric mean of the 12 paired after/before timing ratios. The reported estimate and 95% t interval use the six independent process log ratios (5 degrees of freedom). Individual batches are not independent samples. Displayed before/after times are marginal medians of per-process median scan times; their quotient can differ from the paired estimate. Intervals are per case and are not adjusted across the matrix.

Four additional independent A/A processes compare two neutral copies of the baseline for large numeric values, small cached objects and both warm `get` controls. They expose harness/runtime variability and do not adjust or normalize the A/B results. Warm `get` controls mostly use existing value caches and are not claims about every cold default-decoder caller.

### A/B results

Times are microseconds per full scan; a lower after/before ratio is better. “Faster” counts independent processes with a ratio below 1, out of six.

| Runtime | Operation / type | Entries | Before µs | After µs | After/before (95% interval) | Faster |
|---|---|---:|---:|---:|---|---:|
| Node | values / number | 4,096 | 535.2 | 430.8 | 0.789 (0.763–0.816) | 6/6 |
| Node | values / number | 65,536 | 11,921.1 | 10,128.8 | 0.817 (0.786–0.848) | 6/6 |
| Node | values / boolean | 4,096 | 551.9 | 424.6 | 0.780 (0.757–0.805) | 6/6 |
| Node | values / boolean | 65,536 | 11,419.9 | 9,410.2 | 0.795 (0.771–0.820) | 6/6 |
| Node | values / string | 1,024 | 145.4 | 117.1 | 0.796 (0.771–0.821) | 6/6 |
| Node | values / string | 4,096 | 1,186.7 | 1,059.1 | 0.880 (0.829–0.934) | 6/6 |
| Node | values / object | 1,024 | 172.2 | 139.2 | 0.815 (0.781–0.851) | 6/6 |
| Node | values / object | 4,096 | 2,657.1 | 2,491.1 | 0.941 (0.904–0.980) | 6/6 |
| Node | warm get / number | 4,096 | 140.0 | 134.8 | 0.972 (0.928–1.018) | 4/6 |
| Node | warm get / boolean | 4,096 | 146.4 | 145.1 | 0.980 (0.943–1.018) | 4/6 |
| Bun | values / number | 4,096 | 233.7 | 204.5 | 0.874 (0.831–0.919) | 6/6 |
| Bun | values / number | 65,536 | 6,531.7 | 6,490.6 | 0.980 (0.825–1.163) | 3/6 |
| Bun | values / boolean | 4,096 | 228.2 | 205.0 | 0.906 (0.882–0.932) | 6/6 |
| Bun | values / boolean | 65,536 | 6,030.1 | 4,928.6 | 0.898 (0.774–1.041) | 5/6 |
| Bun | values / string | 1,024 | 66.8 | 61.6 | 0.916 (0.883–0.950) | 6/6 |
| Bun | values / string | 4,096 | 572.3 | 561.6 | 0.949 (0.911–0.988) | 6/6 |
| Bun | values / object | 1,024 | 113.3 | 104.3 | 0.932 (0.910–0.953) | 6/6 |
| Bun | values / object | 4,096 | 2,965.9 | 2,747.0 | 0.950 (0.839–1.076) | 4/6 |
| Bun | warm get / number | 4,096 | 58.4 | 55.7 | 0.964 (0.906–1.026) | 4/6 |
| Bun | warm get / boolean | 4,096 | 53.7 | 56.6 | 1.015 (0.940–1.097) | 1/6 |

### A/A controls

Each row compares the identical baseline with itself in four independent paired processes. Ratios need not equal exactly 1 on a shared runner; large-map and warm-get variation is material.

| Runtime | Operation / type | Entries | Right/left (95% interval) | Process range |
|---|---|---:|---|---|
| Node | values / number | 65,536 | 1.022 (0.865–1.208) | 0.920–1.157 |
| Node | values / object | 1,024 | 1.019 (0.908–1.143) | 0.968–1.134 |
| Node | warm get / number | 4,096 | 1.017 (0.935–1.106) | 0.966–1.094 |
| Node | warm get / boolean | 4,096 | 1.016 (0.976–1.058) | 0.991–1.042 |
| Bun | values / number | 65,536 | 1.055 (0.836–1.331) | 0.895–1.234 |
| Bun | values / object | 1,024 | 0.975 (0.929–1.024) | 0.950–1.014 |
| Bun | warm get / number | 4,096 | 0.905 (0.741–1.105) | 0.789–1.040 |
| Bun | warm get / boolean | 4,096 | 1.016 (0.852–1.212) | 0.889–1.154 |

## Separate-process Chromium supplement

Chromium 153.0.8010.0 ran four balanced AB/BA pairs: one build per fresh browser process, eight measured processes in total. Each process executes the same six cases, with six warmup batches and nine timed batches. Both builds use the same repeat count and loopback URL. This supplement reports all pair ranges without a confidence interval.

Its fixture uses `N + 0.5` numbers, `界-N` strings and `{ id: N, label: 'row-N' }` objects, with the same every-third-row boolean pattern. These payloads and the 1,024-row small cases differ from the primary fixture, so the browser ratios are supplementary and are not pooled with Node/Bun ratios.

Each timed map scan uses a count and order-weighted checksum. Full value arrays, snapshots, copy/shared attachments, growth and special numeric values are checked separately in a disposable correctness browser (24 assertion groups). The generic browser driver's recorded method text says “full arrays checked after timing”; for its map mode, the exact distinction is checksum validation after timing and full-array checks in the separate correctness setup. The raw driver and record are retained unchanged.

Browser source hashes match the measured production sources and bundles. Its test-file inventory predates two test-only fixture changes: four map attachment constructors received private arenas, and a pre-existing primitive growth test later received its own arena. Runtime code and bundles did not change.

Higher browser speedup is better. This is the median of four before/after process-pair ratios; the range includes every pair.

| Type | Entries | Before µs | After µs | Median paired speedup | Pair range | Faster pairs |
|---|---:|---:|---:|---:|---|---:|
| number | 1,024 | 82.1 | 64.0 | 1.283× | 1.198–1.438× | 4/4 |
| number | 65,536 | 6,503.4 | 5,370.9 | 1.141× | 1.055–2.035× | 4/4 |
| boolean | 1,024 | 94.1 | 86.4 | 1.108× | 0.889–1.465× | 2/4 |
| boolean | 65,536 | 6,511.6 | 5,737.5 | 1.159× | 1.070–1.281× | 4/4 |
| string | 1,024 | 99.2 | 86.7 | 1.146× | 0.961–1.312× | 3/4 |
| object | 1,024 | 92.6 | 82.8 | 1.099× | 1.054–1.210× | 4/4 |

## Correctness and validation

[Regression tests](../../map-values-view.test.ts) cover immutable old/forked roots, empty maps, leaf/trie boundaries, unequal key lengths, Unicode and exact hash collisions, IEEE-754 edge values, unaligned payloads, optional value prefixes, legacy journals, laziness/return/throw, paused iterators during growth, copy/shared read-only attachments, frozen JSON and nested snapshots. A nested factory also grows and forks the owning arena during decoding, then checks all original values and published bytes.

The [Node worker proof](worker.mjs) pauses multiple independent numeric/boolean/fork iterators in a real worker while the writer grows memory and creates later versions. Shared and copy transports both pass, preserve old values and bytes, reject writes, and allocate no shared memory while scanning.

The retained [validation log](results/validation.txt) records 51 Vitest files / 1,069 tests passing at the default timeouts, two additional real Node worker tests, the existing Node worker proof, Redux proof and typed JSON worker proof. TypeScript checking and declaration emission also passed in the same successful command. The common investigation-report validator maintenance was cherry-picked afterward; it changes proof-only files and no measured runtime or build input. The real map worker proof is also wired into the existing built-Node-entry-point CI step. The [final checks](results/final-checks.txt) passed the documentation checker tests, the strict historical-evidence/link gate, and that exact worker-proof command. A follow-up proof-only alignment keeps the text-report validator identical to the concurrent website fix.

## Combined integration check

After the search PR merged, a separate local worktree combined the list, long-text-search and map changes. With fresh module isolation per test file, **53 files / 1,076 tests passed in 36.54 seconds**, followed by TypeScript checking and three real Node worker tests. The command retained the normal five-second test timeout and all assertions. Source and built-bundle hashes, commands and outcomes are retained in the [integration manifest](results/combined-validation.json) and [passing log](results/combined-isolated-pass.txt).

The default shared-module run first passed 1,075 tests but timed out in the existing primitive growth fixture. This PR gives that fixture a private arena so its byte comparison excludes unrelated earlier test data. The [initial failure](results/combined-initial-failure.txt) is retained. A second default-mode run after that repair was [interrupted without a verdict](results/combined-default-interrupted.txt); it must not be read as a pass. The repository's `isolate: false` setting remains unchanged. The combined passing result explicitly used `--isolate`; individual candidate full suites passed with the default configuration.

## Retained experiments and limitations

The first implementation specialized numeric and boolean generator loops. It was rejected after mixed Bun large-map results and browser string/object regressions. Its exact patch, original drivers, raw pilot/primary/browser measurements and checksums are retained in [rejected-v1.tar.gz](results/rejected-v1.tar.gz). A proposed extra diagnostic for that version was canceled before running; it produced no measurements.

The initial V2 pilot and the first interrupted formal study had an oracle setup bug: only the baseline called `keys()`. Those key decodes consume the same bounded cache as strings, unfairly changing cache residency in the large-string case. Both are excluded from all primary claims. The corrected primary reads keys on both builds and asserts equal key order before warmup. All original measurements and the exact original drivers are retained; no unfavorable samples were removed from a completed run.

The [initial combined list/search/map validation](results/combined-initial-failure.txt) passed 1,075 tests and timed out in one pre-existing primitive sequence growth test. That fixture used the global default list arena and compared all its historical bytes, so its work depended on unrelated earlier tests under `isolate: false`. Its list now receives a private `Arena`. The 2,051-value scan, 50,000-value growth, all assertions and default 5-second timeout are unchanged. This is a test-only repair after measurement; the initial failure remains recorded.

An initial full validation command was interrupted before any test verdict after a fixture used global default arenas in Vitest's shared module environment. The fixture now uses private arenas, and the full suite passed. A later queued benchmark cancellation raced validation completion and retained two symmetric processes before the final driver-identity guard was added; those two records are also retained and excluded from the fixed complete primary. A retry at the occupied output path refused to overwrite it and produced no samples.

The [exploration archive](results/exploration.tar.gz) contains the exact V2 pilot, both interrupted timing records, original drivers and interrupted validation fixture/log. Its [file manifest](results/exploration-manifest.json) gives dispositions, byte lengths and SHA-256 identities. Compression is lossless; the uncompressed primary JSON is 5,721,637 bytes with SHA-256 `9cc3fdbfd256a1d34beb14bbe13315fd1f07dc611d347602621216e1f41cbf92`.

These measurements establish behavior for the recorded versions, machine, data and cache history. They do not establish a universal improvement for every map size, cold decoder path, ARM hardware, browser engine or runtime version. Shared-memory allocation checks do not measure JavaScript heap allocation or peak RSS. No binary-layout, WASM or dependency change is included.

## Reproduce

Use two separate checkouts, install the pinned dependencies, and build Wasm and portable ESM output in each with Bun 1.4.2. Build the baseline at the commit above and the candidate at this change. Keep benchmark runs serial; do not rebuild or edit sources while a run is active.

```sh
# In each checkout, with Bun 1.4.2 on PATH:
bun install
bun run build:wasm
bun run build:browser

# From the candidate checkout. Choose a fresh output path every time:
flock /tmp/zerocopy-performance.lock taskset -c 2 node \
  proofs/map-values-view/benchmark.mjs /absolute/baseline /absolute/candidate \
  /absolute/path/to/bun /absolute/new-primary.json

node --test proofs/map-values-view/worker.mjs
bun run test
bun run typecheck
bun run build:types
node proofs/node-worker.mjs
node proofs/redux-node.mjs
node proofs/typed-json-worker.mjs

# Optional separate-process browser supplement; use an installed Chromium:
BROWSER_BASE_ROOT=/absolute/baseline \
BROWSER_CANDIDATE_ROOT=/absolute/candidate \
BROWSER_CASE_KIND=map \
BROWSER_OUTPUT=/absolute/new-browser.json \
CHROMIUM_EXECUTABLE=/absolute/path/to/chromium \
flock /tmp/zerocopy-performance.lock node proofs/map-values-view/browser.mjs
```

The primary driver includes the full fixed matrix and A/A controls and refuses an existing output path. Select a valid CPU on your machine if logical CPU 2 is unavailable; changing hardware or affinity changes the experiment. The optional browser driver uses the repository's pinned Playwright package and existing primitive-scan helper; it does not install dependencies or contact the network.

To inspect the exact retained primary JSON without changing the archive:

```sh
gzip -dc proofs/map-values-view/results/2026-11-04-primary-linux-x64.json.gz > /tmp/map-values-primary.json
tar -tzf proofs/map-values-view/results/exploration.tar.gz
```
