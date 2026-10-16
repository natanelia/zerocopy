# Direct native reader correctness

This is a correctness-only comparison against commit
`afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. It reuses the successful gate from
[run 38869133422](https://github.com/natanelia/zerocopy/actions/runs/38869133422),
with a distinct candidate, proof directory, workflow and branch. No performance
conclusion follows from this check. The predecessor's separate performance
study does not supply an accepted result for this successor.

The exact candidate has 504 repository source files before adding this gate.
Its 16-file delta from the baseline comprises eleven runtime files, three test
files and two worker guides. The original session attachment change in
`worker.ts` is retained unchanged. This successor uses direct internal native
reads and lazily owned real raw exports; it adds no public opt-in. All source
bytes are bound by `source-pins.json` plus the complete baseline inventory.
The full candidate checkout with this gate has 518 tracked files.

The source manifest authenticates the complete baseline, overlay and workflow.
One push to `proof/direct-native-reader-correctness-20261016` must advance the
baseline, and the selected commit must have that baseline as its direct parent.
Only the first attempt is admitted. No other workflow trigger is present.

The process supervisor, headroom reader, artifact checks, dependency manifests,
baseline source inventory and repaired temporary-accounting helper are reused
byte-for-byte. Candidate source hashes and test-file selectors are bound to the
new implementation. The gate keeps the same 32 planned targets, final package
archive and ten setup/metadata commands: 43 supervised commands in total.

Both arms use Node.js 22.16.0, Bun 1.4.2, the same locked dependency installation,
unchanged repository build flags, and fresh outputs. They each receive WASM,
browser-bundle, declaration, standard TypeScript, Redux, typed-value, geometry,
and public worker-consumer type checks. Both run the ordinary `bun run test`
script without changing Vitest settings. Node runs the existing worker,
attachment, record, descriptor, checkpoint-descriptor and traversal suites.
The candidate adds `native-reader.test.ts` and `direct-native-reader.test.ts`
to that same Node command, requiring exactly eight selected suite files. The
frozen source adds ten registrations to the predecessor: nine direct-reader
cases and one native-ceiling/error-ordering session case. Expected totals are
1,074 Bun tests across 52 files and 252 selected Node tests across eight files;
baseline totals remain 1,055 / 50 and 233 / 6. These counts are source-derived
expectations, not observed results. The report predicates remain the same: a
successful nonempty report with zero failures and the exact expected file set.
The inherited gate does not newly enforce aggregate totals. The ceiling case
uses a synthetic capacity seam, not a real oversized-memory transport.

The existing public `proofs/worker-sessions.mjs` runs on each arm. It exercises
two real workers, all twelve built-in types, nested data, memory growth,
descriptor-only later publications, retained snapshots, compaction and Redux
publication. Both arms also run `node-worker.mjs` and `typed-json-worker.mjs`.
The candidate receives the existing Redux proof, documentation checks, package
dry run and packed-package consumer check. A local package archive is retained;
no registry publication is performed. Browser bundles are built and their
embedded native bytes authenticated; this packet does not run Chromium or
claim browser runtime validation.

Only `candidate-package-consumer` receives a fresh dedicated TMPDIR. The shared
TMPDIR is restored afterward, including on failure. The unchanged package
script creates a top-level `zerocopy-package-*` workspace and removes it in its
own `finally`. Once the owned process group closes, the controller checks both
scopes for that prefix before any harness deletion. A residual is terminal and
retained; deleting it cannot turn the package check into a pass. A secondary
inventory failure cannot replace the original command failure.

Every checkpoint enumerates its root completely before visiting descendants.
It retains at most 512 records and 128 KiB per scope, with depth eight and a
five-second deadline. Root records consume the allowance first. Descendants
use only the remainder and are explicitly a potentially truncated diagnostic
sample. Both roots need complete package-prefix coverage at every applicable
checkpoint. Incomplete root coverage, unsupported entries, identity errors,
package residue or late persistence are terminal. Metadata contains relative
names, types, sizes and numeric identities, with no contents or followed links.

The inherited cleanup reserve remains 8,192 entries and 2 MiB serialized
metadata across both complete postorder plans, including headers, completion
trailers and the pair-completion record. The separate append-only journal is
limited to 2 MiB. Its historical finite sizing references were 502 baseline
source files, 517 predecessor candidate files, 2,301 project-dependency entries
and 2,379 official Node 22.16.0/npm 10.9.2 regular files. Their sum was 5,699;
adding 512 directory records gave 6,211, rounded to 8,192. These figures explain
the unchanged engineering reserve, not the successor's exact source count or a
guaranteed bound on generated scratch. Exhausting either plan limit is terminal.

Final cleanup is one transaction for both original root identities within the
existing ten-second allowance and 1,620-second whole-run deadline. Both complete
plans must be durably written within five seconds before any removal. They bind
each path, ancestor and leaf identity, per-record and complete-file digests,
counts and serialized sizes. Both roots receive another complete prefix check
before the first removal. No partial plan authorizes deletion.

Removal uses no-follow descriptor-relative traversal and checks current ancestor
and leaf identities against each authenticated record. Symlinks are unlinked
without visiting destinations. Journal records and prospective byte budgets are
checked before removal; bounded buffered fsyncs preserve confirmed removal
acknowledgments. Interrupted deletion or journaling can leave an uncertain tail
and remains incomplete. Independent complete empty-after observations must pass
for both scopes, and the actual journal descriptor, identity, size, digest and
acknowledgment count are authenticated afterward. A late durable write invalidates
completion. No pathname-based cache exemption is added.

The inherited pure-Python synthetic tests cover large subtrees, package prefixes,
cross-scope ordering, finite limits, identity substitutions, symlink containment,
journal I/O and mutation failures, deadlines, first-failure preservation and
independent empty-after checks. The selected-report regression covers exact
suite-file coverage and rejects missing/extra suites, failure and zero-test
reports. These synthetic checks import no repository target module and do not
execute the hosted admission.

The Linux supervisor retains each process-group leader until descendants have
been checked. It samples group RSS every 50 ms, checks observed per-process
high-water RSS, and stops at 4 GiB. This is a sampled guard, not a kernel-enforced
allocation ceiling. Before every command, the same cgroup-aware reader must
resolve memory accounting and observe at least 6 GiB effective available memory.
Insufficient or unavailable accounting rejects the command.

The whole admission, including dependencies, source hashing, builds, checks,
cleanup and evidence sealing, has a 1,620-second deadline. Each full Bun suite
has 600 seconds; focused Node suites and WASM builds have 120 seconds; other
builds and type checks have 60 seconds; worker proofs have 60 seconds; package
consumer and dependency installation have 180 seconds. Metadata commands have
10 seconds. Two seconds of each command allowance are reserved for cleanup.
Each command's entire allowance must fit the remaining whole budget. The first
unexpected failure, memory rejection, timeout or incomplete cleanup terminates
the run without retry. Budgets and permissions are unchanged.

Evidence records complete source and executable SHA-256 hashes, dependency-file
hashes, exact commands, selected-suite reports, headroom observations, output,
return codes, cleanup receipts and built artifact hashes and bytes. Native
artifacts must match across arms because native sources are unchanged. Portable
bundles must embed freshly built native modules. Source, runtime, dependency and
output hashes are rechecked after validation. Success requires a zero controller
exit, complete status, empty owned process groups and the final evidence seal.
Elapsed values enforce safety budgets only; there is no timing or calibration
study. Only public repository sources and synthetic data are used. Logs may name
ephemeral hosted checkout, toolchain and test paths. Runtime `RUNNER_TEMP` supplies
temporary paths; the workflow guard rejects runner-context expressions and
job-level environment blocks.
