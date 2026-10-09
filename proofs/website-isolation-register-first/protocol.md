# Registration-order repair for PR22

The original source is pinned to `56211356dfdb7356b8b3e572109625aa81207d0a`. Candidate changes only the order in which demo setup obtains its first registration wrapper. Runtime collection code, memory evidence, worker bytes, the 12-second production deadline, and existing browser assertions remain unchanged.

## Hypothesis fixed before execution

The pre-registration lookup can snapshot another tab's empty registration before this document subscribes to worker lifecycle changes. WebKit reuses that wrapper without copying newer slots returned by later lookups, `register()`, or `ready`. Starting with `register()` avoids creating the wrapper until the installing worker is present. Equal-scope registration jobs are serialized and a matching script is reused. This is a source-backed hypothesis for the reported natural failure, not yet a browser-confirmed diagnosis.

The pinned Playwright 1.63.0 [browser declaration](https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/packages/playwright-core/browsers.json#L25-L34) identifies WebKit revision 2359/version 26.6. Its [upstream configuration](https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/browser_patches/webkit/UPSTREAM_CONFIG.sh#L3) pins WebKit `4d05d732e5a84f32675bef4cc135a2e7a9269a87`. The release bootstrap patch does not modify these service-worker files. This is release source provenance, not a binary rebuild attestation.

- [Cached wrapper ignores newer input; constructor subscribes later](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/workers/service/ServiceWorkerRegistration.cpp#L64-L92).
- [Lookup returns a snapshot](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/workers/service/server/SWServer.cpp#L508-L529); [subscription has no catch-up snapshot](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/workers/service/server/SWServerRegistration.cpp#L168-L171).
- [Equivalent jobs queue separately in this WebKit release](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/workers/service/server/SWServer.cpp#L660-L669).
- [Installing is set before register resolves](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/workers/service/server/SWServerJobQueue.cpp#L208-L224); [matching script is reused](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/workers/service/server/SWServerJobQueue.cpp#L341-L348).
- Standard: [Register](https://w3c.github.io/ServiceWorker/#register-algorithm), [Install](https://w3c.github.io/ServiceWorker/#installation-algorithm), and [Schedule Job](https://w3c.github.io/ServiceWorker/#schedule-job-algorithm).

## Fixed browser protocol

Use default headless Chromium and WebKit, installed by the pinned project dependency. Each engine runs both original and candidate sources in the same browser process. For each source, run ten natural concurrent-tab scenarios in fresh contexts, alternating original/candidate order by round. Then run one deterministic cached-wrapper scenario per source, with two concurrent tabs and actual browser service-worker installation. This fixture models the stale cross-process wrapper, not browser security: no isolation property, worker execution, navigation, or production deadline is overridden. Total: 44 scenarios and 88 tabs.

Retain all scenario records, source hashes, source identity, actual browser versions, event traces, exceptions, and actual outcomes. No retries, early stopping after favorable results, or discarded failures. On a failure, inspect the same scope from a new homepage document in the same context. The fixture is restricted to compare documents; a unit guard and a browser assertion verify that the homepage observer keeps native readiness. An active fresh registration alongside a stale blocked document distinguishes wrapper state from an installation stall.

Acceptance: every candidate scenario must be genuinely cross-origin isolated with the exact expected controller, original query and fragment, and at most one automatic navigation. The original source must time out in both deterministic injected scenarios while a fresh document sees its real activated worker. Natural original outcomes are recorded without requiring failure: a stochastic race may not appear in ten rounds. This separates proof of the specific defect model from reproduction of the natural race.

After the comparison, run all 46 setup unit tests and the complete existing website setup browser suite against the candidate at root, GitHub Pages subpath, and a commit-specific preview path. All ten natural concurrent rounds, all five demos, header/no-header paths, blocked storage, stale views, registration rejection/retry, restricted APIs, denied isolation, URL preservation, and no-benchmark-work controls stay enabled. The deterministic regression is added to that permanent suite. No production timeout or test deadline increases.

The proof branch has read-only permissions and no deployment step. Passing this proof permits review of the narrow patch; normal PR checks still must run on the final published PR head.
