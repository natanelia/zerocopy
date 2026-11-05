# Checkpoint validation pass: correctness checks

These results were recorded from implementation commands, separately from timing measurements. The final V2 source uses a dedicated validation walk and the original reconstruction walk. The full text of the reconstruction function was compared with the baseline and is byte-for-byte identical.

## V2 source identities

- Baseline: `b07bffe073a7f7d60f1dd7731358c16d1075eb45`.
- Candidate `redux-checkpoint.ts` SHA-256: `e20ba1178c87b5a839ff4da6ec4a9a534cc22e0c18ca68f81c4bba8d3ae9cec6`.
- `checkpoint-validation-pass.test.ts` SHA-256: `415d6ef1e69d7639bf23fbd3e6a784a5cd4b1f38902c9a67fee76d50b6c4d4d9`.
- Frozen `workloads.mjs` SHA-256: `e17c138da14bdf35de0406da46980bb08ff0aa1873029c4998b2ea45f29724b4`.
- `persistent-core.wasm` SHA-256: `08b1e91c9ee6d3602c0a100f449f51555ee35e5641e1839b7f719d016c209d90`.
- `browser-check.mjs` SHA-256: `c0d167a6e15f0ceae9313261bce4bc0df65cf3a8b38cab62d7bc74119cc975c6`.

All WASM files were copied from the freshly rebuilt baseline. No AssemblyScript source, dependency or binary layout changed. The validation host used Node **24.22.1**, Bun **1.4.2** and Chromium **153.0.8010.0**, on Linux x64.

## Completed V2 checks before timing

| Check | Outcome |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run checkpoint-validation-pass.test.ts --maxWorkers 1` | All 10 tests passed. |
| `bun --bun node_modules/vitest/vitest.mjs run checkpoint-validation-pass.test.ts --maxWorkers 1` | All 10 tests passed. |
| Same new tests copied to an isolated unchanged-baseline checkout and run with Node | All 10 passed, including exact read/coercion traces and native error messages. |
| `bun scripts/build-browser.ts` | 12 portable modules built, 235,699 total bytes. |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed. |
| `node proofs/checkpoint-validation-20261105/smoke.mjs` | All eight complete workload outputs and source invariants passed. |
| `bun proofs/checkpoint-validation-20261105/smoke.mjs` | All eight complete workload outputs and source invariants passed. |
| `node browser-check.mjs TARGET_REPOSITORY checkpoint` with the available Chromium executable | Passed: isolated page, full checkpoint tree, writable imports, and actual shared/copy worker attachments. Output is preserved in `browser-result.json`. |

The earlier V1 implementation had also passed all three existing/focused checkpoint suites, **155 tests in each of Node and Bun**. Those results and their exact source identities remain in `archive/validation-v1.md`; they are not presented as executions of the later V2 source. The V2 dedicated workflow runs all three suites again.

## Preserved behavior

The new tests cover complete frozen outputs, sparse holes, null prototypes, special values and names, repeated snapshot aliases, nested shared dependencies, future writes and read-only worker attachments. They also exercise every supported scalar tag, repeated acyclic subnodes, a malformed-tag corpus rejected before any WASM attachment, exact depth/node limits, duplicate-key error precedence, input getter counts, and property-key coercion after visiting the child. Invalid numeric lengths reported by array proxies retain the native `Array` constructor error, including its runtime-specific message.

`smoke.mjs` checks all declared workload oracles without collecting timings. The browser script resolves Playwright from its target repository and starts a local server with COOP/COEP headers. `CHROMIUM_EXECUTABLE` is optional when Playwright already has an installed browser; the local run also provided its browser-library directory through `LD_LIBRARY_PATH`. CI installs Chromium through the existing Playwright dependency.

Correctness checks support the behavior of the changed pass. Performance evidence is reported separately.
