# Bounded Map miss-cache candidate

This study evaluates an internal change to existing `SharedMap.get` and
`SharedMap.has` calls. It does not add an API. **Performance conclusions are
pending the hosted paired study and its same-build controls.** Local same-build
experiments elsewhere in this session were unstable, so this candidate has not
been timed locally.

## Proposed change and cost

An Arena already caches successful scalar lookups. A new, separately bounded
cache remembers an absent raw query string and the exact immutable root at which
it was absent. A repeated miss on that root can avoid UTF-8 encoding, hashing and
HAMT traversal. Existing successful-read paths remain unchanged.

The cache retains **at most 256 query strings and 16,384 UTF-16 code units per
Arena**, plus one numeric root per entry and ordinary JavaScript object/Map
overhead. It is allocated lazily. This is an additional JavaScript memory cost,
not a WASM allocation saving. The character limit describes retained logical key
length; it does not estimate actual JavaScript heap size, RSS or capacity.
Negative entries do not consume the existing positive-cache budgets. Aliases
that encode to the same UTF-8 key can occupy distinct negative entries, within
the same limits.

Each key remembers its most recently admitted missing root. New roots are
checked normally; successful reads do not inherit an old absence. This means
alternating roots can repeatedly replace that entry, and first-time or streaming
misses can pay admission overhead. Keys beyond the character budget remain
uncached. The study includes those countercases explicitly; a repeated-miss
benefit would not imply that every lookup becomes faster.

The field is declared without a constructor initializer and appended only when
needed, preserving the initial positions of the existing Arena fields. Both
successful reads before a miss and successful reads after that lazy field appears
are separate controls.

The implementation retains the original dynamic kernel lookup between stages.
Any observed custom kernel or substituted view retires the optional cache for
that Arena. Cached reuse/publication also excludes accessor-valued WASM exports.
This keeps custom false misses, including a kernel that restores native exports
before returning, out of the cache. Retirement also prevents a custom prefix
directory result from gaining a longer lifetime through the new cache. Reads do
not modify shared bytes, allocation state, descriptors, the WASM ABI or format 4.

## Workloads and measurement plan

[workloads.mjs](./workloads.mjs) defines every input and independent native-Map
oracle. Each operation makes **1,024 complete public scalar calls**, allocates
their result array, and returns it for retention by the driver. Time is reported
per such operation; divide by 1,024 only when explicitly reporting per-query
time. Verification checks every returned scalar outside the timer. It does not
walk unrelated Map entries for each output.

| Case | Source entries | Queries | Read state | Operations per timed batch |
| --- | ---: | --- | --- | ---: |
| `get-repeated-ascii-16` | 4,096 | 16 absent ASCII keys | Primed | 256 |
| `has-repeated-ascii-128` | 4,096 | 128 absent ASCII keys | Primed | 256 |
| `get-repeated-unicode-128` | 32,768 | 128 absent Unicode keys | Primed | 256 |
| `get-short-repeated-misses` | 4,096 | 16 absent three-character keys | Primed | 256 |
| `get-cold-misses` | 4,096 | 1,024 distinct absent keys | Fresh reader per operation | 64 |
| `get-short-cold-misses` | 4,096 | 1,024 distinct absent three-character keys | Fresh reader per operation | 64 |
| `get-cold-hits` | 4,096 | 1,024 distinct existing keys | Fresh reader per operation | 64 |
| `get-streaming-misses` | 4,096 | 65,536 distinct absent keys across a batch | Fresh reader per batch | 64 |
| `get-over-budget-misses` | 4,096 | 1,024 absent keys outside the filled negative budget | Primed | 128 |
| `get-mixed` | 4,096 | 819 hits and 205 misses | Primed | 256 |
| `get-alternating-roots` | 4,096 | 16 absent keys revisiting two immutable roots | Primed | 64 |
| `get-warm-hits` | 4,096 | 1,024 existing keys | No preceding miss | 512 |
| `get-warm-hits-after-miss` | 4,096 | 1,024 existing keys | One preceding miss | 512 |
| `has-warm-hits` | 4,096 | 1,024 existing keys | No preceding miss | 512 |

Every warm reader is a read-only shared attachment. Cold fixtures derive the same
Arena constructor from that public attachment and construct fresh read-only
readers before each batch, without resetting private caches. Streaming query
strings are also prepared outside timing. Both published roots, the writer's
allocation frontier and all published bytes are checked after each batch.

[paired-benchmark.mjs](./paired-benchmark.mjs) compares baseline commit
`a4265a0608ec25eec5719496225212db6b251989` with the frozen candidate in fresh Node
24.22.1 and Bun 1.4.2 processes. Each process imports the chosen portable bundle
from the same neutral path. The entire study holds the common advisory lock and
pins each subprocess to one available CPU. Pair order alternates AB/BA; case and
runtime order reverse on alternating pairs.

The hosted job runs the following studies sequentially on one fresh runner, with
all 14 cases retained in each study:

