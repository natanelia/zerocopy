# Website redesign review

The homepage explains the shared-memory model; Snapshot Studio demonstrates actual worker behavior; the benchmark explorer directs developers to the right measured workload; the adoption guide makes the constraints visible before setup.

## Screenshots

These are browser captures of source commit `e6eeececc3fedf485b34d98e47c9c6f1803e4cba`, built at `/zerocopy/` in Chromium 153.0.8010.0. The evidence commit only adds this directory. There are no mocked worker responses or painted-over results. The studio shows three real workers at revision 2, with pinned stock values of 12, 7, and 12 while the current stock is 4.

- [Desktop homepage](screenshots/home-desktop.png)
- [Mobile homepage](screenshots/home-mobile.png)
- [Desktop snapshot studio](screenshots/studio-desktop.png)
- [Mobile snapshot studio](screenshots/studio-mobile.png)
- [Benchmark explorer](screenshots/benchmarks-desktop.png)
- [Adoption guide](screenshots/adoption-desktop.png)
- [Capture settings and source identity](screenshots/capture.json)

The mobile captures use a 390 × 844 viewport and include the full scrollable page. The desktop homepage and adoption guide use a 1440 × 1000 viewport; the other desktop captures include the full page. Reduced motion is enabled for deterministic screenshots.

## Verified locally

- Library WASM and browser build, then the 34-page static website build.
- 157 website tests pass at root and the GitHub Pages project prefix.
- Chromium: home interactions, keyboard controls, safe local search, copy behavior, no-JavaScript content, documentation navigation, and mobile overflow.
- Real studio workers: drafts and publication, three readers, independent pins, late joins, bounded history, invalid input, canceled startup, disconnect/reconnect, and navigation cleanup.
- Product-catalog workers: 1,000 and 100,000 products, sparse edits, retained revisions, and all 63 benchmark records with exact per-phase copy modes and raw exports.
- Memory charts: values, scales, source provenance, keyboard disclosures, local exports, and 1440/768/390/320-pixel layouts.
- Headerless hosting: scoped service-worker setup and real shared-memory operation in Chromium.

WebKit was not installed in the local runner. The existing hosted workflow retains its Chromium and WebKit checks, and the studio suite is added at the root, project, and commit-preview prefixes. This change makes no new performance claims. The library and benchmark measurement engines are unchanged.

## Reproduce captures

Build the library using the repository setup, then:

```sh
SITE_BASE=/zerocopy/ SITE_ORIGIN=https://natanelia.github.io node website/build.mjs
node website/tests/capture-review.mjs
```

Set `CHROMIUM_EXECUTABLE` when using a local Chromium executable. Screenshot binaries live here, outside `website/assets/` and `_site/`, so they are not shipped with the site or passed to the text-only Pages publisher.
