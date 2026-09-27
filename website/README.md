# zerocopy documentation website

A static product site, source-backed documentation, and real browser experiments. The homepage leads with shared collection storage and direct reads. Tasks remain optional.

## Local development

Use the repository's Bun and Node setup. Build the library first, then the website:

```sh
bun install
bun run build:wasm
bun run build:browser
bun run build:types
npm --prefix website install --ignore-scripts
node website/build.mjs
node website/serve.mjs
```

Open `http://127.0.0.1:4173/`. The preview server supplies isolation headers. The site is written to `website/_site/`. Re-run the build after an edit. There is no runtime UI framework and no browser-side Markdown compiler.

## Content

Most guides are rendered from the existing files in `docs/`. Do not maintain a second copy of those guides. New explanatory use cases live in `website/content/` and are registered in `config.mjs`.

`render.mjs` rewrites source links to site routes, creates heading links, and highlights code at build time with the project's TypeScript scanner. It renders only checked-in Markdown; do not pass user-supplied text to it. Search uses DOM text nodes, not HTML from a query.

The shared-read example appears before optional task execution. Hero diagrams are explicitly conceptual. Real-world guides describe implementation patterns, not unverified customer deployments.

## Log explorer

At `/explorer/`, the flagship application loads up to 100,000 generated events in a dedicated owning worker. The UI receives read-only shared columns. A search worker and a summary worker read the same captured snapshot. The UI reads visible records directly. New events arrive in 2,000-event batches; freeze retains the current investigation without stopping ingestion.

The application caps a session at 200,000 events. Stop and navigation terminate owned workers and drop snapshots. It does not claim per-node reclamation. No user data is imported or uploaded. The homepage remains about shared collections across domains; the use-case index includes editors, tables, catalogs, graphs, simulations, and scientific/spatial tools.

## Investigation benchmark

At `/investigation-benchmark/`, compare shared snapshots, two native-array replicas with incremental updates, and one native-data-owning worker. Measure initial sharing, a query on attached data, and append + publish + query separately. Native replicas receive only deltas after initial load. Each path uses identical data and operations. A separate array implementation validates rows, counts, timeline buckets, service totals, errors, and latency sums outside timing.

Two warm-ups precede seven samples per path. Order rotates, all samples are exported, and no winner is assumed. Dataset construction is reported separately. Timings use a coordinator in place of the UI and exclude DOM paint, worker startup, and module loading. This is not a memory benchmark. The existing Map transport lab remains available unchanged. For append-only arrays, native designs can also retain an earlier view by length.

## Playground

At `/playground/`, start a real dedicated worker and update the owner state. The worker's latest snapshot changes; its retained initial snapshot does not. All collection reads use the actual library, with shared transport explicitly selected. Small worker reports exist only to display the result.

The demo is opt-in. Disconnect and page navigation remove the session and terminate the owned worker. It does not run on the marketing page.

## Benchmark lab

At `/lab/`, a dedicated coordinator builds deterministic numeric maps, starts one to four reader workers, and measures fan-out plus a full lookup pass. It compares `getWorkerData(..., { copy: false })` plus `initWorker()` with a structured-cloned native Map.

Each path gets two warm-ups and seven samples, in alternating order. Every reader checksum is verified. Bars show the median; text shows the interquartile range. Construction is reported separately, with its different update semantics stated. Worker creation and module loading are outside timing. Per-publication shared attachment is included.

Native Map can win. The lab does not measure memory, pure transfer time, persistent edit workloads, or overall application performance. Raw JSON includes all samples, environment information, workload settings, method, and build commit. Nothing is uploaded.

## Static hosting and isolation

All pages are prerendered HTML. The docs remain readable without JavaScript. Search and demos progressively add interaction.

For a host with response-header configuration, deploy `_site/` and apply its `_headers` file or equivalent settings. Use `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. The preview server does this automatically.

GitHub Pages does not provide application-controlled response headers. The live demos therefore offer an explicit **Enable shared memory & reload** action. It registers a network-only service worker scoped to the current demo path. The worker adds isolation headers to same-origin responses and performs no caching. Activation causes one user-requested reload, not a loop. Unsupported browsers keep the demo disabled and show the requirement. No silent copy fallback is used.

Test this hosting path with `SITE_ISOLATED=false node website/serve.mjs`. Server headers remain the preferred deployment method.

## Build paths and metadata

`SITE_BASE=/zerocopy/` builds for a repository subpath. It defaults to `/`. Set `SITE_ORIGIN=https://natanelia.github.io` for canonical URLs and a sitemap. `SITE_COMMIT` or `GITHUB_SHA` records the actual build source; local builds use Git HEAD. Do not label an unverified npm version as the installed release.

