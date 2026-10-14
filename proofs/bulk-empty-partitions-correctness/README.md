# Native empty bulk partitions: ordinary correctness gate

This distinct proof checks the frozen two-file patch against main
`afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. It runs ordinary correctness only:
no benchmark, timing study, calibration, production merge, or package publication.
Preparation has not executed the library, built outputs, run tests, or published
this packet. A separate review and release must precede the one hosted attempt.

The patch changes only `persistent-core.as.ts` and `bulk-input-storage.test.ts`.
Its SHA-256 remains
`03fd0b9536faf3d0e75a60c95d2aca98f593701a9a739dfb81ef6e9b051a2301`.
For each batch digit, the runtime retains the count load and child read, then
skips both recursion and result accumulation only for count zero. Child emission,
start advancement, allocation, scratch handling and publication are unchanged.
The existing top-level zero-count path remains. The added three public setMany
cases cover ordinary sparse nested keys, mixed insertions/replacements,
duplicates, sizes, retained snapshots and published bytes.

## Source and build prerequisites

The existing ordinary hosted correctness controller/workflow pattern is reused.
The exact proof commit must have fixed main as its direct parent. The controller
archives that main source into two isolated arms. It applies the frozen combined
patch to candidate and the exact test-only patch to baseline. Thus both arms run
the identical augmented bulk test, and only `persistent-core.as.ts` differs
between them. Both complete source inventories must contain 502 files; all
changed files and all 50 test file hashes are checked before any build.

Both arms receive fresh ordinary native builds through the unchanged
`scripts/build-wasm.mjs`. Old native outputs are removed first. The baseline
persistent core must reproduce authenticated SHA-256
`08b1e91c9ee6d3602c0a100f449f51555ee35e5641e1839b7f719d016c209d90`.
Each arm's eight legacy core filenames must equal its persistent-core bytes.
Candidate core bytes must differ from baseline. Scalar/SIMD numeric kernels,
geometry WASM and geometry WAT must remain byte-identical across the fresh builds.
No alternate build flags, runtime patch or held experimental source is used.

Both arms also receive fresh portable builds and declarations. This explicitly
clarifies the earlier source report: rebuilding native WASM alone cannot support
worker evidence. `scripts/build-browser.ts` embeds each arm's exact native core.
Before importing either portable entry, the controller decodes its loadWasm
literal, requires byte-for-byte equality with that arm's fresh native output,
and follows the static dependency graph from `dist/shared.js` to the verified
embedded core. Worker proofs and the packed consumer therefore use matching
portable bytes. Generated outputs are frozen after declaration emission and
checked before and after subsequent commands. No sorted-callback artifact ZIP,
measurement payload or generated output is bundled or reused.

## Native evidence before library imports

The pinned Binaryen disassembler runs once per fresh core. Both complete WAT
files, their diff, and native-output hashes are retained. A narrow structural
reader compares import/export names, kinds and function signatures. It identifies
the recursive batch function by its five parameters, recursive call and scratch
frame constant, not a fixed function number.

The emitted candidate must have the per-digit count read followed by the child
read outside the nonzero guard; that guard must contain both the recursive call
and the private result read. The child-read expression, child emission/start
tail, and top-level zero path must match baseline structurally. The comparison
ignores local register numbering and preserves exact expressions for inspection.
It is a deliberately narrow shape check, not a general WASM equivalence proof.
Unrecognized output fails closed and is retained; it does not trigger a retry.
An independent emitted-code review remains required even if this shape check and
the ordinary tests pass, including verification of register roles and memory,
scratch and allocation order.

## Runtime and test inventory

The gate uses the already authenticated official Node 22.16.0 executable,
SHA-256 `8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d`,
and Bun 1.4.2,
SHA-256 `a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c`.
The workflow's setup-node action is commit-pinned. Bun and existing development
dependencies come from the reused integrity-bearing npm lock, with install
scripts disabled. Only the toolchain package's descriptive name changes; no
dependency version, resolution or integrity changes. Binaryen's installed
disassembler must hash to
`d1ea59ca56e9587b5f68d4e6c10db61ee42a55826008bea6b8e5fdeed932bfe8`.
There is no new runtime download or local installation during preparation.

`BULK_INPUT_ARM=candidate` is used for both experiment arms. This existing marker
describes the historical generic staging implementation already present in
main; it does not name the new experiment arm. The optional historical
`BULK_INPUT_RUNTIME` marker stays unset for ordinary unit tests. Its conditional
Node 22.23.3 assertion is preserved without being enabled; it is not a library
compatibility requirement. The controller verifies executable versions/hashes
and actual child runtime fields in each bulk report. The existing bulk worker
proof has its own unconditional runtime assertion and is used unchanged under
Bun 1.4.2. Ordinary Node worker proofs run under the pinned Node 22.16.0.

The authenticated previous full report has 1,069 cases. Its 14 unrelated sorted
callback cases are excluded, leaving 1,055 main cases across 50 files whose source
hashes were verified against retained authenticated main. This patch adds three
parameterized cases to the existing 41-case bulk suite. Exact expectations are:

- Four focused commands: baseline/candidate under Bun/Node, 44 bulk cases each.
- One candidate full Bun suite: 1,058 passing cases across the same 50 files.
- No full baseline suite and no full Node matrix.

The sealed inventory binds all test file hashes, per-file counts, and the 44
focused assertion names. Both verbose and JSON reporters are required. No skip,
todo, failure, unexpected file, count mismatch or missing report is accepted.

## Ordered commands and fixed limits

The 30 sequential child commands are:

1. Locked dependency installation (180 seconds), exact-main archive (30),
   candidate combined patch (30), and baseline identical test patch (30).
2. Fresh baseline and candidate native builds (90 each), then native disassembly
   (30 each), followed by the nonexecuting ABI/shape/output checks above.
3. Each arm's portable build (60) and declaration build (60), then embedded-core
   authentication. No library test or worker starts before this check.
4. Four focused bulk test commands (90 each), including the existing full-hash
   collisions, recursive failure, terminal failure/recovery, journal/overlay,
   boundary and callback fixtures; no extra corpus is added.
5. Existing bulk real-worker proof under Bun for each producer arm (90 each),
   covering both reader arms and shared/copied transport: eight workers total.
6. Candidate main, Redux, typed-values, geometry, worker and inexact optional
   value type checks (60 each); one full Bun suite (300).
7. Candidate ordinary Node worker (45), Redux (30), typed-JSON worker (30),
   real-worker task/lifecycle checks (60), and packed-package consumer (180).

The ordinary full suite and existing integration scripts are unchanged. No held
numeric getter/reentrancy or compaction experiment is added, edited or invoked.
Normal existing coverage is not a release of those separate held studies.
The package checker retains its real local tarball installation, Node/Bun and
TypeScript consumer imports and packaged worker check; it does not publish.

The whole controller has a 1,500-second ceiling; commands also respect their
own caps and the remaining allowance. The job ceiling is 35 minutes, allowing
cleanup/evidence upload. Per-test limits stay unchanged. Each child has its own
process group with bounded TERM/KILL cleanup. Start/end and 15-second liveness
events record stage and log-byte progress. Failures, timeouts, leftover groups,
source/output changes and interruptions stop later work with no retries.

## Comparisons, limits and retained evidence

All focused raw reports and bulk rows are retained verbatim. Paired rows compare
within each engine: logical contents, roots, used bytes, heap payload hashes and
existing failure/recovery observations. The legacy arm label remains untouched.
The nested row is required to contain semantic flags only. Nested descriptors
can contain process-local arena IDs, so cross-process descriptor-byte equality
is not required or silently normalized. The new sparse number/string/object
rows contain plain values and support deterministic payload comparisons.

These existing rows do not include full scratch-memory byte captures. The gate
does not claim full linear-memory equality or recursive post-trap recovery beyond
the existing fixtures. The static result-scalar proof and emitted-code review
cover the preserved successful-result/exception boundary. No extra memory
fixture, interception, mutation test, or proof framework is added.

The upload retains the exact main archive, public inputs/workflow, source and
generated inventories, native/portable outputs, WAT/diff/ABI evidence, actual
runtime records, command plans/logs/receipts, all test reports, raw comparison
rows and any negative terminal result. Dependency trees, executable binaries,
environment dumps and unrelated studies are excluded. Successful ordinary
correctness is not a performance result or permission to promote production.

## Publication boundary and historical limitation

Only a distinct `proof/bulk-empty-partitions-correctness-20261014` branch triggers
this workflow, with one attempt-1 job, read-only repository permission, its own
concurrency group and no cancellation of another run. Publication is separately
reviewed and unreleased; the local manifest binds every proposed file. No main
source file or default-branch workflow changes as part of proof publication.

The held HAMT work concerns allocation/tail layout, which the guard does not
change, but complete historical source independence remains unestablished
because its runtime source pins are incomplete. No held source was opened or
reconstructed. The original source report and reviewed patch remain frozen.
Exact-head normal repository CI remains necessary before any later promotion.
