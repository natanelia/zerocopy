# Website redesign review

The homepage explains the shared-memory model; Snapshot Studio demonstrates actual worker behavior; the benchmark page leads with memory charts and a one-click performance run; the adoption guide makes the constraints visible before setup.

## Screenshots

The homepage, studio, and adoption captures use source commit `e6eeececc3fedf485b34d98e47c9c6f1803e4cba`. The updated benchmark captures use source commit `aafe7cd5138c96b1da379442a074bf5e08f38a2d`. Both were built at `/zerocopy/` in Chromium 153.0.8010.0. There are no mocked worker responses or painted-over results. The studio shows three real workers at revision 2, with pinned stock values of 12, 7, and 12 while the current stock is 4.

The benchmark screenshots show the initial page, including the original verified Node memory measurements and a clearly labelled browser recording. The performance recording was captured on source `ab1eae5c2ecc8497ed1b5a4c422febc0e5e4f492` with 10,000 products, two readers, and 100 replacements. All 63 records remain downloadable. Clicking **Run on my device** replaces those recorded timings with the completed local run.

- [Desktop homepage](screenshots/home-desktop.png)
- [Mobile homepage](screenshots/home-mobile.png)
- [Desktop snapshot studio](screenshots/studio-desktop.png)
- [Mobile snapshot studio](screenshots/studio-mobile.png)
- [Desktop benchmark dashboard](screenshots/benchmarks-desktop.png)
- [Mobile benchmark dashboard](screenshots/benchmarks-mobile.png)
- [Adoption guide](screenshots/adoption-desktop.png)
- [Original capture settings and source identity](screenshots/capture.json)
- [Benchmark capture settings and recording identity](screenshots/benchmark-capture.json)

The mobile captures use a 390 × 844 viewport and include the full scrollable page. The desktop homepage and adoption guide use a 1440 × 1000 viewport; the other desktop captures include the full page. Reduced motion is enabled for deterministic screenshots.

## Verified locally

- Library WASM and browser build, then the 34-page static website build.
- 160 website tests pass at root and the GitHub Pages project prefix.
- Chromium: home interactions, keyboard controls, safe local search, copy behavior, no-JavaScript content, documentation navigation, and mobile overflow.
- Real studio workers: drafts and publication, three readers, independent pins, late joins, bounded history, invalid input, canceled startup, disconnect/reconnect, and navigation cleanup.
- Product-catalog workers: 1,000 and 100,000 products, sparse edits, retained revisions, and all 63 benchmark records with exact per-phase copy modes and raw exports.
- Memory charts: values, scales, source provenance, keyboard disclosures, local exports, and 1440/768/390/320-pixel layouts.
- Benchmark dashboard: recorded results without JavaScript, one-click 10,000-product execution, all 63 exported records, source labels, keyboard disclosures, cancellation/failure, and 390/320-pixel layouts.
- Headerless hosting: scoped service-worker setup and real shared-memory operation in Chromium.

WebKit was not installed in the local runner. The previous revision `ab1eae5c2ecc8497ed1b5a4c422febc0e5e4f492` passed the full hosted matrix, including Chromium and WebKit. The updated workflow adds the dashboard browser suite and checks its isolation scope at root, project, and commit-preview prefixes. The recorded timings describe one environment; they are not a general performance guarantee. The library and benchmark measurement logic are unchanged.

## Reproduce captures

Build the library using the repository setup, then:

```sh
SITE_BASE=/zerocopy/ SITE_ORIGIN=https://natanelia.github.io node website/build.mjs
node website/tests/capture-review.mjs
node website/tests/capture-benchmarks.mjs
```

Set `CHROMIUM_EXECUTABLE` when using a local Chromium executable. Screenshot binaries live here, outside `website/assets/` and `_site/`, so they are not shipped with the site or passed to the text-only Pages publisher.
