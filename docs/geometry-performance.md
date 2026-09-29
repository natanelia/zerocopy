# Geometry performance decision — 27 September 2026

## Decision

Three candidates were implemented and tested: bounds, prepared polygon membership, and the Douglas-Peucker farthest-point scan. The explicit SIMD candidates did not consistently pass the cross-runtime performance requirements. They remain experiment branches, not production additions.

The accepted change is the separate scalar bulk `bboxXY` operation. Its gain comes from running a complete shared-memory scan in Wasm, not SIMD. No geometry precision, snapshot layout, collection mutation rule, or existing collection API changes.

## Accepted bounds implementation

Baseline: main `75e3626ccc6400d1ae195aefdd3526906622009e`.
Production candidate: `18207cde4ae1082c297f5a60209d7ea482c5d9ed`.
[Verification and benchmark run 36287258447](https://github.com/natanelia/zerocopy/actions/runs/36287258447) completed successfully on Linux x64 and ARM64 before opening a PR.

Median milliseconds for **32 complete bounds calculations over 131,072 random points**, with inputs already in their respective storage formats:

| Runtime / architecture | Turf 7.4.0 recompute | SharedList.forEach | Public bboxXY | Throughput / Turf | Throughput / forEach |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 22.23.2 / x64 | 20.334263 | 46.039561 | 6.170887 | 3.295x | 7.461x |
| Node 22.23.2 / ARM64 | 22.687375 | 44.402559 | 6.024731 | 3.766x | 7.370x |
| Bun 1.4.2 / x64 | 42.013866 | 60.080759 | 9.020035 | 4.658x | 6.661x |
| Bun 1.4.2 / ARM64 | 43.949163 | 59.001712 | 5.711312 | 7.695x | 10.331x |

Both runtimes on both architectures also passed all road-like and late-zero cases. Across all 48 runtime/architecture/size/shape combinations, the smallest measured public/Turf ratio was 1.483x and the smallest public/forEach ratio was 2.316x. The benchmark includes 16, 512, 16,384, and 131,072 points. It reports a separate flat-JavaScript-array baseline, which can be faster than the public API for small inputs. The acceptance gate does not claim to beat every storage representation.

Each case uses eight warm-up rounds, then 21 measured rounds with alternating implementation order. Result equality is checked before timing. Timers include result tuple construction and public validation. Input construction/conversion, first compilation, and worker messages are excluded. These are Linux CI results, not Apple Silicon, browser-speed, or Map Creator end-to-end results. No statistical confidence interval or universal speed guarantee is claimed. Retain raw samples and repeat on target devices.

Turf receives a corresponding flat MultiPoint with `{ recompute: true }`; its cached bbox return is intentionally not compared against a scan. The existing list implementation is unchanged from main. The new API reads a pre-existing numeric list; converting a GeoJSON object for one call has an additional cost not included here.

Raw samples: [x64 plus browser cases](https://github.com/natanelia/zerocopy/actions/runs/36287258447/artifacts/10920619594), [ARM64](https://github.com/natanelia/zerocopy/actions/runs/36287258447/artifacts/10920629597). Artifacts expire after 30 days. The committed scripts and this pinned summary remain available.

## Exact output checks

The accepted proof passed **12,754 exact differential comparisons per runtime/architecture**, using 4,096 reproducible random seeds plus targeted cases. It compares the independent JavaScript reference, the installed Turf 7.4.0 package, raw Wasm, and the public API. Floating-point results use `Object.is`, including the distinction between +0 and -0. No epsilon comparison is substituted.

The inputs include random binary64 bit patterns, ordinary finite coordinates, smooth lines, NaN axes, infinities, subnormals, early and late signed-zero ties, empty input, partial leaves, tree-depth boundaries, and complete points ending at the final Wasm memory byte. Actual Node and Bun workers retain old snapshots while the owner appends, edits, and grows memory. Source tests also compare shared bytes before and after read-only operations.

All **550 unit tests in 29 files** passed on x64 and ARM64, along with Wasm/browser/declaration builds, source type checks, strict geometry consumer checks, Redux types, and typed-value checks. The emitted bounds module has no SIMD instructions or memory-store instructions.

Chromium 153.0.8010.12, Firefox 155.0, and WebKit 26.6 each passed **2,048 exact browser comparisons**, plus retained read-only snapshot checks. These browser attachments are in the same realm; they are not actual browser Worker tests. Actual worker execution was checked separately under Node and Bun. Playwright WebKit on Linux is not Safari on Apple hardware.

Random testing is evidence of agreement on the tested inputs, not a proof for every possible input. The API is a flat-XY bounds operation, not a complete GeoJSON replacement.

## Rejected bounds SIMD

[Experiment branch](https://github.com/natanelia/zerocopy/tree/agent/geometry-bbox), final candidate `54fb08d101667bdd2dbf9af1e3675ecdbe05f377`, [run 36286719711](https://github.com/natanelia/zerocopy/actions/runs/36286719711).

The initial single-accumulator version was slower on ARM64. Independent striped accumulators improved common cases but needed a second scan to preserve the first signed zero. A late-zero adversary exposed the cost of that scan. Contiguous per-leaf groups removed the repair scan and preserved exact tie order. An unrolled variant then won on Node ARM64 but lost on Bun ARM64.

For 32 scans of 131,072 random points in the last Bun ARM64 experiment, the best scalar control took about 5.550 ms and SIMD took 6.553 ms: about 18.1% more time. The strong controls included an unrolled scalar implementation, so loop unrolling was not falsely credited to SIMD. All 21,278 differential checks in that proof passed. Correct output did not excuse the performance regression. The production PR contains none of these SIMD variants.

## Rejected prepared polygon membership

[Experiment branch](https://github.com/natanelia/zerocopy/tree/agent/geometry-polygon), candidate `72f293ffa28b8b1e38d1737f9fd97d074d3466b6`, [run 36286492794](https://github.com/natanelia/zerocopy/actions/runs/36286492794).

The API prototype prepares closed finite ring snapshots and returns ascending matching point indices. It supports holes, boundary inclusion/exclusion, and same-arena batch kernels, with a cross-arena scalar path. Numerically uncertain predicates use robust-predicates instead of a fixed coordinate epsilon.

On the ARM64 proof, **9,595 exact comparisons and 529,790 point queries** passed. Scalar Wasm, SIMD Wasm, the public API, Turf boolean membership, Turf collection selection, and an independent BigInt oracle for integer-coordinate cases agreed. Cases include convex/concave rings, holes, repeated vertices, exact edge/vertex queries, near-edge floating-point queries, and memory boundaries. The robust fallback was exercised.

The candidate still lost on large polygons. For four selections of 8,192 interior points against a 256-edge polygon under Node ARM64, the Turf-indices path took **27.491713 ms**, versus **32.519475 ms** for the new public API. Bun ARM64 also lost: **27.549010 ms** versus **29.562405 ms**. Exact equality passed; speed did not.

The Turf benchmark returns equivalent point indices rather than a complete GeoJSON result. Its wrapper uses flatMap and does not provide prepared bounds, so this is not a claim of optimal Turf execution. Losing even under this comparison is sufficient to reject this candidate. Polygon preparation is reported separately and is excluded from repeated-query timing. No polygon API or robust-predicates runtime dependency is shipped in the accepted bounds PR.

## Rejected Douglas-Peucker SIMD

[Experiment branch](https://github.com/natanelia/zerocopy/tree/agent/geometry-simplify), last candidate `1495d7300c500c2864960e96fdb19197521dcf3b`, [run 36287149781](https://github.com/natanelia/zerocopy/actions/runs/36287149781).

The prototype returns retained vertex indices. It keeps scalar arithmetic grouping, first-index distance ties, endpoint branches, and tolerance rules. The public algorithm uses an iterative work stack; an independent JavaScript reference uses recursive subdivision. Both scalar and SIMD Wasm paths were compared against the reference, including exact squared-distance values.

The proof passed **47,490 exact comparisons from 2,048 seeds** plus boundary/adversarial cases. It checks repeated points, signed zero, tiny/large finite coordinates, degenerate endpoints, threshold equality, partial leaves, and end-of-memory access. This is pure planar Douglas-Peucker validation, not equivalence to the entire Turf simplify pipeline with coordinate cleaning, radial prepass, polygon repair, or GeoJSON output.

The first SIMD version regressed on smooth lines under Bun x64. Vector argmax accumulation and a later short-section scalar path with conditional lane transfers did not remove that regression. In the last Bun x64 run, four simplifications of a 16,384-point road-like line took **21.217654 ms** with scalar Wasm versus **25.077398 ms** with the hybrid SIMD path, about **18.2% more time**. Node wins do not justify shipping a cross-runtime regression. No simplification API is included in the accepted PR.

## Scope of the PR

Only scalar `bboxXY`, its optional entry point, documentation, tests, and repeatable benchmark are proposed for production. The three experimental branches preserve reproducible rejected work. None of the existing numeric PRs, main, or snapshot protocols has been merged or overwritten by this series.
