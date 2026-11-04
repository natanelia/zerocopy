# Rejected bulk string preparation experiments

**All three candidates were rejected.** Some repeated-value workloads improved substantially, but each candidate also made control workloads slower. The runtime source was restored to fixed baseline `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`. This branch adds only this proof folder; no performance improvement PR is proposed.

All 192 fresh paired processes completed. Full measurements, source patches, tests, drivers, and validation logs are retained. The JSON files are losslessly gzipped; the [packing manifest](results/packing-manifest.json) records original sizes, SHA-256 identities, compressed identities, and round-trip verification. Each original archive manifest describes the exact uncompressed files.

## Decisions

- **V1:** Key the temporary UTF-8 preparation map by value, so repeated strings share one encoded buffer during the call. Node fresh long unique values were 20.7% slower in the screen. Rejected.
- **V2:** Restore the key-indexed map and add bounded probing/reuse inside its preparation loop. Node short unique values were 17.2% slower; Bun long unique values were 21.5% slower. Rejected.
- **V3:** Use a separate bounded preflight and pooled helper, keeping the ordinary preparation loop unchanged. Node long-unique replacements were 8.1% slower in both processes; the cache-abandonment guard was 19.9% slower overall. Bun fresh long unique values were 11.9% slower in both processes and short unique values 6.5% slower. Rejected; no formal study or further variant.

V3 skips preflight below 256 normalized entries. Otherwise it visits at most 64 entries and 16 Unicode values, requiring four repeated observations. Its pooled helper stops permanently on its 16th total cache miss. These bounds may miss repetition in small batches, later in the input, or after the miss budget. All versions retain separate inline leaf payloads, identical shared allocation, key normalization, binary format, and API behavior. No persistent cache was added. The [V3 hypothesis and guard amendment](results/v3-hypothesis.md) were recorded before measurement.

## Complete screening results

Cells show candidate time divided by baseline time; smaller is faster. Each is the geometric mean of two independent process estimates, each using nine alternating batch ratios. These exploratory estimates have no confidence intervals. Raw median latencies are separate summaries and need not divide to the paired ratio.

| Workload | V1 Node | V1 Bun | V2 Node | V2 Bun | V3 Node | V3 Bun |
|---|---:|---:|---:|---:|---:|---:|
| unicode-short-repeat | 0.454× | 0.752× | 0.599× | 0.813× | 0.597× | 0.911× |
| unicode-short-unique | 1.003× | 0.964× | 1.172× | 0.983× | 1.041× | 1.065× |
| unicode-long-repeat | 0.365× | 0.646× | 0.458× | 0.835× | 0.421× | 0.806× |
| unicode-long-unique | 1.115× | 1.051× | 1.038× | 1.215× | 1.025× | 0.816× |
| ascii-short-repeat | 0.975× | 0.983× | 0.988× | 0.918× | 0.967× | 1.011× |
| ascii-short-unique | 1.013× | 1.004× | 0.921× | 1.085× | 1.019× | 1.079× |
| ascii-long-unique | 0.966× | 0.818× | 0.954× | 0.998× | 0.966× | 0.942× |
| mixed-short | 0.728× | 0.863× | 0.856× | 0.959× | 0.795× | 0.919× |
| mixed-long | 0.780× | 0.808× | 0.820× | 1.114× | 0.752× | 1.040× |
| replace-unicode-short-repeat | 0.468× | 0.741× | 0.597× | 0.853× | 0.603× | 0.874× |
| replace-unicode-long-repeat | 0.484× | 0.606× | 0.508× | 0.709× | 0.427× | 1.032× |
| replace-unicode-long-unique | 1.087× | 1.046× | 1.081× | 0.963× | 1.081× | 0.984× |
| small-unicode-short-repeat | 0.553× | 0.846× | 0.623× | 0.894× | 0.980× | 0.990× |
| small-unicode-short-unique | 1.032× | 1.055× | 1.060× | 1.063× | 1.037× | 1.057× |
| fresh-unicode-long-unique | 1.207× | 0.937× | 1.071× | 1.006× | 0.963× | 1.119× |
| fresh-unicode-long-early-repeat | — | — | 1.268× | 1.067× | 1.058× | 1.056× |
| fresh-unicode-long-cache-abandonment | — | — | — | — | 1.199× | 0.920× |

The first 15 cases were fixed before V1. V2 added the early-repeat guard. V3 retained all 16 and added the separately declared cache-abandonment guard. No case or process was discarded.

## Method and scope

The screens use Node 24.22.1 and Bun 1.4.2 on Linux x64, AMD EPYC 9V74. Every heavy command acquires a shared performance lock; timing processes are pinned to CPU 2. Each fresh process imports both builds, with distinct lexical write/timer functions and balanced import, reset, and timing orders. These are paired processes, not separate processes each importing one build.

Each case has two processes per runtime, nine measured batches per process, at least 150 ms of timed warm-up per variant and eight warm-up pairs, and common calibrated repeats targeting 10 ms. An 8 MiB shared-allocation cap can end calibration before that time target. The complete warm-up, calibration, cap flags, and samples are retained.

