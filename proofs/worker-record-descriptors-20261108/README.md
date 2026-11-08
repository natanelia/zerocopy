# Shared-state record capture: measured Node and Bun improvements

The fixed confirmation found lower local creation and publication time for
1,024-field records on both Node 24.22.1 and Bun 1.4.2. All four large-record
cases improved in all six process pairs in each runtime, and their per-case
95% paired-ratio intervals exclude 1. Small-record results remain uncertain;
this report does not establish a universal speedup or the absence of regressions.

`recordOf` previously built a complete descriptor map and then entry-pair arrays
before constructing the final record. The candidate reads descriptors directly
into that final null-prototype record. It preserves the first symbol scan,
all descriptor-trap ordering, and later-error precedence by deferring accessor
rejection. The single-snapshot path is unchanged. Only `worker-protocol.ts`
changes at runtime; there is no new cache, dependency, API or binary format.

## Fixed confirmation: every case

Times below are **geometric means of six process medians**, in microseconds per
complete public operation. This makes the displayed before/after times consistent
with the geometric mean of paired after/before ratios. Each process median uses
nine measured batches. The original marginal medians and all individual samples
remain unchanged in the raw data and summary sidecars. Ratios below 1 are faster.

| Runtime | Workload | Before, µs/op | After, µs/op | After / before | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | Create/dispose, 1,024 distinct snapshots | 1586.135 | 1020.746 | 0.644 | 0.539–0.769 | 6/6 |
| Node | Publish change, 1,024 distinct snapshots | 1600.764 | 1105.659 | 0.691 | 0.605–0.789 | 6/6 |
| Node | Create/dispose, 1,024 aliases | 1519.355 | 974.361 | 0.641 | 0.581–0.708 | 6/6 |
| Node | No-op publish, 1,024 aliases | 1531.584 | 1214.546 | 0.793 | 0.645–0.975 | 6/6 |
| Node | Create/dispose, 32 distinct snapshots | 35.942 | 29.068 | 0.809 | 0.523–1.251 | 5/6 |
| Node | Publish change, one field | 3.917 | 3.085 | 0.787 | 0.582–1.066 | 4/6 |
| Node | Create/dispose, one-field record | 3.770 | 3.265 | 0.866 | 0.762–0.984 | 6/6 |
| Node | Create/dispose, single snapshot (unchanged path) | 2.567 | 2.641 | 1.029 | 0.865–1.223 | 3/6 |
| Bun | Create/dispose, 1,024 distinct snapshots | 714.265 | 530.260 | 0.742 | 0.678–0.812 | 6/6 |
| Bun | Publish change, 1,024 distinct snapshots | 897.304 | 827.635 | 0.922 | 0.866–0.982 | 6/6 |
| Bun | Create/dispose, 1,024 aliases | 644.339 | 523.525 | 0.812 | 0.717–0.920 | 6/6 |
| Bun | No-op publish, 1,024 aliases | 839.341 | 715.325 | 0.852 | 0.775–0.938 | 6/6 |
| Bun | Create/dispose, 32 distinct snapshots | 17.994 | 12.881 | 0.716 | 0.570–0.900 | 6/6 |
| Bun | Publish change, one field | 1.586 | 1.634 | 1.031 | 0.679–1.565 | 3/6 |
| Bun | Create/dispose, one-field record | 2.223 | 2.390 | 1.075 | 0.771–1.498 | 3/6 |
| Bun | Create/dispose, single snapshot (unchanged path) | 2.065 | 1.921 | 0.930 | 0.759–1.140 | 4/6 |

For distinct 1,024-field records, the paired reductions are **35.6% / 25.8%**
for creation/disposal in Node/Bun, and **30.9% / 7.8%** for publication. These are
local metadata-processing workloads, not worker-delivery, copy, network or whole
application latency measurements. No JavaScript-heap or RSS reduction was measured.

The slower point estimates remain relevant: Bun one-field publication estimates
3.1% more time, and one-field creation 7.5% more time; their intervals include both
improvement and substantial regression. Node's unchanged single-snapshot control
estimates 2.9% more time, also inconclusive. Node's 32-field creation and one-field
publication results are uncertain. Do not describe these controls as proven equal.

