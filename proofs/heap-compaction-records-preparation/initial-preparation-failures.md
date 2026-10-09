# Preserved preparation and harness failures

These failures were corrected without modifying the production candidate after its initial six-line change. No timing result was collected or used to choose a variant.

1. Initial fixture assumption failed under Bun 1.4.2. The distinct-arena/equal-pointer fixture used strings `left` and `right`. Their different encoded lengths crossed an allocator alignment boundary, producing heap roots **65544** and **65552**. `assert.equal(a.root, b.root)` therefore failed at the fixture precondition. It was corrected to equal-length strings `west` and `east`, preserving distinct values while producing equal source pointers. Subsequent exact-byte/cache-namespace checks pass.

2. The first standalone proof TypeScript command omitted `--allowImportingTsExtensions`, although the repository permits `.ts` imports. It reported **TS5097** at `codec.ts(5,33)`. It also exposed two **TS2345** proof-only annotations: helper parameters were typed as only the baseline module, whose private Compactor members made the candidate class nominally incompatible. Helpers now accept `typeof B | typeof C`; the proof command includes the repository-compatible import flag. Production `tsc --noEmit` had already passed, and the corrected proof check passes on Node 22.23.3.

3. The first attempt to emit the Node proof used an `outfile` option with the Bun JavaScript build API. That invocation reported build success but did not persist the requested `.heap-compaction-records-proof/node-check.mjs`. Reading it failed with **ENOENT**; the subsequent Node attempt failed with **MODULE_NOT_FOUND**. The build now uses supported `outdir` and `naming` options, asserts success, hashes the persisted file, and passes the proof under Node 22.23.3. No semantic Node proof ran during the failed attempt.

4. Preliminary contract discovery searched nonexistent `docs/immutable*`, `core.ts`, `.agents`, and not-yet-built `*.wasm` paths. These checks reported missing paths. The actual contracts are in the flat source files and `docs/architecture.md`/worker documentation. WASM was built successfully using `scripts/build-wasm.mjs` before semantic tests; the absence of checkout-local AGENTS/skills was recorded.

5. An attempted independent read-only review agent could not start: **agent thread limit reached**. No independent review is claimed.

Node 22 executions also printed the environment's `EnvHttpProxyAgent` experimental warning. Tests remained local, and all completed checks exited successfully. This warning was not treated as a test failure or suppressed to conceal it.
