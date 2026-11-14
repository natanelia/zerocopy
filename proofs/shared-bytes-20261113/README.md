# Exploring direct JSON parsing and selective byte queries

**Recommendation: keep native JSON parsing for ordinary `.get()` reads. Pursue explicit predicates and projections over the existing shared bytes.**

Both ideas were prototyped against PR #75 (`b4c08def84b905026632bfd27612da4efef0a3f0`) on 13 November 2026. The direct parser removes the whole-document intermediate string and fuses deep freezing into parsing, but this implementation is slower in the measured materialization workloads. Selective field queries avoid much more work and show large gains when they can stop early. Late or missing fields can erase those gains.

This branch adds experiments and evidence only. No production source, public API or stored format changes. Browser performance is unverified: local Chromium 156 failed to start because a required socket was denied, and the environment rejected escalation. All reported measurements are **Node 24.22.1 on Linux x64**, with CPU affinity 2–3 on a shared host.

## 1. Direct UTF-8 parsing into ordinary frozen objects

[direct-json.mjs](direct-json.mjs) reads JSON structure and numeric tokens directly from shared bytes. It creates native strings for property names and string values, creates the normal object/array tree, and freezes each container when it closes. The iterative parser supports deep input without recursive calls. There is no full-document intermediate string or second freeze traversal.

### Isolated materialization

Times are median milliseconds over seven fresh-worker samples per implementation and fixture. The baseline uses the unmodified PR #75 `decodeUtf8` helper, native `JSON.parse`, and `freezeJSON`. Both arms retain all resulting objects and verify their entire contents and deep freezing after timing.

| Fixture | Records | Current codec | Direct-byte parser | Direct/current median ratio |
| --- | ---: | ---: | ---: | ---: |
| Existing website product records | 10,000 | 85.83 | 250.00 | 2.91× |
| Unicode/escaped text | 10,000 | 65.76 | 344.16 | 5.23× |
| Arrays of 128 decimal coordinates | 2,000 | 42.26 | 331.37 | 7.84× |
| Large records, category first | 10,000 | 115.65 | 232.81 | 2.01× |
| Large records, category last | 10,000 | 133.01 | 244.65 | 1.84× |

Paired geometric ratios and exploratory 95% intervals, rather than ratios of the displayed medians, are in [summary.json](summary.json). The parser is slower in 34 of these 35 pairs. This does **not** prove all byte parsers are slower: it measures one portable generic JavaScript implementation.