## Same-build controls

The separate four-pair A/A study uses the identical baseline build in both roles.
Its intervals include 1, but its point estimates show material process/host
variability. These results are never subtracted from the A/B measurements.

| Runtime | Workload | Before, µs/op | After, µs/op | After / before | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Node | Create/dispose, 1,024 distinct snapshots | 1418.667 | 1557.199 | 1.098 | 0.960–1.254 | 1/4 |
| Node | Create/dispose, single snapshot (unchanged path) | 2.754 | 2.380 | 0.864 | 0.699–1.069 | 4/4 |
| Bun | Create/dispose, 1,024 distinct snapshots | 696.399 | 741.607 | 1.065 | 0.845–1.342 | 1/4 |
| Bun | Create/dispose, single snapshot (unchanged path) | 2.129 | 1.814 | 0.852 | 0.687–1.057 | 3/4 |

## Workload and measurement method

Recorded on November 8, 2026. Confirmation ran from `2026-11-08T13:02:51.009Z`
to `2026-11-08T13:05:49.492Z` (UTC).

- Linux x64, AMD EPYC 9V74; Node 24.22.1 and Bun 1.4.2. Both runtimes import the
  portable builds from the same neutral module path. The runner records complete
  runtime versions, source/build hashes, actual CPU affinity and child timestamps.
- Each fixture contains immutable one-key number maps in one shared arena.
  Distinct cases use distinct snapshot roots; alias cases reuse one snapshot.
  Maps, source records, result arrays and publication setup are outside timing.
- Creation includes `createSharedState`, reading `current`, disposal and checking
  the closed flag. Changed publication alternates two prebuilt records differing
  in their final field; timing includes publication, reading `current`, and one
  real subscriber that records the value/version. No-op publication alternates
  two prebuilt wrappers containing identical handles. Options are `copy: false`
  and immediate publication. No worker is connected during these timings.
- Every output is retained and checked after each batch: field identity, key
  order, null prototype, freezing, versions, subscriber order, retained snapshot
  values and complete backing-memory bytes. Validation is outside timing.
- Confirmation uses **192 fresh processes / 1,728 measured batches**: six matched
  pairs for each of eight cases and two runtimes. One case runs in each child.
  A/B order alternates per case/runtime/pair; case and runtime order reverse on
  alternating pairs. Runs are serialized on CPU 2 under a shared lock.
- Each arm independently calibrates a power-of-two batch to at least 20 ms before
  warm-up. Warm-up then executes at least 500 ms of actual timed API work.
  Calibration is not a minimum measured-batch guarantee: confirmation used
  8–16,384 iterations per batch, 12–129 warm-up batches, 500.075–531.936 ms timed
  warm-up, and **2.771–54.342 ms** measured batches. Each arm's actual ranges are
  retained in the [verification log](validation/evidence-verification.txt).
- Ratios use matched process medians. Intervals are two-sided 95% Student-t
  intervals on paired log-ratios, with five degrees of freedom for confirmation
  and three for A/A. Batches are not treated as independent processes. These are
  per-case intervals, not simultaneous family-wise bounds. No performance
  threshold is asserted for CI or another machine/runtime.

## Preserved pilot and method change

The initial two-pair pilot ran all eight cases within each fresh process.
Its unchanged Bun single-snapshot control had pair ratios 0.993 and 0.345.
Large-allocation history or host variability could therefore affect unrelated
later cases. This pilot is exploratory and is not pooled with confirmation.

The [confirmation plan](CONFIRMATION-PLAN.md) fixed one case per fresh process,
balanced order, six pairs, longer warm-up and a separate four-pair A/A study.
**Production and workload bytes did not change.** The original runner and
workloads are preserved alongside all raw pilot data. Every pilot result follows:

