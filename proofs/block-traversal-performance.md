# Immutable block traversal view diagnostic

This is an independent candidate on main `3773c6e519c7c0958da13727ed1082f449f3ee25`. Only `Arena.blocks` changes in production: it captures one DataView on first advancement of a nonempty generator. Empty roots and unstarted generators still acquire no view. The AVL walk, explicit little-endian reads, decoding, wrapper tails, APIs and bytes are unchanged. `Arena.vector` and the merged SharedList optimization are untouched.

Every supported Arena imports shared WebAssembly memory. Published reachable block nodes and data spans already fit when traversal begins; later shared growth cannot detach the captured view. Paused iterators retain that DataView wrapper until completion. There is no retained-heap or universal performance claim.

## Deterministic mechanism and local limits

The count proof measures accessor calls, not heap allocations or speed. For a nonempty prefix with N values and B AVL blocks, baseline traversal performs N+4B `dv` getter/refresh calls; candidate performs one. Whole primitive scans and compaction add the unchanged tail count. At 4,097 values with 128 blocks and one tail value, verified traversal counts are 4,608→1 and whole-source counts 4,609→2. All 54 count rows passed on each source. Nonprimitive decoding has its own unchanged accesses and costs.

Local Bun 1.4.2 / Node 24.19.0 validation passed 23 focused tests, matching WASM/browser/declaration builds, main/Redux/typed-value checks, and six real paused-callback shared/copy worker cases on each baseline/candidate. A larger existing-suite run stalled in Vitest's performance-revision thread termination; a narrower batch hit its 45-second cap without completed-file results. Geometry typechecking was also capped. These checks are incomplete, not passes. No existing tests were changed or weakened. CI includes the full relevant suites and all public typechecks on normal runners. No local timings are authorized or reported.

## First x64 Node/Bun gate

The fixed 40-case stratification is intentionally smaller than a full cross-product:

- All six public linked/doubly scan methods at 0, 1 and 32 numeric values: linked `forEach`/`toArray`; doubly forward/reverse `forEach`/`toArray`.
- 33 and 4,097 values across numeric, Boolean, string and object families, plus both doubly forward methods at 4,097.
- Four 1,057-value edited multi-block fixtures, one per value family, exercising variable block lengths.
- Eight full generic compactions: both sequence kinds, sizes 33/4,097, number/object values.

Timed `forEach` and `forEachReverse` kernels count nonundefined callback values. Timed `toArray` and `toArrayReverse` kernels consume returned-array lengths; compaction consumes result sizes. The `expectedDigest` records reference validation alongside untimed correctness checks, not consumption of every value from every timed scan. Any scan timing claims are limited to these callback-counting and array-length workloads.

Scans repeat the same fixture with the library's normal bounded caches. The 4,097-string/object cases exceed the 2,048-entry decode cache; they are not claims of wholly cached decoding. Compaction includes fresh Arena creation and normal raw-value copying. It does not import or combine another compaction candidate.

Source guards require exact main377 and the full candidate commit, the reviewed Arena source SHA256, unchanged other production/package/build sources, and byte-identical generated kernels. Every fresh process imports exactly one build at the same neutral `dist/shared.js` path, with the original package.json copied verbatim and its full dist layout retained. Bundle and package hashes are checked before and after each child, and source/build guards rerun at the end. Symlinks inside bundles are rejected. Build/role labels do not enter child kernel requests.

Each case has one disposable pilot per build. The faster pilot fixes common repeated work for every subsequent A/B and matched baseline A/A subject; measured subjects never recalibrate. Scan warmup work is also fixed from both pilots, aiming for at least 150ms and 262,144 element visits. Empty cases use an operation count denominator of one. All subjects retain actual warmup durations and short/capped flags.

Compaction uses the previously reviewed allocation regime: exactly 512 warmup calls, explicit full GC outside timing after every 32 warmup calls and before every pilot/measured batch. Automatic GC inside the timed allocation loop remains included. Node children use `--expose-gc`; Bun uses synchronous `Bun.gc(true)`. Common compact repeats are capped at 2,048 and any cap is flagged. This controlled allocation regime is application-specific, not an unqualified application-speed claim.

There are exactly two ABBA and two BAAB quartets per comparison, interleaved in a seeded order. Every role uses a fresh process; both modes use identical fixed work and 21 measured batches, with a 10ms batch target. The independent replicate is each quartet's mean of its two adjacent-pair log latency ratios. Reported 95% Student-t intervals use four quartets, df=3; batches and within-quartet pairs are not additional independent samples. Absolute durations, all samples, pilot calibration, order, flags and direct A/A remain inspectable. A/B is never divided by A/A.

The prospective margin is 2% candidate latency: lower bound >1.02 indicates detected material loss; upper bound ≤1.02 supports within-margin performance for that case; an interval spanning 1.02 is inconclusive. Flagged/incomplete timings cannot support positive performance evidence. There are no result-driven retries, exclusions or threshold changes.

The prospective matched-control rule independently checks baseline A/A: if its geometric latency ratio lies outside the symmetric multiplicative band [1/1.02, 1.02] and its 95% interval excludes 1, that row's performance inference is `control-drift-inconclusive`. The unadjusted A/B interval, all raw data and direct A/A remain visible; there is no normalization or subtraction. A row with control drift cannot establish target gains, material losses, or within-margin performance. The rule was added before any timing, with synthetic 2.0× and reciprocal A/A coverage.

The first gate is eligible for later correctness only when both runtimes complete without a detected material loss, matched-control drift or validity flags and have at least one established target gain. Inconclusive individual cells remain inconclusive. Browser-stage eligibility is permission to run additional correctness checks, not performance acceptance, universal equivalence, or authorization to adopt the candidate.

## Later browser correctness

The `block-traversal.yml` workflow initially runs only the x64 gate. A separate manual `stage=browser` dispatch requires the exact prior gate run ID, verifies both saved runtime results against the current commit and protocol hashes, and does not repeat timings. Chromium, Firefox and WebKit then run baseline/candidate fixture checks and real shared/copy workers paused inside block callbacks while their owning writers grow. This is correctness coverage, not browser performance measurement.

The current stage does not establish ARM64 throughput, browser throughput, cold/new-reader performance, or all operations and applications. Those limits remain explicit before any adoption decision.
