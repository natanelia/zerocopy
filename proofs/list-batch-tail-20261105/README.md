# Bulk list append: reuse the tail without an extra WASM call

The final implementation reduces elapsed time for streams of small numeric
batches by **25–41% in Node and 23–74% in Bun** on this host. Boolean and
repeated-string batches also improve in both runtimes. These are results from
the fixed formal study below, with all 14 workloads retained.

For a 4,096-number stream appended one value at a time with `pushMany`, shared
allocation falls from **601,728 to 62,320 bytes: 89.64% fewer bytes**. This counts
Arena allocation, including old persistent storage that later becomes
unreachable. It does not measure JavaScript heap, process RSS or total live
memory. Timings include memory growth and any garbage collection within the
append loop; the experiment does not separate those effects from reduced copying.

Some controls remain uncertain. In Node the large empty-prefix control has a
1.091 candidate/baseline ratio with a 0.965–1.232 interval. In Bun the interleaved
allocation control has a 1.032 ratio with a 0.974–1.094 interval. Neither establishes
a change, and the wider Node string/object intervals leave room for effects this
study cannot resolve. This is not a universal no-regression guarantee.

## What changed

`SharedList.pushMany` previously copied its visible tail, at most 32 values,
before writing each new batch. If that tail already ends at the Arena's
allocation frontier, the new suffix can be reserved immediately after it.
An older snapshot reads only its original size, so its published bytes remain
unchanged.

The final `tailReserve` helper combines the frontier decision, allocation and
fallback prefix copy in one WASM call. If another allocation or a fork has moved
the frontier, it allocates a new range and copies the old prefix with the
existing `copyWords` helper. Allocation and growth checks finish before any
copy or new-value write. JavaScript obtains its DataView afterward so it sees
the grown memory when necessary.

JavaScript validates the original total byte count before unsigned WASM
conversion, including the existing `0x7ffe0000` allocation limit and `RangeError`.
Only nonnegative safe-integer counts use the helper. Exotic lengths retain the
original `(length + count) * 8` allocation/copy path, including coercion order
and reentry. Serialization and the input length getter finish before the helper
checks the frontier; later element getters run after reservation.

The JavaScript API, node layout, format version and worker descriptors are
unchanged. This changes bulk append; the existing scalar `push` implementation
is unchanged.

## Formal results

Each operation constructs a new list by streaming the complete input through
`pushMany`. Numeric, boolean and string streams contain 4,096 values; the large
numeric stream contains 65,536; the object stream contains 1,024. The fork case
creates 1,024 distinct snapshots from a retained 31-value seed.

Times below are microseconds per **complete operation**, not per individual
append. Before/after times are medians of the eight process medians. The ratio
is the geometric mean of the eight paired candidate/baseline ratios, so it need
not equal the ratio of the two marginal medians. Below 1 favors the candidate.
Intervals are unadjusted 95% Student-t intervals on the paired log ratios.
The process pairs, not the individual timed batches, are the independent units.

Shared bytes are the median Arena used-byte delta per complete operation.
Fractional values arise from amortizing initial encoding or one frontier reuse
over the common repetitions within a batch.

### Node 24.22.1

