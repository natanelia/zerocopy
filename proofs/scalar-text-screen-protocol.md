# Prospective bounded scalar text screen

Preparation only. No timing, remote write, publication, performance conclusion,
or adoption approval is part of this change. This new experiment does not revise
or supersede any optional SIMD observation or its invalid/adverse controls.

## Runtime identity and historical evidence

Baseline is main `ad2a19d65a836985a2364b181bc9bd8dce6e42ad`. Candidate is published
commit `3efaa3bb110f1d4e979d279aec12f52e2b37731b`, exact six-file tree
`b4e060c8517a619f53a958e3ab9bdb091ba83e15`, directly parented on that baseline.
Its only production change is 12 added lines inside the scalar text reader.
The filter intersects first-byte and last-byte SWAR masks only for multi-byte
queries with a dense approximate first-byte mask. All surviving candidates still
receive complete verification. No public API, dependency, auxiliary module,
loader, format, or runtime threshold change is included.

The separate optional SIMD screen is proof commit
`31ccd6e5f892495b6193bd271473bcb23f8b0169`, GitHub run `37888638603`, job
`113684281837`, artifact `11596693926`; artifact ZIP SHA-256
`1dbf9264666377ed03c239ee3c15cea1b18b2abdbb420f2f4e4d39aacf4dfeee`.
That earlier experiment's original classifications remain unchanged. Its
SIMD/main first-valid stage was descriptively +384.171 microseconds with interval
[+336.613,+431.729] and an invalid scalar A/A control. Tiny/short warm effects,
all invalid rows, and cold overhead remain adverse or uncertain evidence.
The scalar experiment changes the existing core, so lack of an auxiliary module
does not establish zero startup/compilation cost.

## Lane, sampling and hard stop

One clean GitHub-hosted Ubuntu 24.04 Linux x64 job using Node 22.23.3 with no
engine flags, NODE_OPTIONS, or NODE_COMPILE_CACHE. Bun 1.4.2 only builds/tests;
AssemblyScript 0.28.20, Binaryen 131.0.0-nightly.20260721 and TypeScript 5.9.3
remain pinned by the existing dependency lock, whose SHA-256 is
`3e2462a27f26395f52e20e1f958b227277d4e40c54c33ff64e06075c8fad99f3`.
No Bun/browser/ARM/kernel-only timing, matrix expansion, concurrent benchmark,
or source tuning after observation.

A0/A1 are independent module paths with identical baseline bytes; B0/B1 have
identical candidate bytes. Compare B/A and retain A1/A0 plus B1/B0 as same-byte
controls. Never subtract A/A bias or use it to shift implementation estimates.

Exactly eight new warm processes plus eight cold blocks of four fresh processes:
40 timing processes total. The controller starts a 240-second wall-clock budget
only after fresh build/correctness gates. Its timeout includes child startup,
validation, untimed setup/warmup, calibration, and observations. No extension,
continuation, replacement process, retry, or favorable-result stopping. Existing
timing output prevents another run in the same evidence directory. Timeout or
failure retains per-process JSONL, stderr/status, schedule and an incomplete
marker, and stops. All partial rows remain reportable as descriptive evidence;
missing global completion prevents interpreted effects. The ceiling is not a
promise that this workload fits.

Alias order is Williams [0,1,3,2], cyclically offset by row; reverse on alternating
four-row cycles. Warm imports/calibration use the process block's row; eight
warmup passes use subsequent rows; timed batch s uses row 6*block+s. Cold block
uses its block row. All orders are deterministic. Cases cyclically advance by
two places per process. No random seed search or balancing after measurement.

## Frozen public workloads

There are 12 separately reported rows, all 1,024 string-list entries and every
index visited sequentially. Each row repeats one value, which may be interned to
one string address. These are deliberate mechanism/control diagnostics, not a
representative workload mix or a 1-MiB distinct-string working set. Every operation
creates a new public compileTextSearch predicate then visits all 1,024 indexes;
previous operations' half-leaf result caches cannot replace this work.

| ID | UTF-8 input | Query | Purpose |
| --- | --- | --- | --- |
| tiny-early-hit | `ok!` | `ok` | Tiny setup/early return |
| seven-start-dense-miss | 14 a | `aaaaaaab` | Immediately below chunk eligibility |
| eight-start-dense-miss | 15 a | `aaaaaaab` | First eligible chunk |
| long-one-byte-miss | 1,024 x | `n` | One-byte guard overhead |
| long-zero-candidate-miss | 1,024 x | `needle` | Broadcast/guard with no candidate |
| long-singleton-per-chunk-miss | 128 × `nxxxxxxx` | `needle` | Singleton guard, no filter saving |
| long-two-candidates-per-chunk-miss | 128 × `nxnxxxxx` | `needle` | Minimum true filter density |
| dense-last-byte-miss-length8 | 1,024 a | `aaaaaaab` | Primary shared-prefix target |
| dense-last-byte-miss-length16 | 1,024 a | 15 a then b | Two-word verification target |
| dense-endpoint-passing-miss | 1,024 a | `abaa` | Added filter without rejection |
| dense-early-hit | 1,024 a | `aaaa` | Added filter before immediate hit |
| insensitive-unicode-tail-miss | 1,021 a then 中 | `aaaaaaab`, insensitive | Unicode negative fallback |

