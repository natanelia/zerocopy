# Bounds parent-cache experiment: untimed review

Status: local correctness and mechanism review only. No throughput measurement,
CI dispatch, publication, or performance acceptance has occurred.

Base: `3773c6e519c7c0958da13727ed1082f449f3ee25`.

## Production scope

The only production edit is `bboxXY` in `geometry-kernels.as.ts`: retain the tail
check, use the root at depth zero, otherwise keep the current leaf's parent in
one `u32` local. Refresh its root-to-parent path when `(base & 1023) == 0`, then
load the leaf lane. A group of 32 leaves spans 1024 values, so the upper trie
digits remain constant within that group. Fragmented allocation and retained,
forked, or popped snapshots do not change that property.

The original point loop, four local extrema, coordinate-load order, strict
comparison order, and final result transfer remain unchanged. Exported
`xyLeaf`, numeric scalar/SIMD kernels, allocator, APIs, layout, and transport are
unchanged. No recursion, extra globals, scratch writes, or shared-memory writes
are added. Existing geometry/numeric decision documents and all original proof
and timing functions remain untouched.

For valid public lists, the size limit is `0x3fffffff` (largest even input
`0x3ffffffe`); depth is at most 5 and the largest traversal shift is 25. The
allocator's `0x7fff0000` limit bounds pointer arithmetic. This reasoning does
not extend the contract of raw exports to arbitrary invalid descriptors.

## Mechanism evidence

`proofs/geometry-parent-cache.mjs` compiles exact-base and candidate production
modules plus separate instrumented modules. Instrumentation records actual
structural-load addresses/values, leaf visits, coordinate-load addresses,
source condition evaluations, and logical source helper entries. It requires
identical leaf visitation and coordinate load order, and requires the remaining
structural loads to be an order-preserving subsequence of the original loads.
Source helper entries are not emitted Wasm calls: both production bounds
functions contain zero calls.

| Case | Base | Candidate |
| --- | ---: | ---: |
| 512 points, depth 1: pointer loads | 31 | 31 |
| 512 points: address conditions excluding tail check | 62 | 63 |
| 512 points: candidate mask tests included in preceding row | 0 | 31 |
| 131072 points, depth 3: pointer loads | 24573 | 8703 |
| 131072 points: address conditions excluding tail check | 32764 | 17150 |
| 131072 points: coordinate loads | 262144 | 262144 |
| 131072 points: extrema comparisons | 524288 | 524288 |

Tail checks also remain identical: 32 and 8192 respectively. The large case
removes 15870 of 286717 total source loads, about 5.5%. Parent reads may already
be cache-hot. These counts do not predict net runtime improvement.

Optimized AssemblyScript 0.28.20 output:

| Bounds function property | Base | Candidate |
| --- | ---: | ---: |
| Parameters | 4 | 4 |
| Locals (i32 / f64) | 3 / 6 | 4 / 6 |
| Static instructions including function-final end | 134 | 157 |
| Integer comparisons including eqz | 4 | 6 |
| Floating-point comparisons | 4 | 4 |
| Static i32.load / f64.load sites | 1 / 2 | 2 / 2 |
| Calls / memory stores / global reads | 0 / 0 / 0 | 0 / 0 / 0 |
| Result-global writes, after traversal | 4 | 4 |
| Function body bytes, including local declarations | 267 | 304 |
| Module bytes | 571 | 608 |

The point-loop WAT is identical after local-register renaming. Exported
`xyLeaf` and the other function bodies are byte-identical. Independently rebuilt
numeric scalar/SIMD binaries match the exact base. Instrumented source counts
are separate from these optimized static counts and from engine-native code.

## Bounded local validation

Node 24.19.0 and Bun 1.4.2 on Linux x64 each passed the untimed proof:

- 4309 cases with complete shared-byte equality and unchanged allocator state;
  all 4096 original binary64/random/road seeds are retained, with Object.is
  comparisons against the exact-base kernel, candidate, public API and Turf.
- 123 mechanism cases comparing 2032262 coordinate addresses per variant.
  Shapes include canonical, fragmented set/push, popped, and retained lists.
