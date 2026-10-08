# Ordered-map history scan diagnostic

This candidate is based on main `3773c6e519c7c0958da13727ed1082f449f3ee25`.
Only `shared-ordered-map.ts` changes production behavior. It does not include
prior ordered-map projection changes or any other optimization.

## Work and storage model

Let H be the number of insertions retained in the insertion log and L the live
map size. Replacing an existing value keeps its ordinal; deleting and reinserting
adds an ordinal. Deleting the last item resets the log.

The existing iterator stores H leaf pointers, then revisits the current HAMT for
every logged insertion to discard tombstones and obsolete insertion identities.
The new branch collects the L live HAMT leaves and sorts their immutable numeric
ordinals before decoding. It still uses the existing leaf key/value decoders.
This removes history-sized temporary storage and lookup work when H dominates L.
It does not reclaim the arena or alter retained snapshots or the binary format.

The initial switch is H > L × (2 + ceil(log2 L)): one live traversal, a
comparison-sort term, and another live-sized allowance for sorting overhead.
This is a conservative work/storage model, not a hardware-specific measured
constant or a claim about an ECMAScript implementation's exact sorting algorithm.
The crossover matrix tests H just below, exactly at, and just above this boundary
for L=2, 32 and 4096. Any measured loss at that boundary remains a loss to review.
Append-only maps and replacements skip the logarithm. Invalid/stale live-size
or last-log-ordinal counters fall back to the original log loop, as do legacy
zero/missing-history hints. No public property or shared mutable scratch is added.

The deterministic proof separately instruments log reads, mapFind calls,
explicit pointer-array lengths, sorted items and comparisons. It includes H up
to 65,536 with L=32. These are operation counts and logical array element counts,
not allocated heap bytes, peak RSS, GC cost, or engine-internal sort scratch.
Shared-arena allocation is checked separately and remains zero during scans. The harness smoke check independently verifies all 32 fixture/operation cells and interval direction, small-sample widening, classification and quartet-level sample counts.

## Correctness

The runtime-neutral suite covers below/at/above-boundary sizes, replacements,
delete/reinsert, deletion-only histories, empty reset, forks, retained snapshots,
compaction, deterministic mixed edits, FNV collisions, Unicode-equivalent keys,
all built-in value types, frozen nested identities, ordered sets, interleaved
iterators, early return, reentrant callbacks, legacy/malformed counter hints,
read-only copies, and shared memory growth. The real-worker handshake suspends
map/set iterators, grows the writer's memory, then resumes the retained snapshots
in both shared and copied transports. It runs on baseline and candidate.

## Measurement and acceptance

The workflow pins the candidate to its exact event SHA and baseline to the SHA
above. A union manifest checks every tracked runtime/build source against those
commits, permits exactly one production difference, and requires all generated
WASM files to match. Bundle and harness hashes, runtime versions, CPU model,
architecture, raw durations, launch order, calibration and warmup flags are saved.

Each subject is a fresh Node/Bun/browser process importing one build from the
same neutral filesystem/URL path. Browser subjects launch a new browser, not
merely a new page in a shared process. Initialization, imports, native-oracle
checks and fixture construction are outside timing. Equal timed repeats and
warmup scan counts are frozen per case from disposable pilots and reused for
all subjects. Samples target at least 10 ms; the faster pilot determines work.
Four seeded ABBA/BAAB quartets supply eight adjacent process pairs per mode.
The two pairs in a quartet and batch samples are not independent replicates.
Baseline A/A is interleaved for controls, all crossover cells and small target
cases; candidate A/A additionally covers replacements and custom-sorted controls.
No slow result is discarded, adjusted by A/A or retried based on its timing.

The predeclared non-inferiority margin is 2% candidate latency. A 95% Student-t
interval is computed from independent quartet-mean log latency ratios (four
quartets by default, three degrees of freedom). Lower bound >1.02 means a
detected material loss; upper bound <=1.02 provides evidence within the margin;
otherwise the result is inconclusive. A/A gets the same descriptive interval,
with its identical-build role direction reported explicitly. Absolute times,
sub-margin shifts, individual pairs and unadjusted A/A variation remain visible.
A green workflow means the proof executed, not that the candidate passed this
gate. No exact-zero or universal no-regression guarantee is implied.

The initial workflow stage runs only a 14-case clean Node/Bun x64 timing gate plus browser correctness. The full architecture/browser timing matrix requires an explicit stage=full dispatch after review of that gate. A material common-path or crossover loss blocks broad promotion.

The matrix separates controls, crossover and long-history targets. Controls
include empty-free singleton/small/large append-only and replaced maps, modest
churn, custom-sorted object entries, ordinary maps and current-main list scans.
Targets cover small/large maps, hot-key and distributed churn, strings, objects,
keys, values, forEach and ordered sets. CI covers Node and Bun on x64/ARM64 and
Chromium, Firefox and WebKit on x64. Local shared-runner timing is only a smoke
check; previous unrelated A/A measurements on this host were badly unstable.

## Reproduction

Build both exact sources with the same Bun 1.4.2 dependencies and build flags.
From the candidate checkout:

```sh
node proofs/ordered-churn-verify.mjs dist/shared.js candidate-checks.json
EXPECT_ADAPTIVE=0 node proofs/ordered-churn-verify.mjs BASE/dist/shared.js baseline-checks.json
RUNTIME=node node proofs/ordered-churn-performance.mjs BASE/dist/shared.js dist/shared.js node.json
RUNTIME=bun bun proofs/ordered-churn-performance.mjs BASE/dist/shared.js dist/shared.js bun.json
RUNTIME=firefox node proofs/ordered-churn-browser.mjs dist/shared.js BASE/dist/shared.js firefox-checks.json
RUNTIME=firefox SUITE=crossover node proofs/ordered-churn-performance.mjs BASE/dist/shared.js dist/shared.js firefox.json
```

Changing `BLOCKS`, `SAMPLES`, `TARGET_BATCH_MS` or warmup settings is recorded in
the effective configuration. A reduced smoke run is not the full performance
protocol. `CANDIDATE_COMMIT` must be a full SHA matching the source tree; the
source guard rejects uncommitted production changes.