The timed operation is `setMany` on a retained base root, including its returned handle. Input generation, old-map setup, periodic resets, validation, and hashing are outside timing. Replacement cases start with the same keys and earlier ASCII values. Each call writes from the same retained root while outputs consume append-only memory; arenas reset outside timing near 64 MiB.

Most cases reuse fixture strings. Repeated workloads cycle eight strings; mixed workloads are 75% distinct ASCII and 25% repeated Unicode. The normal size is 2048 entries, with 64-entry small controls. The fresh cases construct independent flat strings per build and timed call, with a unique per-call nonce and no value-keyed Map/Set to prime hashes. This distinguishes fresh unique input from warmed reused fixtures. It does not measure independently recreated equal strings at every row of the repeated workloads.

The first fresh guard repeats only the first pair and then uses fresh long unique values; it activates V2 but skips V3's pool. The second repeats the first five values, activating V3, then exhausts its cache-miss budget on the unique remainder. Both guards are retained, including their mixed engine results.

After every timed pair, the driver checks all returned root addresses and sizes, equal shared allocation, the SHA-256 of all newly allocated bytes, unchanged base bytes, and the full last output against a native Map model. Whole-region byte equality covers every output; full content iteration checks the last output of each batch. Initial outputs and retained replacement roots are also checked.

Source guards cover production root TypeScript, every imported JavaScript bundle, WASM, and the driver, rechecked on completion. V3 additionally guards package metadata, the build script, configuration, and lockfile presence. Both hydrated checkouts lacked Bun lockfiles; that absence is recorded. These two-process screens support rejecting the candidates, not stable speed guarantees or confidence claims.

## Evidence

| Variant | Processes | Raw data | Source, tests and logs | Exact driver |
|---|---:|---|---|---|
| V1 | 60 | [raw.json.gz](results/v1/raw.json.gz) | [manifest](results/v1/manifest.json), [patch](results/v1/candidate.patch), [tests](results/v1/regression-tests.ts), [validation](results/v1/validation.txt), [output](results/v1/pilot-output.txt) | [pilot.mjs](results/v1/pilot.mjs) |
| V2 | 64 | [raw.json.gz](results/v2/raw.json.gz) | [manifest](results/v2/manifest.json), [patch](results/v2/candidate.patch), [tests](results/v2/regression-tests.ts), [validation](results/v2/validation.txt), [output](results/v2/pilot-output.txt) | [pilot.mjs](results/v2/pilot.mjs) |
| V3 | 68 | [raw.json.gz](results/v3/raw.json.gz) | [manifest](results/v3/manifest.json), [patch](results/v3/candidate.patch), [tests](results/v3/regression-tests.ts), [validation](results/v3/validation.txt), [output](results/v3/pilot-output.txt) | [pilot.mjs](results/v3/pilot.mjs) |

The candidate tests cover bounded reuse/fallback, malformed surrogates, BOM/empty values, duplicate/normalized keys, type errors without allocation, immutable roots/forks, exact allocation and leaf addresses, fixed-capacity failure, and read-only shared/copy attachments after growth. Fixtures use private Arenas. The [real Node worker proof](worker.mjs) checks old snapshots, forks, growth, reset, and read-only access in shared and copy modes; both modes passed V2 and V3. V3's focused checks passed three Vitest files/66 tests and both worker modes. The rejected candidates did not advance to a full-suite/formal performance gate.

Run `node proofs/bulk-string-prepare/verify.mjs` to verify all archive bytes and source/driver identities, recompute every process ratio and summary, and check the report table. The [verifier](verify.mjs) and [successful verification output](results/evidence-verification.txt) are retained. This checks evidence integrity without rerunning timings.

## Reproduce

Create independent baseline and candidate checkouts at the fixed baseline commit. Apply the selected archived source patch to the candidate, and build both using the same dependencies and recorded tool versions from [CONTRIBUTING.md](../../CONTRIBUTING.md). The archived source and tests are exact copies of the measured variants; their manifests and raw records identify the original local commits. Patches allow reconstruction without those local commits.

```sh
# Example: V3, from the directory containing this proof folder.
git -C /path/to/candidate apply /path/to/proofs/bulk-string-prepare/results/v3/candidate.patch
cp /path/to/proofs/bulk-string-prepare/results/v3/regression-tests.ts \
  /path/to/candidate/bulk-string-prepare.test.ts

# Build WASM and portable JavaScript in each checkout using CONTRIBUTING.md.
# The driver compares portable dist builds, including under Bun.
flock /path/to/perf.lock taskset -c 2 node \
  /path/to/proofs/bulk-string-prepare/results/v3/pilot.mjs \
  /path/to/baseline /path/to/candidate /path/to/bun \
  /path/to/new-screen.json

# Restore the exact original raw bytes for inspection.
gzip -dc proofs/bulk-string-prepare/results/v3/raw.json.gz > /tmp/bulk-string-v3-original.json
sha256sum /tmp/bulk-string-v3-original.json
```

Use a new result path for every run; the driver refuses overwrites. V1 and V2 use their own archived drivers to retain their original 15/16-case matrices. A fresh rebuilt run records its own source/build identities and does not replace this evidence.
