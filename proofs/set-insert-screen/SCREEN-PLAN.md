# Prospective set-insert screen

Fixed prospective method, 2026-10-14, with one explicit prospective protocol
amendment increasing the whole-screen budget from 300 to 420 seconds. Both the
initial local and gate-corrected hosted attempts stopped after baseline-only
feasibility, with zero candidate or paired timing measurements. See README.md for
both preserved outcomes and this new hosted cohort. Correctness and
the validation-only smoke must pass before the hosted screen. This exploratory
screen establishes neither portability nor merge clearance. No earlier timing
samples or calibrated counts enter the hosted cohort.

## Bind the things actually executed

- Baseline: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.
- Candidate: `candidate.patch` and the exact four runtime files plus one test
  bound by `candidate-files.json`. No source change is permitted after sealing.
- Both arms must have new ordinary WASM and portable builds made with identical
  pinned toolchain/commands, or independently authenticated identical baseline
  artifacts. Each rebuilt output requires its own exact-source receipt.
  Filenames, a source-only seal, or one successful candidate build cannot establish
  baseline/candidate build provenance. Keep build logs and exact-source receipts.
- Execute explicit retained `dist/shared.js` URLs in both engines, including all
  relative chunks; Bun's source/package-export path is outside this screen. Hash
  every retained emitted file, the original WASM, all transitive runtime sources,
  relevant build scripts/configuration, lockfile, draft/final harness, and raw
  output. Check inventories before and after. Reject symlinks/escaping paths.
- Node 22.16.0 executable SHA-256:
  `8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d`.
  Bun 1.4.2 executable SHA-256:
  `a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c`.
  Use the hosted runtime paths bound by the generated provenance file.
  Check binary hashes and actual reported versions; record CPU, OS, memory,
  affinity if set, and runtime flags. Clear `NODE_OPTIONS`/`BUN_OPTIONS`.

## Fixed cells: 18 per engine

| Group | Cells | Work per fresh batch | Role |
| --- | ---: | --- | --- |
| Unique Set insertion | 6 | 64 and 8,192 adds, each numeric/ASCII/Unicode | Targets; each also a regression guard |
| Cached current-root duplicates | 3 | 512 keys, 32 passes, all three key families | Important cheap-hit guards |
| Cold current-root duplicates | 2 | 512 keys, one pass, numeric and Unicode | No-allocation/search guards |
| Cold historical-root duplicates | 2 | 512 keys, one pass, ASCII and Unicode | Old-root descent guards |
| Cached historical-root duplicates | 2 | 512 keys, 32 passes, ASCII and Unicode | ReadCache guards |
| Ordinary Map construction | 2 | 8,192 scalar sets: ASCII/number and Unicode/string | Unchanged native-writer controls |
| Cold startup | 1 | Import, first Map write, first Set add | Code-generation/import/first-use control |

