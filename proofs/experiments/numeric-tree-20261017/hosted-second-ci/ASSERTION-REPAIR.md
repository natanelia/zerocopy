# Geometry assertion repair

PR 39 head `85eee3354b85f8d7d6121a72579ddc8e06a57112` has two new x64
test failures. Both fail this test:

`geometry.test.ts > bboxXY > preserves attached snapshots after append, fork, and memory growth`

| Workflow run | Job | Result |
| --- | --- | --- |
| Worker sessions 38998487324 | 117296191012 | Geometry test timed out at 5,727 ms. 1,061 of 1,062 tests passed. |
| Numeric performance proof 38998487320, x64 | 117296191057 | Geometry test timed out at 5,735 ms. 1,061 of 1,062 tests passed. |
| Numeric performance proof 38998487320, ARM64 | 117296190799 | All 1,062 tests passed. The geometry test took 1,399 ms. Its existing Node and Bun numeric gates passed. |

These runs are separate from Numeric tree comparison run 38998487385.
The failed x64 numeric proof skipped its worker and timing steps. Its
artifact upload then failed because no result file existed. That upload
failure is secondary.

## Change

The test saved an independent copy of the full memory buffer, then used
element-wise deep equality to compare the current bytes. The repair keeps
that saved copy. It compares the full current buffer length explicitly,
then uses native `Buffer.equals` for the full byte comparison. All numeric
bounds, owner, old-snapshot, and attached-snapshot assertions remain. The
5,000 ms test limit remains.

This change removes the element-wise assertion cost. It does not prove
that a private arena caused the earlier timeout. The earlier numeric-test
arena isolation did not resolve these two new failures. Production source
is unchanged by this repair.

## Retained evidence

- [Worker sessions raw log](job-117296191012.log)
- [Numeric x64 raw log](job-117296191057.log)
- [Numeric ARM64 raw log](job-117296190799.log)
- [Before test source](geometry-before-buffer-equality.test.ts.source)
- [Repaired test source](geometry-buffer-equality.test.ts.source)
- [Workflow and job metadata](origin.json)

The logs retain the decoded GitHub text and terminal control characters.

## Local checks

All local tests used Bun 1.4.2 and the unchanged 5,000 ms limit. Each status
record contains the exact command, elapsed time, exit code, log hash, and
geometry test source hash.

| Check | Tests | Exit code | Raw log |
| --- | --- | --- | --- |
| Geometry, numeric, and spatial files | 56 passed | 0 | [Focused tests](focused-tests.txt) |
| First full suite | 1,047 passed; 15 failed | 1 | [First full suite](full-suite.txt) |
| The two failed files after alias restoration | 58 passed | 0 | [Failed-file check](failed-files-after-aliases.txt) |
| Full suite after alias restoration | 1,062 passed in 50 files | 0 | [Complete suite](full-suite-after-aliases.txt) |

Fourteen failures in the first full suite reported a missing generated
`shared-map.wasm` file. One priority-queue checkpoint test timed out at
6,928 ms. Geometry passed. The normal Wasm build script makes eight exact
copies of `persistent-core.wasm` for legacy names. These aliases were
absent from this local checkout. They were restored from the existing
core, whose SHA-256 matches the retained stage-3 build. This required no
compilation or source change. The [alias record](build-alias-restoration.json)
keeps all eight paths and hashes.

The missing aliases explain the worker errors. They do not explain the
checkpoint timeout. That timeout did not recur in the failed-file check
or the next full suite. The initial failure remains part of the evidence.
These local checks do not establish hosted CI success or performance
acceptance.

The strict documentation check uses the unchanged baseline preservation
gate. Its output is retained in [the documentation log](strict-docs.txt).
