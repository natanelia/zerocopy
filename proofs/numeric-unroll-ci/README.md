# Numeric two-way SIMD screen

Default-off preparation packet for the fixed eight-line numeric unroll. It contains no performance result. [PLAN.md](PLAN.md) is prospective revision 2; [REPAIR-2.md](REPAIR-2.md) records the narrow repair and [PLAN.revision1.md](PLAN.revision1.md) preserves the preceding plan; [PLAN.revision0.md](PLAN.revision0.md) preserves the initial proposal and [REVISION-1.md](REVISION-1.md) records its changes.

Exact baseline is `f4fad3a850cb544ff9440d263eeec464a31dd123`; exact candidate is its single runtime child `50d91158eeff95456dd2945cba2140ab08e9f029`. Only `numeric-kernels.as.ts` differs. [origin.json](origin.json) fixes both trees, source/patch identities, every Wasm hash, the SIMD section/body hashes and unchanged upstream controller/math/lock identities.

The nine cases are unchanged. The scalar control now imports `numeric-scalar-control.mjs`, an exclusive, physically distinct byte-identical sibling of the verified official `numeric.js`. Same-directory chunk imports preserve public constructor identity. The clone is a generated test fixture, not official output 13; separate source metadata plus the unchanged controller's harness hash list bind it, and preservation copies it from dist. File guards reject overwrite, symlinks, hardlinks and mismatched bytes. The existing selection guard still requires separate closures, one automatic/forced-scalar probe per closure, cached repeated calls and restored WebAssembly.validate before clocks.

Original hosted run 37946676323 passed both 32-command source gates and 36 Node untimed rows, then failed Bun baseline's query-alias prerequisite before output or timing. It remains failed and unresumed. The successor keeps f4fad3a/50d91158 source pins. A frozen synthetic loader probe followed by four narrow retained-build seed guards passed on Node 22.23.3/Bun 1.4.2; this does not execute or admit a new nine-case subject, full gate or timing study.

First import, decode/compile and first instance cost remain unresolved. Repeated calls and fresh Arenas using an already compiled Module are warm work. A gain in this screen cannot clear startup cost, promote the candidate, or support browser/ARM claims.

The adapter retains 23 standard gate commands and adds nine numeric commands: one consumer type check, four fixed corpus processes and four existing worker proofs. The full unmodified suite already contains the 45 historical numeric/spatial tests; it is not followed by a duplicate focused run. Both fresh complete gates and artifact/source freeze precede four untimed subjects; those precede the original four-block paired screen. No historical pass or timeout exception admits a run.

`controller.py`, `math.mjs` and the frozen lock are byte-identical to the accepted packet. The CI adapter's tool inventory now returns both arms' installed compiler paths, retaining the equality check, so unchanged final controller verification catches a candidate-only dependency mutation as well as a baseline mutation. This fixes a prospective coverage gap; it is not evidence that an earlier study's compiler changed.

Preparation-only checks are `protocol.test.mjs`, `subject.test.mjs`, `ci-report.test.mjs`, `controller.test.py`, `ci.test.py` and `artifact_checks.test.py`. They use deterministic arithmetic, fake API calls, temporary text files or synthetic reports. They never import an arm, compile Wasm, run an actual workload subject or read an operation clock. `verify-preparation.py` reads Git objects and retained artifacts only. These pure checks supplement the narrow retained-build guard and cannot replace fresh gates or complete untimed admission.

The preserved [history](history/manifest.json) contains the three original failing command records and their stdout/stderr, original prototype summary, corrected-proof explanation, independent review and phase diagnostic. Baseline 44/45 and candidate 43/45 remain historical focused failures. The diagnostic located its own multi-second wall time in full-array equality; it did not clear the original gate or prove a CPU cause.

The generated report labels process.resourceUsage().maxRSS as Linux KiB (1024 bytes); ordinary process/controller RSS and Arena capacity remain bytes. [RESOURCE-UNITS.md](RESOURCE-UNITS.md) records the Node 22 and tagged Bun 1.4.2 sources.

The workflow, activation-only child, exact packet digest/branch/repository checks, original-run-attempt restriction, owned-process cleanup, finite caps and raw-first preservation follow the accepted adapter. Activation is false. Publication, activation, subjects and operation clocks require separate review and authorization. Held PR 24/25, cache, ASCII, HAMT and other workflows are untouched.

The inherited per-case row-buffer limitation is unchanged: an interruption can lose rows still in memory before case emission. Only surviving raw output is preserved. This fixture repair does not change streaming or claim stronger interrupted-row recovery.
