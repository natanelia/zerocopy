# Website integration review

The website rewrite now includes the Rust migration, the consolidated CI setup, and the separate read workloads from benchmark PR #78. The homepage explains shared storage, Snapshot Studio uses real reader workers, and one **Benchmarks** page contains memory and performance. This integration does not change the production collection or Rust implementation.

The integration includes main through `12429087`, including the merged benchmark PR #78 (`06d986ee`). That benchmark update also fixes a hosted Chromium test-driver stall: stale-build and changed-asset faults are injected by the test server, with the same failure assertions and measurement deadlines. Its existing Chromium validation evidence is preserved alongside the Firefox recording below.

## One benchmark destination

The homepage, desktop/mobile navigation, docs sidebar, search and PR preview point to `/benchmarks/`. Eleven older comparison, benchmark and report URLs redirect to its memory, performance or source-data sections. Original Markdown reports remain downloadable. Historical interactive interfaces run only as internal regression fixtures and are not deployed.

Verified historical memory bars appear first. Four performance charts are visible immediately: cold full-object `.get()`, cached `.get()`, a selective application query, and construction through the first full answer. Setup, transport, retained revisions, explicit view materialization and the original catalog control are available in disclosures on the same page. `getView()` results are labelled separately from ordinary `.get()`.

## Fresh performance recording

The [complete v4 recording](../assets/catalog-read-recording.json) was captured with Firefox 155 on Linux from clean source [`c1247f59f8d5a1022398c80ccc9e6c91cb008de2`](https://github.com/natanelia/zerocopy/commit/c1247f59f8d5a1022398c80ccc9e6c91cb008de2), built at `/zerocopy/`. It uses 10,000 products, two reader workers, 1,000 requested IDs and 100 replacements. The 18 cases each have two warm-ups and seven measured samples: **99 read records plus 63 original catalog-control records**.

The recording contains the exact source commit, `sourceDirty: false`, library/workload/dependency hashes, API and freeze contracts, timer boundaries, browser details, individual reader durations, retained/current checks, and complete execution order. The checked-in JSON is compacted without changing any parsed value. The independent verifier recomputed all summaries, per-sample construction totals and rotated execution order. The site build also rejects invalid or inconsistent prefills.

The [original v3 recording](../assets/catalog-benchmark-recording.json) remains byte-identical and separately downloadable. Historical memory recordings and all 77 recorded benchmark table rows are unchanged. Neither recording is presented as a general speed guarantee or a measurement from the visitor's device.

**Run on my device** starts the same fixed workloads on the current build. Completed bars and their source label remain visible during another run. Failed or stopped attempts have clearly named partial exports; incomplete medians do not replace complete evidence. Passive page setup reads metadata and starts no workers or library/Wasm requests. Run verifies fetched files before measurements start.

## Screenshots

All screenshots are actual browser captures. The manifests identify the exact built source, browser and viewport. There are no mocked worker replies or painted-over results. The studio capture waits until all three workers show current stock 4 at revision 2, while their independently pinned stock values are 12, 7 and 12.

- [Desktop homepage](screenshots/home-desktop.png)
- [Mobile homepage](screenshots/home-mobile.png)
- [Desktop Snapshot Studio](screenshots/studio-desktop.png)
- [Mobile Snapshot Studio](screenshots/studio-mobile.png)
- [Desktop Benchmarks](screenshots/benchmarks-desktop.png)
- [Mobile Benchmarks](screenshots/benchmarks-mobile.png)
- [Adoption guide](screenshots/adoption-desktop.png)
- [Capture source and observed worker state](screenshots/capture.json)
- [Benchmark capture and recording identity](screenshots/benchmark-capture.json)

Mobile captures use a 390 × 844 viewport. Desktop captures use 1440 × 1000; Studio and Benchmarks include the full page. Reduced motion is enabled for consistent captures. Screenshot binaries live outside deployed assets.

## Local verification

- Pinned Rust/Wasm and browser builds; all seven Rust/Wasm audit tests pass.
- All **196 website tests** pass, including recording validation and adversarial changes to samples, summaries, APIs, contracts, execution order and hashes.
- Firefox public dashboard: a complete 10,000-product run, every value and scale in all 25 charts, raw v4 export, no-JavaScript prefills, metadata-only setup/reload/return, keyboard disclosures, partial cancellation, worker failure, stale source and asset rejection, navigation cleanup, and 320px/390px layouts.
- Firefox real product-catalog comparison: 1,000 and 100,000 products, sparse replacements, retained snapshots, stop/restart/navigation, headerless worker setup and mobile layouts.
- Firefox Snapshot Studio: draft/publication separation, three readers, independent pins, late joins, bounded history, invalid input, startup cancellation, disconnect/reconnect, navigation cleanup and 320px/390px layouts.
- Strict documentation preservation: 77/77 benchmark rows unchanged; zero historical evidence files changed.
- Independent review of lifecycle handling, source identity, render contracts and deployment paths found no remaining blocker.

Chromium and WebKit remain the default hosted browser gates. The local environment has Firefox available; hosted results are reported on the PR after execution. The expensive browser flows run once at the deployment target. Alternate root/project prefixes retain their static and isolation checks, preserving the reduced two-build CI structure.

## Reproduce

Build the library with the pinned Rust toolchain and repository dependencies, then:

```sh
SITE_BASE=/zerocopy/ SITE_ORIGIN=https://natanelia.github.io node website/build.mjs
node --test website/tests/*.test.mjs
DASHBOARD_BROWSERS=firefox node website/tests/benchmark-dashboard-browser.mjs
FEATURE_BROWSERS=firefox node website/tests/feature-browser.mjs
STUDIO_BROWSERS=firefox node website/tests/studio-browser.mjs
node proofs/benchmark-integration-20261115/verify.mjs website/assets/catalog-read-recording.json
CAPTURE_BROWSER=firefox node website/tests/capture-review.mjs
CAPTURE_BROWSER=firefox node website/tests/capture-benchmarks.mjs
```

Omit the browser selectors to use the default hosted engines. `CHROMIUM_EXECUTABLE` supports an installed local Chromium binary. The complete build and source files remain available in the PR.