The checked-in generator and JSON fixture SHA-256s freeze exact values/options/
access order. The manifest and correctness receipt cover every one of the 48
alias/case combinations. Tiny and dense-early rows score 524,800; all other rows
score zero. No rows are pooled into a grand score.

## Warm measurement, validity, and effect

Each process imports four aliases, builds four lists per case outside timing,
then runs eight fixed untimed operations per alias. Each alias calibrates powers
of two, starting at one, to at least 20 milliseconds, capped at 1,024 operations.
Retain every calibration and its explicit terminal state. The maximum selected
repeat count across aliases applies to all four. Cap before target invalidates
the row, even if subsequent batches exceed the timer floor.

Six retained batches per alias/case. Each must last at least max(10 ms,
1,000 × measured p99 timer-pair overhead). Record raw integer nanoseconds, repeats,
requested accesses, absolute per-operation duration and paired differences.
Clock units do not imply nanosecond accuracy. No empty-loop/timer subtraction.
An alias's last-three/first-three median duration outside [0.9,1.1] invalidates
the row for early/late drift. Fixed warmup does not prove a JIT plateau.

For each batch take the mean of the two aliases' logs per implementation, then
subtract candidate minus baseline. Take the median of six paired log ratios
within each process. Likewise retain within-process median paired absolute
nanosecond differences. The eight processes, not batches or aliases, are the
independent units. Mean and Student-t 95% descriptive intervals use df=7 and
critical value 2.364624251. Retain all eight observations and A/A absolute intervals.

One deliberate prospective change from the prior text experiment's validity
rule: for warm rows use the main campaign's material A/A drift rule. A control
invalidates a row only when its point ratio is outside [1/1.02,1.02] AND its 95%
interval excludes 1. The old exploratory rule flagged any interval excluding 1,
including tiny subpercent imbalances. This new rule is declared before any new
measurement to avoid mistaking precise trivial drift for material drift. It
must never be applied retroactively to revise the old SIMD classifications.
A control with a wide interval spanning material changes remains explicitly
uncertain; absence of a validity failure does not establish control equivalence.
All small directional imbalances remain visible. No bias correction is applied.

Freeze the coherent multiplicative warm margin [1/1.02,1.02], the same endpoints
used for A/A material drift. For quality-valid B/A, an entire interval strictly
below 1/1.02 is material-gain evidence; an entire interval strictly above 1.02 is
material-loss evidence; an interval wholly within the margin is within-margin
evidence; otherwise unresolved. This changes the prior text screen's lower
effect boundary 0.98 to 1/1.02 prospectively, not its historical conclusions.
Quality failure is separately not-interpretable-data-quality. Neither validity
nor within-margin evidence is a general improvement, release or expansion gate.

## Five cold stages and prospective cold validity

Each of eight cold blocks has four new OS processes, one per alias. Each process
observes these conditional lifecycle stages exactly once:

1. Ordinary dynamic import of the portable shared.js dependency closure.
2. First numeric-list construction and push of [1,2,3] after import.
3. Unused query compilation after constructing two independent 16-row string
   memories outside timing. Each value is eight decimal index bytes, 120 x, needle.
4. Query compilation plus first valid search/access on the first string memory.
5. Query compilation plus first valid search/access on the second memory.

The memories are asserted distinct. There is no auxiliary module here; existing
core compilation/instantiation can affect ordinary import/construction, and
conditional search work affects later stages. First-valid is conditioned on the
prior unused query. Stages within one process are correlated and not extra
replicates. Process/module state is cold; OS/filesystem/page/CPU caches are not
flushed or claimed cold. Inventory validation is outside measured stages and
can warm filesystem caches equally; it is not a fresh-filesystem experiment.

Retain the old conservative cold validity rule, prospectively: same-byte point
ratio outside [0.9,1.1] OR 95% ratio interval excluding 1 invalidates that stage
for all comparisons. Unlike warm, single cold observations have no sustained
batch/early-late diagnostic and can be dominated by startup order or tiny
absolute durations; this intentionally cautious rule can invalidate small effects.
This threshold is diagnostic, not a cold equivalence or materiality margin.
Probe timer precision only after all stages. Any cold observation below
max(1,000 ns, 100 × p99 timer-pair cost) invalidates that stage; never substitute
more operations to rescue it.

For every stage show all eight block-level absolute deltas, mean absolute delta,
df=7 95% absolute interval, median delta, ratio and ratio interval, plus A/A
absolute intervals. No percentage-only cold acceptance, warm 2% cold label,
stage pooling, or fabricated break-even division. Invalid adverse observations
stay prominent even though they cannot support accepted effect estimates.

## Source/output and fresh correctness gates