The build also provides local search, a 404 page, raw Markdown downloads, `llms.txt`, and a build manifest. All fonts use system stacks. No analytics, remote fonts, or third-party runtime scripts are loaded.

## Tests

```sh
node --test website/tests/*.test.mjs
node website/tests/browser.mjs
node website/tests/explorer-browser.mjs
node website/tests/comparison-browser.mjs
```

Build first. Browser tests use the root Playwright dependency and Chromium. `CHROMIUM_EXECUTABLE` can select a local executable. Tests cover live snapshot updates, retained history, checksum-checked benchmarks and export, cancellation, keyboard search, no-JS docs, mobile overflow, and the scoped service-worker fallback. Build and run these checks with both `/` and `/zerocopy/` prefixes.

CI uploads the static output, test logs, and desktop/mobile screenshots. Existing library and Markdown checks remain separate and unchanged.

## Automatic PR previews

The `Documentation website` workflow now publishes tested **same-repository PRs** to GitHub Pages. Each preview has its own path:

```text
/zerocopy/previews/pr-<number>/<head-commit>/
```

The workflow creates or updates one bot comment with links to the homepage, live comparison, explorer, and benchmark. The comment names both the PR head and the tested merge commit. It says **Preview ready** only after the public `build.json` matches the tested build. Failed or stale builds do not claim a working link. Closing a PR removes its preview files; reopening it builds a new preview.

The `gh-pages` branch stores static output only. It is separate from source branches. Updates preserve other previews and the production site. Git updates are non-forced and retry conflicts. Commit-specific URLs prevent old service workers or cached scripts from running under a new preview. Previews have a visible banner and `noindex` metadata.

GitHub Pages uses **Deploy from a branch → gh-pages → / (root)**. This repository's preview branch enables that source. On another repository, select those settings once. No Vercel account or hosting secret is required. The workflow explicitly requests a Pages build because a `GITHUB_TOKEN` push alone does not start one.

Build jobs have read permission only. Publishing is a separate runner with scoped `contents`, `pages`, and PR-comment write permissions. It publishes only same-repository PRs, never external forks, and does not use `pull_request_target`. The publisher does not execute files from the generated artifact. It validates the PR/head identity, UTF-8 static file types, paths, size limits, and symlinks. Source contributors with repository write access are trusted; preview HTML still runs publicly and must not contain private data.

Production root publication remains opt-in: set the repository Actions variable **DOCS_PAGES=true**, then push or dispatch on `main`. It uses the same branch publisher and preserves `previews/`. Do not switch Pages to GitHub Actions while using this branch-based preview workflow. Custom-domain deployment needs a matching base/origin configuration. The workflow does not publish npm or merge PRs.

## Side-by-side comparison

The `/compare/` route runs **with and without zerocopy** over identical deterministic events. Each implementation has two real reader workers. One control surface applies the same search, service, severity, time filter, pagination, append, and freeze operation to both views.

The native baseline uses incremental deltas by default. Full snapshot replication is an optional, separately labelled mode. Both can retain this append-only stream: shared immutable roots on one side, a native prefix length on the other. There are no artificial delays or precomputed results. All result pages and aggregates are checked against the independent array reference after timing.

The transport counter reports logical event deliveries to worker replicas. It does not measure bytes, retained heap, or result-message traffic. Shared mode still sends descriptors, allocates wrappers, and decodes strings. Timing reports show publication/attachment and query completion separately. Owner construction and append work, startup, and DOM rendering are not included. Concurrent timings can be affected by CPU contention; use the rotated three-architecture benchmark for controlled samples.

A single active operation and one latest pending query bound work. Live ingestion waits for previous work to finish. The session stops at 200,000 events. Stop terminates the coordinator and nested readers, clears the displayed results, and drops references without promising forced garbage collection.
