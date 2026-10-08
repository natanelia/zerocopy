# Reuse a portable UTF-8 write buffer

This change removes temporary encoded byte buffers from common string and JSON writes. It uses one lazy 48 KiB ordinary buffer. It does not change the public API, persistent records, or worker format 4.

## Change

Previously, a value passed through `TextEncoder.encode()`. That call allocated a byte buffer. The writer then copied those bytes into scratch or into the new persistent record.

`Arena.encode`, `Arena.leaf`, and the generic `Arena.write` path now use native `TextEncoder.encodeInto()` to fill a reusable ordinary buffer. Each caller copies the returned byte view into its own storage before another serialization can run. No published record points into the temporary buffer. The ordinary buffer works in engines that reject shared encoder output and needs no extra shared-output copy.

Native `JSON.stringify()` still runs exactly once. All serialization callbacks finish before the temporary buffer is used. A callback can create another snapshot in the same arena or another arena. It can also grow shared memory. `Arena.prepare()` still returns independent encoded bytes for callers such as compaction. Arena fields and the existing numeric, boolean, and cached-string dispatch retain their original structure.

The encoder checks that it consumed the complete UTF-16 input. Large values and engines without `encodeInto` use the previous allocating encoder. The first fitting text write retains one 49,152-byte ordinary buffer per module instance. Read-only workers do not allocate it. Encoding result objects and typed-array views still exist; this is not a claim of zero JavaScript allocation or lower peak memory.

The value path serves SharedMap, SharedOrderedMap, SharedSortedMap, SharedList, SharedQueue, SharedStack, SharedLinkedList, SharedDoublyLinkedList, and SharedPriorityQueue. It also serializes nested collection descriptors. Numeric and boolean values, existing ASCII map string fast paths, and interned-string hits keep their fast dispatch. The three Set wrappers store values as keys, so this change does not remove their key-encoding buffers.

## Results

The clearest local gain is for 512 appends of unique 4 KiB strings: **1.86x in Node and 1.56x in Bun**. The four measured JSON write cases are **1.17x to 1.76x faster in Node**. Bun JSON results range from 0.94x to 1.05x. The repeated-string Node control is slower at 0.92x. These results support a text-write optimization, not a universal speed claim.

### Node v22.23.2

| Workload | Operations | Base median, ms | Candidate median, ms | Speed | Round range |
| --- | ---: | ---: | ---: | ---: | ---: |
| `map-json-set` | 5,000 | 16.429 | 12.661 | 1.30x | 1.23–1.36x |
| `map-json-setMany` | 5,000 | 12.694 | 10.871 | 1.17x | 1.03–1.26x |
| `map-json-update` | 5,000 | 16.421 | 11.653 | 1.41x | 1.34–1.47x |
| `list-json-push` | 5,000 | 15.716 | 8.919 | 1.76x | 1.32–1.85x |
| `list-4k-push` | 512 | 4.599 | 2.470 | 1.86x | 1.35–2.29x |
| `control-list-number` | 5,000 | 1.142 | 1.046 | 1.09x | 0.72–1.81x |
| `control-list-repeated` | 5,000 | 1.218 | 1.319 | 0.92x | 0.86–1.00x |

### Bun 1.4.2

| Workload | Operations | Base median, ms | Candidate median, ms | Speed | Round range |
| --- | ---: | ---: | ---: | ---: | ---: |
| `map-json-set` | 5,000 | 13.257 | 13.912 | 0.95x | 0.85–1.12x |
| `map-json-setMany` | 5,000 | 7.833 | 8.323 | 0.94x | 0.84–1.08x |
| `map-json-update` | 5,000 | 14.593 | 13.899 | 1.05x | 0.91–1.25x |
| `list-json-push` | 5,000 | 12.010 | 12.504 | 0.96x | 0.87–1.04x |
| `list-4k-push` | 512 | 11.292 | 7.256 | 1.56x | 1.32–1.91x |
| `control-list-number` | 5,000 | 0.469 | 0.386 | 1.21x | 0.85–1.14x |
| `control-list-repeated` | 5,000 | 0.537 | 0.500 | 1.07x | 0.89–1.47x |