- Point boundaries include 16, 32, 512/513, actual depth transitions 528/529 and
  16400/16401, partial tails, and 131072 points. NaN axes, infinities, subnormals,
  signed-zero first ties, empty input, odd-size traps, and complete points at the
  last visible memory byte are covered.
- Eight actual-worker cases per runtime: shared and copied transport at 513,
  529, 16401, and 131072 points, with owner append/edit/growth, retained readers,
  separate kernel instances, and unchanged reader bytes/allocator state.
  Shared readers must observe growth; copied readers must retain their buffer
  length. Counts before observing the completion flag describe a coordinated
  window, not proof that every counted scan overlapped growth. The report
  separately records scan windows whose visible memory length increased.
- Probe-only deterministic owner growth before coordinate load 1025, for both
  variants, checks a scan that starts before growth and resumes afterward.

An independent review also passed 186 cases and 148901 leaf comparisons,
including the next depth transition at 524304/524305 points.

Wasm, browser-package, and declaration builds passed, as did source, geometry,
Redux, and both typed-value checks. The actual packed package passed Node/Bun
entrypoint imports, immutable snapshots, a Node worker, and strict TypeScript
consumer checks. The focused Bun suite passed 128 tests in six files. Its first
parallel run had two existing 5-second timeout failures while other correctness
work ran; the serial rerun with a 30-second test budget passed without changing
any test or production code. Package validation initially could not create the
default npm cache; it passed with `npm_config_cache=/tmp/zerocopy-npm-cache`.

No full test suite, browser execution, ARM execution, or throughput screen was
run locally. Random and boundary tests are evidence, not exhaustive proof.

Reproduce the untimed proof after the normal Wasm/browser/declaration builds:

```sh
GEOMETRY_PROOF_OUTPUT=/tmp/geometry-parent-cache-node node proofs/geometry-parent-cache.mjs
GEOMETRY_PROOF_OUTPUT=/tmp/geometry-parent-cache-bun bun proofs/geometry-parent-cache.mjs
```

The output directory retains both sources, both production Wasm/WAT files,
both mechanism modules, runtime versions, hashes, per-case counts, trace hashes,
worker observations, and the JSON report. No timers are used for throughput.

## Proposed first timing screen, subject to review

This is a prospective screen, not acceptance and not permission to run it.
Use fixed exact-base and candidate packages, unchanged original fixtures and
full timing functions, AssemblyScript 0.28.20, Node 22.23.2 and Bun 1.4.2 on
both Linux x64 and ARM64. Record actual versions and reject a version mismatch.
No JIT/layout tuning, alternate kernel variants, or changed data generators.

Keep a compact case set:

1. 16 random points: tail only.
2. 17 and 32 random points: depth-zero root plus tail, partial/full tail.
3. 512 random points: depth-one control with no pointer-load reduction.
4. 528 and 529 random points: actual depth-one/two boundary.
5. 16400 and 16401 random points: actual depth-two/three boundary.
6. 131072 random points: documented deep case; add its existing road and
   late-zero shapes to guard scan/branch behavior.

Compare candidate and original full public operations. Retain the original raw
kernel, candidate raw kernel, and original flat-array reference as separately
labeled controls; retain existing Turf/SharedList.forEach functions and their
full-target data unchanged. Check exact equality before measurement. Prepare
inputs before timing and keep the existing point count, seed, order and result
consumption fixed. Raw-kernel evidence cannot substitute for public-API results.

For a first screen, use four independent process quartets per runtime and
architecture with fixed balanced A/A and A/B order. Alternate implementation
order within each process, keep all raw batches, and report geometric mean
paired latency ratios with pointwise 95% intervals across the independent
quartets. Fix the batching/warmup rules before dispatch; short batches,
insufficient warmup, A/A drift, failed checks, or missing controls invalidate
a cell. Report every small and deep cell separately and hold the screen if
any required runtime, architecture, or small control is unresolved. The modest
source-load reduction is a reason to screen carefully, not a speed claim.
