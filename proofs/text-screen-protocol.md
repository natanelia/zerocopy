# Bounded text SIMD screen, frozen for review

Status: preparation only. No timing has run and no remote branch, workflow, PR,
or package has been published. This protocol is not performance or adoption
approval. The earlier correctness prototype and its review used main
`3773c6e519c7c0958da13727ed1082f449f3ee25`; that evidence remains historical.
This screen rebuilds main `ad2a19d65a836985a2364b181bc9bd8dce6e42ad` and ports the
same text changes coherently onto it. The intervening main change affects sorted
map iteration, equally in all three arms. New source/build/correctness evidence
must pass before the screen.

## Scope, budget, and arms

One clean GitHub-hosted Ubuntu 24.04 x64 job, Node **22.23.3**, default engine
settings. No Bun timing, browser, ARM, kernel-only benchmark, concurrent benchmark
job, tuned length threshold, or runtime flags. Bun **1.4.2** builds portable JS;
AssemblyScript **0.28.20**, Binaryen **131.0.0-nightly.20260721**, and TypeScript
**5.9.3** are pinned by the retained Bun lockfile. No dependency version change.

There are three runtime implementations and six independent module-path aliases:

| Implementation | Aliases | Change |
| --- | --- | --- |
| Exact ad2 main | A0, A1 | Existing mandatory scalar detector |
| Auxiliary scalar | B0, B1 | Lazy auxiliary plumbing, original scalar detector |
| Auxiliary SIMD | C0, C1 | Same plumbing, vector first-byte candidate detector |

Each alias pair must have identical complete file inventories and hashes. There
are three paired implementation contrasts: B/A (plumbing), C/B (detector), and
C/A (net public cost). Three same-byte controls, A1/A0, B1/B0, and C1/C0, estimate
order/noise effects. No A/A bias is subtracted from implementation results.

The timing controller has a **240-second wall-clock ceiling**, separate from
build and correctness; the whole CI job has a 15-minute ceiling. This is a fixed
ceiling, not a claim that the design is guaranteed to fit. Expiry kills the active
child, retains partial evidence, and fails the screen. It never skips rows,
reduces sample counts, relaxes precision, or retries until favorable. Any later
budget or design change requires another review. Expected timing work is six
warm subprocesses plus 48 cold subprocesses. Only one runs at a time.

## Twelve frozen warm cases

Each uses 1,024 immutable strings and the unchanged public
`list.compileTextSearch(term, options)` followed by the specified index accesses.
Every timed operation creates a fresh predicate and scans once. Dataset creation,
full reference validation, module import, and first auxiliary activation are
outside warm timing. Query construction, lazy function selection, leaf traversal,
16-row batch work, Unicode fallback, and the result checksum remain inside.
This is query-plus-scan latency, not precompiled predicate-only throughput.

| Case | Bytes/string | Distribution and access |
| --- | ---: | --- |
| Long sparse-candidate miss | 1,024 | Unique, sequential |
| Long sparse-candidate miss | 1,024 | Repeated, sequential; separate result |
| Long sparse late hit | 1,024 | Unique, sequential, final six-byte match |
| Long dense-candidate miss | 1,024 | Unique, sequential, many `a` candidates |
| Tiny early hit | 3 | Repeated `ok!`, sequential |
| Short miss | 12 | Unique, sequential |
| 15 legal starts | 20 | Unique miss, six-byte query |
| 16 legal starts | 21 | Unique miss, six-byte query |
| 17 legal starts | 22 | Unique miss, six-byte query |
| Sparse half-leaf access | 1,024 | Unique, 64 requested indexes, one per 16 rows |
| Alternating half-leaf access | 1,024 | Unique, 0/16/1/17/... in each 32-row leaf |
| Unicode negative fallback | 1,024 UTF-8 bytes | Unique, insensitive, final Kelvin sign |

Sparse strings have `n` at offsets 240, 496, and 752; the query is `needle`.
Dense strings search `aaaaaaab`. Fixed eight-digit row IDs make unique fixtures
unique without adding the sparse query's first byte. No repeated/unique pooling,
geometric mean across workloads, or accidental recoding of one as the other.
The manifest freezes all data and index-order SHA-256 values.

## Warm replication, precision, and analysis

Six fresh processes are the six independent warm blocks. Each imports all six
aliases at unique paths and constructs independent memories. Workloads, aliases,
and six batches within one process are correlated observations, not extra
replicates. Module-path aliases are never counted as independent process runs.

Import, calibration, and sample ordering use rotations of the six-arm Williams
order `[0, 1, 5, 2, 4, 3]`; successive blocks reverse sample-order cycles. Case
order rotates by two positions per block. Each alias receives eight untimed
query-and-scan operations before calibration. Eight operations are not evidence
of a JIT plateau, so the last-three/first-three batch median ratio is retained
for every alias. More than 10% drift in either direction flags that case as
inconclusive, without adding warmup or more samples.

Each alias calibrates powers-of-two operation counts to 20 ms, capped at 1,024.
The largest chosen count, generally from the fastest alias, is used unchanged
for all six aliases and all six measured batches in that case/block. Calibration
observations are retained but are not result samples or independent replicates.
Every terminal calibration explicitly records whether it reached the target or
hit the 1,024-operation cap first. Any alias capped below 20 ms makes its entire
case inconclusive, even when subsequent measured batches exceed the 10 ms floor.
Each measured batch must last at least max(10 ms, 1,000 × observed p99 empty
timer-pair cost). A cap/floor failure remains visible and inconclusive.

