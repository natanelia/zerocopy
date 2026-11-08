# Checkpoint byte decoder: measured import performance

## Supported result

The final V3 implementation reduces complete `decodeZerocopyState` time on **Node 24.22.1** for the two declared text-payload targets:

- 512 KiB of text: **23.4% less time**, paired after/before ratio **0.766 [0.689–0.851]**.
- 2 MiB of text: **32.4% less time**, ratio **0.676 [0.613–0.747]**.

Both operations improved in **all six independent process pairs**. These are whole checkpoint imports, including validation, byte decoding, checksums, arena attachment, compaction into writable storage, and state reconstruction. They are not isolated Base64 microbenchmarks.

**The final evidence does not establish a Bun improvement or a `deserializeZerocopyState` improvement.** Every final Bun target interval and both deserialization intervals include parity. Bun's small-snapshot boundary estimates **10.4% more time**, with **five of six pairs slower** and a ratio interval of **0.975–1.250**. This adverse observation remains visible; the interval does not establish equivalence or absence of a regression. The forced-portable and plain-state controls also remain inconclusive.

## Implementation

The old import path obtains a binary string with `atob`, allocates a byte array, and copies every character code into that array. V3 selects an available byte decoder at module initialization: `Uint8Array.fromBase64` first, otherwise a callable global `Buffer.from`. The browser bundle imports no Node module and adds no dependency. Engines without either API retain the original `fromBase64` helper, including its function name and body, with a direct call from the import loop.

Both byte decoders receive the existing alphabet and encoded-length checks before execution. Decoded length and checksum checks remain in their original sequence. Default final-chunk handling preserves `atob`'s acceptance of nonzero unused padding bits. Direct packet inputs can have getters: if the later Base64 read returns a nonprimitive String-like value after initial validation, the original portable helper preserves its coercions and errors. Buffer results are consumed as byte views, respecting their offset and length.

The measured runtime file is [redux-checkpoint.ts](../../redux-checkpoint.ts). The [frozen V3 source](source-snapshots/redux-checkpoint-v3.ts) has SHA-256 `55e8aa4be4db3e0644bfb3d7fc8a04031975a49c995874bb54274e5ca71e6ef1`.

## Final V3 results

The time columns are medians of process estimates. Ratios and intervals use matched process log ratios, so a ratio need not equal the ratio of the two displayed medians. A lower ratio means less time. Intervals are pointwise 95% Student-t intervals; no multiple-comparison or A/A adjustment is applied.

| Runtime | Complete operation | Before ms | After ms | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | decode · 512 KiB text | 6.343 | 5.069 | 0.766 [0.689–0.851] | 6/6 |
| node | deserialize · 512 KiB text | 7.996 | 7.561 | 0.909 [0.605–1.364] | 5/6 |
| node | decode · 2 MiB text | 30.020 | 19.106 | 0.676 [0.613–0.747] | 6/6 |
| node | decode · one 8-byte string | 1.450 | 1.256 | 0.915 [0.817–1.026] | 4/6 |
| node | decode · 64 plain rows | 0.275 | 0.217 | 0.839 [0.664–1.060] | 4/6 |
| node | decode · 512 KiB, byte APIs disabled | 8.338 | 7.410 | 0.998 [0.778–1.281] | 4/6 |
| bun | decode · 512 KiB text | 11.718 | 10.337 | 0.831 [0.657–1.051] | 5/6 |
| bun | deserialize · 512 KiB text | 11.378 | 9.149 | 0.891 [0.712–1.115] | 5/6 |
| bun | decode · 2 MiB text | 20.778 | 17.886 | 0.920 [0.788–1.075] | 5/6 |
| bun | decode · one 8-byte string | 7.163 | 8.227 | 1.104 [0.975–1.250] | 1/6 |
| bun | decode · 64 plain rows | 0.297 | 0.332 | 0.997 [0.834–1.191] | 2/6 |
| bun | decode · 512 KiB, byte APIs disabled | 8.474 | 8.709 | 0.938 [0.779–1.129] | 3/6 |

All six workloads, including slower estimates and every control, are retained in [the final recording](results/formal-v3.json.gz). The normal Node cases use the global Buffer decoder; normal Bun cases use the standard Uint8Array decoder. The forced-portable case disables **both** APIs before the first library import, then restores the globals after the decoder selection is captured. Each timed subject is a fresh process, so module caching cannot silently activate a different path.

