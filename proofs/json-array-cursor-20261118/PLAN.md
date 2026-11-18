# JSON array cursor measurement protocol

Baseline: `1242908762b554e3574365c486d5a6c52d5e568f`.

Measured candidate: `75409acb6d9eab2b26b693c1d690568cd1cedb11`.

The final runs use the shared driver in `../performance-20261118/`. Its source and the actual built JavaScript are fingerprinted in each report. Both revisions use the repository's pinned Bun, Rust, and Binaryen tools. No dependency version or shared format changes.

## Fixed final runs

- `json-formal.json`: seven alternating baseline/candidate pairs in each of Node and Bun; eight untimed warmup passes per case; batch scale 2; every `json-array` case.
- `json-identical-control.json`: seven alternating pairs comparing the baseline to itself in each runtime; eight warmups; batch scale 4; reverse traversal and unrelated object-field reads. These controls investigate variation in the cases flagged by the exploratory runs. They do not correct, normalize, or replace any before/after sample.

The main cases read numeric JSON arrays of 1,024 and 4,096 elements in forward order, every fourth element, reverse order, a deterministic shuffled order, and one repeated index. An unrelated `JsonView.get('id')` case is retained as a control.

Every measured array traversal starts with a separately prepared view. Inputs, owner construction, attachment, view creation, warmup, garbage collection when available, and verification are outside the timer. Every returned number is captured in a preallocated output array and checked afterward. Additional checks verify materialization, array boundaries before sibling values, rewinding, old/new snapshots, arena allocation and byte preservation.

These are operation measurements in an already loaded runtime. They do not measure process startup, worker transport, or view-construction latency. The integrity copy can warm CPU caches. JavaScript heap usage and peak process memory are not measured. Browser correctness runs in CI; these local performance recordings cover Node and Bun only.

The driver launches each variant in a fresh process, alternates A/B and B/A, rotates case order by pair, retains every sample and refuses an existing output path. All timing runs are sequential on one host, with no concurrent project builds or tests. Medians of matched elapsed-time ratios and separate absolute medians are reported independently. No confidence interval or statistical-significance claim is inferred from seven pairs.

## Reproduce

Create clean worktrees at the two commits above. Install the pinned dependencies and run `bun run build:wasm && bun run build:browser` in each. From the candidate checkout:

```sh
node proofs/performance-20261118/benchmark.mjs \
  --baseline /absolute/baseline --candidate /absolute/candidate \
  --runtimes node,bun --group json-array --pairs 7 --warmups 8 \
  --batch-scale 2 --output /absolute/new-json-formal.json

node proofs/performance-20261118/benchmark.mjs \
  --baseline /absolute/baseline --candidate /absolute/baseline \
  --runtimes node,bun --group json-array --pairs 7 --warmups 8 \
  --only json-array.reverse.4096,json-array.fields.control \
  --batch-scale 4 --output /absolute/new-json-identical-control.json

node proofs/json-array-cursor-20261118/workers.mjs
```

Use `--bun /absolute/bun` or `--node /absolute/node` when testing a specific executable. The reports record the actual runtime versions and host CPU information. The worker proof checks correctness independently of the timed local attachment measurements.
