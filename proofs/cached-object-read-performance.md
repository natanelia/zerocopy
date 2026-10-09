# Prospective single-lookup object-read performance screen

This is the first timing screen for the structurally new single-lookup candidate
042b41a7f68a89a10751f285eef79259adfe4aa3. No latency measurements have been taken
for this candidate. The twelve workloads, subject kernels, quartet schedule,
21 samples, calibration, validity rules and interpretation are retained exactly
from the reviewed original screen. Only source/reference pins and the narrow
source guard change; this is not a repeat of the old candidate's campaign.
Before measurement, the revised harness must pass deterministic protocol tests,
both-runtime built-package fixture checks and independent exact-tree review.

## Prior adverse evidence and unresolved history

The earlier exact-root candidate e249dd4148211dfec0e439ea5988af041c446e94 was
measured under proof 41579f630429a51000abdda238be08ac86e30121 in
[run 37870613839](https://github.com/natanelia/zerocopy/actions/runs/37870613839).
It produced six of eight substantial scoped target gains, but no overall
no-regression clearance. Node alternating-root time ratio was 1.073395 with
pointwise 95% interval [1.003745, 1.147879]; all four quartets exceeded 1.02.
Bun primitive-number and string controls were also adverse and uncertain:
1.150759 [0.955948, 1.385272] and 1.077826 [0.867233, 1.339558], respectively.
Those results remain evidence against the earlier candidate; no sample, case
or acceptance rule is changed to improve their outcome. This screen compares the
new algorithm against the same baseline, not against the earlier candidate.

The new candidate calls the existing find/radixFind once and then unchanged
leafValue for every generic code-0/code-4 read. It avoids both outer cache probes
without the earlier candidate's additional exact-root probe. This structural
change motivates one new bounded screen; correctness success is not performance
clearance. Earlier local five-second test timeouts and the 300-second process
cap remain unresolved historical evidence. The successful paired CI run does
not diagnose their cause or erase them.

## Exact source and reference evidence

- Baseline: 3773c6e519c7c0958da13727ed1082f449f3ee25.
- Candidate runtime: 042b41a7f68a89a10751f285eef79259adfe4aa3.
- Completed correctness proof: 63f1a0a2d589418fb4f4630f2353f2ba88e9f58d,
  GitHub Actions run 37876200596.
- Baseline frozen artifact ID: 11592795943; ZIP SHA-256:
  1892892ed631a8afd3259d829230d62169fb0530552e261182b1d3bfe63a7a45.
- Candidate frozen artifact ID: 11592292506; ZIP SHA-256:
  4543ea4c01e6f9a4d265c26ab4aa179446d805c0ca3e3f2482182a271808000b.

The candidate changes only the four-line generic code-0/code-4 early return in
Arena.value and adds 21 focused tests. The completed paired correctness run
passed 774/774 tests in both roles with identical 21-case overlays, all 19
command receipts per role, type/build/package checks, 18 Node worker-lifecycle
checks and six dedicated real-worker cases. This performance
harness does not amend runtime source or replace that evidence.

The workflow downloads those immutable reference ZIPs read-only. Authenticated
GitHub API requests use a no-redirect handler. The expected artifact redirect is
validated and followed only through a new request without Authorization; metadata
redirects fail closed. The extractor
verifies the ZIP and inner archive digests, rejects links and path traversal,
checks source/runtime identities, and retains all original bytes and receipts.
New builds use their frozen Bun lockfile and must exactly match the reference
dist, generated WASM and compiler bytes before any pilot starts. An unavailable
artifact or a hash mismatch blocks measurement; do not substitute newly observed
hashes as expected values. Retain build commands, build-script hashes, source Git
tree/blob identities, source SHA-256s, compiler entry/implementation hashes,
runtime versions, CPU data, all dist bytes and all WASM hashes.

## Fixed matrix: 12 public-get workloads

| Workload | Role | Timed work per sweep |
| --- | --- | --- |
| map-object-512 | Primary target | 512 warm object gets in one SharedMap root |
| ordered-object-512 | Primary target | 512 warm object gets with the four-byte ordered prefix |
| sorted-object-512 | Primary target | 512 warm object gets through the sorted/radix path |
| map-nested-512 | Primary target | 512 warm nested SharedMap gets; consume returned root and size |
| map-object-1 | Control | 512 repeated gets of one warm object |
| map-unadmitted-address-object-512 | Control | 512 existing-object gets whose addresses cannot enter the cache |
| map-number-512 | Control | 512 warm primitive number gets in SharedMap |
| map-string-512 | Control | 512 warm primitive string gets in SharedMap |
| sorted-number-512 | Control | 512 warm primitive number gets through sorted/radix lookup |
| map-alternating-roots-object-512 | Control | 1,024 gets: old then changed root for each of 512 keys in one arena |
| map-unknown-missing-object-512 | Control | 512 repeatedly absent keys against an object map; misses never obtain address entries |
| map-object-cache-saturated-tail-512 | Control | 512 warm-address gets requiring object decoding beyond the object-cache entry limit |

The address-admission control replaces a redundant ordered one-object cell rather
than expanding the matrix. It first reads 512 disjoint existing keys of exactly
256 UTF-16 characters, consuming all 131,072 address-cache characters. It then
prewarms 512 short existing keys. All 1,024 small decoded objects fit in the object
cache, but those 512 short keys cannot be admitted to the address cache. This is
an unadmitted-address / warm-decoded-object workload, not a first-ever object
decode benchmark. Source guards pin the relevant cache limit/admission logic.

The independent decoded-object pressure control creates 2,560 entries and reads
them in ascending order. The first 2,048 fill the decoded-object cache. Only the
last 512 are timed. Their addresses fit in the address cache, while every get
decodes and freezes the JSON again. Public identity assertions verify retention
of the first entries and nonretention of the tail. Labels do not claim address
pressure for this case.

Each 512-key sweep uses the same fixed odd permutation. One-entry control sweeps
still perform 512 gets. Alternating roots contain distinct values at every key,
and every key is read from the two roots consecutively. Nested results are
validated by reading their inner value outside timing; timed consumption reads
only returned handle root and size. Object gets consume the numeric index,
string gets consume length, number gets consume value, and misses contribute one
only when undefined. Every measured sample must have the exact expected checksum.
No prototypes or runtime methods are instrumented.

## Fixture identity and package neutrality

Both runtimes import the built portable dist/shared.js by the same physical
subject URL. Bun's package export condition would select source shared.ts, so
package-name import is deliberately not used. A single neutral package directory
is overwritten with the selected role's complete dist between fresh processes.
There are no role-named subject paths, symlinked package roots, hot module swaps,
role-specific runtime flags or role identifiers in subject input.

The built API does not export Arena. Before constructing any published fixture,
a throwaway SharedMap exposes its existing protected arena getter via Reflect.get.
Its constructor creates a fresh arena with a fixed explicit ID. The existing
collection constructors receive this arena. SharedSortedMap receives undefined
as its second, comparator argument; root is third. This setup does not change
published bytes or monkey-patch module globals. All timed collection operations
are public get calls.

Before and after each subject, public getWorkerData({copy:true}) provides arena
IDs, used lengths, complete copied bytes and structure descriptors. Their
SHA-256s, exact roots, output checksum/hash and key-sequence hash must agree
between roles, pilots, subjects, and Node/Bun preflight checks. No fixture hash
normalization masks random arena IDs or descriptor differences.

## Sampling and ordering

Initial scope is Node 22.23.3 and Bun 1.4.2 on x64, built with Bun 1.4.2 and
AssemblyScript 0.28.20. No browser or other architecture claim is made.

Every runtime/workload cell has:
- Four AB quartets = 16 fresh measured subjects.
- Four separate baseline AA quartets = 16 fresh measured subjects.
- Four separate candidate AA quartets = 16 fresh measured subjects.
- Total: 48 measured subjects per cell, not 32.
- 21 timed samples per subject following one fixed-work warmup.

There are 24 cells and 1,152 measured subjects in the complete screen. These
counts exclude preflight checks and disposable pilots.

A recorded fixed seed (0x6b3a912d) generates four campaign rounds. Every cell gets
one quartet of each comparison in each round; cell and comparison order are
shuffled prospectively. Each quartet remains contiguous. Every cell/comparison
has two ABBA and two BAAB quartets, in seeded shuffled order. AA pseudo-A/B
positions use the same source package. AA observations are interleaved with AB.

All 48 disposable pilot processes (two roles for all 24 cells) complete before
any measured process starts. Pilots double whole-sweep work to a 40 ms target.
The maximum final sample-sweep count across roles is used by both roles. The
common warm-sweep count is the maximum pilot-rate estimate for a 500 ms warmup.
Both counts are saved before measurement and then remain fixed for all AB and
AA subjects in that cell. Pilots are not included in estimates.

Every sample must last at least 10 ms; fixed warmup must last at least 150 ms.
These are validity floors, not adaptive stopping targets. A floor failure
invalidates the cell, retains its entire raw output and never causes a rerun,
sample exclusion, work adjustment or substitute subject. Other scheduled
subjects continue. Pilot failure prevents measurements from starting. Timeouts,
errors, partial stdout/stderr and complete failures are retained.

## Analysis and predeclared interpretation

For each subject use the median of all 21 raw elapsed-time samples. Work counts
are identical across source roles within the cell, so ratios use elapsed time
directly. No correction, normalization by AA, outlier removal or timing rerun is
allowed.

For each quartet q:
Dq = mean(log(median subject time) in pseudo-B positions)
     - mean(log(median subject time) in pseudo-A positions).

The reported ratio is exp(mean(Dq)). Its pointwise two-sided 95% interval is:
exp(mean(Dq) +/- 3.182446305284263 * sampleSD(Dq) / 2).
There are four independent quartet contrasts, hence three degrees of freedom.
This log-of-each-subject estimator cancels linear log-time drift across symmetric
ABBA/BAAB positions; do not replace it with log of an arithmetic mean.

The noninferiority boundary is 1.02. The primary family is the eight predeclared
target runtime/workload cells. A substantial scoped gain requires a target
upper confidence bound at or below 0.90 (at least 10% faster under this interval).
Selected target subsets may be reported as exploratory pointwise findings; show
every target and control alongside them. Do not require every target to improve
to describe useful scoped gains.

The established AA drift invalidation rule is: the AA point estimate is outside
[1/1.02, 1.02] AND its interval excludes 1. This rule applies separately to each
source's AA comparison. Full containment of both AA intervals within that band
is recorded as an additional, stronger equivalence label. A wide AA interval is
uncertainty, not a reason to erase an observed large effect.

Strong-clear requires all 24 AB upper bounds <= 1.02, valid complete data and no
AA drift invalidation. AA-equivalence-clear additionally requires all AA
intervals to fit inside their equivalence band.

A scoped draft may describe substantial target gains alongside inconclusive
controls when no AB interval lies entirely beyond the adverse 2% boundary
(lower bound > 1.02) and no AA drift invalidation occurs. The draft must identify
controls for which regression remains unexcluded. This is not an overall
no-regression conclusion. Any missing or invalid subject blocks its cell's
confirmatory conclusion; an incomplete campaign is labeled invalid and keeps
the valid-cell estimates visible, without a global pass.

The t intervals assume approximately independent, normally distributed quartet
contrasts. Four contrasts cannot meaningfully validate that assumption.
Twenty-one within-process samples do not add independent replications. AA
success does not establish nominal confidence coverage. No simultaneous
confidence guarantee is claimed for selected pointwise subsets.

## Validation and execution boundary

The protocol tests cover count/order/label balance, contemporaneous AA,
calibration, fixture mismatch, exact work and sinks, every-sample/warmup floors,
four-quartet arithmetic, linear log-drift cancellation, AA drift and decision
labels. Preflight runs all 12 fixtures with both source roles in both runtimes,
checks public outputs and immutable bytes, and checks cross-runtime identity.

The workflow defaults to checks only on the isolated proof branch; manual dispatch
also runs checks only, where dispatch is available. Independent review must
identify the exact harness digest printed by validation. A later proof-only push
may set measure=true and that digest in cached-object-read-run.json, together with
the successful checks-only commit and run ID. The activation must directly follow
that commit and change only the exact-schema intent file; the push's prior head
must equal the validated commit. A no-redirect GitHub read must verify that the
linked run succeeded on the exact commit, workflow, first attempt and push event.
It must also verify the sole gate job and named intent/reference/build/fixture
steps actually succeeded, with the timing step skipped. Workflow-level success
alone is insufficient because a skipped job may be reported as successful. This intent
file is excluded from the harness digest to avoid self-reference; its exact bytes
and triggering commit are retained. A measurement activation is rejected unless
the intent previously existed as checks-only and every earlier version in branch
history also had measure=false. This is one activation for this pinned experiment,
not a repeatable attempt to obtain passing timings. The controller refuses an existing
campaign directory, changed source/build bytes or a changed harness digest.
Workflow attempts other than the first are disabled. Do not start a second
campaign to rescue an inconvenient timing result.

The checks-only then one-time measurement intent is a technical validation gate,
not a new request for user approval. Publication is handled after independent
review. Before first timing, retain the final matrix review, exact harness review,
successful protocol checks, fixture-check evidence and the frozen plan.
