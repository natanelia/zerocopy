# Optional Rust kernel comparison

The initial comparison exposed a geometry regression. A targeted aligned-load
path in [`rust/src/geometry.rs`](../../rust/src/geometry.rs) removed the repeated
null-pointer checks from ordinary vector scans while keeping the unaligned raw
ABI fallback. The follow-up no longer showed a consistent slowdown above 10%.
Timing variation remains substantial, so these measurements do not establish
performance equivalence or a general speedup.

## Method and evidence

[`kernel-benchmark.mjs`](kernel-benchmark.mjs) compares the AssemblyScript baseline
`b4c08def84b905026632bfd27612da4efef0a3f0` with the Rust migration. Both module
instances read the **same WebAssembly.Memory**, using identical scalar JavaScript
wrappers and input descriptors. Input creation, module compilation, warmup,
calibration and hashing are outside the measured samples. Every measured call
checks its result; geometry includes the four scalar result getters. No measured
operation copies payloads, converts values, freezes objects or allocates result
objects.

Runs used Node 24.22.1 / V8 13.6 on Linux x64, an Intel Xeon Platinum 8573C, pinned
to CPU 0, with no concurrent project tests or benchmarks. Each case had at least
75 ms of warmup per variant, calibrated batches targeting 20 ms, and seven
adjacent pairs alternating AssemblyScript/Rust order. All measured batches lasted
at least 10 ms. Case order reversed each round. All samples, including noisy
ones, are retained in the raw files.

Full vectors contain 262,144 numbers. Range tails contain one additional number;
point tails contain one additional XY pair. Deterministic data includes NaNs and
signed zeros. Retained short tails sit immediately beside newly appended values
that must be excluded. Geometry processes 131,072 or 131,073 points per call.

- [Initial complete run](kernel-results.json.gz): scalar/SIMD range and point counts,
  plus the original Rust geometry module.
- [Aligned geometry follow-up](kernel-geometry-aligned-results.json.gz): the selected
  geometry source, built in an isolated scratch crate with the production build
  flags and mandatory module audit. Numeric modules were unchanged.

The raw reports record exact module hashes, fixture descriptors, expected counts,
warmup/calibration data, every sample, runtime identity and source checkout
metadata. The initial Rust checkout was
`9a2d32e40004934da7b071d94d1caf576e521a6c`; the follow-up geometry change was built
outside that commit, so its artifact hash identifies the tested candidate.

## Results

Times are median microseconds per call. **Rust/AS** is the median of the seven
paired ratios, not the ratio of the two time medians; values above 1 mean slower
Rust calls. The final column counts pairs with more than 10% slowdown. The review
threshold requires a median above 1.10 and at least six such pairs; it is a
diagnostic threshold, not a statistical significance test.

| Initial case | AS µs | Rust µs | Rust/AS | Pairs >10% slower |
| --- | ---: | ---: | ---: | ---: |
| Range, scalar, full | 302.34 | 314.46 | 1.032 | 3/7 |
| Range, scalar, one-value tail | 319.41 | 318.53 | 0.970 | 0/7 |
| Points, scalar module, pair tail | 290.90 | 322.15 | 1.061 | 3/7 |
| Range, SIMD, full | 143.54 | 105.64 | 0.763 | 0/7 |
| Range, SIMD, one-value tail | 148.36 | 105.46 | 0.718 | 0/7 |
| Points, SIMD module, pair tail | 308.24 | 323.53 | 1.054 | 3/7 |
| Bounds, full | 301.20 | 367.59 | 1.198 | 5/7 |
| Bounds, pair tail | 303.31 | 335.42 | 1.116 | 6/7 |

Point counting uses the scalar implementation in both numeric modules. The
geometry tail case crossed the review threshold; the full-vector case also
showed a material median slowdown. Inspection of the generated Wasm found two
null-pointer checks inside the coordinate loop. The selected change checks
alignment once per leaf and uses aligned volatile loads for that path. Unaligned
inputs retain the general loader. Strict comparisons, bounded loads, NaN handling,
first signed-zero behavior and the public ABI are unchanged.

| Selected geometry follow-up | AS µs | Rust µs | Rust/AS | Pairs >10% slower |
| --- | ---: | ---: | ---: | ---: |
| Bounds, full | 467.73 | 447.70 | 1.054 | 3/7 |
| Bounds, pair tail | 488.45 | 426.90 | 0.960 | 0/7 |

The changed absolute timings between runs and the full-vector pair ratios
(0.639–1.567) show host variation. Compare adjacent pairs within each run;
subtracting timings across runs would overstate the certainty of the fix. This
follow-up supports choosing the simpler hot path, with no remaining consistent
regression above the review threshold in these cases. Cold startup, adapter
dispatch, worker messaging and application latency are outside this experiment.

## Correctness and artifact checks

Each run passed 860 preflight module invocations across 42 fixtures, covering
empty vectors, leaf/tree boundaries, finite/infinite/inverted bounds, NaN bounds,
odd point counts trapping before early return, signed zeros, independent NaN
axes and retained tails. The initial run checked all 10,626 timed invocations;
the follow-up checked all 1,932. Every geometry call checked all four components.
The SHA-256 of the entire used shared arena was unchanged after each run, and
memory capacity did not grow.

An additional untimed direct geometry ABI comparison passed **80 module calls**:
five payloads at eight addresses, each against AssemblyScript and the selected
Rust candidate. Addresses were 0, 1, 8, 9, 2112, 65536, 65537 and the exact final
in-bounds payload span. Payloads covered signed zeros, NaNs on either axis,
infinities, all-NaN coordinates, the smallest positive subnormal and the largest
finite value. This checks
aligned address zero, unaligned reads, the former state-slot address and loads
ending exactly at the memory boundary.

These cases are retained in [`geometry-abi.mjs`](geometry-abi.mjs), which also
compares the full memory before and after every call. With no arguments it checks
40 candidate calls against fixed expected bounds, so it can run in CI without an
AssemblyScript checkout. To repeat the original 80-call comparison:

```sh
node proofs/rust-migration-20261115/geometry-abi.mjs \
  --baseline ../zerocopy-rust-baseline
```

Use `--candidate CHECKOUT` to override the candidate directory.

| Module | AssemblyScript bytes | Initial Rust bytes | Selected Rust bytes |
| --- | ---: | ---: | ---: |
| Numeric scalar | 720 | 1297 | 1297 |
| Numeric SIMD | 782 | 1529 | 1529 |
| Geometry | 571 | 1323 | 1199 |

The selected 1199-byte geometry module has SHA-256
`36da9253c5cf3eeb7bc863a85747a666a9009557855cde73f6f8400a6d486804`.
Its production audit passed with six functions, 417 instructions, no data
segments and no linear-memory stack usage. All six functions passed the reader
write audit; the four result values reside in per-instance Wasm globals.

## Repeat

Build the baseline with its own AssemblyScript dependencies and build the current
candidate with `npm run build:wasm`. Run in an idle benchmark window with a new
output filename; recorded reports are never overwritten:

```sh
taskset -c 0 node proofs/rust-migration-20261115/kernel-benchmark.mjs \
  --baseline ../zerocopy-rust-baseline \
  --output proofs/rust-migration-20261115/kernel-repeat.json
```

For a focused geometry comparison add `--only bounds.full,bounds.pair-tail`.

The recorded JSON reports are losslessly compressed; `gzip -dc FILE.json.gz` prints the original JSON. [checksums.json](checksums.json) records both compressed and original hashes.