| Workload | Before µs/op | After µs/op | Ratio | 95% interval | Before shared B/op | After shared B/op |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| number/1 | 1,188.30 | 689.51 | 0.588 | 0.507–0.682 | 601,728.00 | 62,320.00 |
| number/4 | 359.41 | 221.85 | 0.606 | 0.503–0.729 | 208,512.00 | 65,344.00 |
| number/8 | 200.32 | 131.07 | 0.664 | 0.613–0.720 | 142,976.00 | 69,376.00 |
| number/16 | 133.23 | 103.05 | 0.749 | 0.642–0.874 | 110,208.00 | 77,440.00 |
| number/31 | 93.64 | 86.26 | 0.929 | 0.781–1.105 | 79,152.00 | 77,640.00 |
| number/32 | 93.07 | 96.31 | 0.952 | 0.852–1.063 | 93,824.00 | 93,312.00 |
| number/33 | 89.02 | 78.90 | 0.885 | 0.794–0.987 | 76,464.00 | 76,456.00 |
| number/interleaved | 323.27 | 260.24 | 0.827 | 0.698–0.978 | 212,480.00 | 212,480.00 |
| number/large | 263.51 | 294.06 | 1.091 | 0.965–1.232 | 532,864.00 | 532,864.00 |
| boolean/8 | 258.77 | 149.29 | 0.622 | 0.561–0.690 | 142,976.00 | 69,376.00 |
| string/repeated | 384.63 | 277.47 | 0.722 | 0.611–0.852 | 142,978.80 | 69,378.80 |
| string/unique | 923.24 | 929.52 | 0.975 | 0.738–1.290 | 194,972.24 | 160,397.18 |
| object/8 | 620.81 | 585.79 | 0.986 | 0.787–1.236 | 73,344.00 | 73,344.00 |
| number/forks | 380.04 | 344.11 | 0.868 | 0.720–1.047 | 262,144.00 | 262,133.67 |

### Bun 1.4.2

| Workload | Before µs/op | After µs/op | Ratio | 95% interval | Before shared B/op | After shared B/op |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| number/1 | 2,089.26 | 553.58 | 0.263 | 0.224–0.309 | 601,728.00 | 62,320.00 |
| number/4 | 622.64 | 242.55 | 0.401 | 0.366–0.440 | 208,512.00 | 65,344.00 |
| number/8 | 427.54 | 218.03 | 0.516 | 0.451–0.591 | 142,976.00 | 69,376.00 |
| number/16 | 307.18 | 231.10 | 0.767 | 0.696–0.846 | 110,208.00 | 77,440.00 |
| number/31 | 204.94 | 210.44 | 0.990 | 0.901–1.088 | 79,152.00 | 77,640.00 |
| number/32 | 250.79 | 230.63 | 0.913 | 0.840–0.992 | 93,824.00 | 93,312.00 |
| number/33 | 212.96 | 191.97 | 0.906 | 0.780–1.053 | 76,464.00 | 76,456.00 |
| number/interleaved | 607.22 | 646.20 | 1.032 | 0.974–1.094 | 212,480.00 | 212,480.00 |
| number/large | 478.06 | 477.75 | 0.992 | 0.942–1.045 | 532,864.00 | 532,864.00 |
| boolean/8 | 420.16 | 238.61 | 0.575 | 0.513–0.645 | 142,976.00 | 69,376.00 |
| string/repeated | 537.79 | 394.57 | 0.682 | 0.580–0.801 | 142,977.37 | 69,377.37 |
| string/unique | 944.86 | 791.98 | 0.879 | 0.765–1.010 | 194,230.26 | 159,091.48 |
| object/8 | 448.40 | 452.60 | 0.986 | 0.933–1.042 | 73,344.00 | 73,344.00 |
| number/forks | 1,345.87 | 1,253.80 | 0.899 | 0.829–0.973 | 262,144.00 | 262,141.86 |

The small numeric, boolean and repeated-string targets have intervals below 1
in both runtimes. Other cases are reported in full, including uncertain and
adverse point estimates. No observation was removed or replaced.

## Method and limits

The [formal plan](FORMAL-PLAN.md) kept the original 14-case matrix. For every
runtime/workload there are eight fresh-process pairs, alternating AB/BA order,
with case order rotated each round. A subject imports one build and runs one
workload. Both builds use the same neutral import path; the entire bundle
directory is replaced between processes, including content-hashed chunks.
There are 448 measured subject processes and 4,032 measured batches across
the two runtimes, plus separate disposable calibration processes.

**There is one fresh private Arena per batch, reused across that batch's
repeated complete operations.** Each operation starts a new list; the fork case
uses the prepared seed. `string/unique` has distinct labels within one operation,
but repetitions reuse the same inputs and Arena, so later operations benefit
from the existing bounded string cache. It is a mixed first-encoding/cache-reuse
control, not a benchmark where every string is newly allocated in a fresh Arena.

