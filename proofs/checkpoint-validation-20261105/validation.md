# Checkpoint validation pass: correctness checks

These results were recorded from implementation commands, separately from timing measurements. The final V3 source uses a dedicated validation walk, records active membership only for recursive containers, and retains the original reconstruction walk. The full text of the reconstruction function was compared with the baseline and is byte-for-byte identical.

## V3 source identities

- Baseline: `b07bffe073a7f7d60f1dd7731358c16d1075eb45`.
- Candidate `redux-checkpoint.ts` SHA-256: `efe50d67389eac9463f43fc7c4fe1554511e65a4044940688d939d7ecabcd632`.
- `checkpoint-validation-pass.test.ts` SHA-256: `e1bed7251dc0e2c4e83b52453bbd69ef3fcebe9fee65b850eca41b82f427cb37`.
- Frozen `workloads.mjs` SHA-256: `e17c138da14bdf35de0406da46980bb08ff0aa1873029c4998b2ea45f29724b4`.
- `persistent-core.wasm` SHA-256: `08b1e91c9ee6d3602c0a100f449f51555ee35e5641e1839b7f719d016c209d90`.
- `browser-check.mjs` SHA-256: `c0d167a6e15f0ceae9313261bce4bc0df65cf3a8b38cab62d7bc74119cc975c6`.

All WASM files were copied from the freshly rebuilt baseline. No AssemblyScript source, dependency or binary layout changed. The validation host used Node **24.22.1**, Bun **1.4.2** and Chromium **153.0.8010.0**, on Linux x64.

## Completed V3 checks before timing

| Check | Outcome |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run checkpoint-validation-pass.test.ts redux-checkpoint.test.ts checkpoint-descriptor-validation.test.ts --maxWorkers 1` | Three files / 157 tests passed. |
| `bun --bun node_modules/vitest/vitest.mjs run checkpoint-validation-pass.test.ts redux-checkpoint.test.ts checkpoint-descriptor-validation.test.ts --maxWorkers 1` | Three files / 157 tests passed. |
| Same new tests copied to an isolated unchanged-baseline checkout and run with Node | All 11 passed, including exact read/coercion traces and native error messages. |
| `bun scripts/build-browser.ts` | 12 portable modules built, 235,671 total bytes. |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed. |
| `node proofs/checkpoint-validation-20261105/smoke.mjs` | All eight complete workload outputs and source invariants passed. |
| `bun proofs/checkpoint-validation-20261105/smoke.mjs` | All eight complete workload outputs and source invariants passed. |
| `node browser-check.mjs TARGET_REPOSITORY checkpoint` with the available Chromium executable | Passed: isolated page, full checkpoint tree, writable imports, and actual shared/copy worker attachments. Output is preserved in `browser-result.json`. |

The earlier V1 implementation passed all three existing/focused checkpoint suites, **155 tests in each of Node and Bun**. V2 passed the expanded 10-test regression suite under both runtimes, both complete workload smokes and the browser proof. Those results and their exact source identities remain in `archive/validation-v1.md` and `archive/validation-v2.md`; they are not presented as executions of the later V3 source. The dedicated workflow runs all three suites again.

## Preserved behavior

The new tests cover complete frozen outputs, sparse holes, null prototypes, special values and names, repeated snapshot aliases, nested shared dependencies, future writes and read-only worker attachments. They also exercise every supported scalar tag, repeated acyclic subnodes, a malformed-tag corpus rejected before any WASM attachment, exact depth/node limits, duplicate-key error precedence, input getter counts, and property-key coercion after visiting the child. An active ancestor whose getter would change its tag to a scalar is rejected before that getter can run again. Invalid numeric lengths reported by array proxies retain the native `Array` constructor error, including its runtime-specific message.

`smoke.mjs` checks all declared workload oracles without collecting timings. The browser script resolves Playwright from its target repository and starts a local server with COOP/COEP headers. `CHROMIUM_EXECUTABLE` is optional when Playwright already has an installed browser; the local run also provided its browser-library directory through `LD_LIBRARY_PATH`. CI installs Chromium through the existing Playwright dependency.

Correctness checks support the behavior of the changed pass. Performance evidence is reported separately.
