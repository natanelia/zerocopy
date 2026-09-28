# Query and append/publication audit

Baseline for this audit: merged main `f3ba7a494b77c4b2e46540a599d98440c629cb5a`.

## What changed

`SharedList.get()` used an arena-wide cache for one vector leaf. The log view
interleaves five lists in the same arena. Reading the next column evicted the
previous column's cache. The replacement keeps one leaf address and one
`DataView` on each immutable list handle. Nearby reads avoid a new WASM tree
walk. Public handles remain frozen. Private cache fields are not serialized.
This does not copy the list or change its wire format.

Published bytes never move or change. A cached view can keep reading its old
range after shared memory grows. New snapshots get their own view. A reset
creates a different arena, so old snapshots do not point at reused addresses.

`Arena.encode()` now reuses the encoded bytes of repeated string values in that
arena. Its lazy dictionary admits at most 2,048 keys and 256 KiB of accounted
UTF-16 key plus UTF-8 payload bytes. This is a retention budget, not a measured
heap bound: Map entries have additional overhead. New unique strings still use
the ordinary path after the budget is full. Existing keys remain reusable.
JSON objects are not interned. Read-only checks still run before cache hits.
`Arena.decode()` also checks the existing decoded-string cache before fetching
another buffer view or length header.

The demo used one persistent `push()` per field value. It now calls the existing
public `pushMany()` once per column per batch. This is a caller improvement,
not a new library API. Length and capacity checks happen before appending.
Immutable.js continues to use `withMutations` for its batch appends.

The common query scheduler chained zero-delay timers. In browsers, nested
`setTimeout` calls can incur a minimum delay. Every architecture now uses the
same task scheduler: `scheduler.yield()` when supported, or `MessageChannel`.
Node tests use `setImmediate`. The 4,096-index cancellation checkpoints are
unchanged. Promise-only yielding is not sufficient because it can prevent
other task messages from running.

## Measurement

`Query performance` builds three variants and runs the actual four-architecture
browser benchmark with real workers and shared WASM memory:

- **Original:** the exact merged baseline, including its old caller and timers.
- **Matched:** the original engine, with the same new scheduler and public bulk
  append caller used by the candidate. All architectures use that scheduler.
- **Optimized:** the new engine with the same scheduler and bulk caller.

Comparing matched and optimized separates engine improvements from timer and
caller improvements. Comparing shared and Immutable.js within the optimized
run addresses the product workload. The native replicas and native single
owner remain in every benchmark.

At 100,000 events, three fresh contexts per variant run in Chromium and WebKit.
Variant order rotates. Each run preserves two warm-ups, seven measured samples,
the existing three queries, two reader workers for replica designs, a 2,000-event
append, and independent checks of complete visible rows and aggregates.
No sample is removed. Raw exports and per-query groups are retained.

A separate diagnostic makes every event message unique by adding its event ID,
equally for all architectures. It runs one seven-sample set per matched and
optimized variant per browser. It is not a speed acceptance gate. Its results,
including losses, must remain visible alongside the repeated-text workload.
The public demo fixture and historical benchmark JSON are not rewritten.

These are operation timings, not raw collection-read throughput or memory
measurements. They include worker communication and cooperative task turns.
Construction is reported separately; worker startup and DOM rendering are not
included. Pooling different queries describes this fixed mix, not any one query.

## Limits and rejected experiments

UTF-8 strings still need local JavaScript strings for JavaScript string queries.
Shared backing bytes do not make this decoding cost disappear. A workload with
unique messages can remain slower than an already-decoded Immutable.js List.
Small and random-access workloads also need separate measurements.

A reusable UTF-8 decode buffer and a longer handwritten ASCII decode path were
tried locally. They did not improve the unique-message scan, so neither change
is included. The implementation does not keep an unbounded decoded copy of the
dataset to make a benchmark score look better.

## Reproduction

The workflow selects the event's actual PR base SHA. Manual runs select the
checked-out repository's current `origin/main`. Both revisions are recorded in
the result files. The control accepts old and new schedulers but rejects other
query or fixture changes. This prevents unrelated changes from being credited
to the collection engine. It uses the repository's exact build and dependency
setup. Run the steps in `.github/workflows/query-performance.yml`
to build both websites, then run:

```sh
node proofs/query-performance.mjs
```

Output is retained in `proofs/results/query-performance/`, with one JSON file
per run, `by-query.json`, and `summary.json`. The workflow also uploads its log.

Correctness checks run independently of timing:

```sh
node --test proofs/list-query.mjs proofs/list-codecs.mjs proofs/query-control.test.mjs
node --test website/tests/task-yield.test.mjs
```

The existing library, worker, browser, memory, and documentation checks remain
enabled. A green build does not imply a speed win; read the measurements.

## Recorded browser run

Run [36393872702](https://github.com/natanelia/zerocopy/actions/runs/36393872702)
measured candidate `b7bfe25b702bff89f5c2dbcdc25b7882b7a58a91`, tested merge
`abf1438f3e952ae327207fee16b0a8dc1f4e33fd`, against the baseline above.
This records that run, not a promise about future devices or workloads.

Medians in milliseconds across 21 samples per architecture for the unchanged
100,000-event demonstration mix (three fresh runs of seven samples):

| Engine | Phase | Shared | Immutable.js | Immutable / shared |
| --- | --- | ---: | ---: | ---: |
| Chromium | Query | 10.445 | 12.935 | 1.24x |
| Chromium | Append + publish + query | 10.395 | 18.220 | 1.75x |
| WebKit | Query | 7.940 | 10.780 | 1.36x |
| WebKit | Append + publish + query | 8.860 | 14.580 | 1.65x |

Against the matched original engine, shared query medians fell from 18.245 to
10.445 ms in Chromium, and 21.640 to 7.940 ms in WebKit. Update medians fell
from 19.025 to 10.395 ms and 14.620 to 8.860 ms. These controls already include
the new scheduler and bulk caller. Do not describe the much larger difference
from the original timer-based build as an engine-only gain.

**Not every query wins.** WebKit's broad `request` query on repeated text was
20.500 ms for shared lists and 17.580 ms for Immutable.js in the per-query group.
Unique-text `request` queries were 93.755 versus 27.190 ms in Chromium, and
84.280 versus 20.960 ms in WebKit. The one-run unique-text diagnostic is less
extensive, but its losses are large enough to reject a general text-scan claim.
Its service-filter update was faster with shared lists; see the full breakdown.

All raw samples, per-query groups, controls, and native architectures are in the
run's `query-performance-abf1438f3e952ae327207fee16b0a8dc1f4e33fd` artifact.
The downloaded archive's SHA-256 is
`aa84ea321934e0f02bcfcc93c77c51da5fa9b4a86b3c60323c0014eec35da8ac`.
