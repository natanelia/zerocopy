# Correctness validation

Baseline: `b07bffe073a7f7d60f1dd7731358c16d1075eb45`.

The candidate changes only numeric/boolean Redux stack and queue encoding when at
least 32 elements remain and the normal read methods are present. The small,
empty, string, JSON, nested-value and overridden-reader paths retain the public
`peek()` / `pop()` / `dequeue()` loop. No public entrypoint, wire format, dependency
or AssemblyScript source changes.

## Completed checks

| Check | Result |
| --- | --- |
| Node Redux suites | 9 files / 169 tests passed, including 28 new regressions |
| Bun Redux suites | 9 files / 169 tests passed |
| Final full default Bun suite | 56 files / 1,136 tests passed in 36.31 s; `validation/full-suite-bun.txt` |
| Portable browser/Node bundle | 12 modules built successfully |
| Main TypeScript check | Passed |
| Declaration emission | Passed |
| Redux TypeScript consumer check | Passed |
| Typed-value, geometry and worker TypeScript checks | Passed |
| Installed package consumers | Node/Bun exports, real Node workers and TypeScript consumer passed; 145 files, 217,428 bytes; `validation/installed-package.txt` |
| Actual Node worker threads | Shared and copied payloads passed; complete numeric/boolean results, read-only enforcement, retained roots and unchanged bytes across owner edits and growth |
| Chromium 153 page and worker proof | Numeric/boolean encoding and actual shared/copy worker attachments passed across owner edits and growth; see `browser-result.json` |
| Fresh optional Redux import | Reader getters and decoder overrides passed in Node portable, Bun portable and Bun source entrypoints |
| Workload smoke checks | Every one of the 10 cases passed twice for baseline and candidate in Node and Bun; complete outputs and source invariants checked |
| Patch formatting | `git diff --check` passed |

The initial `.txt` files under `validation/` contain stdout captured by the
execution tool for the targeted commands. They were copied from that capture
while timings ran; no tests or builds were rerun concurrently with the
performance study.
Silent TypeScript commands all exited successfully.
The final full-suite and installed-package logs were captured directly by their
commands after all timing studies completed. They validate the same frozen
production source.

WASM binaries were copied from the freshly prepared baseline after comparing
every root AssemblyScript source byte for byte. The performance harness separately
requires identical baseline/candidate WASM hashes. This candidate changes no
WASM source or binary. These are local correctness results, not GitHub CI results.

## Commands

```sh
bun scripts/build-browser.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --emitDeclarationOnly --noEmit false --declarationMap false --outDir dist/types
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.redux.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.typed-values.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.typed-values.json --exactOptionalPropertyTypes false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.geometry.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.worker.json
node node_modules/vitest/vitest.mjs run redux --maxWorkers=1
bun --bun node_modules/vitest/vitest.mjs run redux --maxWorkers=1
bun run test
node scripts/check-package.mjs
node proofs/redux-sequence-reads-20261105/worker.mjs
node proofs/redux-sequence-reads-20261105/late-import.mjs
node proofs/redux-sequence-reads-20261105/late-import.mjs --decode
bun proofs/redux-sequence-reads-20261105/late-import.mjs
bun proofs/redux-sequence-reads-20261105/late-import.mjs --decode
bun proofs/redux-sequence-reads-20261105/late-import.mjs --source
bun proofs/redux-sequence-reads-20261105/late-import.mjs --source --decode
node proofs/redux-sequence-reads-20261105/browser-check.mjs . sequence
git diff --check
```

The local Bun executable was
`/workspace/scratch/83f1d4baba1f/tools/bun`. Commands above use `bun` for portability.
The local Chromium check selected the installed binary with
`CHROMIUM_EXECUTABLE=/workspace/scratch/102d37e63531/tools/browser/chromium`
and `LD_LIBRARY_PATH=/workspace/scratch/102d37e63531/tools/browser/lib`.
Its proof script was copied byte for byte into this directory after the run.
CI installs Chromium through the existing Playwright dependency and needs
neither selector.
The workload smoke loops called `createWorkload()` for every case and build,
verified two `operation()` outputs and ran `checkInvariant()` without timing.

## Covered behavior

Regression cases cover empty/small sequences; 31/32/33-element boundaries;
1,024-element and deep vector boundaries; dequeued offsets; old roots/forks;
booleans, NaN, signed zero and infinities; the stack constructor's explicit
cached top; collection/node/depth/text limits; generic Unicode strings, frozen
JSON and nested collections; exact thrown errors; method/getter receiver binding
and call counts; decoder overrides, recursion and memory growth; mutable
prototype methods during a fallback scan; custom Arena subclasses; and shared
and copied read-only attachments.

The native read identities are captured in the modules defining Arena,
SharedStack and SharedQueue. A caller may import shared collections, replace a
reader, and only then import Redux: the fresh-process proof verifies that this
still takes the original public-method fallback. Native fast-path kernels retain
the existing internal WASM exports; arbitrary replacement of those internal
kernel exports is not claimed as a supported extension point.

## Frozen measured production sources

| File | SHA-256 |
| --- | --- |
| `arena.ts` | `a4a5fc53a66baf943688ccf357095afab02b0ff538711542e384d2b01004243f` |
| `shared-stack.ts` | `8ef42efe1135edeb85293e1d26b237150582472ea4e48ac454d772ffd9f3dca8` |
| `shared-queue.ts` | `e3995a791f9a0e1a90c4cd19270b17a31a6fa117171b7e30bf14dd59d7366125` |
| `redux-codec.ts` | `aa0034c6bba39edabc04eb48e985f78be3e8cfb7d3ad7b273bb2a39edf9180a6` |
| `redux-sequence-codec.ts` | `151fc89fb1d57f79ebaa33b1b324d5f6449a283c4fc24805bce6e51660860362` |
| `workloads.mjs` | `872240d433c14df83d7701844b72dd1a30ab2756e0e99f671985401517d0f4d1` |

The production source and workload module remained unchanged after these checks
and before the pilot began. Later timing reports carry their own immutable
source/build hashes and complete raw samples.