Input generation, Arena initialization, the fork seed, the outer batch-output
array and content verification are outside the timer. List wrappers, all appends,
retained result wrappers, optional intervening scalar pushes and the fork-result
array are inside it. After every calibration, warm-up and measured batch, the
driver checks every final value and retained root, and verifies object freezing.
Validation must not allocate shared storage.

Calibration first performs at least 250 ms of timed work in one-operation
batches. It then takes three trials at each of up to three repetition counts,
targeting 16 ms per batch. Repetitions are bounded by 256 and a 32 MiB shared
allocation estimate. Each case uses common repetitions and a common warm-up
batch count for before/after. The warm-up count targets 500 ms using the faster
calibration; **500 ms is not a per-subject time minimum**. There are nine measured
batches per subject, and their median is the subject statistic.

Calibration and measured subjects have different prior Arena histories:
calibration starts with repeated one-operation Arenas, while subjects warm
directly at the final common repetition count. Some Node boundary cases settle
much faster than calibration predicts. Both the actual warm-up totals and all
individual batches are preserved. The observed ranges were:

| Runtime | Actual timed warm-up per subject | Measured batch duration |
| --- | --- | --- |
| Node | 96.136–969.732 ms | 2.313–56.248 ms |
| Bun | 351.750–1526.514 ms | 14.611–241.774 ms |

The shortest Node batches are below the 16 ms target. The original nine-batch
summaries remain the primary results. There was no rerun solely to achieve a
warm-up duration and no extra A/A performance run. The result applies to these
warm engines, workloads and host; browser timing was not measured here.

Measured on 2026-11-04 UTC, AMD EPYC 9V74 80-Core Processor, Linux 6.18.57 / x64,
pinned to CPU 2. The cgroup quota was eight CPU equivalents (`800000 100000`).
All heavy tests/builds/measurements shared `perf.lock`, so other agents did not
run competing benchmarks. Both engines used the same built portable entry point;
their version details are retained in every subject record.

## Correctness and validation

The new regressions check retained snapshots and forks across tail/tree
boundaries; numeric special values; exact suffix allocation; object serialization
and input-getter reentry; length coercions; negative, fractional and oversized
lengths; allocation failure and recovery; nested snapshots; and read-only
shared/copy attachments through growth. Tests use private Arenas.

The new [real worker proof](worker.mjs) reads an old snapshot concurrently while
the owner repeatedly appends eight-value batches and grows memory from 131,072
to 655,360 bytes. It then attaches new snapshots after growth and after reset,
checks all values, rejects reader writes and verifies unchanged published bytes.
Both shared and copy transports pass. A five-value tail plus two values reserves
16 bytes instead of the original 56, a deterministic 40-byte reduction. The proof
is included in the existing built-Node-entry-points CI step.

Recorded focused validation:

- V2 WASM/portable builds, 78 tests across the new regression file plus allocation
  failure and immutability suites, and both worker transports passed in
  [wasm-v2-validation.log](results/wasm-v2-validation.log).
- The final fractional-count regression brought the new file to 13 passing tests;
  see [wasm-v2-fraction-validation.log](results/wasm-v2-fraction-validation.log).
- [verify.mjs](verify.mjs) independently recomputes every subject median, paired
  ratio and interval, checks equal work and expected full-content verification
  counts, and verifies source/driver identities. All 224 formal pairs pass; see
  [Node verification](results/node-verification.txt) and
  [Bun verification](results/bun-verification.txt).

**Combined validation passed** at integration commit
`95e0bbc825cee94be3c24f097b315ee9154fda6c`: all three builds, the default suite
(55 files / 1,092 tests in 46.17 seconds), type checking, three real-worker tests
and an actual installed-package consumer check. The latter checked the 143-file,
215,196-byte tarball through Node/Bun exports, retained immutable snapshots,
Node worker sharing and a TypeScript consumer.

That integration combines search PR50 and this list change; the map candidate
was excluded. The [combined manifest](results/combined-validation-manifest.json)
records that scope and confirms the measured list source hashes; the full
[combined log](results/combined-validation.log) is retained. The full-suite counts
above refer to that combined tree. Individual PR CI also tests the published merge.

## Experiments retained