- Pilot: two pairs, at least 500 ms of timed warmup and eight warmup batches,
  followed by nine measured batches per process.
- Formal: six pairs with the same warmup and sampling requirements.
- A/A: four baseline-versus-baseline pairs with the same requirements.

Repetitions are fixed before collecting evidence. The driver retains and flags
every measured batch shorter than 2 ms rather than silently excluding it. The
formal and A/A summaries use geometric means of paired after/before ratios and
pointwise Student-t 95% intervals on their log ratios. These are unadjusted
intervals across multiple cases, not a universal performance guarantee. Pilot
rows have no confidence interval.

The source manifests, changed-source snapshots, WASM/bundle hashes, runtime
versions, process order, affinity, raw samples, oracle digest and output counts
are recorded. [verify.mjs](./verify.mjs) independently recomputes the statistics
and checks provenance; [audit-evidence.mjs](./audit-evidence.mjs) audits all three
saved records. Both accept plain or gzip-compressed JSON. No recorded values are
changed by compression.

## Correctness and memory checks

The focused local Node and Bun runs each passed **76 tests across four files**:
[Node log](./validation/node-focused-final.log) and
[Bun log](./validation/bun-focused-final.log). The new tests cover snapshots,
insertions/deletions/forks, primitive and JSON values, UTF-8 aliases and long keys,
full-hash collisions, legacy journals, both cache limits, memory growth,
compaction, shared/copied read-only attachments, ordered/sorted collections,
invalid keys, custom kernels and custom views. The final typecheck and portable
build also passed.

The non-timing [smoke check](./smoke.mjs) verified all 14 cases against both builds
in both runtimes. Their fixture metadata and oracle digests matched:
[Node baseline](./validation/node-baseline-smoke.json),
[Node candidate](./validation/node-workload-smoke.json),
[Bun baseline](./validation/bun-baseline-smoke.json), and
[Bun candidate](./validation/bun-workload-smoke.json).

[cache-budget.mjs](./cache-budget.mjs) inspects the logical JavaScript cache
limits and verifies unchanged published bytes and writer allocation state:
[baseline](./validation/cache-budget-before.json) and
[candidate](./validation/cache-budget-after.json). It observes 256 entries at the
entry limit, 16,384 retained UTF-16 units at the character limit, no admission for
a longer key, no positive-cache displacement and zero WASM bytes allocated by
reads. These results do not measure JavaScript heap overhead or process memory.

The local real Node worker proofs also passed all eight combinations of four
value types and shared/copied transport, with both
[current readers](./validation/node-workers-current-reader.json) and
[baseline readers](./validation/node-workers-baseline-reader.json). Their
independent input oracles cover old snapshots, a miss becoming present on a new
root, forks, compaction, read-only enforcement and growth during concurrent reads.
The dedicated hosted workflow repeats these checks and adds package checks and
real Chromium workers. Hosted results are pending; the workflow uploads logs and
all raw/partial evidence even if a step fails.

## Hosted collection and review

[map-miss-cache.yml](../../.github/workflows/map-miss-cache.yml) temporarily runs
on `perf/map-miss-cache-20261108` to collect evidence before creating a performance
PR. It builds the pinned baseline with its own declared dependencies, completes
correctness/browser checks, then runs pilot, formal and A/A sequentially with a
60-minute job limit. Existing records are never overwritten. Review must retain
adverse countercases and A/A uncertainty before any performance claim is made.
After evidence is committed, the temporary collection trigger/steps should be
removed and the saved study audited against its recorded revision.

## Reproduce with a fresh output directory

Run from a checkout of the candidate with Node 24.22.1 and Bun 1.4.2 installed.
Build the pinned baseline with its own package manifest; the current revision has
no dependency lockfile. Use a new output directory for every invocation.

```sh
git worktree add --detach ../zerocopy-map-miss-baseline a4265a0608ec25eec5719496225212db6b251989
(cd ../zerocopy-map-miss-baseline && bun install && bun run build:wasm && bun run build:browser)
bun install
bun run build:wasm
bun run build:browser

proof=proofs/map-miss-cache-20261108
output_dir="$(mktemp -d /tmp/zerocopy-map-misses-XXXXXX)"
benchmark_cpu="$(awk '/Cpus_allowed_list/ { split($2, ranges, /[,-]/); print ranges[1] }' /proc/self/status)"
for mode in pilot formal aa; do
  taskset -c "$benchmark_cpu" node "$proof/paired-benchmark.mjs" \
    "$proof/workloads.mjs" ../zerocopy-map-miss-baseline . \
    "$(command -v bun)" "$output_dir/$mode.json" "$mode"
done
node "$proof/verify.mjs" "$output_dir/pilot.json" .
node "$proof/verify.mjs" "$output_dir/formal.json" .
node "$proof/verify.mjs" "$output_dir/aa.json" ../zerocopy-map-miss-baseline
```