`process.hrtime.bigint()` records raw integer nanoseconds; no empty-loop or clock
cost is subtracted. The precision probe records minimum positive, median, and
p99 timer-pair durations, not a claim that nanosecond units imply nanosecond
accuracy. Raw time, operation count, requested index count, absolute per-operation
latency, and absolute paired deltas accompany every ratio.

For each sample, compute paired log ratios using the two copies of each arm;
the within-block median of six sample log ratios yields one block observation.
Report all six block observations and their descriptive paired-log Student-t
interval (df=5), with block-level absolute deltas. An A/A interval excluding 1,
or A/A point estimate outside 0.9..1.1, flags an imbalance. No pseudo-replication,
outlier removal, significance-driven extra samples, or simultaneous-inference
claim is allowed. The interval is a small-sample description on one CI machine.

Freeze the existing **2% warm materiality margin** before timing. Data-quality
validity and effect evidence are separate fields: a quality-valid row alone does
not demonstrate a material effect. For each implementation contrast, a complete
descriptive ratio interval strictly below 0.98 is material-gain evidence, strictly
above 1.02 is material-loss evidence, and entirely within [0.98,1.02] is
within-margin evidence. All other quality-valid intervals are unresolved. Rows
failing any quality check cannot support an effect classification. These are
exploratory labels for this screen, not adoption or expansion approval.

## Cold observations

Eight cold blocks each run six **new OS processes**, one per alias, in declared
Williams order. Every process has a new module/realm and one observation of each
stage, in this order:

1. Dynamic import of the ordinary portable `shared.js` dependency closure.
2. Ordinary first numeric-list construction and push of `[1,2,3]`, after import.
3. One unused `compileTextSearch('unused')`, after constructing two independent
   16-row string memories outside timing.
4. Query compilation plus first valid access on the first memory. This is the
   first eligible auxiliary use and includes probing, decoding, compiling,
   instantiating, and the 16-row search, where applicable.
5. Query compilation plus first valid access on the second memory. The auxiliary
   module is already compiled, but that memory has never been searched and must
   receive its own instance.

These are conditional stages of one lifecycle, not five independent samples.
The unused-query stage means first-use compilation is conditioned on an earlier
unused query, which still cannot activate an auxiliary module. First-memory and
second-memory creation use public resets and are verified as different memory
objects. String fixture setup and validation are excluded explicitly.

Each cold stage remains a single observation per process. It is never warmed,
batched, or presented as 21 repeated samples. Timer precision is probed after all
cold stages. Observations below max(1 microsecond, 100 × p99 timer-pair cost) are
flagged; more operations are never substituted for a cold sample. Report raw
durations and block-level absolute differences as well as ratios. Across alias
pairs there are eight paired blocks (df=7); the five stages are not pooled.
Report the mean paired absolute delta and its descriptive Student-t interval
alongside raw block deltas, median delta, and ratio interval. No percentage-only
materiality threshold is applied to cold costs, especially near zero; the warm
2% margin does not classify cold observations.
Processes/modules are cold; filesystem/page caches and CPU caches are not
flushed or claimed cold. Runtime inventory/source validation is consistent
between arms and is outside each measured stage.

## Safety gates, artifacts, and stopping

The proof stages only the actual static `shared.js` closure plus a private ESM
package marker into new allowlisted runtime directories. Exact inventories are
checked before execution; no symlinks, extra files, build trees, external
dependencies, dynamic imports, or standalone scalar-control WASM are allowed.
Scalar bytes are embedded only in the scalar control's ordinary JS, preserving
its actual import cost. Mandatory core bytes are identical. This is a portable
runtime fixture, not an npm package or a release-hygiene fix. The original
populated experiment checkout remains unsafe to package as-is.

Keep ordinary reachable byte overhead visible. The earlier 3773 build measured
+2,456/+2,876 reachable JS bytes for scalar/SIMD; new ad2 values must be measured
by the build inventory and reported beside latency. First-use loading,
compilation, instantiation, and extra-memory costs are not erased by lazy loading.
Unsupported SIMD probing falls back to the existing core; read/decode/compile/
instantiate errors propagate. No other fallback guarantee is made.

Before timings: frozen source and dependency guards; same-core WASM checks;
284,672-case exact-return/batch proof; existing public text kernel/batch/search
checks for all three arms; supported and forced-unsupported auxiliary activation;
cross-arm byte/format attachment proof; and exact expected outputs for all 72
alias/case combinations. Instrumented activation proofs run in separate processes
and never in a timing process. A gate failure prevents all timings.

The controller writes each observation to per-process JSONL immediately. Process
status, stderr, schedule, complete/incomplete marker, source and binary hashes,
tool versions, CPU, OS, runner image, raw samples, and summary are retained.
`always()` artifact upload preserves unsuccessful controls and partial results.
Missing, short, drifting, imbalanced, or interrupted cases stay visible.

The dedicated `proof/text-simd-screen-20261009` branch push is an activation of
this workflow and must wait for independent review and authorization. No PR or
general push trigger activates it. An explicit workflow dispatch is also an
activation. The runner rejects local timing and non-default engine settings.

After the fixed screen, stop and review all three contrasts, cold/ordinary
costs, adverse controls, precision, drift, and A/A behavior. A detector gain
without a credible net public gain is insufficient to expand. Inconclusive
results do not authorize more samples. No result of this initial screen alone
authorizes a runtime threshold, broader platform matrix, adoption, PR, or release.
