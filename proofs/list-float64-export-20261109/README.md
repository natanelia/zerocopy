# Numeric List → Float64Array: paired performance study (2026-11-09)

This proof covers the additive `SharedList<'number'>.toFloat64Array()` API.
It copies immutable WASM leaf bytes into an independently owned typed array;
callers may mutate the result without changing any snapshot. This is **not** a
zero-copy mutable view of the arena. The byte copy preserves signed zero and
noncanonical NaN payloads. A native endian check keeps exports portable.

## Baseline and comparison

- **Pinned main baseline:** `a4265a0608ec25eec5719496225212db6b251989`.
- **Measured candidate:** `f704e9d44b334fdd95c03321b9d1177e3029517a`.
- **Before:** `new Float64Array(list.toArray())`, the existing convenient
  way to obtain a detached numeric typed array.
- **After:** `list.toFloat64Array()`.
- Linux x64, Node 24.22.1 and Bun 1.4.2; separate portable distribution builds
  of baseline and candidate. Each runtime/size uses six independent A/B process
  pairs in alternating execution order. Each process warms for at least 250 ms,
  then reports the median of nine timed batches. The timer includes result
  allocation and copying, but excludes list construction, process startup and
  exhaustive output verification. Every returned array is checked for correct
  length and all numeric values, including signed zero and NaN.
- Ratios and intervals are based on paired process estimates. 95% intervals
  use the log-ratio mean and the 5-df Student t critical value of 2.571.
  Same-build A/A controls were collected separately and **not** used to
  adjust the A/B results.

## Results

Lower times are better. Times shown are medians of the six process estimates,
in microseconds per complete export. Reductions are based on geometric paired
ratios, so may differ slightly from the ratios of the displayed medians.

| Values | Node before → after | Node paired reduction | Bun before → after | Bun paired reduction |
| ---: | ---: | ---: | ---: | ---: |
| 32 | 0.55 → 0.51 µs | 7.6% (inconclusive) | 0.21 → 0.29 µs | **38.9% slower** |
| 1,024 | 4.85 → 2.59 µs | **46.8%** | 6.26 → 2.93 µs | **53.2%** |
| 65,536 | 719.16 → 152.71 µs | **78.8%** | 407.41 → 199.75 µs | **50.9%** |
| 262,144 | 2,863.88 → 734.46 µs | **74.5%** | 1,642.82 → 633.02 µs | **61.3%** |

At 1,024, 65,536 and 262,144 values, all six pairs are faster in **both**
runtimes and the paired 95% ratio intervals are below 1. At 32 values,
Node's 95% interval is 0.829–1.030, while Bun's is 1.349–1.430.
This API is intended for larger numeric data exports; tiny-array callers
should retain the existing approach if Bun latency matters.

The unchanged A/A results: Node 1,024 ratio 1.003 [0.995, 1.011], Node 65,536
1.005 [0.943, 1.071], Bun 1,024 1.002 [0.989, 1.016], Bun 65,536
1.004 [0.991, 1.017]. They show measurement variation without invalidating
the much larger gains in the target workloads.

## Validation and evidence

- All **1,207 Bun tests across 62 files passed**.
- Declaration builds, main and typed-value type checks, packed package,
  existing Node workers and List query checks passed.
- New tests cover empty and non-number inputs, eleven leaf/tree boundary
  sizes, detached output, retained snapshots, read-only copied attachment
  and exact IEEE-754 NaN payload preservation.
- [Successful source-pinned validation and benchmark run](https://github.com/natanelia/zerocopy/actions/runs/42532541313).
- [Raw nine-batch readings, six process pairs, A/A controls, and test logs](https://github.com/natanelia/zerocopy/actions/runs/42532541313/artifacts/13637833049)
  (Actions artifacts are retained for seven days). A separate offline audit
  independently recomputed the stored medians, geometric ratios, intervals,
  sample counts and output checksums.

## Reproduce

The complete sources for the child-process benchmark and pairing code are
`case.mjs` and `compare.mjs` in this directory. The branch-only Actions
workflow `.github/workflows/list-float64-export-proof.yml` checks out and
builds the exact baseline and candidate, then runs the comparison:

```bash
bun install
bun run build:wasm
bun run build:browser
bun run build:types
bun run test
# Build the same dependencies and portable bundle in a detached baseline worktree.
node proofs/list-float64-export-20261109/compare.mjs /path/to/pinned-baseline "$PWD"
```

The change does not alter existing List methods, the WASM binaries, any
stored snapshot layout or worker descriptors.