Numeric values are integers; ASCII values are `k` plus four base-36 digits.
Unicode values are `café-東京-🚀|` repeated eight times plus four base-36 digits
(148 UTF-8 bytes before the Set's `s:` prefix). Visit index `(i*4051)&(N-1)`.
The Set prefixes are `n:`/`s:` exactly. Inputs/oracles are generated outside timing.
Record fixture SHA-256, encoded bytes, key lengths, and full-hash collision counts.
Do not search for favorable fixtures. Full hash collisions, if any, remain visible.
The large Unicode build crosses the existing 131,072-character membership budget;
the 512-key duplicate fixtures fit both existing cache budgets.

Every batch gets a fresh writable arena via public `resetMap`; construction/reset
and validation are outside the operation timer. An insert timer includes only the
scalar immutable update loop, its ordinary allocations, and loop assignments.
Duplicate timing includes the add loop and a cheap identity-failure tally. No
encoding, cache guard, or native call is replaced. There is no forced GC, memory
rewind, instrumentation of production functions, or candidate-only warmup.
Set a 64 MiB per-arena maximum; this is an arena ceiling, not a JS heap/RSS bound.
Retain only current batch roots. Record RSS/high-water RSS as diagnostics, with no
memory-benefit claim. Ordinary GC and memory growth inside the timer are included.

Duplicate setup uses `new SharedMap('number').setMany` of encoded keys with zero
values, then wraps that exact map in `SharedSet`. Bulk construction does not prime
membership/read caches. Current-cold fixtures have no membership lookups before
timing. For historical fixtures, create a distinct later root with ordinary
`map.set('s:__screen_advanced__',17)` and retain the old Set. Cached variants prime
every target through public `has` before timing. Cold batches use each key once;
every subsequent batch uses a fresh arena/root, so repeated cold measurements do
not quietly become warm. No cache field is cleared or rewritten.

Outside the timer, read the existing arena fields through the backing map to
assert the declared cache state: no `valueMap`/ReadCache on current-cold fixtures;
an advanced `valueRoot` and no ReadCache on historical-cold fixtures; every exact
key/root present for warm fixtures. These are read-only fixture audits, not added
runtime exports or modified builds. Abort if the emitted field surface differs.
Hash published bytes `[65536,used)` before/after every duplicate batch, require
unchanged used bytes/root/identity/size, and verify content. Scratch is excluded
because native duplicates may validly write scratch word zero. Keep Map contents
and target contents checked against independent fixture digests outside timing.

Startup uses a separate fresh process, no warmup: record import time, then first
Map construction/write, then first Set construction/add, their total, and parent
launch-to-clean-exit wall time. Both arms use that fixed order. OS caches are not
flushed; label this process-cold startup, not cold-disk startup. Also record WASM
and complete portable-output sizes. No repeated import in one process counts as
an independent startup sample.

## Calibration, order, and budget

Complete baseline-only calibration for both engines before any candidate timing.
Each non-startup cell has one fresh calibration process: eight warm batches then
eight pilot batches. Let `m` be mean pilot operation milliseconds. Freeze warm
count `clamp(ceil(50/m),8,cap)` and measurement count
`clamp(ceil(75/m),4,cap)`, with caps 2,048 for small inserts/cold duplicates,
512 for cached duplicates, and 64 for large inserts/Map builds. Both arms use the
same engine/cell counts. Store pilot batch operation and whole-batch wall costs,
including setup, checksums, and output overhead. Startup has one baseline pilot
only and always one observation per measured process.

Project all six pairs from measured whole-process fixed costs plus selected
batch counts times pilot whole-batch costs. Require elapsed calibration plus
1.25 times projected remaining work <= 420 seconds before releasing measurements.
Hard whole-screen cap: 420 seconds, including calibration; hard child cap: 10
seconds. A projection failure stops baseline-only, with no smaller fixtures,
selective cell removal, shorter warmup, or candidate-informed recalibration.
The prospective 420-second cap provides headroom over the prior hosted
302.1-second baseline projection for the complete fixed design. Both earlier
feasibility failures remain valid under their original budgets. No automatic
retry or second cap increase is permitted if this cohort still fails feasibility.

Six independent paired processes per engine/cell; every arm is a fresh process
with one cell only. Pair indices 0..5 alternate AB/BA, giving three of each.
Rotate the 18-cell order by `5*pair mod 18`. Alternate the engine visited first
by pair; run the two arms of a cell consecutively. A and B are exact baseline and
candidate. Run sequentially in an exclusive local timing slot; pause unrelated
builds/tests. No competing benchmark, simultaneous arm, replacement sample,
outlier deletion, favorable rerun, or source-tuning loop. Failed slots remain in
the raw record. An invariant/binding failure stops immediately; a wall-time or
process failure is incomplete evidence, never a passing screen.

## Readout and predeclared decisions

Save raw warm/pilot/measured batch nanoseconds or high-resolution milliseconds,
operation counts, checksums, used/backing bytes, cache-state audit, process wall
time, exit status/stderr, and order. Hash raw files. A process score is total timed
batch milliseconds / total operations. Batches within a process are not independent
repeats. Each pair ratio is candidate/baseline score; report all six, absolute arm
medians/ranges, and exp(mean(log(pair ratios))). Do not pool engines, cells, older
runs, pilot data, or warmup into this estimate.

Compare measured fresh-batch arena bytes explicitly: before/after used bytes,
their allocated-byte difference, and backing bytes. Report each arm's full range.
Any deterministic candidate increase is an adverse memory tradeoff that blocks
promotion pending explanation, regardless of timing gains. Unexpected varying
allocation is unresolved. This uses existing batch observations, adds no memory
benchmark, and establishes no RSS/JS-heap benefit.

Use 10,000 paired bootstrap resamples of the six log ratios, xorshift32 seed
`0x5e7add14` with shifts 13/17/5, reset per endpoint. Report sorted bootstrap
ratios at indices 249 and 9749 as a descriptive 95% interval. Bootstrap the paired
absolute deltas the same way for startup. These intervals are exploratory,
not a multiple-comparison-adjusted or host-independent guarantee.

- Resolution: sub-2% timing differences are not a speed finding. A hot cell is
  unresolved if any measured arm aggregates <25 ms, hits a count cap without
  reaching the target duration, has a failed/missing pair, or has log-ratio sample
  SD > log(1.10) or max/min pair ratio >1.25. Also flag warmup instability if the
  median operation cost in the last half differs >20% from the preceding half;
  do not fix that by extending only one arm. Startup has no warmup or aggregate
  batching. A startup endpoint is short if any arm observation is below 1 ms;
  the same missing-pair/variability checks apply. Short cold observations remain
  unresolved instead of receiving an absolute-cost waiver.
- Useful target evidence: the same predeclared large ASCII or large Unicode
  target has ratio interval upper <=0.90 in both engines, with no unresolved
  issue. Report which scoped workload benefited. Numeric and small cases remain
  visible. This earns further validation only, not a general speed claim.
- Material hot-path regression: any target, duplicate, or Map control has ratio
  interval lower >1.02. That blocks promotion of this source revision, even when
  another target wins. Any adverse point estimate (>1.00) without that supported
  regression is unresolved. The 2% guard is an exclusion margin, not a claim
  that a small point estimate is a stable effect.
- Startup uses the same 2% guard for import, import-through-first-use, and parent
  launch-to-exit: interval lower >1.02 blocks promotion. There is no percentage or
  absolute-cost exemption. Adverse points, short observations, and noisy intervals
  remain unresolved. Component first-write timings are diagnostics because single
  sub-millisecond operations cannot reliably satisfy a ratio guard.
- A clean exploratory screen additionally requires every hot guard upper <=1.02,
  non-adverse point estimate, and no short/noisy/unstable/missing issue.
  Each startup guard also requires ratio upper <=1.02, non-adverse point estimate,
  and no short/missing-pair/variability issue. Otherwise report
  specific unresolved guards. No target gain can cancel a guard failure. Even a
  clean screen carries no general no-regression claim or merge clearance.

If both predeclared large targets have lower ratio >0.90 in either engine, this
screen has ruled out the stipulated cross-engine 10% lead for those workloads;
stop this optimization lead. Other outcomes can be inconclusive. No automatic
follow-on matrix, tuning, or rerun is part of this release. Source correctness,
broader platforms, allocation failure, full package tests, emitted-code review,
and later deployment/merge decisions remain separate.

## Implementation boundary

`draft-workload.mjs` is inert on import and supplies fixture generation, read-only
cache audits, timers, and invariant digests. The source-pinned controller and CLI
implement the stated release binding, fresh processes, calibration, order, caps,
raw custody, and readout. The hosted wrapper changes source/build/runtime binding
only. The workload and subject CLI remain byte-identical to the reviewed local
packet. The controller changes only its whole-screen cap and matching projection
limit/message from 300 to 420 seconds. No earlier proof helper, sample, or
calibrated count is imported.