Do not count the numeric-control ratios as a benefit of this text change. Their round-to-round variation is large. The repeated-string workload uses eight interned values; it remains a useful counterexample to a blanket speed claim. The p95 values and every individual sample are in the evidence.

The tables compare this change with `main` at `c3c45821a00030e5dd72ea4af5c9d3d51f96d836`. They do not compare different libraries. Values above 1 in a speed column mean that the candidate is faster. A round range is the minimum and maximum ratio of the three round medians; it is not a confidence interval.

## Method

The recorded run uses Node 22.23.2, Bun 1.4.2, AssemblyScript 0.28.20, and the repository's unchanged build flags. Both variants use the same installed dependencies. The machine is Linux x64 with an Intel Xeon Platinum 8573C processor.

Each workload, library version, runtime, and round runs in a separate process. Each process loads only one library version. This prevents two constructor identities from changing the workload's JIT feedback. An earlier diagnostic that loaded both variants together had unstable control results and is not the source of these tables.

There are three process rounds, 20 warm-ups, and 15 recorded samples per process. Each row therefore has 45 recorded samples per variant. Variant order changes across workloads and rounds. Fixtures and native reference values are prepared before measurement. Every sample starts with a fresh arena. Full garbage collection runs after setup and before the timer, so garbage from the previous verification is outside timing.

The timer covers the public collection operations, including serialization, encoding, immutable updates, and snapshot construction. It excludes input creation, arena creation, validation, payload hashing, and explicit garbage collection. It does not measure full application latency, worker startup, query speed, peak memory, or process RSS.

The local run selects seven workloads: four JSON write cases, a 4 KiB string case, and two controls. Ordinary rows perform 5,000 operations. The 4 KiB string row performs 512 operations. The full driver and CI cover 23 workloads, including all nine value collection types, ASCII and Unicode strings, bulk writes, and a 64 KiB fallback case limited to 64 operations. Strings are unique except in the explicit repeated-string control. The measured JSON fixtures contain nested fields and Unicode labels. The full driver also includes separate ASCII JSON cases. The update row performs real changes to an existing 5,000-entry map. Scalar builds retain an intermediate snapshot. Bulk builds retain the original empty snapshot.

Every warm-up and sample checks all returned values and retained snapshots against native UTF-8/JSON expectations. Every measured baseline/candidate sample also has matching descriptors, allocated bytes, backing-buffer sizes, and SHA-256 hashes of every allocated byte above the reserved scratch range. Heap validation uses priority traversal, without requiring a particular traversal order. No wall-clock threshold is enforced on a shared runner.

Small differences need care. CPU affinity and frequency are not controlled. An additional A/A run used two identical baseline bundles to check the measurement floor; its samples are included with the evidence. Review the round ranges and controls before applying a result to another machine or workload.

## Correctness and package checks

The local suite passes all 723 tests, including 61 new regression cases, with `bun run test --maxWorkers=2`. The default four-worker runs hit the unchanged five-second limit in existing spatial, map-index, or typed-value stress tests on this host; limiting worker concurrency resolved the timeouts without changing tests or their limits.

The new cases check native UTF-8 bytes and exact allocations, seeded arbitrary UTF-16 strings, incomplete surrogate pairs, NUL and BOM, scratch boundaries, oversized keys, and empty output. They also check retained snapshots, forks, shared-memory growth, read-only attachments, getter and `toJSON` reentry within one arena and across arenas, thrown serialization, nested descriptors, shared-output rejection, and missing `encodeInto`.

Public type checks pass for the core, typed values, Redux, worker tasks, numeric, geometry, and text-search entry points. The real Node worker proofs pass, including retained reads during writer updates, all 12 collection types, typed nested JSON, shared and copy transport, and compaction. The installed-package check passes for Node and Bun exports, immutable snapshots, Node workers, and a strict TypeScript consumer.