The initial queued pilot was canceled before any timing because review found a
length-coercion reentry edge. Its source patch, exact driver and zero-sample
[cancellation record](results/pilot-01-cancelled.json) remain available.

The complete [JavaScript V1 pilot](PILOT.md) showed strong small-batch gains but
consistent Node penalties in 33-value batches and retained-root forks. That
version made a separate heap-frontier call before allocation. Its full source,
patch, driver and all observations are retained under `exploration/` and
[pilot-02.json.gz](results/pilot-02.json.gz).

The [WASM V2 pilot](PILOT-WASM.md) retained every workload and combined the calls.
The two prior Node penalties were resolved. A small Bun fork penalty and noisy
Bun large-batch result appeared in that pilot; neither persisted in the longer
formal study. The complete V2 pilot remains in
[pilot-wasm-v2-01.json.gz](results/pilot-wasm-v2-01.json.gz). Pilot observations
were not pooled with the formal estimates.

## Sources and raw evidence

The fixed baseline is `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`, including the
previously merged list-to-array improvement. The measured production/test commit
is local commit `df43219addee389992b2551074927fa680b5922f`. Publication can use a
different commit ID for the same files; source and bundle hashes identify the
measured implementation. All imported bundle chunks, source files, build scripts
and WASM outputs are recorded in each formal JSON.

| File | Candidate SHA256 |
| --- | --- |
| arena.ts | `67130eff8263bcf08b37395f67b9af644cf0528aaa0ea6f16c82b8b624ab33c6` |
| persistent-core.as.ts | `968cbe532d9ffc0e82310287af296f4ce2c6e77efba1beec0ec03185e6c9b267` |
| persistent-core.wasm | `5df6abc1b99fe13197bd4cd20ed998dfc3acd1a7b693aa81ea710b940809be59` |
| benchmark.mjs | `26aa70cfc8d24261c977aa6f5aeee4a1b5fdf1f3e08afd324aaf01060ef9505e` |

The [baseline manifest](results/baseline-manifest.json) and
[baseline validation](results/baseline-validation.log) are copied unchanged from
the frozen baseline preparation. Its default suite passed 53 files / 1,076 tests.

Large JSON files are losslessly gzip-compressed. The
[archive manifest](results/archive-manifest.json) records original and compressed
byte counts/SHA256 values and verified decompression round trips. All original
calibration, warm-up and measured observations remain in:

- [Node formal data](results/node-01.json.gz) and [process log](results/node-01.log).
- [Bun formal data](results/bun-01.json.gz) and [process log](results/bun-01.log).
- Both pilot archives linked above.

## Reproduce

Use Node 24.22.1 and Bun 1.4.2. The following Linux commands use an allowed CPU 2
and a common lock; choose an allowed CPU on another host and record that choice.
Run from this candidate checkout. Output files must be new: the driver refuses
to overwrite an existing recording.

```sh
git worktree add --detach ../zerocopy-batch-before 09b1a385a7c2ac9b027a4055335ae2f9449abe6e
(cd ../zerocopy-batch-before && bun install && bun run build:wasm && bun run build:browser)
bun install
bun run build:wasm
bun run build:browser
flock /tmp/zerocopy-batch-perf.lock taskset -c 2 node proofs/list-batch-tail-20261105/benchmark.mjs ../zerocopy-batch-before . "$(command -v bun)" /tmp/list-batch-node.json node
flock /tmp/zerocopy-batch-perf.lock taskset -c 2 node proofs/list-batch-tail-20261105/benchmark.mjs ../zerocopy-batch-before . "$(command -v bun)" /tmp/list-batch-bun.json bun
bun run test -- shared-list-batch-tail.test.ts allocation-failure.test.ts immutable-proof.test.ts
node --test proofs/list-batch-tail-20261105/worker.mjs
node proofs/list-batch-tail-20261105/verify.mjs proofs/list-batch-tail-20261105/results/node-01.json.gz proofs/list-batch-tail-20261105/results/bun-01.json.gz
```

The last command verifies the archived original study. Its source-commit checks
refer to the original local measurement commit. A fresh run on another checkout
records that checkout's own commit and hashes.
