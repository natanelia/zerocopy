# Prospective Bun primitive-tail diagnostic

This is one new bounded mechanism/control diagnostic for refinement
25b55f5dfacb926dc3d7354234c6d69326329071 (tree
4dabf1e3e9ec76d4a81e2e17999ceb888bc5e826). It compares that exact commit with
main 3773c6e519c7c0958da13727ed1082f449f3ee25 and its direct parent
042b41a7f68a89a10751f285eef79259adfe4aa3. Timing is disabled in intent.json.

The original candidate's full campaign remains separate evidence:
https://github.com/natanelia/zerocopy/actions/runs/37878061121 . Bun number and
string point ratios were 1.166210 and 1.130276, with inconclusive intervals.
This screen cannot erase those results, pool their observations, diagnose the
cause of their modes, or give overall no-regression clearance. No PR is enabled
by a favorable focused result. Eventual publication still requires full CI and
the broader review of the remaining performance uncertainty.

## Frozen scope and reuse

Only map-object-512, map-number-512 and map-string-512 run, using the exact
original workload, subject, fixture-validation and numerical utility files.
Their historical CASES array still contains twelve definitions; the focused
controller selects only the three explicit cases. Keeping unused definitions
does not authorize measuring other cases. Subject kernels and fixture IDs,
512-get sweeps, checksums, full-byte/descriptor hashes, prewarming, exported
portable dist import, and timed regions are unchanged.

Measured runtime: default stock Bun 1.4.2, Linux x64. Node 22.23.3 is only the
controller and an untimed cross-runtime fixture validator. No runtime optimizer
flags, profiling, forced JIT tiers, memory-size knobs or tier warming is added.
Builds use the original frozen Bun lock SHA-256
9a66d94c2fbd6c9d37917c53264f8c08ac58a42a6c75eb425dd905539eb1a1fe,
AssemblyScript 0.28.20, TypeScript 5.9.3, bun-types 1.4.2 and Vitest 4.1.11.
The baseline and original expected builds come from the audited original
campaign. The refinement expected build comes from the separately reviewed
untimed semantic/emitted-code preparation. All 53 dist files and 12 unchanged
WASM files are matched before any pilot. Reusing unchanged audited WASM is
explicit; this preparation does not claim a fresh WASM compile.

All tracked source bytes must match each exact Git commit, including staged
changes. The source guard proves the original four-line insertion and the
refinement's exactly three redundant-tail guard removals, its sole changed
file, exact tree and direct parent. Compiler entry and implementation hashes,
lock, toolchain, complete dist, WASM, source SHA-256s and Git blob-list hashes
are retained. The original candidate and all historic evidence remain untouched.

## Comparisons, replication and order

For each workload, five groups have four contiguous four-process quartets:

- baseline-refinement: A = main, B = refinement
- original-refinement: A = 042b41a, B = refinement
- baseline-aa: both labels use main
- original-aa: both labels use 042b41a
- refinement-aa: both labels use refinement

There are 80 fresh measured processes per workload, 240 total and 5,040 raw
batches. Sharing refinement AA across the two comparisons saves 48 processes;
it is explicitly shared, dependent evidence, not two independent confirmations.
Each group has two ABBA and two BAAB orientations. Fixed seed 0x6b3a912d uses
the original unsigned xorshift/Fisher–Yates algorithm. Four rounds each contain
one quartet of every group in every workload, with prospectively shuffled
workload/group order. Both comparisons and all three AA groups are interleaved.
The exact 240-entry schedule is frozen before pilots.

Untimed preflight is 18 fresh processes: three roles × three cases × Node/Bun.
Their public outputs, immutable full-byte/descriptor hashes, key sequence and
work/sink counts must all agree. Nine disposable Bun pilots (one per role/case)
finish before any measured process. Each doubles whole sweeps to 40 ms. For
each case, common sample and warmup counts are the maxima over all three roles
using the original calibration formula and 500 ms target warmup. The two
original pairwise chooseWork calls are used only to obtain that same three-role
maximum. Counts are saved once and never adapted after measurement begins.

All measured subjects use 21 batches after the fixed-work warmup. Every batch
must be at least 10 ms and warmup at least 150 ms. Floor failures invalidate the
affected evidence and are retained. No exclusions, clipping, source-dependent
work, AA normalization, sample replacements or favorable reruns are allowed.

## Frozen interpretation

