# Materialize TanStack values without decoding discarded keys

## Result and change

For the three declared cached-value workloads (256 ASCII rows, 256 long Unicode
keys, and 2,048 ASCII rows), this change reduced paired materialization time by
**41–49% on Node and 27–39% on Bun**. All six pairs improved in every one of
those cases, and their unadjusted 95% intervals exclude parity.

The production diff is one line in `tanstack-db-collection.ts`:
`SharedCollection.toArray()` iterates `this.data.values()` instead of
`this.data.entries()`. It retains the same value order, fresh result array,
immutable decoded values and generic object decoding. It avoids key decoding
and temporary key/value pairs that the adapter previously discarded. Core map
traversal, cache limits, shared allocation, binary layout and public signatures
are unchanged. `withSharedCache().toArray()` delegates to this method.

The broader controls are less conclusive. The formal single-row, subsequent
entry scan, and unchanged entry-only intervals include parity in both runtimes;
so do Node's fresh nested-object case and Bun's cache-overflow case. This report
does not claim every materialization improves, equivalent controls, or a
complete TanStack application speedup. The fresh ASCII cases have favorable
but comparatively close-to-parity interval bounds.

## Complete formal results

Times are microseconds per complete public operation. Before/after times are
marginal medians across six processes per build. The ratio is the geometric
mean of the six paired process-median ratios, so it need not equal the ratio
of the two displayed marginal medians. Lower ratios mean less time. Intervals
are unadjusted two-sided Student-t intervals on paired log ratios (5 degrees
of freedom), not a universal performance guarantee.

### Node 24.22.1

| Workload | Rows | Before µs | After µs | Paired after/before | 95% interval |
| --- | ---: | ---: | ---: | ---: | --- |
| empty | 0 | 0.129 | 0.025 | 0.229 | 0.166–0.317 |
| single | 1 | 0.324 | 0.264 | 0.732 | 0.423–1.266 |
| warm-ascii | 256 | 46.501 | 27.742 | 0.588 | 0.558–0.619 |
| warm-unicode | 256 | 48.632 | 26.781 | 0.508 | 0.443–0.582 |
| warm-cache-boundary | 2,048 | 439.973 | 242.211 | 0.542 | 0.510–0.577 |
| warm-cache-overflow | 4,096 | 3323.001 | 2574.797 | 0.741 | 0.641–0.856 |
| fresh-ascii | 256 | 427.572 | 350.347 | 0.811 | 0.674–0.976 |
| fresh-unicode-nested | 256 | 821.129 | 681.817 | 0.871 | 0.719–1.055 |
| fresh-array-then-entries | 256 | 506.943 | 458.110 | 0.982 | 0.698–1.382 |
| entries-control | 256 | 57.315 | 56.765 | 0.953 | 0.783–1.160 |

### Bun 1.4.2

| Workload | Rows | Before µs | After µs | Paired after/before | 95% interval |
| --- | ---: | ---: | ---: | ---: | --- |
| empty | 0 | 0.131 | 0.074 | 0.517 | 0.397–0.674 |
| single | 1 | 0.242 | 0.230 | 0.909 | 0.740–1.117 |
| warm-ascii | 256 | 22.289 | 15.687 | 0.673 | 0.596–0.760 |
| warm-unicode | 256 | 25.782 | 16.517 | 0.612 | 0.521–0.717 |
| warm-cache-boundary | 2,048 | 199.413 | 148.662 | 0.727 | 0.623–0.847 |
| warm-cache-overflow | 4,096 | 3169.319 | 2548.325 | 0.813 | 0.572–1.157 |
| fresh-ascii | 256 | 351.264 | 302.962 | 0.822 | 0.681–0.992 |
| fresh-unicode-nested | 256 | 1622.321 | 1156.206 | 0.769 | 0.623–0.951 |
| fresh-array-then-entries | 256 | 738.296 | 605.544 | 0.860 | 0.656–1.128 |
| entries-control | 256 | 58.000 | 47.078 | 0.916 | 0.703–1.195 |

## Fixed method

The [premeasurement plan](PLAN.md) fixes all ten cases. The unchanged source was
screened with two pairs per runtime/workload, then measured with six. Primary
and pilot results remain separate. There were **240 primary subject processes**
(120 pairs), each importing only one build and running only one workload.
Each pair alternates before/after order; workload order rotates each round.
Both builds are copied to the same neutral import directory, with all old
bundle files removed before replacement.

The writer is prepared identically for both builds: enumerate its keys, create
an independent native JSON value oracle in that order, then prime both key and
object caches through the same calls. The 4,096-row case explicitly exceeds the
2,048-entry decoded-object cache limit. Fresh-reader cases create a separate
attached Arena before **every** operation and do not read its values or keys
before timing. Thus their decoding caches are empty, although CPU caches and
module compilation are warm. Shared attachment and wrapper construction are
outside timing. The `fresh-array-then-entries` case times both complete results,
including any key decoding deferred by the new value-only operation.

Timed work includes complete `toArray()` calls, their result-array construction,
and full entry-array construction where specified. Input generation, shared
writer construction, attachment, the outer result-retention array and complete
output verification are excluded. All returned arrays are retained until every
row and entry key has been checked against the native oracle. Used shared bytes
and backing capacity must be unchanged after each batch; the shared byte hash
must be unchanged after each subject. This is not a JavaScript heap/RSS study;
the new path still allocates its public result array and any uncached decoded
objects.