## Method and scope

- Date: 2026-11-08. Linux x64, AMD EPYC 9V74 80-Core Processor, CPU affinity 2. Node 24.22.1 and Bun 1.4.2; project dependencies keep their pinned versions.
- Baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`. Only `redux-checkpoint.ts` differs in the measured runtime source; WASM bytes are identical. The measured candidate was uncommitted source on that baseline. Full source text, source hashes, bundle hashes, runtime versions, and host metadata identify each measured build independently of its Git HEAD.
- V3 confirmation: six A/B process pairs per workload and runtime, alternating AB/BA order and reversing case/runtime order. Each process loads one build and one workload through the same neutral package entry path. All studies hold `/tmp/zerocopy-performance.lock` to avoid timing other local experiments concurrently.
- Each subject performs at least 500 ms of actual timed warm-up and at least eight warm-up batches, followed by nine measured batches. Every warm-up and measured duration is retained. The pilot uses 150 ms warm-up and two pairs and is kept separate.
- The timer includes the complete public call and retention of each returned result. Imports, fixture construction, initial checkpoint encoding, output-array allocation, full output verification, and source checks are outside the timer.
- After every batch, every retained output is checked completely: values, collection type and size, snapshot aliases, frozen state, state fields, and new arena identity. Input packets, original snapshot contents, source arena bytes, and source used-byte counts remain unchanged.
- The cases use 128 distinct fixed-width ASCII strings, so string interning cannot collapse the large payload to one repeated blob. The surrounding state also contains a repeated snapshot alias and a small Unicode UI record. The no-arena control uses 64 ordinary records.

| Workload | Values / rows | Bytes per string | Decoded arena bytes | Calls per batch |
| --- | ---: | ---: | ---: | ---: |
| `decode-text-512k` | 128 | 4096 | 592,000 | 4 |
| `deserialize-text-512k` | 128 | 4096 | 592,000 | 4 |
| `decode-text-2m` | 128 | 16384 | 2,164,864 | 2 |
| `small-snapshot` | 1 | 8 | 65,560 | 32 |
| `plain-state-control` | 64 | — | 0 | 128 |
| `portable-decode-text-512k` | 128 | 4096 | 592,000 | 4 |

These measurements concern latency on this host. They do not establish ARM or browser performance, a memory reduction, or a universal speedup. In particular, substantial host variation occurred during the study and the result claims remain limited to the two supported Node workloads.

## Predeclared V3 same-baseline controls

The separate A/A study runs the identical baseline in both roles, with four pairs per declared control case. Its results describe measurement variability; they are **not subtracted** from A/B estimates and do not clear an adverse candidate result.

| Runtime | Complete operation | Before ms | After ms | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | decode · 512 KiB text | 7.808 | 8.066 | 1.012 [0.706–1.449] | 3/4 |
| node | decode · 64 plain rows | 0.210 | 0.165 | 0.875 [0.532–1.438] | 2/4 |
| node | decode · 512 KiB, byte APIs disabled | 6.375 | 6.926 | 1.001 [0.835–1.201] | 1/4 |
| bun | decode · 512 KiB text | 12.273 | 10.432 | 0.766 [0.576–1.018] | 4/4 |
| bun | decode · 64 plain rows | 0.333 | 0.349 | 0.977 [0.554–1.721] | 2/4 |
| bun | decode · 512 KiB, byte APIs disabled | 11.223 | 10.933 | 0.893 [0.639–1.247] | 3/4 |

The apparent Bun 512 KiB A/A improvement is large even though the implementation is identical. Its interval includes parity. This reinforces the need to retain workload-specific uncertainty. [Raw V3 A/A recording](results/aa-v3.json.gz).

## Earlier versions and the V3 pilot

All earlier measurements remain separate from the final confirmation. No favorable pilot or later version replaces an unfavorable result.

**V1** added a standard Uint8Array byte-decoder branch inside the portable helper. Node has no such standard method in this runtime, and its 512 KiB fallback pilot was **27.1% slower**, with both pairs slower. Bun target pilots improved. Inspection also found that nonprimitive results from dynamic packet getters must retain `atob` coercions. [V1 source](source-snapshots/redux-checkpoint-v1.ts), [V1 pilot](results/pilot-v1.json.gz).

**V2** added that compatibility guard and selected a renamed native/portable helper at module load. Its confirmation still showed a **7.4% Node 512 KiB slowdown**, ratio **1.074 [1.022–1.130]**, with all six pairs slower. That version was rejected despite favorable Bun decoding results. Its A/A study was also unstable: the Bun 512 KiB estimate was **1.595 [0.708–3.596]**. Those controls were never used to erase or adjust the V2 slowdown. [V2 source](source-snapshots/redux-checkpoint-v2.ts), [V2 confirmation](results/formal-v2.json.gz), [V2 A/A](results/aa-v2.json.gz).

**V3** adds actual byte decoding through optional `Buffer.from` on Node and preserves the original portable helper and its direct call. This removes the temporary-string copy on Node as well. Its new pilot is shown below; the subsequent confirmation above is the only source of final speed claims.

| Runtime | Complete operation | Before ms | After ms | Paired after/before (95% interval) | Faster pairs |
| --- | --- | ---: | ---: | --- | ---: |
| node | decode · 512 KiB text | 4.911 | 3.252 | 0.668 | 2/2 |
| node | deserialize · 512 KiB text | 5.026 | 3.484 | 0.697 | 2/2 |
| node | decode · one 8-byte string | 0.757 | 0.630 | 0.832 | 2/2 |
| node | decode · 64 plain rows | 0.113 | 0.113 | 1.001 | 1/2 |
| node | decode · 512 KiB, byte APIs disabled | 4.246 | 3.891 | 0.919 | 1/2 |
| bun | decode · 512 KiB text | 5.227 | 4.712 | 0.902 | 2/2 |
| bun | deserialize · 512 KiB text | 6.000 | 5.504 | 0.923 | 1/2 |
| bun | decode · one 8-byte string | 3.530 | 3.496 | 0.990 | 1/2 |
| bun | decode · 64 plain rows | 0.192 | 0.185 | 0.966 | 2/2 |
| bun | decode · 512 KiB, byte APIs disabled | 5.530 | 5.979 | 1.077 | 1/2 |

[Raw V3 pilot](results/pilot-v3.json.gz). V1/V2 use the frozen [original workload](workloads.mjs); V3 uses [its separate workload](workloads-v3.mjs), including the new forced-portable control. All original files and measured source snapshots remain available.

## Correctness and evidence verification

- V3's [15 semantic regressions](../../checkpoint-base64-import.test.ts) pass in Node and Bun. They cover all padding lengths, Unicode and NUL values, nonzero unused padding bits, malformed alphabet/padding, decoded-length mismatches, checksum and resource-limit errors, dynamic getter coercions, nested payloads, independent writable imports, retained snapshots, and read-only attachments. See [Node output](checks/v3-node-tests.txt) and [Bun output](checks/v3-bun-tests.txt).
- Ten fresh-process compatibility runs compare the unchanged baseline against V3: five API environments on each runtime. They exercise the preferred standard API, forced Buffer, real Buffer subviews with a 17-byte offset, both methods missing, and both methods noncallable. Every run checks 17 cases and compares exact error names/messages and getter/coercion order. See [the compatibility runner](compatibility-v3.mjs) and the JSON records in [checks](checks/).
- This change and [heap compaction #62](https://github.com/natanelia/zerocopy/pull/62) also passed together: **six focused files / 201 tests on each runtime**, actual Node shared/copied workers, and an end-to-end compaction/checkpoint/fork/alias/growth/attachment check on Node and Bun. The [combined manifest](combined-validation.json), [captured output](combined-validation.txt), and [interaction check](combined-check.mjs) retain the exact source/build identities and results. These are correctness checks only; every timing above measures this PR alone against the baseline.
- All six workload outputs and input invariants pass deterministic smoke checks on both runtimes. Each smoke case also gets a fresh process. [Smoke runner](smoke-v3.mjs), [Node output](checks/v3-node-smoke.txt), [Bun output](checks/v3-bun-smoke.txt).
- Portable bundles, declarations, and Redux type checks passed. An earlier type-check setup attempt lacked generated declarations; that failure is preserved in [its original output](checks/v2-types-missing-declarations.txt), followed by the completed declaration build and type checks.
- Local Chromium could not start because the execution sandbox rejected its process-singleton socket. No local browser success or timing is claimed. [Observed launch failure](checks/browser-launch-failure.json). The [browser correctness proof](browser.mjs) checks the real standard API and forced portable paths, all padding lengths, actual shared/copied workers, read-only attachments, memory growth, and retained snapshots. The [dedicated workflow](../../.github/workflows/checkpoint-base64-import.yml) installs Playwright Chromium and runs that proof; hosted CI status is reported on the PR.
- The independent [Python verifier](verify.py) checks all six studies: **416 fresh processes and 3,744 measured batches**. It recomputes estimates and intervals from every retained sample, checks schedule/order, counts, warm-up, source/build identities, immutable evidence digests, and matching complete-output oracles. It does not collect new timings. See [verification output](checks/evidence-verification.txt).

The [manifest](manifest.json) records compressed and uncompressed recording hashes, source-version hashes, and frozen tool/workload identities. Gzip compression preserves the exact original JSON bytes. The six recordings are not pooled.

## Hosted CI and test assertion repair

At the initial published head `62975a8a2e8e5b4169ff19680dcc695147fa8d7d`, [main CI](https://github.com/natanelia/zerocopy/actions/runs/42471144393/job/128701919813) passed 1,161 tests and failed only the new large nested-payload test: it exceeded Vitest's default 5,000 ms timeout, reporting 18,886 ms under the full parallel Bun suite. There was no value-mismatch failure. The complete [failed job log](checks/ci-main-62975a8a-timeout.txt) is preserved.

The follow-up changes only the two complete arena-byte comparisons from Vitest's `toEqual` to `deepEqual` from `node:assert/strict`. Both assertions still compare every byte and the exact lengths; the large fixture and 5,000 ms timeout remain unchanged. All 15 tests then passed locally on Node and Bun, with test-body totals of 286 ms and 486 ms respectively. See the [Node output](checks/ci-assertion-fix-node.txt) and [Bun output](checks/ci-assertion-fix-bun.txt). These test-run durations are not performance measurements of the library.

The [dedicated hosted workflow](https://github.com/natanelia/zerocopy/actions/runs/42471144522/job/128701920431) passed on that initial head, including the focused tests, all compatibility modes, workload smoke checks, archived-evidence verification, and Chromium **153.0.8010.12**. Chromium exercised seven real native API calls, plus the missing and noncallable API fallbacks with zero native calls; all three modes passed shared/copied workers, growth, retained snapshots, and read-only checks. The [captured browser result](checks/ci-chromium-62975a8a.json) identifies that exact head and job.

That hosted result predates the test-only assertion repair. The production source and browser proof remain identical, with `redux-checkpoint.ts` SHA-256 `55e8aa4be4db3e0644bfb3d7fc8a04031975a49c995874bb54274e5ca71e6ef1`. No benchmark input, recording, estimate, or timing claim changed. Current-head CI status remains visible on the PR.

## Reproduction

Use two independent checkouts, with the before checkout at `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e` and the after checkout at this PR. Use Node 24.22.1, Bun 1.4.2, and the pinned dependencies. In each checkout, run `bun install`, `bun run build:wasm`, and `bun run build:browser`.

From the PR checkout, verify the saved evidence without collecting measurements:

```sh
python3 proofs/checkpoint-base64-import-20261108/verify.py   proofs/checkpoint-base64-import-20261108/results/*.json.gz
node proofs/checkpoint-base64-import-20261108/smoke-v3.mjs
bun proofs/checkpoint-base64-import-20261108/smoke-v3.mjs
```

For a new confirmation, choose an available CPU and a **new** output path. The driver refuses to overwrite an existing recording:

```sh
taskset -c 2 node proofs/checkpoint-base64-import-20261108/paired-benchmark.mjs   proofs/checkpoint-base64-import-20261108/workloads-v3.mjs   /absolute/before /absolute/after /absolute/bun   /absolute/new-formal-v3.json formal
```

Use mode `aa` with another new output path for the declared identical-baseline controls. To reproduce V1 or V2, start the after checkout from the same baseline and replace only `redux-checkpoint.ts` with that version's frozen source **before building**. Use `workloads.mjs`, mode `pilot` for V1, or `formal` / `aa` for V2. Do not benchmark the current V3 source and label it as an earlier version.

For full compatibility checks, run `compatibility-v3.mjs BEFORE AFTER MODE` in each runtime, where MODE is `auto`, `buffer`, `buffer-offset`, `portable-missing`, or `portable-noncallable`. To run Chromium correctness checks, install Playwright Chromium and execute `node proofs/checkpoint-base64-import-20261108/browser.mjs`. `CHROMIUM_EXECUTABLE` can optionally select an already installed browser; the default uses Playwright's installation.
