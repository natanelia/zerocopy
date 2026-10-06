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

At `/investigation-benchmark/`, compare shared snapshots, two Immutable.js List replicas, two native-array replicas, and one native-data-owning worker. Both replica designs use incremental updates. Measure initial sharing, a query on attached data, and append + publish + query separately. Native and Immutable.js replicas receive only deltas after initial load. Each path uses identical data and operations. A separate array implementation validates rows, counts, timeline buckets, service totals, errors, and latency sums outside timing.

Two warm-ups precede seven samples per path. Order rotates, all samples are exported, and no winner is assumed. Dataset construction is reported separately. Timings use a coordinator in place of the UI and exclude DOM paint, worker startup, and module loading. This is not a memory benchmark. The separate Map transport lab compares zerocopy, Immutable.js Map, and Immer Map. For append-only arrays, native designs can also retain an earlier view by length.

## Playground

At `/playground/`, start a real dedicated worker and update the owner state. The worker's latest snapshot changes; its retained initial snapshot does not. All collection reads use the actual library, with shared transport explicitly selected. Small worker reports exist only to display the result.

The demo is opt-in. Disconnect and page navigation remove the session and terminate the owned worker. It does not run on the marketing page.

## Benchmark lab

At `/lab/`, a dedicated coordinator builds deterministic string-keyed numeric maps, starts one to four reader workers, and measures full-snapshot fan-out plus a lookup for every key. The three paths use real zerocopy `SharedMap`, Immutable.js `Map`, and Immer-managed `Map` implementations.

Each path gets two warm-ups and seven samples, in rotating order. Every reader checksum is verified. Bars show the median; text shows the interquartile range. Worker creation and library loading are outside timing. Every publication includes zerocopy descriptor creation and shared attachment, Immutable.js entry encoding plus structured cloning and Map reconstruction, or Immer Map structured cloning and replica freezing.

Construction is reported separately: zerocopy uses persistent sets, Immutable.js uses `withMutations`, and Immer uses one `produce` batch with `enableMapSet` and default auto-freezing. These setup costs are not an equivalent immutable-update comparison. Snapshots do not change during the measured publication trials.

Any path can win. The lab does not measure memory, pure transfer time, persistent edit workloads, or overall application performance. Raw JSON uses schema `zerocopy-browser-benchmark/v2` and includes all 21 measured samples, environment information, workload settings, method, dependency versions, and build commit. Both upstream libraries are pinned, licensed, and served locally inside the lab's isolation scope. Neither is a zerocopy runtime dependency. Nothing is uploaded.

## Static hosting and isolation

All pages are prerendered HTML. The docs remain readable without JavaScript. Search and demos progressively add interaction.

For a host with response-header configuration, deploy `_site/` and apply its `_headers` file or equivalent settings. Use `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. The preview server does this automatically.

Shared memory requires HTTPS (or localhost) and cross-origin isolation. This is a browser security rule, not a permission prompt. A host that sends COOP/COEP headers makes a demo ready on the first response: no service worker and no reload are needed. The generated `_headers` file is suitable for hosts that support that format; GitHub Pages does not apply it.

On GitHub Pages, each demo prepares itself automatically. It registers a network-only service worker scoped to that demo path and waits until that worker is active. Setup also observes `navigator.serviceWorker.ready`, checking the exact scope and script, to recover when registration views or lifecycle events are stale. A new navigation uses the active registration even when another tab installed it and the current page was not claimed. The worker adds isolation headers to same-origin responses without caching data. A first visit then refreshes once. Return visits normally need no setup refresh. The comparison still waits for **Load all four paths**; setup does not allocate datasets or start benchmarks.

A temporary `__zerocopy_isolation` query marker limits setup to one automatic navigation, even when cookies or browser storage are blocked. The marker is removed after success; other query parameters and the fragment are retained. A failed attempt does not reload repeatedly. **Retry setup** appears only after failure when another attempt could help. Registration and activation share a 12-second deadline. The next document must report actual cross-origin isolation before the demo is enabled. Late completion after a timeout cannot trigger a reload. Unknown or unrelated service workers are not removed.

The homepage and guides do not register the worker and remain outside the demo scopes. Insecure pages, unsupported browsers, and blocked setup retain readable documentation and a clear error. There is no silent copy fallback. Run `node --test website/tests/isolation.test.mjs` for state-machine tests and `node website/tests/isolation-browser.mjs` for Chromium/WebKit first-visit, return-visit, storage-blocked, failed-setup, and no-reload-loop tests.

Test this hosting path with `SITE_ISOLATED=false node website/serve.mjs`. Server headers remain the preferred deployment method.

## Build paths and metadata

`SITE_BASE=/zerocopy/` builds for a repository subpath. It defaults to `/`. Set `SITE_ORIGIN=https://natanelia.github.io` for canonical URLs and a sitemap. `SITE_COMMIT` or `GITHUB_SHA` records the actual build source; local builds use Git HEAD. Do not label an unverified npm version as the installed release.

