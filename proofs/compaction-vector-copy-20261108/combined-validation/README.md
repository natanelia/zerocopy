# Combined correctness validation

## Reading the archive

[combined-validation.json](combined-validation.json) exposes the final results and hashes directly. [combined-validation.log.gz](combined-validation.log.gz) preserves the complete joined log. [evidence.tar.gz](evidence.tar.gz) contains all 46 original files byte-for-byte, including both attempts, per-command logs, orchestration scripts, and the baseline fixture reproduction. [archive-manifest.json](archive-manifest.json) lists every original file checksum. Paths discussed below refer to files inside that archive.

```sh
gzip -dc combined-validation.log.gz
tar -xzf evidence.tar.gz -C /path/to/empty-directory
```

The final heap-read and primitive-vector-compaction changes work together: **59 files / 1,178 tests passed** under Bun with file isolation; the **31 new regressions passed** under Node. Portable build, declarations, main/Redux/values/geometry/worker typechecks, real Node workers, Chromium workers, late imports, installed-package checks, author documentation checks, and every saved timing-record verifier passed. This directory contains correctness evidence only; it makes no combined speed claim.

## Failed default attempt and exact recovery

**The default full suite did not pass.** Attempt 1 reported 1,175 passed / 3 failed tests. Two existing allocation-failure tests exceeded their 5-second timeout. The third failure (`arena.copy is not a function`) came from the unchanged `worker-records.test.ts` fake dependency graph leaking through the default SharedMap arena into a later SharedSet copy test while `isolate:false` is configured. The included reproduction demonstrates the same clean/failing/reset behavior on the untouched baseline and combined runtime. The two timeout failures were not separately reproduced on baseline.

Attempt 2 used the unchanged tests and runtime with:

```sh
bun run test --isolate --testTimeout 15000
```

All 1,178 tests passed. Runtime files, test files, and Vitest config were not changed to recover. The seven successful build/typecheck commands from attempt 1 were reused; their logs and hashes remain in that attempt. Both complete attempts are retained, including the original failure.

## Inputs and provenance

- Baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.
- Heap commit: `b23a1d3efe088aae253223b2fd10a9d43b820091`.
- Compaction commit: `240f373e84a9c14df4c8d1566a8660a241838dc4`.
- Node: `v24.22.1`; Bun: `1.4.2`.
- The shared Arena change is byte-identical in both candidates. Only five runtime files and the two new regression suites were overlaid; the rejected map experiment is absent.
- Unchanged native sources and build script were compared byte-for-byte before reusing the baseline WASM. All 12 native artifact hashes are recorded.
- Every build/test/evidence command ran after both final performance studies completed, under `/tmp/zerocopy-perf-20261108.lock`. No combined timing study was run.

## Evidence files

`combined-validation.json` summarizes outcomes and exact source/build hashes. `combined-validation.log` includes both attempts and the baseline reproduction. The attempt directories retain every command's full log, argv, working directory, exit code, timestamps, and hashes. The final attempt also records the final proof-directory inventories and all historical/final timing evidence verification.

`reproduce-fixture-leak.mjs` accepts a source-checkout path:

```sh
bun reproduce-fixture-leak.mjs /path/to/untouched-baseline
bun reproduce-fixture-leak.mjs /path/to/combined-checkout
```

The Python scripts record the actual local orchestration. Their original absolute checkout paths remain in `inputs.json` and the manifests for provenance; use equivalent local paths when reproducing the recorded commands.