| Runtime | Workload | Pilot after / before | Individual pair ratios |
| --- | --- | ---: | --- |
| Node | Create/dispose, 1,024 distinct snapshots | 0.583 | 0.366, 0.929 |
| Node | Publish change, 1,024 distinct snapshots | 0.765 | 0.656, 0.891 |
| Node | Create/dispose, 1,024 aliases | 0.684 | 0.571, 0.818 |
| Node | No-op publish, 1,024 aliases | 0.890 | 0.815, 0.973 |
| Node | Create/dispose, 32 distinct snapshots | 0.941 | 0.872, 1.016 |
| Node | Publish change, one field | 1.087 | 0.987, 1.197 |
| Node | Create/dispose, one-field record | 0.947 | 0.780, 1.149 |
| Node | Create/dispose, single snapshot (unchanged path) | 0.911 | 0.754, 1.101 |
| Bun | Create/dispose, 1,024 distinct snapshots | 0.342 | 0.303, 0.385 |
| Bun | Publish change, 1,024 distinct snapshots | 0.324 | 0.400, 0.263 |
| Bun | Create/dispose, 1,024 aliases | 0.256 | 0.304, 0.216 |
| Bun | No-op publish, 1,024 aliases | 0.275 | 0.313, 0.242 |
| Bun | Create/dispose, 32 distinct snapshots | 0.392 | 0.802, 0.192 |
| Bun | Publish change, one field | 0.443 | 0.855, 0.230 |
| Bun | Create/dispose, one-field record | 0.592 | 0.923, 0.381 |
| Bun | Create/dispose, single snapshot (unchanged path) | 0.586 | 0.993, 0.345 |

## Correctness and validation

The [seven new public-API regressions](../../worker-record-descriptors.test.ts)
cover null prototypes and special names, aliases, retained publications, symbol
rejection, deferred accessor errors, later proxy-trap errors, disappearing
descriptors, symbol-enumerability changes, numeric key order, single snapshots
and empty records. They pass on both the unchanged baseline and candidate under
Node and Bun. The focused worker checks pass; source and worker-consumer type
checks also pass.

The isolated full Bun suite passed **1,193 tests / 61 files** at the unchanged
5-second timeout. The preceding default shared-context run passed 1,192 tests
and timed out in the existing geometry snapshot/memory-growth test. Both logs
are preserved. Isolation passed; the exact cause of the default timeout was not
established, and no test or timeout was changed.

The existing [real Node worker-session proof](../worker-sessions.mjs) passes:
two real workers, all 12 types, nested values, shared backing, growth,
descriptor-only updates, retained snapshots, compaction and Toolkit publication.
The existing [main CI](../../.github/workflows/ci.yml) and
[worker-session CI](../../.github/workflows/worker-sessions.yml) also run the
default suite, built workers, package checks and Chromium validation for the PR.
Browser performance is not measured by this study.

| Evidence | Result |
| --- | --- |
| [Baseline Node parity](validation/baseline-node.txt.gz), [baseline Bun parity](validation/baseline-bun.txt.gz) | Seven new cases pass against unchanged code |
| [Focused Bun checks](validation/focused-bun.txt.gz) | 46 tests pass |
| [Workload smoke checks](validation/workload-smoke.txt) | All eight complete-output oracles pass |
| [Source types](validation/source-types.txt), [worker types](validation/worker-types.txt) | Successful commands emitted no output |
| [Default full Bun run](validation/full-bun-default.txt) | 1,192 pass; one geometry timeout retained |
| [Isolated full Bun run](validation/full-bun-isolated.txt.gz) | 1,193 pass |
| [Real Node workers](validation/real-node-workers.txt) | Pass |
| [Saved-data verification](validation/evidence-verification.txt) | 232 processes / 2,592 measured batches across all three studies |

## Source identity and saved data

Baseline: `0ac8a005268335a6116f025e75f670b5cee6843e`.
The fixed local implementation/harness commit was
`93fcd53609e8b290028fcbe2a00ac754908dce85`. Publication through GitHub may use
another commit identity with identical source bytes; reproduction uses the PR
checkout and source hashes, not the availability of that local commit.

