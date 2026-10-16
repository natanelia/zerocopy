# Compiled artifact provenance

The exact bundles in `artifacts/` were produced by the original
[hosted preparation run](https://github.com/natanelia/zerocopy/actions/runs/38852823427),
job `116817615868`, attempt 1, on commit
`7fdc05472382667d8bb75f6ba160d75c677e82de`. The preparation workflow ran only two
Bun builds and four compiled-bundle regression commands. All six exited zero;
all leaders were reaped, with no surviving descendants, cleanup signals or cap
failures. The gate took 2.228 seconds. No calibration or measurement ran there.

GitHub artifact `12025868422` had ZIP SHA-256
`66445ee92d545cdd239ecaa90269738c81210525582ecbb2ec3572d2153e233d`.
Its 24 source files and 16 output files were retained and checked. The original
local attempt, which stopped with zero children because effective cgroup
accounting was unavailable, remains unchanged in `prior-attempt/local-admission.json`.

The emitted baseline is 5,211 bytes, SHA-256
`c8de925fa2b9f00ad495fef6170ab58ec6489067bf674f575f1bc19cda018c56`.
The candidate is 5,260 bytes, SHA-256
`e7f026562d0a3235ca9a9f2494c3b1f58fa890e83cb4dc2b66033654204da9d5`.
Their only textual difference is the reviewed lazy worklist transformation in
`freezeJSON`. Both include the actual object/primitive codecs, shared-buffer
UTF-8 compatibility path and type parser. Both engines use these same artifacts.
`ARTIFACT-SEAL.json` binds all sixteen original preparation outputs before any
calibration. Source/runtime bindings and all twelve command streams are retained.

Both builds emitted the same Bun internal directory-mismatch diagnostic for
`$PROOF/dependencies/tsconfig.json`, descriptor 3, despite exiting zero. Each
stderr is 149 bytes with SHA-256
`260ce4f31b54f473190c41f8a3378d5911e0a0bae0a731f4ea75f016ce479639`.
The preparation was not warning-free, and it does not prove that every explicit
tsconfig setting was applied. The complete emitted code, helper-only arm
difference, identical flags, exact compiler hash and compiled regressions bind
the artifacts actually produced. The screen studies these exact bytes without
assuming unobserved config processing. No rebuild was performed.

All four compiled regression invocations passed eight equivalence cases each,
for 32 case executions. The four expected initial-pop differences remain
explicit: replacing the first dynamic pop throws before the baseline root is
frozen; the candidate omits that call. This is a compatibility boundary, not
universal equivalence. Earlier focused source correctness also covered the
existing helper/object-codec tests on the same source bytes.

Command receipts disclose known-path normalization before log hashing. Compiler
logs therefore retain logical labels; successful regression JSON is unchanged
by that substitution. RSS/high-water fields are safety receipts only; a short
build with zero periodic samples does not imply zero memory use. This successful
preparation makes no performance or comparative-memory claim.
