# Contributing

Use Bun 1.4.2 and Node.js 22 to match the recorded build. Direct development dependencies are pinned in `package.json`.

## Set up and test

```sh
bun install
bun run build:wasm
bun run build:browser
bun run build:types
bun run typecheck
bun run typecheck:redux
bun run test
node --test scripts/check-docs.node.mjs
node scripts/check-docs.mjs
node scripts/check-doc-examples.mjs
node proofs/node-worker.mjs
node proofs/redux-node.mjs
```

Use `bun run test`, not Bun's separate built-in test runner. The package script runs Vitest. `bun run test:watch` starts watch mode.

For the browser checks:

```sh
bunx playwright install --with-deps chromium
bun run test:browser
node scripts/check-doc-browser.mjs
```

For the local browser demo:

```sh
bun run demo
```

The server prints its address and supplies cross-origin isolation headers. Browser workers need those headers for shared memory.

## Where changes belong

Collection wrappers and their unit tests are at the repository root. Shared allocation and value handling belong in `arena.ts`; persistent WASM operations belong in `persistent-core.as.ts`. Keep Redux and TanStack integration behind their existing entry points.

Use `demo/` for browser integration tests, `proofs/` for benchmark drivers and measurements, `scripts/` for build and documentation checks, and `docs/` for user guides. See the [source map](docs/architecture.md#source-map) before changing module boundaries.

Do not move runtime files only to make the directory tree look different. Build entry points, package exports, source digests, and worker bundles depend on that structure. Keep structural changes separate from documentation edits or measured engine changes.

## Collection changes

Test the old snapshot as well as the new one. Include forks, nested values, empty inputs, memory growth, and read-only attachments where relevant. Allocation scratch and private construction can change; published reachable nodes must not.

A transport or binary-layout change needs a format-version decision and a producer/reader migration note. Do not use raw pointer tests as a substitute for an actual worker test. Keep ordinary iteration state local to the reader.

## Documentation changes

Lead with what a reader needs to do. Use complete imports, name the file in a worker example, and show the value returned by an immutable update. Explain a limit beside the feature that has that limit.

Keep one source of truth for each topic. Put setup and navigation in the README, detailed contracts in guides, and historical methods in benchmark reports. Do not add delivery notes, generated progress reports, repeated feature claims, or test-count badges to user documentation.

`node scripts/check-docs.mjs` checks local Markdown links, heading targets, and the main benchmark table structure. It does not check external websites. `node scripts/check-docs.mjs --base <commit> --preserve` also rejects changed numerical README rows and recorded evidence files. Pull-request CI uses this strict mode. Omit `--preserve` only for a report without enforcement; strict mode requires a base commit.

`node scripts/check-doc-examples.mjs` extracts marked examples directly from Markdown. It type-checks the TypeScript examples against the built package, executes the collection examples, and runs the documented Node worker pair. Update the example and its expected result together. The check does not execute arbitrary shell fences or browser examples in Node.

`node scripts/check-doc-browser.mjs` runs the README and worker-guide examples in Chromium. It checks the expected worker reply with isolation headers. Without those headers, it checks the documented error, no worker creation, and no library request. Both example checks use the shared extractor in `scripts/doc-examples.mjs`.

## Benchmark changes

Keep the README comparison between Shared, Immutable.js, and native collections. Include slower cases. State the date, runtime, hardware, workload size, sample count, warm-up, and the operations inside the timed region. Keep initialization, warm reads, cold reads, mutable native construction, and copy-preserving native updates distinct.

Memory reports must state whether they count payload, heap, backing buffers, peak use, or RSS. Preserve original JSON samples and source checksums. Save a new run separately instead of editing historical evidence. Small differences on a shared runner are not a stable performance guarantee.

Commands and existing reports are in the [README](README.md#reproduce-the-timing-and-memory-comparisons) and [proofs](proofs/README.md).

## Package checks

After all builds and tests pass:

```sh
npm pack --dry-run
npm pack --ignore-scripts
```

Inspect the package contents and use the local archive in a consumer test. These commands do not publish a package. Do not change dependency versions, publish releases, or combine unrelated runtime refactors with a documentation patch.

A useful bug report includes the runtime version, transport mode, a small reproduction, and whether the problem affects a retained old snapshot. For performance reports, include the workload and raw samples, not only a ratio.