The likely explanation is that the saved conversion work is outweighed by JavaScript parsing, string construction, container bookkeeping and own-property creation. The prototype uses `Object.defineProperty` to preserve native own-property semantics, including `__proto__` and inherited setters. Native engines can build objects through internal paths. V8 also documents native JSON parsing optimizations for repeated shapes; its headline stringify speedup is not a parse speed claim. [V8 source](https://v8.dev/blog/json-stringify)

For the catalog, decoding alone takes 15.45 ms; native decode+parse without freezing takes 52.00 ms; direct parsing without freezing takes 265.75 ms. These are **separate diagnostic runs**, not additive phase measurements. Their differences cannot be subtracted to estimate exact freeze/parse costs, and they do not establish a universal decoding budget.

### The actual first-query workload

[prepare.mjs](prepare.mjs) creates a benchmark-only library variant that changes only object materialization inside `Arena.decodeAt`. Existing address/key caches, nested collections, map traversal, writer code and transport remain unchanged. The original PR #75 worker proof runs against both builds: two fresh readers, 10,000 products, 1,000 requested IDs, 910 hits, full-field fingerprints, repeats, edits and retained snapshots.

| Phase | Current median | Direct-parser median | Paired ratio (95% interval) | Prototype slower |
| --- | ---: | ---: | ---: | ---: |
| First query | 68.17 ms | 112.70 ms | 1.534 (0.942–2.498) | 6/7 |
| Repeated query | 6.21 ms | 8.09 ms | 1.237 (0.716–2.136) | 5/7 |
| Construction + publication + first query | 192.38 ms | 212.28 ms | 1.134 (0.858–1.500) | 6/7 |
| First query after editing 100 records | 28.71 ms | 50.33 ms | 1.450 (1.085–1.938) | 6/7 |

The first-query interval includes no change, so the precise slowdown is uncertain. There is no evidence of a first-query benefit. Construction also varies even though its code is unchanged, illustrating host noise. All phases, including favorable retained-snapshot readings, remain in the raw evidence and summary.

**Decision:** this prototype should not replace the default parser. Native/WASM parsing or schema-specialized object construction remains a different experiment; its setup, crossing into JavaScript, allocation, strings, freezing and cache behavior would all need measurement. A native C++ parser's throughput does not establish the performance of returning JavaScript objects through a WASM binding.

## 2. Querying shared bytes without materializing complete records

[byte-query.mjs](byte-query.mjs) compiles a top-level scalar field predicate once, locates that field using a JSON-aware scan, and compares it directly. It understands strings and nested structures; searching for a raw `"category"` substring would be incorrect. It also offers numeric projection and range predicates.

```js
// Experimental helper, not a supported SharedMap API.
const isBook = compileJsonFieldEquals('category', 'books');
const readRevision = compileJsonNumberField('revision');
const inRange = compileJsonFieldNumberRange('revision', 10, 100);

isBook(sharedBytes, recordStart, recordEnd);       // boolean
readRevision(sharedBytes, recordStart, recordEnd); // number | undefined
inRange(sharedBytes, recordStart, recordEnd);      // boolean
```

These operations create no complete record object or JSON text. Numeric decimals, exponents and unsafe integers still use a small selected-token string so native `Number` supplies the correct rounding.

### Selective count query

The task is to count records where `category === 'books'`. The baseline decodes/parses/deep-freezes each record and then reads the field; the candidate scans bytes and returns the same count. Query compilation is inside the timer. Shared input preparation is outside both timers. Each arm has seven fresh-worker samples. This is a **predicate-kernel experiment**, not an end-to-end SharedMap or application benchmark: map traversal, transport and result-row materialization are excluded from both arms.

| Fixture | Records | Materialize then count | Query bytes | Assessment |
| --- | ---: | ---: | ---: | --- |
| Website products | 10,000 | 79.94 ms | 12.90 ms | 6.20× faster by medians; wins 7/7 pairs |
| Unicode/escaped text | 10,000 | 61.65 ms | 9.58 ms | 6.43× faster; wins 7/7 |
| Numeric coordinate arrays | 2,000 | 33.49 ms | 2.88 ms | 11.63× faster; wins 7/7 |
| Large payload after the category | 10,000 | 67.49 ms | 5.83 ms | 11.59× faster; wins 7/7 |
| Same large payload before the category | 10,000 | 84.11 ms | 96.22 ms | Slower median; no reliable win |
| Missing field in large records | 10,000 | 141.29 ms | 141.71 ms | No reliable win |

Large fixtures carry approximately 4 KiB of text per record. The early and late variants contain the same substantive data with different property order. Their construction is not timed. Category selection is approximately one third of records; the missing-field control selects none. This does not measure the cost of returning every matching full object or varying selectivity across a general query.

The late-field paired ratio is 1.170 (95% interval 0.963–1.421); the missing-field ratio is 1.031 (0.903–1.177). These adverse controls are retained. There is no blanket claim that scanning bytes always beats native parsing.

### Repeated queries and memory tradeoffs

An already fully materialized catalog takes only **1.73 ms** to scan, versus 12.90 ms for the byte predicate. This control retains all 10,000 frozen objects; it is **not** a claim that ZeroCopy's bounded object cache holds the whole catalog. Its initial materialization time is recorded separately. Bytes are attractive when avoiding decoding/caching is valuable; cached objects can win for repeated full-data access.

ZeroCopy already follows this design in [string-list text search](../../text-search.ts), `SharedMap.has()`, [numeric reductions](../../numeric.ts) and [geometry operations](../../geometry.ts). The new opportunity is fields inside its existing JSON object values.

**Decision:** first add a small explicit predicate/projection interface that can inspect object records and materialize only requested results. Keep `.get()` returning the existing frozen value. Prototype top-level support first; nested field paths, map/list traversal and public API behavior require a separate integration design.

For late or frequently queried fields, a writer-built field-offset directory or a typed record layout could avoid rescanning. That adds construction work and storage, so it must be evaluated against the original construction goal. As simple storage arithmetic, one pair of 32-bit start/end offsets costs 8 bytes per indexed record/field, before headers/alignment; it is not a measured implementation result. A lazy per-reader index moves that cost to the first query and should not be marketed as eliminating it.

Schema-based formats such as [FlatBuffers](https://flatbuffers.dev/languages/javascript/) expose direct field access through generated accessors. [simdjson On Demand](https://simdjson.org/api/2.0.0/md_doc_basics.html) demonstrates selective native parsing that avoids unused materialization. Both are architectural references, not measured replacements for this JavaScript API. Lazy getters/proxies would likewise change observable object behavior and require compatibility and performance work.

### Semantic boundaries

- The query prototype expects immutable, compact output of the current built-in `JSON.stringify` writer, with unique, canonically spelled top-level keys. Arbitrary handwritten JSON and overridden serializers are outside its contract. It is not an untrusted-input validator.
- It supports alternate scalar spellings from `JSON.rawJSON`, including escaped Unicode and numbers. `JSON.rawJSON` accepts primitives, so it cannot inject duplicate outer object keys. [TC39 source](https://tc39.es/proposal-json-parse-with-source/)
- Strict equality, suitable substring search and numeric predicates can stay on bytes. JavaScript string ordering, case conversion, surrogate-half searches and Unicode normalization require their exact semantics; byte order is not a generic substitute. [ECMAScript comparison](https://tc39.es/ecma262/2026/multipage/abstract-operations.html#sec-islessthan)
- A public API should return scalar answers, keys, projections or frozen values. It should not expose writable views over published memory.

## Validation and limits

The parser checks **3,065 documents / 64,646 assertions**. The field-query checks **90,576 assertions**. Coverage includes shared and ordinary buffers, nonzero offsets, nested decoys, Unicode, all UTF-16 code units for the parser, escaped lone surrogates, `__proto__`, exact numeric boundaries, raw JSON scalars, deep freezing and 20,000 nested arrays. Independent review found and fixed an intermediate safe-integer rounding issue before any recorded measurements.

The isolated suite contains **210 samples**; the actual-reader suite contains **14 samples**. Every sample is verified. Reader fingerprints match, storage is identical in both arms, and first/repeat/edited/retained outputs pass the original reference assertions. Source hashes, build identities, checks and compressed raw results are included. No samples or outliers are dropped.

The direct parser assumes valid UTF-8 and captures the native decoder; it does not replicate the production helper's full monkeypatch/reentry contract. The query prototype has no supported public byte-range validation. Neither is production-ready. The experiments measure latency and stored arena bytes, not peak JavaScript heap/RSS, allocation count, energy use, or end-to-end application startup. No Bun, Chromium, Safari or Firefox performance result is claimed.

The seven-pair intervals use Student-t on log(after/before) ratios and are exploratory, without correction for multiple endpoints. This experiment has no same-build A/A cohort. Measurements on a busy shared host are not hardware-independent guarantees; use the effect sizes and controls to select a next experiment, not as release performance promises.

## Reproduce

Build the baseline PR #75 checkout with its normal pinned dependencies and portable browser build. Run one timed process at a time. CPU affinity is optional and must match available CPUs.

```sh
node proofs/shared-bytes-20261113/prepare.mjs /path/to/baseline/dist
node proofs/shared-bytes-20261113/direct-json-checks.mjs
node proofs/shared-bytes-20261113/byte-query-checks.mjs
node proofs/shared-bytes-20261113/run.mjs node /tmp/byte-results.json 7
node proofs/shared-bytes-20261113/reader-run.mjs node /tmp/reader-results.json 7
```

Both runners reject existing output files. Chromium runners are included for a future environment where it can launch; they require Playwright, a local Chromium executable and cross-origin-isolated localhost serving. The recorded attempt did not produce browser timing samples. `prepare.mjs` uses Node 24's built-in TypeScript stripping for the two unchanged helpers and checks the exact bundle patch site before creating the test variant.

Raw evidence is losslessly compressed: `node-results.json.gz` and `node-reader-results.json.gz`. `node summarize.mjs` in this folder audits the saved data and reproduces [summary.json](summary.json). [manifest.json](manifest.json) covers the harness, all website fixture dependencies and compressed evidence; [validation.json](validation.json) records the executable checks and the browser limitation.
