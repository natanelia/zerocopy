# Clean CI adapter for the focused primitive-tail diagnostic

This adapter moves the reviewed, prospective three-case diagnostic to clean
GitHub-hosted Linux x64 CI. It does not change the controller, protocol, subject,
workload kernels, semantic probe, numerical auditor or any reference bytes in
`proofs/object-tail-screen`. That entire directory, excluding only its original
intent file as previously specified, must retain reviewed SHA-256
`f814ddaca8d22056be8ef5c063d8d2dcfe0851af7e6f651c3108e96b43293fad`.

Runtime comparisons remain historical: baseline
3773c6e519c7c0958da13727ed1082f449f3ee25, original candidate
042b41a7f68a89a10751f285eef79259adfe4aa3, refinement
25b55f5dfacb926dc3d7354234c6d69326329071. Current-main integration is separate.
The adapter does not claim a full suite, global performance clearance, or PR
readiness. The original campaigns remain separate evidence.

## Two clean CI runs, one possible measurement campaign

1. Publish the independently reviewed proof tree with the CI intent file still
   `measure:false`. A push on `perf/object-read-simplified-tail-20261009` runs one
   checks-only job. No pilot or latency measurement is permitted in this state.
2. Review that exact first-attempt push run, its complete build/check evidence,
   and the small check-reference artifact. Record the successful check commit,
   run ID, artifact ID, downloaded ZIP SHA-256, exact manifest SHA-256, original
   harness digest and adapter digest. The adapter digest covers this directory
   except its intent file, plus the workflow bytes.
3. One direct-child activation may change only `proofs/object-tail-ci/intent.json`
   to `measure:true` and fill those identities. The push's prior head must be the
   validated check commit, and activation must have exactly one parent. Every
   intent blob in the full, unsimplified reachable commit history must have
   been checks-only, including side branches hidden by an ours merge. Rerun
   attempts, force pushes and manually dispatched activated revisions cannot
   start measurements.
4. The new runner verifies the exact prior successful run/job/steps and artifact
   read-only through GitHub. Named checks must actually have succeeded and the
   timing step must have been skipped. An empty/skipped successful workflow is
   insufficient. The artifact must belong to that exact run and commit, be
   unexpired, and match the independently recorded ZIP and manifest hashes.
   A separate read-only workflow-start check rejects an earlier run of the same
   activation commit or any previous activation on this branch, even if Git
   history was rewound. It inspects the complete workflow-run listing and exact
   committed intent files, retaining API responses and a status receipt. The
   bound is 20 runs, at most one listing plus 19 distinct intent reads, and a
   three-minute verification budget. Truncated/oversized history, an absent
   current run, unavailable prior intent, or any uncertainty fails closed.
5. The activation job fresh-installs, rebuilds and reruns the same narrow checks
   on its own clean runner. Only after all checks and the cross-run identity
   reconciliation pass does it activate the copied controller intent and start
   the single bounded measurement campaign.

The initial committed CI intent is checks-only and all approval fields are
empty. No remote write or timing is part of adapter preparation.

## Prospective resolution of the manifest/environment constraint

The old local executor manifest is never used as CI timing approval. Its tests
remain local preparation evidence. The checks-only CI artifact supplies the
reviewed CI manifest, and activation validates its exact bytes.

An activation runner necessarily has new CPU/kernel/path metadata. This
adapter prospectively permits only `environment.cpus`, `environment.release`,
`environment.totalMemory`, and `environment.execPath` to differ between the two
CI manifests. Their complete source/build/lock/compiler/harness/settings/plan
identities and runtime executable SHA-256s must remain equal. Node/Bun versions,
platform, architecture, all other environment keys, all fixture bytes and
descriptors, package digests, work counts and checksums must also match. A new
environment key is not silently ignored. The full previous and current
environment objects and both manifest hashes are retained in a transition
receipt before timing.

The copied controller's intent is then bound to the exact successful manifest
from the activation job itself. Its unmodified check-to-measure guards still
compare that same runner's binaries/builds/harness/kernel metadata. This
reconciliation is an explicit part of the prospective adapter review, not an
exception invented after seeing timings. Only the copied intent is changed;
the committed reviewed harness remains byte-identical.

## Narrow checks and fresh builds

- Fresh dependency installation uses the original frozen lock, with SHA-256
  `9a66d94c2fbd6c9d37917c53264f8c08ac58a42a6c75eb425dd905539eb1a1fe`, and
  `bun install --frozen-lockfile --ignore-scripts`.
- Three isolated worktrees are checked out at the exact commits. Every role
  freshly runs unchanged `build:wasm`, `build:browser`, `build:types` and
  `typecheck`. Unlike the original local preparation, CI recompiles WASM and
  must reproduce the already frozen expected hashes. Reference mismatch fails;
  no newly observed hash is substituted.
- The unchanged deterministic protocol tests run on Node 22.23.3 and Bun 1.4.2.
  The unchanged semantic probe runs 15 scenario groups per role. The existing
  focused Vitest file runs 21 tests per role, with the unchanged baseline test
  overlay and declared baseline slot-count expectation of three; the other
  two roles expect one. No test timeout, test configuration, runtime source or
  assertion is changed.
- All 18 original neutral-path fixture checks run. The exact original
  controller validates source, compiler, all 53 dist files per role, all 12
  generated WASM files per role, full fixture identities and default runtime
  settings before any pilot.
- Adapter tests use synthetic data, fake API responses and disposable tiny Git
  histories. They do not contact GitHub, compile runtime code or run a benchmark.

## Bounds and evidence

The workflow has one `ubuntu-24.04` job, read-only contents/actions permissions,
a unique concurrency group, no cancellation of another run and a 60-minute job
ceiling. The original campaign remains 240 fresh Bun measured processes, nine
pilots, 21 batches per measured process and a 30-minute campaign ceiling,
including pilots. Its expected timing phase remains approximately 8–12 minutes;
fresh build/check and artifact time is additional. The outer campaign command
has a 35-minute fail-safe, leaving the unchanged 30-minute budget in charge.
Dependency installation and each WASM build have 300-second command caps;
other individual build/test commands have 120-second caps, and fixture checks
have 300 seconds. Ordinary completion is expected well before the job ceiling.

Every external command has start, complete/failed exit and raw combined-log
receipts. Explicit test-only environment settings are retained, never tokens.
Source Git archives/tree inventories, compiler/lock/build identities, original
and activated intents, complete and partial dist/WASM bytes, neutral packages,
all raw subject receipts, and any prior-reference verification data are archived.
External node_modules symlinks and mutable worktrees are excluded; source
snapshots and build outputs are retained separately. Failure/timeout output is
never replaced or converted into a successful result. Partial stdout from the
unchanged controller remains in its existing per-subject receipts.

The always-run retention step independently audits any started campaign,
creates the evidence archive and its SHA-256, then fails if the raw audit is
incomplete or invalid. Auditor launch errors and timeouts are caught; partial
stdout/stderr and a failed audit-status receipt are retained, and archive plus
SHA creation still precedes failure. The final evidence upload is always attempted. A hard
runner loss or GitHub job termination can prevent retention/upload; that run
must stay incomplete and cannot justify a timing rerun. The small check
reference is uploaded only after all required steps succeed. Check and
measurement artifacts are retained for 30 days.

No local heavy timing, current-main integration, broader case matrix, additional
engine timing, profiling, PR creation, or unrelated workflow modification is
included.