| Component | SHA-256 |
| --- | --- |
| Baseline worker-protocol.ts | `21868d3b9b0d2479837b733f342a2980adbe2dadee0ea7692a27611be73085d2` |
| Candidate worker-protocol.ts | `c5941cc9ba08dfc84cb1771e51c7fddb8fed9204f7df407611e9210d102d7222` |
| Final runner | `0d786ccc6d3b70d81bc10c42eb679c99fcc6fde6dac2b5fac8b9a1a815c12623` |
| Unchanged workloads | `aecaf4add27b726bc9c59e6ce2d2da7cb315b80621f158eaeb460c61a0b181bb` |

The runner checks the baseline's tracked production, package and build-script
bytes against Git, requires `worker-protocol.ts` to be the only changed runtime
source, verifies unchanged WASM bytes, and checks every child's imported bundle
hashes. The raw archives embed both source texts, complete source/build identities,
process order, timestamps, calibration, warm-up, every measured sample and checksums.
Gzip compression is lossless; the verifier pins the original decompressed bytes.

| Record | Purpose |
| --- | --- |
| [Initial plan](PLAN.md), [confirmation plan](CONFIRMATION-PLAN.md) | Workloads and fixed confirmation method |
| [Pilot archive](pilot-v1.json.gz), [pilot summary](pilot-v1-summary.json) | Original eight-process screening, including anomalous controls |
| [Confirmation archive](formal-v2.json.gz), [confirmation summary](formal-v2-summary.json) | All 192 one-case processes and 1,728 batches |
| [A/A archive](aa-v2.json.gz), [A/A summary](aa-v2-summary.json) | All 32 same-build processes and 288 batches |
| [Original runner](pilot-runner-v1.mjs), [original workloads](pilot-workloads-v1.mjs) | Exact pilot harness bytes |
| [Final runner](benchmark.mjs), [workloads](workloads.mjs), [verifier](verify.mjs) | Reproduction and independent saved-data checks |

## Reproduce

Verify saved measurements without running a benchmark:

```sh
node proofs/worker-record-descriptors-20261108/verify.mjs
# Also check Git baseline files and the current measured implementation:
node proofs/worker-record-descriptors-20261108/verify.mjs --check-source
```

The optional source check requires the baseline Git history. It compares the
current runtime file to the measured source digest and checks the local
implementation commit if present. The default verifier remains usable after
future runtime changes; it verifies the archived sources and measured harnesses.

For a new study, create the baseline checkout and install/build the same pinned
dependencies in both checkouts. Run from the candidate checkout. The runner uses
Linux CPU-affinity reporting; choose an available single CPU and keep other
workloads quiet. CPU 2 was used for the recorded study. Use new output paths;
the runner refuses to overwrite existing recordings.

```sh
git worktree add --detach /tmp/zerocopy-record-before 0ac8a005268335a6116f025e75f670b5cee6843e
# In each checkout:
bun install
bun run build:wasm
bun run build:browser

# From the candidate checkout, after building both:
flock /tmp/zerocopy-performance.lock taskset -c 2 node proofs/worker-record-descriptors-20261108/benchmark.mjs --baseline=/tmp/zerocopy-record-before --candidate="$PWD" --bun="$(command -v bun)" --pairs=6 --warm=500 --output=/tmp/zerocopy-record-new-formal.json
flock /tmp/zerocopy-performance.lock taskset -c 2 node proofs/worker-record-descriptors-20261108/benchmark.mjs --baseline=/tmp/zerocopy-record-before --candidate=/tmp/zerocopy-record-before --bun="$(command -v bun)" --pairs=4 --warm=500 --cases=create-distinct-1024,create-single-snapshot --output=/tmp/zerocopy-record-new-aa.json
```

Correctness checks used the existing Vitest runner and built worker proof:

```sh
bun run typecheck
bunx tsc --noEmit -p tsconfig.worker.json
bun --bun node_modules/vitest/vitest.mjs run worker-record-descriptors.test.ts
bun --bun node_modules/vitest/vitest.mjs run --isolate
node proofs/worker-sessions.mjs
```
