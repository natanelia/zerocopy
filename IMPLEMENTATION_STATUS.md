# Candidate integration status

The full v0.2 runtime, all collection wrappers, build scripts, tests, report, and
raw benchmark evidence are integrated on this branch. The earlier upload failure
is resolved. This is no longer an unused WASM core or a baseline-only test branch.

This remains a draft for design review. Several writes regress, and the binary
layout, worker protocol, and memory lifetime change. No merge or npm release has
been performed.

## Source and verification

Commit `750467021e0844386e4fbdb3e2f6bf116da450d3` reproduces the historical local
candidate's runtime and proof code. Commit `724e35571cc72a60782b6751e135e7329e28cc4d`
adds a shared UTF-8 decoding fix found by the real Chromium tests. The full proof
workflow then passed, including unit tests, real Node and browser workers,
allocation checks, snapshot counterexamples, and matched-compiler benchmarks.

Verified engine run:
https://github.com/natanelia/zerocopy/actions/runs/34743983166

The unit suite has 280 tests in 13 files. The Node proof checks all 12 public types
and nested values, including 10,000 retained reads during writer updates and
memory growth. The historical raw data is split into nine reviewable JSON rounds;
`node proofs/restore-local-evidence.mjs` restores and checks the exact original
record and all summary calculations. CI also runs that check.

Historical timings and new CI measurements have different source identifiers.
See [the results guide](proofs/results/README.md) for the exact hashes and format.
Check the Actions run for the current PR commit before treating its checks as
passed. The runtime after the browser fix is unchanged by the evidence upload.

## Review limits

Public collection values are immutable through supported APIs. Internal caches,
allocation, and unpublished construction remain mutable. Raw shared memory is
not a read-only security boundary. There is one allocating writer per arena and
read-only worker attachment. Arenas are append-only with a limit below 2 GiB and
no per-node reclamation. Any retained snapshot pins its arena. Reset creates a
new lifetime; dispose and auto-GC configuration are deprecated no-ops. Bun uses a
used-prefix copy by default, so that fallback is not zero-copy.

See [the proof report](proofs/README.md) for all measured improvements and
regressions, reproducible checks, the invariant argument, and migration details.
