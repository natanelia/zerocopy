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

GitHub Pages does not provide application-controlled response headers. The lab and playground therefore offer an explicit **Enable shared memory & reload** action. It registers a network-only service worker scoped to the current demo path. The worker adds isolation headers to same-origin responses and performs no caching. Activation causes one user-requested reload, not a loop. Unsupported browsers keep the demo disabled and show the requirement. No silent copy fallback is used.

Test this hosting path with `SITE_ISOLATED=false node website/serve.mjs`. Server headers remain the preferred deployment method.

## Build paths and metadata

`SITE_BASE=/zerocopy/` builds for a repository subpath. It defaults to `/`. Set `SITE_ORIGIN=https://natanelia.github.io` for canonical URLs and a sitemap. `SITE_COMMIT` or `GITHUB_SHA` records the actual build source; local builds use Git HEAD. Do not label an unverified npm version as the installed release.

The build also provides local search, a 404 page, raw Markdown downloads, `llms.txt`, and a build manifest. All fonts use system stacks. No analytics, remote fonts, or third-party runtime scripts are loaded.

## Tests

```sh
node --test website/tests/*.test.mjs
node website/tests/browser.mjs
```

Build first. Browser tests use the root Playwright dependency and Chromium. `CHROMIUM_EXECUTABLE` can select a local executable. Tests cover live snapshot updates, retained history, checksum-checked benchmarks and export, cancellation, keyboard search, no-JS docs, mobile overflow, and the scoped service-worker fallback. Build and run these checks with both `/` and `/zerocopy/` prefixes.

CI uploads the static output, test logs, and desktop/mobile screenshots. Existing library and Markdown checks remain separate and unchanged.

## Publish

The `Documentation website` workflow builds and checks pull requests without publishing them. A push to `main` can deploy to GitHub Pages after one-time repository setup:

1. Set **Settings → Pages → Source** to **GitHub Actions**.
2. Set the repository Actions variable **DOCS_PAGES** to **true**.

Then merge the site PR or run the workflow manually on `main`. The deploy job requires `pages: write` and `id-token: write`, and uses the `github-pages` environment. Without that variable, CI still produces a downloadable, tested static site. The workflow does not publish an npm package or change a custom domain.
