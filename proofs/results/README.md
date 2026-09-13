# Recorded evidence

## Historical local benchmark

[local.json](local.json) contains the original metadata, source hashes, and all
14 summary rows. Its `roundFiles` field lists nine ordinary JSON files under
[local-rounds](local-rounds). Those files retain every original round, runtime
field, and timing sample. There are 1,890 measured timing samples in total.
No sample was dropped or rounded.

The file layout is split for review. Restore the exact original one-file JSON
record, or verify it without writing a file:

```sh
node proofs/restore-local-evidence.mjs
node proofs/restore-local-evidence.mjs /tmp/zerocopy-local-full.json
```

The optional output must not already exist. The script verifies the original
file's SHA-256, then recomputes every median and speed ratio from the raw samples.
CI runs this verification as a required step.

Original one-file SHA-256:

```
6a842f88ed6b7931f08304fcd993f44d09454f4ccfab56a0dbfdf3deb6f80f5f
```

## Source versions and new CI results

The historical engine digest is
`c408c5a71c9a3e8fb57fd4c010e197d8b4856201e72a677f36dbf6cb8508fba6`.
Commit `750467021e0844386e4fbdb3e2f6bf116da450d3` integrated that runtime and its
proof programs without changing the measured source.

Commit `724e35571cc72a60782b6751e135e7329e28cc4d` adds a browser compatibility
fix. Chromium rejected shared byte views in TextDecoder. The new `utf8.ts`
helper probes support once and copies only the requested decode range when
necessary. Collection nodes and shared snapshot payloads remain unchanged.
The current engine digest, including the helper, is
`f2f3c7eeae2a91a639b02bc7859944ad6bbe8a349c64d6550e6c933fc1115279`.
Do not attribute the historical timing table to this different source digest.

The full GitHub proof run for the browser fix passed, including Chromium and
matched-compiler benchmarks:
https://github.com/natanelia/zerocopy/actions/runs/34743983166

New runs publish `ci*.json` files in the `immutable-performance-evidence` Actions
artifact. They include current source hashes and raw measurements. Keep those
results separate from the historical local data. Consult the Actions run for the
specific commit under review, rather than a previous green run.

## Other recorded checks

`allocation.json` records the deterministic immutable-to-immutable allocation
comparison. `baseline-regressions.json` and `candidate-regressions.json` record
the same six counterexamples on both versions. `node-worker.json` records the
local real-worker proof. `local-verification.txt` is the historical local test
log. The full methodology and material limits are in [the report](../README.md).