Time ratio is refinement / comparator. For each subject take the median of all
21 batches. Each quartet contrast is mean(log medians in B positions) minus
mean(log medians in A positions). Report exp(mean of four contrasts), and
exp(mean ± 3.182446305284263 × sample SD / 2), the original pointwise two-sided
95% t interval with 3 degrees of freedom. The original median/mean/interval
functions are imported unchanged. Four contrasts cannot validate normality or
independence; batches are not independent replications. No simultaneous
selected-subset guarantee is claimed.

For each comparison, its comparator AA and the shared refinement AA apply.
The original drift invalidation conjunction is unchanged: an AA point ratio
outside [1/1.02, 1.02] AND its interval excludes 1. Full AA interval containment
in that band remains a separate equivalence label. Broad AA uncertainty is
shown and cannot remove an observed adverse point estimate.

- Preserved object gain requires main/refinement upper bound ≤0.90 and
  original/refinement upper bound ≤1.02, with complete valid evidence and no
  AA drift invalidation.
- A primitive concern is cleared within this focused diagnostic only when its
  main/refinement upper bound is ≤1.02 with valid AA evidence. Show both primitive
  controls. A good point estimate or an interval spanning 1.02 is inconclusive.
- Original/refinement upper bound <1 separately supports improvement versus the
  original candidate. Improvement alone does not establish recovery to main.
- Any AB lower bound >1.02 is adverse; an upper bound >1.02 with a lower bound
  ≤1.02 stays inconclusive. All six AB comparisons and all nine AA intervals are
  displayed, including raw quartet contrasts and subject medians.
- FocusedDiagnosticClear requires both object conditions and both primitive
  main comparisons to pass with a complete campaign and no AA drift. It is
  never global clearance. Both AA-equivalence labels remain visible separately.

Any incomplete group has no confirmatory interval. Valid complete groups stay
visible when other groups fail. Missing/invalid scheduled subjects make the
campaign incomplete; valid-subject selection must not repair a partial quartet.

## Bound, receipts and review boundary

Expected elapsed campaign time is about 8–12 minutes, extrapolated from the
original run's 1,152 subjects and its overhead, not a new speed measurement.
The hard prospective campaign wall budget is 30 minutes including all pilots;
each process has a 120-second cap further bounded by remaining campaign time.
After the ceiling, all remaining subjects receive not-started outcomes. There
is no added sampling or follow-up campaign to obtain a favorable outcome.

One neutral subject URL, input path and physical package directory are reused
serially. Every subject is a fresh process; its input contains only phase,
workload and fixed work. Source roles never enter subject input. Each role's
complete dist bytes replace the neutral package between processes. All source
builds and package digests are checked before execution. PID, args, timestamps,
package digest, raw stdout/stderr, and start/exit/outcome receipts are retained.
A killed controller may lack summary/outcome files: those remain incomplete,
never assumed successful. The read-only audit.py independently reconstructs
the seeded plan, process validity, fixed work, raw medians and all intervals;
it accepts partial evidence without importing or executing benchmark modules.
The local cloud environment emits one fixed Node EnvHttpProxyAgent warning.
That exact warning is retained and permitted only in untimed Node fixture
checks; any other stderr, and any stderr from a measured Bun subject, fails.
The initial preparation attempt stopped on that warning before any timing and
is retained separately; neither runtime flags nor subject kernels were changed.

Preparation may execute only controller check and deterministic/semantic tests.
Before measurement, independent review must identify the exact harness digest,
successful check manifest SHA-256 and final source/build identities. Only then
may intent.json be changed to measure=true with those two hashes. That file
alone is excluded from the harness digest. The controller rejects changed
builds, runtime binaries, reference bytes, checked manifest or harness, and
refuses any existing campaign directory. This is one planned local diagnostic,
not a remote workflow or authorization to push/publish. Retain all failed
preparation attempts separately. A full suite is deferred to eventual full CI;
the focused checks are not a full correctness pass.

Optional diagnosis, proposed only: after the measurement campaign is complete,
use a separate untimed stock bun:jsc driver with the same fixtures and default
optimizer settings to record numberOfDFGCompiles, reoptimizationRetryCount and
profile tier/stack output. Do not load bun:jsc in measured subjects, compare
profile elapsed times as latency evidence, or infer an inlining decision from
an absent sampled frame. This preparation does not run that diagnosis.
