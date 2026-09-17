# Recorded evidence

[Benchmark reports](../README.md) · [Library comparisons](../../README.md#performance)

## Result sets

| Record | Purpose |
| --- | --- |
| [map-set-index-summary.json](map-set-index-summary.json) | September 14 scalar-write medians, paired index results, memory, and checksums |
| [map-memory](map-memory) | Compact-memory timing and raw memory measurements |
| [hot-path](hot-path), [cold-build](cold-build) | Recorded initialized-arena, first-use, read, and memory workloads |
| [readme-ci-summary.json](readme-ci-summary.json) | September 13 revision-to-revision results |
| [local.json](local.json), [local-rounds](local-rounds) | Initial local persistent-engine experiment |

Each record describes its own source, driver, runtime, and workload. Do not combine medians from different source versions or replace an unfavorable case with a different access pattern.

## Historical local benchmark

`local.json` contains the original metadata, hashes, and all 14 summary rows. Its `roundFiles` field lists nine JSON files under `local-rounds/`. They retain every round, runtime field, and timing sample: 1,890 measured samples in total, with no dropped or rounded values.

Restore the exact original one-file record, or verify it without writing a file:

```sh
node proofs/restore-local-evidence.mjs
node proofs/restore-local-evidence.mjs /tmp/zerocopy-local-full.json
```

The optional output must not exist already. The script verifies the original SHA-256 and recomputes medians and speed ratios from the raw samples.

Original one-file SHA-256:

```text
6a842f88ed6b7931f08304fcd993f44d09454f4ccfab56a0dbfdf3deb6f80f5f
```

## Source versions and CI results

The historical engine digest is `c408c5a71c9a3e8fb57fd4c010e197d8b4856201e72a677f36dbf6cb8508fba6`. Commit `750467021e0844386e4fbdb3e2f6bf116da450d3` integrated that runtime and the proof programs without changing the measured source.

Commit `724e35571cc72a60782b6751e135e7329e28cc4d` added the browser compatibility fix. Chromium rejected shared byte views in `TextDecoder`; `utf8.ts` probes support and copies only the requested decode range when needed. Collection nodes and shared snapshot payloads were unchanged. The browser-fix engine digest was `f2f3c7eeae2a91a639b02bc7859944ad6bbe8a349c64d6550e6c933fc1115279`, not the historical timing digest and not an identifier for every later revision.

The [browser-fix proof run](https://github.com/natanelia/zerocopy/actions/runs/34743983166) passed Chromium checks and matched-compiler benchmarks. Its unit suite recorded 280 tests in 13 files. The Node proof covered all 12 types and nested values, including 10,000 retained reads during writer updates and memory growth. These counts belong to that run, not the current test suite.

New proof runs publish `ci*.json` records in the `immutable-performance-evidence` Actions artifact with their own hashes and raw measurements. Check the run for the source under review rather than treating an older successful run as current verification.

## Artifact retention

The [September 14 archive](https://github.com/natanelia/zerocopy/actions/runs/34801792862/artifacts/10330799515) contains 1,800 paired scalar-write samples, 4,005 original-table samples, 1,080 first-use samples, 540 extra-read samples, 108 isolated memory measurements, and test logs. Its recorded retention end is December 13, 2026.

The [September 13 revision archive](https://github.com/natanelia/zerocopy/actions/runs/34764774485/artifacts/10319983686) contains that revision's raw timings, worker results, and allocation records. Its recorded retention end is October 13, 2026. Committed summaries remain after artifact expiry; they are not substitutes for the full raw archives.

## Other checks

[allocation.json](allocation.json) records the immutable-to-immutable allocation comparison. [baseline-regressions.json](baseline-regressions.json) and [candidate-regressions.json](candidate-regressions.json) record the same six counterexamples on both engines. [node-worker.json](node-worker.json) records the local real-worker check. [local-verification.txt](local-verification.txt) is the historical local test log.

Keep new runs in new files. Do not edit old samples to match a new implementation. Methods, exclusions, and limits are in the [reports](../README.md).
