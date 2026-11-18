# Optional Float64 list import

This change adds `fromFloat64(input)` to the existing `zerocopy/numeric` entry.
It creates a numeric SharedList by copying typed numeric bytes into ordinary
vector leaves and linking them with the existing WASM kernel. Callers explicitly
choose the new API:

```js
import { fromFloat64 } from 'zerocopy/numeric';

const list = fromFloat64(new Float64Array([1.25, -0, 3.5]));
```

The existing SharedList class and all WASM binaries are unchanged. All five
JavaScript modules reachable from `dist/shared.js` have exactly the same relative
paths and bytes in the two measured builds. Ordinary Map/List imports do not
load the new factory. The existing numeric readers share its optional entry and
are measured as regression controls.

## Implementation and contract

The factory validates genuine Float64Array views through intrinsic operations,
takes a private fixed snapshot before acquiring the writer or invoking storage
hooks, copies into fresh arena bytes, and returns a frozen ordinary numeric list.
It preserves every stored bit, including signed zero and NaN payloads. It supports
subviews, genuine subclasses and cross-realm views. It rejects the wrong element
type, ordinary arrays, proxy wrappers, detached views and out-of-bounds resized
views. Imported lists work with ordinary edits, compaction and worker transport.
The [public documentation](../../docs/numeric.md#import-a-float64array) gives the
complete contract.

One private buffer of at most one MiB is reused for inputs up to 131,072 elements
when it is free. Calls above the limit, and calls that reenter while the reusable
buffer is borrowed, get separate temporary snapshots. A small call nested inside
a large uncached import can use the free reusable buffer safely.
The buffer remains borrowed until all writes and tree linking finish; `finally`
releases it after success or failure. Published lists never alias this scratch
storage or the input. Shared inputs require synchronization by the caller when a
coherent atomic snapshot of concurrent writes is needed.

Allocation and view hooks remain active. The input snapshot protects against a
hook mutating, resizing or detaching the input, even when that hook was installed
before the optional module was imported. Custom numeric encoders do not transform
this explicitly raw input. The early hard allocation limit avoids making a
temporary snapshot that the allocator is guaranteed to reject.

## Measured scope and decision

The useful confirmed target is bulk numeric import, with the input history and
runtime kept explicit. In the mixed-history 65,536-value case, the paired elapsed
time fell by **77.1% on Node and 19.2% on Bun**. Shared input and subviews of that
size also improved on both runtimes. All six pairs favored the candidate for the
ordinary and shared 65,536-value cases.

These are the material limits:

- **Typed-only history gives a smaller result.** At 65,536 values, Node's ratio
  was 0.813 with a 95% interval of 0.651–1.015: a useful estimate, but an unresolved
  change. Bun's ratio was 0.901 with an interval of 0.813–0.999, narrowly below 1.
  Neither runtime had a resolved improvement for the typed-only 4,096-value case.
- **32-value imports are slower:** paired ratios 2.267 on Node and 2.354 on Bun.
  Keep using the old operation when this fixed overhead matters for tiny inputs.
- **One million values trade Node speed for Bun time:** Node's ratio was 0.312,
  while Bun's was **1.130 (1.028–1.243)**, slower in all six pairs. Inputs above
  the one-MiB scratch limit allocate an uncached private snapshot on every call.
  The existing `pushMany` path remains available for large Bun imports.
- **Existing numeric controls are unresolved.** Range-count ratios were
  0.977 (0.637–1.498) on Node and 0.935 (0.817–1.069) on Bun; box-count ratios were
  1.032 (0.915–1.164) and 1.065 (0.898–1.262). These intervals do not establish
  absence of regression. Both complete control rows and the same-code ordinary
  controls remain below. No A/A result is used to adjust them.

The PR exposes an optional choice and documents the measured tradeoffs. It does
not replace existing List operations or claim a speedup for every numeric buffer.
These measurements apply only to this frozen optional-entry implementation.

### Complete confirmation results

Times are microseconds per complete operation and are medians of the process
estimates. Ratios are geometric means of paired after/before estimates, so they
need not equal the ratio of the two displayed medians. Lower ratios are faster.
Each row has six pairs and an unadjusted 95% interval. The scalar control's
operation contains **256 pushes**; numeric controls each perform one full scan.

The unmarked typed import cases use mixed ordinary-array/typed-array setup
history. The `float64-only-*` rows use typed-only history. Input creation and
conversion are not timed in either variant.

#### New import API

| Runtime | Case | Before (µs) | After (µs) | Paired ratio | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| node | `float64-32` | 0.708 | 1.454 | 2.267 | 2.039–2.521 | 0/6 |
| node | `float64-4096` | 66.772 | 16.964 | 0.240 | 0.201–0.287 | 6/6 |
| node | `float64-65536` | 918.987 | 210.706 | 0.229 | 0.193–0.271 | 6/6 |
| node | `float64-1048576` | 14406.195 | 4918.203 | 0.312 | 0.239–0.407 | 6/6 |
| node | `float64-subview-65536` | 951.980 | 210.451 | 0.211 | 0.174–0.256 | 6/6 |
| node | `float64-shared-65536` | 992.059 | 193.150 | 0.188 | 0.155–0.229 | 6/6 |
| node | `float64-only-4096` | 19.216 | 19.515 | 0.992 | 0.872–1.129 | 4/6 |
| node | `float64-only-65536` | 277.961 | 221.438 | 0.813 | 0.651–1.015 | 5/6 |
| bun | `float64-32` | 0.858 | 2.224 | 2.354 | 1.966–2.818 | 0/6 |
| bun | `float64-4096` | 50.941 | 51.600 | 0.970 | 0.838–1.123 | 3/6 |
| bun | `float64-65536` | 381.632 | 301.182 | 0.808 | 0.717–0.911 | 6/6 |
| bun | `float64-1048576` | 4323.127 | 4858.459 | 1.130 | 1.028–1.243 | 0/6 |
| bun | `float64-subview-65536` | 405.188 | 322.595 | 0.789 | 0.642–0.970 | 5/6 |
| bun | `float64-shared-65536` | 380.750 | 302.739 | 0.784 | 0.696–0.883 | 6/6 |
| bun | `float64-only-4096` | 54.866 | 50.828 | 0.950 | 0.839–1.075 | 4/6 |
| bun | `float64-only-65536` | 333.214 | 291.657 | 0.901 | 0.813–0.999 | 5/6 |

#### Existing operations

| Runtime | Case | Before (µs) | After (µs) | Paired ratio | 95% interval | Faster pairs |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| node | `array-build-control-32` | 0.486 | 0.445 | 0.920 | 0.704–1.203 | 3/6 |
| node | `scalar-append-control-2048` | 28.750 | 23.890 | 0.947 | 0.648–1.383 | 3/6 |
| node | `numeric-range-control-65569` | 30.947 | 28.511 | 0.977 | 0.637–1.498 | 4/6 |
| node | `numeric-box-control-65538` | 58.185 | 60.121 | 1.032 | 0.915–1.164 | 2/6 |
| bun | `array-build-control-32` | 0.620 | 0.563 | 0.922 | 0.826–1.028 | 5/6 |
| bun | `scalar-append-control-2048` | 20.399 | 16.340 | 0.946 | 0.759–1.180 | 4/6 |
| bun | `numeric-range-control-65569` | 30.625 | 28.593 | 0.935 | 0.817–1.069 | 4/6 |
| bun | `numeric-box-control-65538` | 65.504 | 64.729 | 1.065 | 0.898–1.262 | 3/6 |

### Completed evidence

| Phase | Fresh processes | Measured batches | Warmup batches | Verified outputs | Measured batches below 2 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| pilot | 72 | 648 | 2,977 | 12,183,552 | 0 |
| confirmation | 288 | 2,592 | 10,547 | 38,534,504 | 0 |
| aa | 96 | 864 | 4,229 | 15,744,064 | 0 |
| **Total** | **456** | **4,104** | **17,753** | **66,462,120** | **0** |

Verified-output counts cover warmup and measured batches; the two additional
untimed probe operations per process and separate worker checks are not included.
The [complete pilot and A/A tables](PILOT-AND-REPEATABILITY.md) preserve every row.
All phases use the same frozen code and workload. A/A's wide intervals are not an
adjustment to the confirmation estimates. The archived records passed
[source-bound independent verification](validation/archived-evidence-audit.txt).


## Method

The baseline is `0ac8a005268335a6116f025e75f670b5cee6843e`. Before calls
`new SharedList('number').pushMany(input)` with the actual Float64Array; after
calls `fromFloat64(input)`. The old JavaScript runtime already accepts this input
despite its narrower TypeScript signature. Neither timed path creates an ordinary
array. Input creation, setup and independent expected results are outside timing.
The complete public operation, allocation/growth, copying, handle creation and
retention are timed. All outputs stay reachable until batch verification ends.
There is no forced GC or GC subtraction.

The [plan fixed before timing](PRE-BENCHMARK.md) and [workload](workloads.mjs)
declare 12 cases and fixed repetition counts. Most import cases construct a small
ordinary-array sentinel through old `pushMany` outside each batch. Two additional
cases use only typed inputs for that setup in both builds. These encoding histories
must remain separate: the baseline's speed depends materially on input history.
Their difference does not diagnose a particular JIT mechanism.

The root-only ordinary-array and scalar-push controls never import `numeric.js`;
their complete loaded code is identical across labels. The existing `countInRange`
and `countPointsInBox` controls import the changed optional entry in both builds.
They reuse one ordinary-array source and prime their lazy kernel with an untimed
call. Their independent JavaScript oracles include NaN, infinities, signed zero and
inclusive-boundary values. The readers must not allocate in the source arena.

Node 24.22.1 and Bun 1.4.2 run serially on CPU 2 under a common lock, with no builds
or test suites overlapping. Every runtime/case/build/pair gets a fresh process.
Both builds use the same neutral import path. AB/BA alternates by pair and case
and runtime order reverse on alternate pairs. Each process warms for at least
500 ms of actual timed work and eight batches, then records nine measured batches.
Short batches remain included and are counted explicitly.

The process estimate is the median batch time divided by repetitions. The paired
ratio is the geometric mean of after/before process estimates. Confirmation uses
six pairs; A/A uses four. The intervals are unadjusted 95% Student-t intervals on
paired log ratios. The process pair is the statistical unit. Pilot results have
two pairs and remain exploratory. No samples are dropped or pooled between
phases. A/A is not subtracted or used to cancel an adverse A/B result.

These are warmed repeated-operation measurements on the recorded little-endian
host. The scratch buffer can be reused after warmup. There are no cold-start,
browser timing, peak-memory or other-architecture measurements in this study.
Both runtimes execute the portable JavaScript distribution build. The installed
Bun source entry is covered by package correctness checks, not separately timed.

## Output checks and build identity

For every imported result, the workload checks its frozen numeric handle, size,
depth, actual owner through the public worker packet, every encoded input byte,
every tree pointer and every unused branch slot. It also fully materializes the
first result of each batch. Every scalar-control output value is checked, and
every numeric count is compared with an independent complete predicate scan.
Complete input bytes, subview margins, source values and all previously published
source bytes remain unchanged after each batch.

Each raw record stores all warmup and measured times, verified-output counts,
source snapshots and hashes, every bundle and WASM hash, runtime versions, CPU
affinity, fixture digests and exact process order. The driver checks those code
identities again at the end. The [independent auditor](audit-evidence.mjs) checks
the complete schedule, recomputes statistics and binds the shared-module graph and
actual Node-worker proof to the measured build. Historical graph bytes are saved
so the audit does not depend on reproducing a historical bundler's output.
Measurements preceded the implementation commit: `source.after.commit` records
the checkout parent, while the complete changed-source snapshots and hashes bind
the measured candidate. The source is also pinned in
[pre-benchmark-identities.json](pre-benchmark-identities.json).

## Correctness validation

The frozen candidate passed:

- **1,221 Bun tests across 62 files**, using the unchanged repository worker
  configuration: [full suite](validation/full-bun-configured-scratch-final.txt).
- **171 focused Node tests across eight files**, covering the new factory,
  existing List behavior, numeric readers, allocation failure and immutability:
  [focused suite](validation/focused-node-scratch-final.txt).
- **14 independent contract cases on each runtime**, including raw bits through
  nested calls, memory growth, a self-removing custom view getter, allocation
  failure and partial-write recovery: [Node](validation/contract-scratch-node.txt)
  and [Bun](validation/contract-scratch-bun.txt).
- **Three fresh-process late-import scenarios per runtime**, installing allocator
  mutation, allocator detachment or view hooks before importing the optional
  module: [Node](validation/late-import-contract-node.json) and
  [Bun](validation/late-import-contract-bun.json).
- Declarations, every TypeScript project, both optional-property modes for
  numeric/typed-value public APIs, installed-package Node/Bun/worker/type smoke,
  and executable documentation examples. Final logs use the `scratch-final`
  suffix in `validation`.
- Untimed checks of **all 12 complete benchmark oracles in both builds and
  runtimes**: [Node](validation/workloads-node-final.json) and
  [Bun](validation/workloads-bun-final.json).
- Actual shared and copied **Node worker** checks with retained readers during
  owner growth: [worker result](node-worker-result.json). Every value, raw special
  number bit, old snapshot and published byte is checked, including subsequent
  ordinary edits and read-only guards.

An earlier full run with a two-worker override stalled after an existing geometry
test and a worker-termination timeout. Both affected files then passed on baseline
and candidate with identical flags; the single subsequent full run using the
repository's configured four workers passed. The cause was not established and
the failure remains in [FULL-SUITE-NOTE.md](validation/FULL-SUITE-NOTE.md). No test
timeout or assertion was weakened. Earlier implementation checks and the caught
late-import bug are distinguished in [PRE-FIX.md](validation/PRE-FIX.md); they are
not presented as validation of the measured source.

The [workflow](../../.github/workflows/list-float64-numeric.yml) checks public
types, runs Node/Bun regressions and fresh-process late-import cases, audits saved
measurements without retiming, and exercises actual shared/copied Node and
Chromium workers while the owner grows its memory. Worker results identify their
source and bundles and are correctness evidence, not performance measurements.
Hosted browser outcomes are recorded with the PR; a local browser launch
restriction is not counted as a pass.

## Audit and reproduce

Audit the archived measurements without collecting replacement samples:

```sh
node proofs/list-float64-numeric-20261108/verify.mjs
```

`results/manifest.json` binds the compressed and decompressed bytes of all three
records. Setting `CHECK_CONFIRMED_SOURCE=1` additionally requires the current
runtime source to match the recorded candidate. The PR's own CI enables that
check; future unrelated changes can continue auditing historical evidence.

To collect new measurements, prepare a clean checkout at the declared baseline
and a candidate checkout with identical dependencies. Build WASM and portable
bundles in both. Choose an available CPU, keep competing work out of the
measurement window, and use new output paths:

```sh
PROOF_DIR="$PWD/proofs/list-float64-numeric-20261108"
BEFORE_DIR="/absolute/path/to/baseline-checkout"
AFTER_DIR="$PWD"
BUN_BIN="$(command -v bun)"

taskset -c 2 node "$PROOF_DIR/paired-benchmark.mjs" \
  "$PROOF_DIR/workloads.mjs" "$BEFORE_DIR" "$AFTER_DIR" \
  "$BUN_BIN" /tmp/list-float64-local-confirmation.json formal

taskset -c 2 node "$PROOF_DIR/paired-benchmark.mjs" \
  "$PROOF_DIR/workloads.mjs" "$BEFORE_DIR" "$AFTER_DIR" \
  "$BUN_BIN" /tmp/list-float64-local-aa.json aa
```

The driver takes the common lock itself and refuses to overwrite a record. New
measurements remain separate evidence. Run correctness checks independently:

```sh
node node_modules/vitest/vitest.mjs run shared-list-float64*.test.ts \
  shared-list.test.ts shared-list-to-array.test.ts allocation-failure.test.ts \
  immutable-proof.test.ts numeric*.test.ts --maxWorkers=2

node proofs/list-float64-numeric-20261108/late-import-contract.mjs
bun proofs/list-float64-numeric-20261108/late-import-contract.mjs
node proofs/list-float64-numeric-20261108/node-worker.mjs
bunx playwright install --with-deps chromium
node proofs/list-float64-numeric-20261108/browser-check.mjs
```
