# Catalog benchmark integration

This change starts from `22933ebf35f23f0047ab0f020fb1ccf2ddd993d9` and changes benchmark code, website presentation, build identity and tests only. Production collection code, Rust kernels, stored format, dependency versions and historical measurements are unchanged.

## Fixed workloads

The existing `/investigation-benchmark/` route contains one run action. Historical memory charts keep their original dates, sources and values. New timings distinguish complete frozen `.get()` results, selective application queries, immediate repeats, explicit view materialization and construction through first answer. See the [method](../../website/README.md#catalog-benchmark) for exact contracts and boundaries.

Every new read sample creates an owner and two readers. Cold and repeat outputs are captured before verification. Both readers run in parallel; local charts report the slower reader and retain both durations. The combined total is computed from construction, publication and the first full round-trip within each sample, before taking the median. Startup is recorded separately. Current and retained outputs are checked after replacing 100 records. Full-object source values are checked inside readers for deep immutability after timing.

The original catalog fixture, fingerprint calculation and worker measurement code are untouched. Its seven cases and 63 warm-up/measured records remain a distinct legacy control. Fingerprint computation is timed. Independent reference comparison is untimed. Eleven read cases add 99 records; a complete v4 export has 162 records with the execution schedule, exact API/freeze contracts, failures and build identities.

The page checks source metadata on initial load and after restoration from browser history, without loading library/Wasm files. Each Run action repeats that metadata check and verifies fetched library, workload and dependency hashes before creating workers. It rejects mismatched metadata before measuring. Fetched-byte verification does not attest already evaluated modules; commit-specific preview URLs provide a stable review location. Service-worker scopes and inspection failures are exported. The shipped isolation service worker does not cache assets.

## Verification

The local website build and 169 static tests pass. New protocol tests exercise all actual storage implementations and retained revisions; adversarial tests check API call counts, query short-circuiting, excluded-field access, ordering, misses, mutable/frozen materialization and oracle rejection. Existing browser checks now verify all new samples, every displayed median, parallel-reader aggregation, per-sample totals, legacy restrictions, cancellation, stale-build failure and responsive layout.

The pinned Rust build, seven rejection/audit tests, 12-worker concurrency proof and geometry ABI proof also pass locally. Chromium cannot launch in this local environment because its process-singleton socket is denied; WebKit lacks system libraries. **Firefox 155.0 passes the complete feature/browser flow:** 1,000/100,000-record comparisons, all 162 benchmark records, exact displayed medians, retained snapshots, cancellation, stale-build rejection before measurement, headerless isolation, no-JavaScript content and 390/320px layouts. Its compressed raw export, log and desktop/mobile/screenshots are included with checksums in `evidence-manifest.json`. Hosted Chromium/WebKit checks are tracked in PR #78. These validation runs establish correctness, not a runtime speedup.

The first Firefox attempt completed the benchmark but exposed a test assertion that read rendered text inside a collapsed disclosure as empty. The test now checks text content, preserving all value/API assertions; the failed log is retained. The successful recording explicitly carries `sourceDirty: true`: runtime/workload sources and hashes are from `3143c471`, while its browser test driver includes the presentation assertion repair in `d42ddea0`. Do not treat it as a clean performance baseline for Track B. An earlier local browser attempt was interrupted by an overlapping static-site rebuild; the completed run uses a stable build.

Hosted website run [43656962551](https://github.com/natanelia/zerocopy/actions/runs/43656962551) caught eager hash-verification requests during passive page setup: the isolation test observed 36 library requests where it required zero. Asset verification now starts only with Run; metadata remains visible on page load. The existing isolation assertion is preserved, and the main feature test also checks that setup fetches no library files. A local parallel static run also hit an existing short scheduling timeout in `isolation-slot.test.mjs`; its focused rerun and the complete serial run both passed (169/169). These failures are not performance evidence.

## Reproduce

Build the library and website with the versions in `CONTRIBUTING.md`, then run:

```sh
node --test website/tests/*.test.mjs
node website/tests/feature-browser.mjs
FEATURE_BROWSERS=firefox node website/tests/feature-browser.mjs
node proofs/benchmark-integration-20261115/verify.mjs path/to/export.json
```

The browser tests retain raw exports and desktop/mobile screenshots under `website/artifacts/` (or `BROWSER_ARTIFACTS_DIR`). The independent export verifier reconstructs all medians from raw values, checks per-sample totals, individual reader aggregation, complete schedules, APIs, correctness flags and the preserved legacy publication contract. It does not rerun timings.

After this benchmark-only change lands, its merge commit is the harness anchor for a separate standard-`.get()` performance study. That study must use fresh, same-API baseline/candidate measurements. Neither selective-view gains nor these validation timings establish faster standard `.get()`.