Disposable calibration selects common measured repetitions for both builds,
targeting 12 ms within caps of 131,072 output rows, 32,768 repetitions, and 64
fresh readers per batch. Each primary subject warms **at its selected repetition
count** for at least 500 ms of actual timed work and at least eight batches,
then records nine measured batches. Actual warm-up was 500.005–537.670 ms
and 17–346 batches. The shortest measured batch was 0.699 ms;
bounded output counts and changing runtime speed mean the 12 ms target is not
a guaranteed minimum. Five hundred milliseconds is a disclosed warm-up protocol,
not proof of universal steady state. The statistical units are the six process
pairs, not the 2,160 measured batches. No observations were dropped or replaced.

Environment: Node 24.22.1 and Bun 1.4.2, both using the portable JavaScript
bundles; Linux x64 kernel 6.18.57, AMD EPYC 9V74, 8-CPU quota,
all timing pinned to CPU 2 under the shared performance lock. Formal measurement
ran from `2026-11-05T00:30:27.339Z` through `2026-11-05T00:34:14.234Z`. No browser,
ARM, cold-module-startup or end-to-end application performance claim is made.

## Pilot and preserved failures

The [complete two-pair pilot](results/pilot-02.json.gz) contains every control,
including an adverse Node single-row estimate: paired ratio **1.510**, with
marginal medians **0.525 → 0.788 µs**. Its individual ratios were 1.422 and 1.603.
That penalty did not persist in the longer six-pair study, whose interval is
still wide enough to include slower outcomes. The source was not changed in
response to the pilot. The pilot's unchanged entry-only control was also noisy
(Node pair ratios 1.429/0.830; Bun 1.417/0.894). Pilot warm-up was at least five
batches and 100 ms; none of its measurements are pooled into the primary result.

Two verification-only failures occurred before any timing pair was recorded.
The original worker proof incorrectly required mutable writer scratch bytes to
remain unchanged across owner writes; the corrected proof checks bytes within
each read phase and exact retained results across writes. The initial empty
checksum oracle produced negative zero instead of positive zero. Its explicit
empty case was corrected without changing nonempty checks. The exact original
scripts, failure logs and aborted record are retained in
[experiments](experiments/README.md). No production variant was discarded or
hidden, and the one-line candidate stayed unchanged throughout.

## Correctness and provenance

WASM, browser-bundle and declaration builds, source typecheck, **14 focused
tests**, and the default full suite (**54 files / 1,079 tests**) pass. New tests
cover empty and unusual/normalized keys, exact value order, fresh mutable result
arrays containing deeply frozen values, subsequent entries/keyed reads, retained
forks, shared/copy readers and owner memory growth. The [real Node worker proof](worker.mjs)
checks both shared and copied map transports, constructs the TanStack wrapper
inside each reader, and rechecks all 257 nested rows after owner edits/growth.
It does not add transport support for the wrapper itself. A dedicated CI step
runs that proof and the saved-evidence verifier.

Baseline: `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`.
Measured local candidate revision: `3c43a277d1cb7aba3401f0b7eaca81e4a2558ef5`.
Later report/CI commits package the same measured runtime source. The exact
candidate `tanstack-db-collection.ts` SHA-256 is:

`066007cbc9713d435c873835a593fc063a28c189dd05c43d547bb873d7ff5535`

The primary record contains every root runtime-source hash, generated WASM hash,
all imported bundle hashes, support-file hashes and optional lockfile presence.
It asserts baseline identity, the single intended runtime-source difference,
and unchanged source/build/driver/fixture identity at completion. Driver and
fixture SHA-256 values are:

- Driver: `c311da9023742f531d5ab350857e6057738854a65160213322b3e17384f3afd4`
- Fixtures: `fad99c596fb1758ca0de23b236d4911205207b6960a31092a1026fef092820ea`

The [baseline validation](validation/baseline-validation.txt) and
[baseline manifest](validation/baseline-manifest.json) are reused from the
already-validated, frozen baseline. Candidate logs are
[build/focused tests](validation/initial-build-tests.txt),
[full suite and pilot verification](validation/full-suite-and-pilot-verification.txt),
[actual worker results](validation/node-workers.txt), and
[formal verification](validation/formal-verification.txt).

## Reproduce

The complete raw [primary recording](results/formal-01.json.gz) and
[pilot recording](results/pilot-02.json.gz) are losslessly gzip-compressed;
[artifact hashes](artifacts.json) include the original uncompressed SHA-256.
The [independent arithmetic/identity verifier](verify.mjs) accepts either JSON
or gzip, recomputes process medians and all paired intervals, validates every
batch's oracle count/checksum and actual warm-up totals, and can verify both
local source/build manifests when their paths are supplied.

```sh
node proofs/tanstack-values-20261105/verify.mjs proofs/tanstack-values-20261105/results/formal-01.json.gz
node proofs/tanstack-values-20261105/verify.mjs proofs/tanstack-values-20261105/results/pilot-02.json.gz
```

To rerun, build separate baseline and candidate worktrees with the same pinned
dependencies (`bun run build:wasm` and `bun run build:browser` in each). Use an
allowed CPU on your host, an exclusive timing lock, and a **new** output path:

```sh
flock /tmp/zerocopy-perf.lock taskset -c 2 node proofs/tanstack-values-20261105/benchmark.mjs /absolute/baseline /absolute/candidate /absolute/bun /new/output/formal.json formal
node proofs/tanstack-values-20261105/verify.mjs /new/output/formal.json /absolute/baseline /absolute/candidate
node proofs/tanstack-values-20261105/worker.mjs
```