The build also provides local search, a 404 page, raw Markdown downloads, `llms.txt`, and a build manifest. All fonts use system stacks. No analytics, remote fonts, or remote runtime scripts are loaded. Immutable.js is served locally for the demos.

## Tests

```sh
node --test website/tests/*.test.mjs
node website/tests/isolation-browser.mjs
node website/tests/browser.mjs
node website/tests/explorer-browser.mjs
node website/tests/comparison-browser.mjs
node website/tests/memory-browser.mjs
```

Build first. Browser tests use the root Playwright dependency with Chromium and WebKit. `CHROMIUM_EXECUTABLE` can select a local executable. Tests cover live snapshot updates, retained history, checksum-checked benchmarks and export, cancellation, keyboard search, no-JS docs, mobile overflow, and the scoped service-worker fallback. Build and run these checks with both `/` and `/zerocopy/` prefixes.

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

Tested `main` builds publish the production documentation by default. Set the repository Actions variable **DOCS_PAGES=false** to pause production publication explicitly. An unset variable no longer leaves the root serving the non-indexable PR-preview placeholder. Publication uses the same branch publisher and preserves `previews/`. Do not switch Pages to GitHub Actions while using this branch-based preview workflow. Custom-domain deployment needs a matching base/origin configuration. The workflow does not publish npm or merge PRs.

## Search indexing and repository discovery

Production URL: `https://natanelia.github.io/zerocopy/`.
Sitemap: `https://natanelia.github.io/zerocopy/sitemap.xml`.

Production guides contain static HTML, unique titles and descriptions, canonical URLs, and Open Graph metadata. The sitemap lists only production pages. PR previews and the 404 page carry `noindex,nofollow`; previews do not generate a sitemap. Crawlers may fetch previews so they can see the exclusion directive.

GitHub Pages project sites cannot control the host's `/robots.txt` from a repository subdirectory. `/zerocopy/robots.txt` is not the robots policy for `natanelia.github.io`. Submit the sitemap directly instead of relying on its discovery through that subpath file. Do not block previews in a host-level robots file if you want crawlers to observe their `noindex` metadata.

After the changes reach `main` and the Documentation website workflow succeeds:

1. Check that the public homepage serves the product documentation, not "zerocopy PR previews", and that the sitemap returns HTTP 200. Check `build.json` against the tested source commit.
2. In GitHub's repository **About** settings, set the website to the production URL and describe the project as "Zero-copy immutable collections for JavaScript and TypeScript using SharedArrayBuffer and WebAssembly." Add relevant topics such as `typescript`, `javascript`, `webassembly`, `sharedarraybuffer`, `web-workers`, `immutable`, and `data-structures`. These remote settings are separate from the README and package metadata.
3. Add a **URL-prefix property** for `https://natanelia.github.io/zerocopy/` in Google Search Console. Use Google's HTML-file verification method. The verification file must be included in future builds, not added only to `gh-pages`, where the next production publication would remove it. No verification token is shipped by default.
4. Submit `sitemap.xml` in that property. Use URL Inspection to request indexing for the homepage and getting-started guide. Check the reported crawl/indexing reason before changing more metadata.

Google controls crawl timing, indexing, and ranking. Metadata and a sitemap do not guarantee inclusion or a particular position. `llms.txt` is for model readers, not a replacement for search indexing. Run `node --test website/tests/seo.test.mjs` after a production or preview build to check the indexing rules.

## Side-by-side comparison

The `/compare/` route runs **zerocopy, Immutable.js, Immer, and native arrays** over identical deterministic events. Each implementation has two real reader workers. One control surface applies the same search, service, severity, time filter, pagination, append, and freeze operation to all four views.

All three replica baselines use incremental deltas by default. Full snapshot replication is an optional, separately labelled mode. All four can retain this append-only stream: zerocopy, Immutable.js, and Immer keep immutable roots; native arrays keep a prefix length. There are no artificial delays or precomputed results. All result pages and aggregates are checked against the independent array reference after timing.

