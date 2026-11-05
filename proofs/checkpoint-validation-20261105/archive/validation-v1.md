# Checkpoint validation pass: implementation checks

These results were recorded from the implementation commands, independently of any timing study. Runtime source was frozen before the workload screen. A later workload-only correction replaced one ordinary record field with `__proto__`, making the named 4,096-field case contain exactly 4,096 total fields.

## Source identities

- Baseline: `b07bffe073a7f7d60f1dd7731358c16d1075eb45`.
- Candidate `redux-checkpoint.ts` SHA-256: `7f2714d5de59b9320c25084c10d80a8c7586a4cb299aca5338a0c7b4fdc00c92`.
- Added `checkpoint-validation-pass.test.ts` SHA-256: `064b08627cc0ba2b6571d777caec7a73d40061c73c90fa5d2b7c1cb53ad98e0c`.
- Frozen `workloads.mjs` SHA-256: `8a3c2a9279465525010c1e0742ba59c58fdbcc19087348e3b3395c18bba74173`.
- `persistent-core.wasm` SHA-256: `08b1e91c9ee6d3602c0a100f449f51555ee35e5641e1839b7f719d016c209d90`.

All WASM files were copied from the freshly rebuilt baseline; no AssemblyScript source, dependency or binary layout changed. Node was **24.22.1**, Bun **1.4.2**, on Linux x64.

## Completed checks

| Check | Outcome |
| --- | --- |
| Node checkpoint suites: `node node_modules/vitest/vitest.mjs run checkpoint-validation-pass.test.ts redux-checkpoint.test.ts checkpoint-descriptor-validation.test.ts --maxWorkers 1` | 3 files / 155 tests passed. |
| Bun checkpoint suites: `bun --bun node_modules/vitest/vitest.mjs run checkpoint-validation-pass.test.ts redux-checkpoint.test.ts checkpoint-descriptor-validation.test.ts --maxWorkers 1` | 3 files / 155 tests passed. |
| New tests copied into an isolated unchanged-baseline checkout, then `node node_modules/vitest/vitest.mjs run checkpoint-validation-pass.test.ts --maxWorkers 1` | All 9 tests passed on the baseline too, including exact input-read traces and native error messages. |
| `bun scripts/build-browser.ts` | 12 portable modules built, 233,878 total bytes. |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed. |
| One complete operation per workload against both builds, under Node and Bun | All eight workload outputs and source invariants passed. This was before the workload-only record-count correction. |
| Corrected record workload, against both builds under Node | Complete output and invariant checks passed with exactly 4,096 properties. |
| `git diff --check` | Passed. |

The first attempted Node suite had no tests execute because the new worktree lacked generated WASM. Copying the freshly built, identical baseline binaries resolved that setup issue; the successful suites above are the subsequent runs.

## Preserved behavior covered by the new tests

The tests cover complete frozen outputs, sparse holes, null prototypes, special values and names, repeated snapshot aliases, nested shared dependencies, future writes and read-only worker attachments. They also exercise malformed trees before any WASM attachment, exact depth/node limits, duplicate-key error precedence, input getter counts, and property-key coercion after the child is decoded. Invalid numeric lengths reported by array proxies retain the native `Array` constructor error, including its runtime-specific message.

`smoke.mjs` is a reproducible, untimed check of all workload oracles. Run it after the portable build with either `node proofs/checkpoint-validation-20261105/smoke.mjs` or `bun proofs/checkpoint-validation-20261105/smoke.mjs`. An optional first argument selects another built checkout.

Correctness checks support the behavioral equivalence of the changed pass. They do not establish performance; timing evidence is reported separately.
