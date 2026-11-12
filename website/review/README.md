# Website redesign review

The homepage explains the shared-memory model; Snapshot Studio demonstrates actual worker behavior; the benchmark page leads with memory charts and a one-click performance run; the adoption guide makes the constraints visible before setup.

## Screenshots

All seven screenshots use source commit `e9ae75712fcd883821c0b6ff4fe88b3c79b58cce`, built at `/zerocopy/` in Chromium 153.0.8010.0. There are no mocked worker responses or painted-over results. The studio shows three real workers at revision 2, with pinned stock values of 12, 7, and 12 while the current stock is 4.

Benchmarks is now the single comparison destination. The homepage, desktop/mobile menus, docs sidebar, search, and PR preview point to it. Eleven older comparison, benchmark, and report URLs redirect to its memory, performance, or source-data sections. Original Markdown reports remain downloadable, while the old interactive interfaces run only as internal regression fixtures and are never deployed.

The benchmark screenshots show the initial page, including the original verified Node memory measurements and a clearly labelled browser recording. The performance recording was captured on source `ab1eae5c2ecc8497ed1b5a4c422febc0e5e4f492` with 10,000 products, two readers, and 100 replacements. All 63 records remain downloadable. Clicking **Run on my device** replaces those recorded timings with the completed local run.

- [Desktop homepage](screenshots/home-desktop.png)
- [Mobile homepage](screenshots/home-mobile.png)
- [Desktop snapshot studio](screenshots/studio-desktop.png)
- [Mobile snapshot studio](screenshots/studio-mobile.png)
- [Desktop benchmark dashboard](screenshots/benchmarks-desktop.png)
- [Mobile benchmark dashboard](screenshots/benchmarks-mobile.png)
- [Adoption guide](screenshots/adoption-desktop.png)
- [Capture settings and source identity](screenshots/capture.json)
- [Benchmark capture settings and recording identity](screenshots/benchmark-capture.json)

The mobile captures use a 390 × 844 viewport and include the full scrollable page. The desktop homepage and adoption guide use a 1440 × 1000 viewport; the other desktop captures include the full page. Reduced motion is enabled for deterministic screenshots.

## Verified locally

- Library WASM and browser build, then the 24-page static website build.
- 161 website tests pass.
- Chromium: home interactions, keyboard controls, safe local search, copy behavior, no-JavaScript content, documentation navigation, and mobile overflow.
- Real studio workers: drafts and publication, three readers, independent pins, late joins, bounded history, invalid input, canceled startup, disconnect/reconnect, and navigation cleanup.
- Product-catalog workers: 1,000 and 100,000 products, sparse edits, retained revisions, and all 63 benchmark records with exact per-phase copy modes and raw exports.
- Memory charts: values, scales, source provenance, keyboard disclosures, local exports, and 1440/768/390/320-pixel layouts.
- Benchmark dashboard: recorded results without JavaScript, one-click 10,000-product execution, all 63 exported records, source labels, keyboard disclosures, cancellation/failure, and 390/320-pixel layouts.
- All retired routes redirect with and without JavaScript; query parameters survive, and the final anchor selects the appropriate section. Navigation, search, and the sitemap expose one benchmark destination.
- Headerless hosting: scoped service-worker setup and real shared-memory operation in Chromium.

WebKit was not installed in the local runner. Hosted checks retain Chromium and WebKit coverage, including original worker regressions through the test-only fixture server. Public-page checks use the actual built site. The earlier dashboard passed both browsers; this revision also fixes the isolation test's wait for an intentionally hidden ready state. The recorded timings describe one environment; they are not a general performance guarantee. The library and benchmark measurement logic are unchanged.

## Reproduce captures

Build the library using the repository setup, then:

```sh
SITE_BASE=/zerocopy/ SITE_ORIGIN=https://natanelia.github.io node website/build.mjs
node website/tests/capture-review.mjs
node website/tests/capture-benchmarks.mjs
```

Set `CHROMIUM_EXECUTABLE` when using a local Chromium executable. Screenshot binaries live here, outside `website/assets/` and `_site/`, so they are not shipped with the site or passed to the text-only Pages publisher.