The transport counter reports logical event deliveries to worker replicas. It does not measure bytes, retained heap, or result-message traffic. Shared mode still sends descriptors, allocates wrappers, and decodes strings. Timing reports show publication/attachment and query completion separately. Owner construction and append work, startup, and DOM rendering are not included. Concurrent timings can be affected by CPU contention; use the rotated four-architecture benchmark for controlled samples.

A single active operation and one latest pending query bound work. Live ingestion waits for previous work to finish. The session stops at 200,000 events. Stop terminates the coordinator and nested readers, clears the displayed results, and drops references without promising forced garbage collection.

## Memory startup regression

The comparison is tested in real Chromium and Playwright WebKit, including 1,000-event startup, 100,000-event loading, Stop/restart, and no-header hosting. This is engine coverage, not a claim of testing every iPhone model. Preview publication waits for the WebKit check.

The library now creates default arenas only when used. New writable arenas start at 128 KiB with a configurable 256 MiB maximum; read-only workers reuse supplied memories. Native, Immutable.js, and Immer comparison readers do not import the WASM engine. Shared readers preload it before publication timing, so module loading is not moved into that measurement.

Nested demo workers use a small local ES module wrapper. This lets them inherit the parent worker's isolation on WebKit while importing the original worker module. The wrapper URL is released with the worker. Hosts with a custom Content Security Policy must permit `blob:` in `worker-src` for these nested demos.

`node --test proofs/memory-startup.mjs` checks allocation counts in fresh workers, bounded defaults, configuration, read-only copies, growth, reset, and retained snapshots. `node website/tests/memory-browser.mjs` runs the browser regression.

## Immutable.js comparison

The build copies the root package's exact pinned `immutable` dependency, upstream ESM distribution, and MIT license into the site. The version is included in `build.json` and both raw exports. There is no CDN dependency and no handwritten substitute for Immutable.js. The package is used only by the demos, not by the zerocopy runtime.

All four live implementations use five columns of primitive values. Immutable.js uses one `List` per column, `withMutations` for batch appends, and direct `get` calls during queries. The owner and both readers hold real Lists. The frozen view retains actual roots, including when a full replica replacement arrives. No full `toJS()` or array conversion occurs during a query.

Immutable.js shares structure between versions within a worker, not the JavaScript heap between workers. Publication encodes the initial columns, or only the appended suffix, with `toArray()`. It then structured-clones those columns and reconstructs or appends Lists in each reader. Encoding and reconstruction are included in publish time. The copy counter counts event deliveries, not retained nodes, bytes, or memory savings.

Immer uses the existing pinned upstream ESM package and MIT license, with its version in the live export. The owner and readers hold frozen native-array columns. Appends use one `produce` batch with default auto-freezing, copying the changed arrays while preserving the retained root. Full publication structured-clones the frozen columns and freezes each receiver without another full copy. Incremental publication sends the generated delta and runs `produce` in each receiver. Reader-side freezing and updates are timed; owner-side appends are not. Queries read the frozen arrays directly. The recorded Node.js memory tables do not include Immer.

The controlled investigation benchmark has four paths: shared snapshots, Immutable.js incremental replicas, native incremental replicas, and one native data owner. It keeps two warm-ups, seven measured samples, rotated path order, separate phase timings, and independent output checks. Immutable.js owner appends and delta encoding are included in the update phase. Initial input generation and List construction are reported separately.

Exports use `zerocopy-live-comparison/v3` (four live paths) and `zerocopy-investigation-benchmark/v2`. The controlled benchmark retains 28 measured path records. Historical benchmark files are unchanged. Tests cover seeded random columns, Unicode messages, tree-size boundaries, exact rows and aggregates, retained roots, both replication modes, and Chromium/WebKit isolation and restart flows.

### Query scheduling and batch updates

All investigation paths yield to the task queue at the same 4,096-index checkpoints.
They use `scheduler.yield()` when available, or a reusable `MessageChannel`.
The older `setTimeout(0)` chain acquired browser minimum delays; those delays were
not collection work. New exports identify the scheduling method. Do not compare
new timings directly with historical timer-based scores as library-only speedups.
The before/after proof includes a baseline with the same new scheduler to isolate
the collection changes. Historical JSON results remain unchanged.

The shared owner now calls public `SharedList.pushMany()` once per column and batch,
just as the Immutable.js owner batches with `withMutations`. Query work, generated
values, independent reference checks, worker counts, and retained versions remain
the same. See `proofs/query-performance.mjs` and the Query performance workflow.