The PR workflow also runs the public-operation proof in Chromium, Firefox, and WebKit. Each browser variant/workload uses its own context. Browser results and every runtime sample are retained as CI artifacts. A local browser download was unavailable, so local results in this report cover Node and Bun. Check the PR workflow before treating browser validation as complete.

## Evidence and reproduction

| Evidence | Contents |
| --- | --- |
| [Summary](utf8-write-results/summary.json) | Pooled medians, p95, round ratios, payload hashes, and build hashes |
| [Node round 1](utf8-write-results/node-1.json), [round 2](utf8-write-results/node-2.json), [round 3](utf8-write-results/node-3.json) | Every included Node sample and its process metadata |
| [Bun round 1](utf8-write-results/bun-1.json), [round 2](utf8-write-results/bun-2.json), [round 3](utf8-write-results/bun-3.json) | Every included Bun sample and its process metadata |
| [Source manifest](utf8-write-results/manifest.json) | Baseline commit, production source hashes, compiler settings, test and driver hashes, and matching WASM hashes |
| [A/A summary](utf8-write-results/aa/summary.json), [round 1](utf8-write-results/aa/node-1.json), [round 2](utf8-write-results/aa/node-2.json), [round 3](utf8-write-results/aa/node-3.json) | Identical-baseline controls and their raw samples |
| [Recovery record](utf8-write-results/recovery/manifest.json) | Original incomplete evidence, replacement pair, commands, hashes, dates, and validation |

The final six round files contain 84 variant reports and 1,260 measured samples. All 42 matched workload pairs have equal stored descriptors, payload hashes, used bytes, and backing sizes.

One local round file was missing its final variant after the original process completed. The full repeated-string Node pair from round 1 was rerun with the same settings and order, using unique output files. The [original summary](utf8-write-results/recovery/originals/summary.json) and [original partial round](utf8-write-results/recovery/originals/node-1.json) are preserved. The recovered control ratio is 0.923x; the original aggregate was 0.858x. All other summary rows are unchanged. The driver now separates changing progress files from completed round files, which it writes once.


Use the pinned runtime and compiler versions above. From the candidate checkout, build the base with the same dependencies:

```sh
bun install
bun run build:wasm
bun run build:browser
git worktree add --detach ../zerocopy-utf8-base c3c45821a00030e5dd72ea4af5c9d3d51f96d836
ln -s "$PWD/node_modules" ../zerocopy-utf8-base/node_modules
(cd ../zerocopy-utf8-base && bun run build:wasm && bun run build:browser)
node proofs/run-utf8-write.mjs ../zerocopy-utf8-base/dist/shared.js dist/shared.js /tmp/zerocopy-utf8-results
```

The default driver runs all 23 workloads. To reproduce the seven local rows, set `UTF8_CASES=map-json-set,map-json-setMany,map-json-update,list-json-push,list-4k-push,control-list-number,control-list-repeated`. `UTF8_CASES` selects comma-separated workload names. `UTF8_COUNT`, `UTF8_WARMUPS`, `UTF8_SAMPLES`, and `UTF8_ROUNDS` change the measurement size. `UTF8_RUNTIMES=node` or `UTF8_RUNTIMES=bun` selects one runtime. The driver enables Node's explicit GC hook itself.

For the real-browser proof:

```sh
bunx playwright install --with-deps chromium firefox webkit
node proofs/utf8-write-browser.mjs ../zerocopy-utf8-base/dist/shared.js dist/shared.js /tmp/zerocopy-utf8-browsers.json
```

Browser measurements use five warm-ups and seven recorded samples by default. `UTF8_ENGINES` selects engines. Browser timing is separate from the Node/Bun table above; it does not use explicit GC. The proof fails if isolation, value checks, or the exact storage comparison fails. Completed results are saved as the proof progresses.