Use the unchanged standard WASM, portable, and declaration builders in fresh
baseline and candidate checkouts. Every production source and build script must
match its committed identity. Only shared-text-reader.as.ts may differ. Require
12 baseline/12 candidate root WASMs, nine core copies changed by identical bytes,
three other binaries byte-identical; imports/exports and every non-code section
must match. Exactly textContains16 may change among 81 emitted function bodies.
All 80 sibling functions, including the batch wrapper, must be byte-identical.
Baseline core SHA-256 is
`b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4`;
candidate core SHA-256 is
`383a99278cb1eae78a164489493c71eeb2a0cea3b3edb3db47349fe5e54b0647`.

Manifest every complete dist file, all sources, build scripts, proof scripts,
compiler inputs, executable hashes and version identity. Stage only static
shared.js import closures plus a private ESM marker. Reject symlinks, extra files,
unaccounted imports and hidden build/control artifacts. Each closure must embed
exactly its one intended core. A/A inventories must match exactly. Report raw
core, complete-dist and reachable-JS changes plus per-file gzip byte overhead;
gzip is a reproducible size descriptor, not network transfer or startup latency.
Retain all 24 WASM output files and every runtime closure in the evidence.

Before calibration, freshly run both roles' scoped Node screen gates: all builds,
typechecks (including text consumer), complete Vitest unit/integration suite,
Node worker/list/memory proofs, documentation links/examples and the existing
worker-documentation --node-only check, portable entries, installed package check and historical evidence verification.
Vitest uses a separate fresh task-generated results cache for each role, seeded
with byte-identical empty results JSON. Its only configuration override is
cacheDir; the original standard concurrency, isolation, assertions and timeouts
are inherited unchanged. Retain original/generated config hashes and before/after
cache receipts. This prospectively prevents the shared node_modules results cache
(project-name/relative-filename keys) from importing another arm's ordering history.
This is gate hygiene and does not revise any earlier failed block evidence.
Then run scalar bounds/oracle proof under Node and Bun, existing public text
proofs on both arms, cross-format/attachment proof, all 48 fixture checks, and
synthetic statistical/control tests. These are serial. A missing dependency or a
failure in these scoped required checks is recorded as a blocker, never skipped to run timing. This exploratory
Node lane does not require the separate browser or website UI matrix. The local
missing-Chromium checks remain explicitly unpassed broader evidence, and no full
repository CI or browser clearance is claimed. Any later PR still requires its
full required exact-head CI and broader portability evidence. Prepare retains every
check's stdout/stderr/status and hashes them into a gate receipt tied to the manifest. Timing verifies that receipt before clock
sampling. No existing historical correctness receipt substitutes for fresh gates.

`scalar-text-screen-prepare.mjs NEW_OUTPUT BUN` performs only preparation/checks.
The timing runner defaults to `check`, rejects non-GitHub-hosted timing, requires
a clean exact committed proof tree and explicit SCALAR_TEXT_SCREEN_REVIEWED_TREE
matching the manifest, and requires every gate to pass. The dedicated branch
push is a reviewable execution path only. This preparation does not authorize
publication or execution.

### Immutable guarded push activation

A newly added workflow cannot rely on workflow_dispatch discovery from the
default branch. Instead, first create `proof/scalar-text-screen-20261009` exactly
at published runtime `3efaa3bb110f1d4e979d279aec12f52e2b37731b`. Branch creation
must not run this screen. Only after independent review of the complete final
proof tree may the publisher advance that branch by one direct proof commit.
That commit's final nonempty message line must be exactly
`Reviewed-Tree: <the independently reviewed 40-hex source tree>`.

The commit message is outside the source tree, so this immutable attestation has
no self-referential hash. The reviewer records the tree before publication; the
publisher copies that exact tree into the trailer without modifying the tree.
No mutable repository variable, inferred HEAD value, or runtime-only tree is an
acceptable substitute. A local proof commit without the trailer is deliberately
not an activated commit, even when its source tree is otherwise ready.

Both workflow and executable guard require a push on that exact branch in
`natanelia/zerocopy`, created=false, deleted=false, forced=false,
event.before equal to the published runtime, and GitHub run_attempt=1. The
executable guard additionally requires a single direct runtime parent, the
unchanged b4e060c runtime tree and ad2 baseline parent check, and equality of the
push after/head_commit ID, GitHub SHA, and checked-out HEAD. Event and Git commit
messages must agree. Exactly one valid final Reviewed-Tree trailer must equal
HEAD^{tree}. Missing/malformed metadata fails closed. Validation runs before
dependency installation, fresh correctness, and clock sampling, and is repeated
in timing children. Its receipt is retained. Workflow reruns, branch creation,
subsequent proof updates, force pushes, wrong repositories/refs/trees and missing
trailers cannot activate another screen. Do not reset/recreate the branch to
manufacture another eligible event after observing a result.

The proof source manifest pins published runtime identity plus exact source
bytes. Superseded local identity 5a55e9c0fbbc8b9f8315d040e8b394551f34ebb1 and proof
0f9ed0892d1ce93f17b85dbf931c0558a730b881 remain historical receipts; their runtime
tree and every fixture/statistical rule are unchanged by this publication fix.

After the one fixed screen, stop and review the dense gains, every adverse
control, cold costs, file overhead, drift, floors and uncertain controls together.
Small-sample pointwise intervals on one host/day are not simultaneous guarantees
or between-host replication. Inconclusive findings authorize no extension.
