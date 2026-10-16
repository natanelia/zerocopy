# Native reader reuse correctness

This is a correctness-only comparison against commit
`afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. The source delta is limited to
`arena.ts`, `worker.ts`, `worker.test.ts`, and `native-reader.test.ts`.
The source manifest authenticates the baseline, the complete overlay, and the
workflow. One push on the exact proof branch must advance the baseline; the
selected commit must also have that baseline as its direct parent. No performance conclusion follows from this check.

The original correctness run, 38858529188, remained incomplete. Its baseline
focused Node report recorded 233 passed tests and zero failed tests in six files,
but the controller expected only five files and stopped at the coverage check.
Vitest's `descriptor-validation.test.ts` substring selector also selected
`checkpoint-descriptor-validation.test.ts`. This successor explicitly includes
that already-selected checkpoint suite in the command's selector list and its
expected coverage. The candidate also requires `native-reader.test.ts`. The
earlier run remains incomplete; no later stage is inferred to have passed.

The corrected run, 38860107844, passed all 43 child commands and the final
source, runtime, output, and dependency rechecks. It still remained incomplete:
the final assertion found entries in the TMPDIR shared by all commands. The
retained evidence did not inventory those entries or identify their producers.
Their nature and cause remain unknown.

This successor gives only `candidate-package-consumer` a fresh dedicated TMPDIR
and restores the shared TMPDIR afterward. The unchanged package script creates
a top-level `zerocopy-package-*` workspace and removes it in its own `finally`.
After the consumer's owned process group has closed, the controller checks that
no such top-level entry remains, before any harness deletion. A residual is
terminal and is retained; deleting it cannot turn that check into a pass.

Run 38863704317 also remained incomplete. Before package execution, its shared
recursive snapshot reached 512 entries under a directory named node-compile-cache:
two directories and 510 files, 64,920 metadata bytes, depth three. The full count
and the remaining root entries were unknown. The package scope was empty; its
consumer and the final cleanup never ran. That pathname and a possible npm
producer mechanism do not establish every entry's producer or harmlessness.

This revision enumerates each root completely before visiting descendants.
Each checkpoint retains at most the existing 512 records and 128 KiB per scope,
with depth eight and a five-second deadline. Root records consume that allowance
first; ordinary descendants use only the remainder and are explicitly marked as
a potentially truncated diagnostic sample. Both roots must have complete
package-prefix coverage at every applicable checkpoint. An incomplete root
pass, unsupported entry, identity error, package residue or late persistence is
terminal; a diagnostic sample reaching its declared budget is reported honestly.
Metadata contains relative names, types, sizes and numeric identities, with no
contents and no followed symlinks.

Only the final recursive accounting reserve changes: both cleanup plans together
permit 8,192 entries and 2 MiB serialized metadata, including headers, completion
trailers and the pair-completion record. Depth eight remains unchanged. The
finite sizing references are 502 baseline source files, 517 audited candidate
files, 2,301 project-dependency entries and 2,379 official Node 22.16.0/npm 10.9.2
regular files, including 1,231 JavaScript files. Their sum is 5,699; adding 512
directory records gives 6,211, rounded to 8,192. This is an engineering reserve,
not a guaranteed bound on generated scratch or evidence of its contents. The
full hosted npm tree was not retained. Exhausting either plan limit is terminal.

Final cleanup is one transaction for both original root identities, inside the
existing ten-second cleanup allowance and 1,620-second whole-run deadline. Both
complete postorder plans must be durably written within the five-second
inventory allowance before any removal. The plans authenticate each path,
ancestor and leaf identity, per-record and complete-file digests, counts and
serialized sizes. Both roots receive another complete prefix check before the
first removal. No partial plan authorizes deletion.

Removal uses no-follow descriptor-relative traversal and validates the current
ancestor and leaf identities against each authenticated record. Symlinks are
unlinked without visiting destinations. An append-only journal records confirmed
removals and has a separate 2 MiB cap, including headers and closure. Each record
and its prospective byte budget are checked before the removal. Bounded buffered
fsyncs replace per-entry whole-receipt rewrites. The journal and plan capacities
are explicit additional finite evidence retention; process-memory limits do not
change. Interrupted deletion/journaling can leave an uncertain tail and remains
incomplete. New unplanned entries are retained and independently complete
empty-after checks must succeed for both roots. A late durable write invalidates
completion. No unknown entry receives a pathname-based cache exemption.

Pure-Python filesystem tests cover the demonstrated large subtree, package
prefixes at every checkpoint, cross-scope plan failures, metadata limits,
root/ancestor/leaf/plan substitutions, symlink containment, journal capacity and
I/O failures, deadline failures, and independent empty-after verification.

The report's two validation predicates are unchanged. A small pure-Python
regression uses synthetic paths to reproduce the six-file baseline report shape
and the seven-file candidate shape: the original expected sets reject them and
the corrected sets accept them. Missing or extra files, failed reports, and
zero-test reports remain rejected. It imports no target modules. Production code,
target tests, dependency versions, all other commands, admission rules, process resource
limits, and process cleanup are unchanged. The successor uses the new isolated
branch `proof/native-reader-reuse-correctness-accounting-20261016` with the same
baseline-before, direct-parent, exact-source, and first-attempt checks.

Both arms use Node.js 22.16.0, Bun 1.4.2, the same locked dependency installation,
unchanged repository build flags, and fresh outputs. They each receive the WASM,
browser bundle, declaration, standard TypeScript, Redux, typed-value, geometry,
and public worker-consumer type checks. Both run the ordinary `bun run test`
script without changing Vitest settings. Node also runs the selected existing
worker, attachment, record, descriptor, checkpoint descriptor, and traversal suites. The candidate adds
its native-reader facade suite to that selection.

The existing public `proofs/worker-sessions.mjs` runs on each arm. It exercises
two real workers, all twelve built-in types, nested data, memory growth,
descriptor-only later publications, retained snapshots, compaction, and Redux
publication. Both arms also run `node-worker.mjs` and `typed-json-worker.mjs`.
The candidate receives the existing Redux proof, documentation checks, package
dry run, and packed-package consumer check. A local package archive is retained;
no registry publication is performed. Browser bundles are built and their
embedded native bytes authenticated; this packet does not run Chromium.

The Linux supervisor retains the original process-group leader until its
descendants have been checked. It samples group RSS every 50 ms, checks observed
per-process high-water RSS, and stops at 4 GiB. This is a sampled guard, not a
kernel-enforced allocation ceiling. Before every child command, the existing
cgroup-aware resource reader must resolve memory accounting and observe at least
6 GiB effective available memory. Insufficient or unavailable accounting rejects
the command.

The entire admission, including dependency preparation, source hashing, builds,
checks, cleanup, and evidence sealing, has a 1,620-second deadline. Each full
Bun suite has a 600-second allowance; focused Node suites have 120 seconds;
WASM builds have 120 seconds; other builds and type checks have 60 seconds;
worker proofs have 60 seconds; package consumer checks and dependency installation
have 180 seconds. Metadata commands have 10 seconds. Two seconds of each command
allowance are reserved for cleanup. A command starts only if its full allowance
fits the remaining whole-run budget. Per-command maxima are not additive
extensions to that budget. The first unexpected failure, memory rejection,
timeout, or incomplete cleanup ends the run without a retry.

Evidence records source and executable SHA-256 hashes, dependency file hashes,
exact commands, selected-suite reports, headroom observations, command output,
return codes, cleanup receipts, and built artifact hashes and bytes. The native
artifacts must match across arms because this source delta changes no native
code. Portable bundles must embed the freshly built native modules. Source,
runtime, dependency, and generated output hashes are rechecked after validation.
Successful completion requires a zero controller exit, a complete status, empty
owned process groups, and the final evidence seal. Elapsed values exist only to
enforce safety budgets; this packet performs no timing study or calibration.

Only public repository sources and synthetic test data are used. Logs may name
ephemeral hosted checkout, toolchain, and test paths. The workflow derives its
temporary directories from runtime `RUNNER_TEMP`; a static guard rejects
runner-context expressions and job-level environment blocks.
