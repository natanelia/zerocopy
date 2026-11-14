# Direct UTF-8 parsing and Rust: ZeroCopy investigation

## Recommendation

**Keep native JSON parsing for ordinary full-object reads. Test Rust as a small optional parsing/query module before considering a backend migration.**

Direct UTF-8 parsing is feasible, including with the existing JavaScript API. The two generic JavaScript implementations measured here are slower than the current `decodeUtf8 → JSON.parse → freezeJSON` path. This does not establish a universal limit on direct parsing, and it is not a Rust-versus-AssemblyScript benchmark.

The more promising direction is to evaluate predicates, selected fields and aggregates on bytes, creating complete JavaScript records only when requested. An earlier verified experiment supports that direction for early fields, while retaining counterexamples for late and missing fields.

This investigation adds proof code and documentation only, based on PR #75 at **`b4c08def84b905026632bfd27612da4efef0a3f0`**. It does not replace a production codec, change the stored format or migrate the backend. At the start of the investigation, `main` was `6ee24d20e6be91e1d757995770654a249b489d0f`, and PR #75 remained open.

## What was investigated

The existing object path is in [arena.ts](../../arena.ts): a cache miss decodes the JSON bytes, calls native `JSON.parse`, deeply freezes an ordinary object tree, and admits it to the existing bounded object cache. JSON parsing occurs in TypeScript/JavaScript, outside the AssemblyScript backend.

The backend build already uses imported shared memory, `--runtime stub` and optimization level 3 in [scripts/build-wasm.mjs](../../scripts/build-wasm.mjs). [persistent-core.as.ts](../../persistent-core.as.ts) manages its arena explicitly with numeric pointers and raw memory loads/stores. Optional [numeric kernels](../../numeric-kernels.as.ts) already use Wasm SIMD. Consequently, replacing the AssemblyScript compiler alone would leave the current JSON codec untouched.

An existing staged experiment from 13 November was recovered and audited without modifying its original checkout. Its source, compressed raw results, summaries and report are preserved in [shared-bytes-20261113](../shared-bytes-20261113/README.md). Its measurements are distinguished from the new measurements below.

The follow-up removes one concrete source of avoidable overhead: the first direct parser defined every object property and array element with `Object.defineProperty`. The new [guarded parser](direct-json-guarded.mjs) assigns fresh properties directly when the ordinary prototype chain permits it, retaining own-property definition for inherited or existing names. Both direct parsers still construct all ordinary JS values and freeze containers when they close; neither constructs the entire JSON document as one intermediate string.

## New full-object materialization measurements

Environment: **Node v24.22.1, V8 13.6.233.17-node.58, Linux x64, Intel Xeon Platinum 8573C**, process affinity CPUs 2 and 3 on a shared host. Seven samples per arm and fixture, each in a fresh worker. The order rotates. Shared input generation and worker/module startup are excluded equally. All complete results remain retained during timing; complete-content fingerprints and deep freezing are checked afterward. The native baseline uses the unchanged PR #75 helpers.

The table shows median milliseconds. Every fixture uses 10,000 records except the coordinate fixture, which uses 2,000 records with 128 decimal coordinates each.

| Fixture | Current native codec | Original byte parser | Cheaper byte parser | Cheaper / native medians |
| --- | ---: | ---: | ---: | ---: |
| Website products | 56.10 | 187.42 | 122.43 | 2.18× |
| Unicode and escaped text | 77.81 | 300.36 | 263.96 | 3.39× |
| Decimal coordinate arrays | 39.55 | 354.07 | 163.94 | 4.15× |
| Large records, category first | 92.33 | 203.47 | 183.31 | 1.99× |
| Large records, category last | 94.89 | 202.77 | 169.66 | 1.79× |

The cheaper parser loses 34 of 35 pairs against native. Its paired geometric ratio is above 1 in every fixture; the exploratory 95% interval excludes 1 in four fixtures, while the large/category-first interval is **0.939–2.933**. These intervals are not adjusted for multiple comparisons. Ratios of medians in the table differ from paired geometric ratios; [summary.json](summary.json) contains both.

