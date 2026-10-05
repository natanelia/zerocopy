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
bun run typecheck:values
bun run test
node --test scripts/check-docs.node.mjs
node scripts/check-docs.mjs
node scripts/check-doc-examples.mjs
node proofs/node-worker.mjs
node proofs/redux-node.mjs
node proofs/typed-json-worker.mjs
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
bun run check:package
```

Inspect the package contents and use the local archive in a consumer test. These commands do not publish a package. Do not change dependency versions, publish releases, or combine unrelated runtime refactors with a documentation patch.

## npm releases

The package name is `zerocopy`. Use Bun 1.4.2 for release builds and Node.js 22 or newer for local checks. `npm publish --access public` runs `prepublishOnly`: WASM, portable JavaScript, declarations, type checks, the test suite, the Redux proof, and the packed-package consumer check. Do not bypass this gate with `--ignore-scripts` when publishing.

The consumer check installs the tarball in a temporary application outside the repository. It checks all public Node and Bun entry points, retained immutable snapshots, the real Node worker proof, and TypeScript imports. It also rejects development files and missing exported declarations.

Successful `main` CI runs retain an `npm-package-<commit>` artifact after the builds, type checks, tests, and consumer checks pass. A release can publish that exact archive with `npm publish /path/to/zerocopy-<version>.tgz --access public`. Archive publication does not rerun source lifecycle scripts: use only the artifact from a successful CI run for the intended source commit, never an unvalidated archive. This is an alternative when the local test runner cannot complete.

For the first release, authenticate with `npm login`, verify the intended account with `npm whoami`, and publish the validated current version with `npm publish --access public`. Complete npm's account verification and two-factor authentication if requested. A registry 404 does not guarantee that npm will allow a particular package name.

After the package exists, configure its npm **Trusted Publisher** for GitHub Actions:

- Owner: `natanelia`
- Repository: `zerocopy`
- Workflow filename: `npm-publish.yml`
- Environment: leave blank; the workflow does not declare an environment.

The **Publish npm package** workflow uses Node.js 24 with npm's OIDC support and publishes provenance without a stored `NPM_TOKEN`. Future releases use a new `package.json` version and a matching `v<version>` tag. Tag creation and pushing are separate release actions. Manual dispatch on `main` is also available. Tags that do not match the package version fail. Already-published versions fail visibly; publishing is no longer attempted on every `main` push, and errors are not suppressed.

Until the trusted publisher is configured, the Actions publish step cannot authenticate. Do not commit credentials or paste tokens into issues or agent conversations. Registry publication is immutable: confirm the package version and validated contents before a release.

A useful bug report includes the runtime version, transport mode, a small reproduction, and whether the problem affects a retained old snapshot. For performance reports, include the workload and raw samples, not only a ratio.
