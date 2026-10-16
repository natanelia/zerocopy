# Checkpoint registry correctness

This is a correctness-only admission against main commit
`afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`, tree
`eb3bd4217f132e13b01c42f9b9c6bdc5aa92afab`. The only implementation delta is
`redux-checkpoint.ts`; the only changed test is
`checkpoint-descriptor-validation.test.ts`. The exact patch SHA-256 is
`30d410b9c2d0c8bded13733e16dce2a3c3641e6738b6d3b2c1709ec1b9121721`.
This gate contains no comparative timing or performance acceptance criterion.

The candidate uses the existing Arena registry when decoding at least two
captured arenas whose retained keys are strings. Zero/singleton imports and
nonstring captured keys retain the original eager setup. Validation walks,
limits, descriptor factories and fresh-identity compaction are unchanged.
Ordinary checkpoint encoding compacts into at most one arena; this proposal
does not establish a general Redux or returned-state memory benefit.

## Exact sources and command plan

The complete 502-file baseline inventory, the two-file candidate delta and every
gate source are authenticated. The workflow runs only on one push from the
baseline to `proof/checkpoint-registry-correctness-20261016`; the selected
candidate must have the baseline as its direct parent and run attempt one.
Clean tracked sources, exact changed paths and source hashes are checked before
dependencies or target execution. No other workflow trigger is present.

There are 31 supervised commands: eight Git/runtime metadata commands, one
baseline checkout, one locked dependency installation, 20 target checks, and one
final local package archive. No package is published to a registry.

The 20 target checks are ordered as follows:

1. On exact baseline, then exact candidate: `bun run build:wasm`,
   `bun run build:browser`, `bun run build:types`, `bun run typecheck`, and
   `bun run typecheck:redux`.
2. On baseline, then candidate: focused Node Vitest, focused Bun Vitest,
   the ordinary unchanged `bun run test` full suite, and
   `node proofs/redux-node.mjs` against portable package exports.
3. Candidate `npm pack --dry-run --ignore-scripts --json` and
   `node scripts/check-package.mjs`.

Both focused commands select exactly `redux-checkpoint.test.ts` and
`checkpoint-descriptor-validation.test.ts`. Node invokes
`node node_modules/vitest/vitest.mjs run`; Bun invokes
`bun --bun node_modules/vitest/vitest.mjs run`. Both pass those two filenames,
`--reporter=json`, and a unique evidence output path. Successful nonempty reports
with zero failures and the exact expected file set are required. Aggregate
counts are documented expectations, not an additional inherited predicate.

For each baseline focused command only, the controller temporarily installs the
exact candidate checkpoint-descriptor regression text. Baseline production,
the other selected test, all build inputs and dependencies remain unchanged.
The controller authenticates the original and replacement bytes, records a
pending receipt before mutation, and records installed/unrestored state before
the child starts. Its own `finally` restores and authenticates the original
baseline test, including after installation failure, child failure, interruption
or memory rejection. Restoration is outside the supervised child process group.
A restoration failure is terminal and cannot replace an earlier primary error.
An abrupt controller kill leaves incomplete receipts/status and cannot permit
any later target command or a successful admission.

Both baseline compatibility commands must have authenticated restoration before
the original baseline full Bun suite starts and before final source/artifact
authentication. Thus baseline builds, typechecks, full suite and portable Redux
proof use exact main. The baseline compatibility runs and candidate focused runs
use the same regression tests. Expected focused inventory is 152 tests in two
files: 34 ordinary checkpoint tests and 118 descriptor tests, six more descriptor
cases than baseline. Expected full Bun inventory is 1,055 tests / 50 files on
exact baseline and 1,061 / 50 on candidate. These are source-derived expectations;
preparing this packet does not execute any target test.

## Retained safety and artifact checks

The process supervisor, effective-headroom reader, artifact checker, temporary
scope accounting and its 25 synthetic cases, baseline inventory and dependency
manifests are copied byte-for-byte from the preceding correctness packet. The
workflow guard changes only its branch/proof identity strings. The predecessor's
production overlay is not included. Additional synthetic checks cover the
two-file selectors, the smaller command plan and temporary regression transplant.

Both arms use official Node.js 22.16.0 and Bun 1.4.2, one locked installation from
the official npm registry, unchanged build flags and fresh outputs. All native
modules and portable bundles are authenticated; bundles must embed the newly
built native bytes. Native artifact hashes must match across arms because no
native source changes. Declaration artifacts, portable exports, Redux state
restore, the packed package's Node/Bun imports, immutable snapshots, Node worker
sharing and TypeScript consumers remain checked. Browser bundles are built;
Chromium execution is outside this gate. Unrelated geometry-specific typechecks,
worker-specific typechecks/proofs and documentation checks are omitted from this
smaller patch's command plan.

Before every command, the cgroup-aware reader must resolve memory accounting and
observe at least 6 GiB effective headroom. The supervisor samples owned-group RSS
every 50 ms, also checks observed per-process high-water RSS, and stops at 4 GiB.
This remains a sampled guard, not a kernel-enforced allocation ceiling. It keeps
the original group leader unreaped until descendant checks complete. Unexpected
survivors, incomplete process cleanup, memory rejection, timeout or first command
failure terminates the run without retry.

The whole admission, including setup, hashing, commands, cleanup and evidence,
has a 1,620-second deadline. Full Bun commands allow 600 seconds; focused tests
and WASM builds 120 seconds; other builds, typechecks, Redux proofs and packing
60 seconds; dependency installation and package consumer 180 seconds; metadata
10 seconds; baseline checkout 30 seconds. Two seconds of every command allowance
are reserved for cleanup. The complete allowance must fit the remaining whole
budget. Elapsed values are retained only to enforce these safety bounds.

The package consumer uses a fresh dedicated TMPDIR; the shared TMPDIR is restored
on both success and failure. After the owned group closes, both scopes are
checked for `zerocopy-package-*` residue before any harness deletion. Residue
remains a failure even if later deleted. A secondary inventory failure preserves
the first command failure. Temporary observations retain relative names, types,
sizes and numeric identities only, never private file contents or followed links.

Root-first temporary accounting retains the existing limits: 512 records /
128 KiB per checkpoint, depth eight and five-second scans. Complete root coverage
and both-scope package-prefix checks are mandatory; descendant sampling may be
truncated but cannot hide root entries. Cleanup is one ten-second transaction
inside the whole deadline. Two complete authenticated postorder plans must be
durably written before any deletion, bounded together by 8,192 entries and 2 MiB.
The separate append-only removal journal remains bounded by 2 MiB. Identity
changes, incomplete plans, unsupported entries, deadline expiry, interrupted
deletion/journaling, late persistence or nonempty final scopes are terminal.
No-follow, descriptor-relative removal and independent final empty observations
are unchanged. Failed runs preserve available partial evidence and cannot use
cleanup to turn failure into success.

After validation, all source, executable, dependency and built-output hashes are
rechecked. Success requires complete status, zero controller exit, empty owned
process groups, complete temporary cleanup and a final evidence seal. Artifacts
contain public repository/gate sources, synthetic test output and resource/cleanup
metadata. The workflow has read-only contents permission and retains complete or
partial evidence for 30 days.