Reducing object-insertion overhead helps the prototype: product medians fall from 187.42 to 122.43 ms, and coordinate medians from 354.07 to 163.94 ms. Those gains remain insufficient to beat the native codec. String token construction, numeric conversion, structural parsing and container bookkeeping still need work. The result does not attribute an exact fraction of runtime to any one of those operations.

Two native labels execute identical code in independent workers. Their medians differ by roughly 0.5–14% across fixtures; all five paired intervals include 1. They are reported as a noise control, never used to normalize or discard samples. The run contains **140 verified samples**.

## New actual fresh-reader measurements

[prepare.mjs](prepare.mjs) creates a baseline and a benchmark-only candidate changing only full-object materialization in `Arena.decodeAt`. Existing caches, nested collection codecs, writers, traversal, memory format and transport are preserved. Both builds use the unchanged PR #75 worker proof and website workload: 10,000 products, two fresh readers, 1,000 requested IDs with 910 hits, and full-field answer fingerprints.

| Phase | Native median | Cheaper byte parser median | Paired ratio | Exploratory 95% interval |
| --- | ---: | ---: | ---: | --- |
| Construction | 72.84 ms | 57.65 ms | 0.741 | 0.493–1.112 |
| Publication/attachment | 8.57 ms | 6.34 ms | 0.826 | 0.423–1.614 |
| **First query** | **49.66 ms** | **76.59 ms** | **1.649** | **1.177–2.309** |
| Repeated query | 4.74 ms | 6.38 ms | 1.262 | 0.696–2.287 |
| Construction + publication + first query | 126.48 ms | 144.78 ms | 1.061 | 0.876–1.286 |
| Edit 100 records | 0.79 ms | 0.99 ms | 1.824 | 0.674–4.937 |
| Publish edit | 2.38 ms | 2.60 ms | 1.332 | 0.499–3.550 |
| First query after editing | 23.55 ms | 26.63 ms | 1.108 | 0.694–1.770 |
| Retained-snapshot query | 3.08 ms | 3.34 ms | 0.884 | 0.619–1.264 |

The first query is slower in **all seven pairs**. Its ratio of medians is 1.54; the paired geometric ratio is 1.65. The evidence is sufficient to reject this variant as the default for the measured workload. The exact magnitude remains host- and workload-dependent.

The identical-build control's first-query medians are 49.66 and 48.06 ms, with paired ratio 1.070 and interval 0.733–1.561. Other phases also show substantial noise. In particular, construction code is unchanged: its lower candidate median is **not** a construction optimization. The combined-ready-time interval includes 1. Combined medians are calculated from each sample's phase sum, not by adding the separate displayed phase medians.

All **21 reader samples** pass the original answer checks, including repeats, edits and retained snapshots. Every sample has 910 hits, 90 misses, fingerprint 2425954933 for both tasks, 2,715,440 arena bytes used and 2,752,512 arena bytes allocated. These arena figures are not measurements of JS heap allocation or total RSS.

## Why selective byte queries remain worth pursuing

The previously recorded and now hash-verified experiment counted records whose top-level `category` equals `books`, without constructing whole objects. These are **13 November Node measurements**, not additional measurements of this follow-up.

| Earlier isolated query | Materialize/freeze then count | Scan bytes and count |
| --- | ---: | ---: |
| 10,000 website products | 79.94 ms | 12.90 ms |
| 10,000 large records, category before payload | 67.49 ms | 5.83 ms |
| 10,000 large records, category after payload | 84.11 ms | 96.22 ms |
| Missing field in 10,000 large records | 141.29 ms | 141.71 ms |

These compare predicate kernels with equal results, excluding map traversal, publication and returning complete matching records. They are not `.get()` speedups. Compilation of the field query is timed. Late and missing fields retain their adverse results because rescanning a large record can consume the benefit. An already materialized catalog also scans faster than the byte path, at 1.73 ms in that earlier control; retaining every decoded record has a different memory cost from ZeroCopy's bounded cache.

An explicit query API could return a count, keys, or selected fields, and materialize only requested full results. Frequently queried late fields may justify stored offsets or a typed record layout. Such indexing adds writer work and storage, so its construction cost must be measured too. None of these APIs is introduced by this investigation.

## Rust versus AssemblyScript

### Rust can parse bytes directly

[`serde_json::from_slice`](https://docs.rs/serde_json/1.0.154/serde_json/fn.from_slice.html) accepts immutable bytes. [`simd-json` 0.19.0](https://docs.rs/simd-json/0.19.0/simd_json/) documents Wasm `simd128` support. SIMD means processing several bytes or values with one instruction. Native x86 or ARM parser throughput is not a browser result.

However, [`simd-json`'s borrowed parser](https://docs.rs/simd-json/0.19.0/simd_json/borrowed/fn.to_value.html) rewrites input while unescaping strings. Published ZeroCopy bytes must remain immutable, so this route needs a private mutable copy or a different parser. Buffer reuse can reduce allocations but cannot justify modifying a retained snapshot.

### Returning ordinary JS values remains a separate cost

The straightforward design would parse Rust values and then convert them to JS values. That can add an intermediate tree and many host calls. The [official wasm-bindgen guide](https://wasm-bindgen.github.io/wasm-bindgen/reference/arbitrary-data-with-serde.html) explicitly notes that direct Serde/JS conversion can lose to native JSON parsing, depending on data and runtime. This does not prove either route always wins.

Three designs deserve different measurements:

| Candidate | Work avoided | Work that remains |
| --- | --- | --- |
| Rust visitor constructing JS values | Whole-document JS text; intermediate Rust tree if implemented carefully | JS strings, objects, property insertion, host calls and freezing |
| Rust token tape followed by JS construction | Whole-document JS text; per-token Rust-to-JS callbacks | Tape storage, JS construction pass, string conversion and freezing |
| Queries executed on bytes in Wasm | Unused objects, strings and properties; potentially most output conversion | Scanning/index lookup, selected values and the small result |

A token tape is a flat list describing values and container boundaries. It can reduce calls between JS and Wasm, but does not make full JS objects free to construct.

Ordinary [`wasm-bindgen` numeric-slice arguments](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/number-slices.html) also copy input into Wasm memory. ZeroCopy already stores its bytes in `WebAssembly.Memory`, so a deliberate pointer/length interface could avoid that binding copy. A typed-array parameter alone does not establish zero-copy behavior.

### Existing AS capabilities reduce the reason to rewrite

AssemblyScript already supports imported/shared memory and SIMD in its [compiler](https://www.assemblyscript.org/compiler.html). Its [`stub` runtime](https://www.assemblyscript.org/runtime.html) has no garbage collector. ZeroCopy uses that runtime and its own arena, so “Rust removes the AssemblyScript GC” is not an explanation for a speedup here. The JS objects returned to callers remain managed by the JS engine either way.

Rust is attractive for access to parser libraries, more extensive native reuse and ownership checking as the codebase grows. Those are reasons to evaluate it, not evidence that an equivalent raw-memory kernel will run faster. The migration would also require a new toolchain, byte-layout compatibility, module-size/startup measurement and regression checks for all collection operations.

### Memory integration must preserve concurrent readers

The current AS core reserves the first 64 KiB for writer scratch and keeps cold-reader kernels scratch-free. A general Rust module cannot assume that region is available for its stack or allocator.

The [LLVM Wasm linker](https://lld.llvm.org/WebAssembly.html) places stack/static data/heap in linear memory; the [Wasm tool conventions](https://github.com/WebAssembly/tool-conventions/blob/main/BasicCABI.md) describe the compiler-managed linear stack. Importing a shared memory does not partition those regions across independently instantiated readers. **Inference for this project:** any concurrently writable Rust stack, scratch or allocator state must occupy nonoverlapping regions, and static initialization must respect existing arena bytes. Small scalar kernels may avoid a linear-memory stack frame; a general parser needs explicit design. This is solvable through layout integration or private parser working memory, with copying measured where required.

### Compatibility is a real requirement

The normal Rust JSON value representation is not automatically equivalent to `JSON.parse`:

- JS allows escaped lone UTF-16 surrogates such as `"\ud800"`. [`serde_json` documents rejection](https://docs.rs/serde_json/1.0.154/serde_json/struct.Deserializer.html) when converting such strings into Rust `String`; custom byte handling or a native fallback is needed.
- [`serde_json::Value`](https://docs.rs/serde_json/1.0.154/serde_json/value/enum.Value.html) sorts object keys by default, unless `preserve_order` is enabled. A visitor could instead preserve input order.
- [`serde-wasm-bindgen`](https://docs.rs/serde-wasm-bindgen/0.6.5/serde_wasm_bindgen/) has defaults for maps, null-like values and large integers that need explicit JSON-compatible handling. Its JSON-compatible preset does not, by itself, settle every number/string edge case.
- Own `__proto__` properties, inherited setters, exact number rounding, negative zero, duplicate keys, deep nesting, immutable results and retained snapshots must retain existing behavior.

Current direct-byte JavaScript packages were also considered. The source review of `@jsonjoy.com/json-pack` 18.30.0 found compatibility differences with the existing contract, including Unicode escapes and own `__proto__` properties. It was not benchmarked as an equivalent replacement. See [JSON-PARSERS.md](JSON-PARSERS.md) for exact package/source identities and the distinction between source inspection and executed tests.

## Concrete next experiment

Keep the current TypeScript public API and AssemblyScript core. Add one isolated Rust reader module only if pursuing the next experiment. Compare immutable-byte Serde parsing and a copied-input SIMD parser, preferably with both full-value output and a small batch predicate/projection operation. A complete backend rewrite would come after evidence from that module.

For a full-value candidate, include input copies, parsing, temporary structures, JS conversion, freezing and existing cache behavior. Measure module initialization separately and in total first-use latency. Test the actual fresh-reader workload in Chromium and other supported runtimes; use representative product, Unicode and numeric data. Check peak memory as well as latency. For a query API, compare equal answers and include traversal, selectivity, output size, early/late/missing fields, repeated queries and any writer-built indexes. This is the proposed next evaluation, not work claimed completed here.

## Validation, limitations and reproduction

New guarded parser validation passes **3,071 documents / 64,715 assertions**, including shared and ordinary input, nonzero offsets, Unicode, every UTF-16 code unit, numeric rounding boundaries, own properties, inherited setters/read-only properties, prototype traps, deep freezing and 20,000 nested arrays. The original parser and query suites were rerun successfully. [AUDIT.md](AUDIT.md) records independent verification and separates old evidence from new execution.

Chromium was attempted with the installed Playwright and local browser. Launch failed with `process_singleton_posix.cc: socket() failed: Operation not permitted`. No browser timing was collected and no permission escalation was attempted in this follow-up. No Bun or Rust/Wasm comparison was performed. The Rust assessment is source-backed design analysis. These prototypes assume valid UTF-8 writer-produced JSON and do not reproduce the production decoder's full monkeypatch/reentry contract; neither is production-ready.

To reproduce, check out this branch and build the exact baseline commit with the project's pinned dependencies. The same portable baseline build used by PR #75 was reused here and is identified by output hashes. Then run from the repository root:

```sh
node proofs/shared-bytes-20261113/prepare.mjs /path/to/baseline/dist
node proofs/utf8-rust-20261114/direct-json-guarded-checks.mjs
node proofs/utf8-rust-20261114/prepare.mjs
taskset -c 2,3 node proofs/utf8-rust-20261114/run.mjs codec /tmp/utf8-codec.json 7
taskset -c 2,3 node proofs/utf8-rust-20261114/run.mjs reader /tmp/utf8-reader.json 7
```

Run one timed process at a time. Affinity is optional and must name CPUs available on the machine. Runners refuse existing output files. To regenerate the recorded summary, prepare the helper files as above, then run `node proofs/utf8-rust-20261114/summarize.mjs`; it audits the checked-in compressed raw evidence and source identities before writing the summary. The new native/guarded build identities are recorded in [build-manifest.json](build-manifest.json). [manifest.json](manifest.json) records evidence hashes.

All samples and adverse outcomes are retained. Confidence intervals are exploratory, with seven paired log ratios and no multiple-comparison correction. The identical-build controls quantify local noise without adjusting results. Stored arena size is verified; total JS heap/RSS, allocation count, code size, energy use and whole-application startup were not measured.
