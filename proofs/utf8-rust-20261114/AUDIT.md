# Independent audit of the UTF-8 parser follow-up

## Scope and outcome

Reviewed the previous `shared-bytes-20261113` experiment read-only, implemented
and checked the separate guarded-assignment variant, then reviewed this
follow-up's `run.mjs`, `bench-worker.mjs` and `prepare.mjs` without changing them
while measurements were running.

**No benchmark fairness or parser correctness blocker was found within the
documented experimental contract.** This is not a production-readiness claim.
The new guarded variant's performance must be judged from its own recorded
measurements. The earlier generic parser's slowdown cannot establish a Rust
versus AssemblyScript result.

The original staged checkout and its raw evidence were not modified by this
audit. No timed benchmark was run by the auditor.

## Previously recorded evidence, newly verified

The old measurements were recorded on 13 November. The following checks were
executed again during this follow-up:

- SHA-256 checks passed for every file in the old manifest's `sourceFiles` and
  `evidenceFiles` sections, and for both decompressed raw-result payloads.
- All **210 isolated samples and 14 reader samples** in those archived results
  have `verified: true`.
- The source hashes embedded in the isolated results match the parser, query,
  worker, fixtures and generated native helpers present on disk.
- The reader result's embedded build manifest matches the saved build manifest.
  The old before/after builds differ only in `chunk-hp088bng.js` and the added
  `_direct-json.mjs` module.
- Recomputing the old five materialization medians reproduced the report's
  figures. The original parser loses 34 of the 35 corresponding pairs.

These are checks of existing evidence, not newly collected timing samples.

## Newly executed correctness checks

The original parser check was rerun without editing its source:

```text
{"status":"pass","documents":3065,"assertions":64646,"metadata":{"fullDocumentString":false,"input":"valid UTF-8 JSON; intended for immutable JSON.stringify-produced bytes","freezesOnContainerClose":true,"recursiveCalls":false,"retainedDecodeScratchMaximum":65536,"crossDocumentObjectCache":false,"crossDocumentKeyCache":false,"supportsSharedTextDecoderInput":true}}
```

The original selective-query check was rerun without editing its source:

```text
{"checks":90576,"status":"pass","rawJSON":true}
```

The new guarded variant was checked with:

```sh
node proofs/utf8-rust-20261114/direct-json-guarded-checks.mjs
```

Its exact output on Node v24.22.1 was:

```text
{"status":"pass","documents":3071,"assertions":64715,"metadata":{"experimentalGuardedAssignment":true,"exoticArrayPrototypeUsesDefineProperty":true,"fullDocumentString":false,"input":"valid UTF-8 JSON; intended for immutable JSON.stringify-produced bytes","freezesOnContainerClose":true,"recursiveCalls":false,"retainedDecodeScratchMaximum":65536,"crossDocumentObjectCache":false,"crossDocumentKeyCache":false,"supportsSharedTextDecoderInput":true}}
```

The added checks exercise own-property descriptors for special names, inherited
object setters and read-only fields, inherited numeric array setters and
read-only indices, and an altered array prototype with a throwing Proxy `has`
trap. The original corpus supplies numeric rounding boundaries, duplicate keys,
Unicode and escaped lone surrogates, shared/nonshared buffers, deep freezing,
and 20,000 nested arrays.

## Guarded-assignment semantics

The original parser uses `Object.defineProperty` for every object field and
every array index. The guarded variant uses direct assignment only for absent
keys on an ordinary prototype chain. Existing or inherited keys retain the
original own-property insertion path. This includes `__proto__`, inherited
setters, inherited read-only properties and duplicate keys.

For arrays, the prototype parent is checked when the container is created. An
altered `Array.prototype` chain disables the assignment path for that array.
This prevents the `in` check from invoking an exotic prototype's `has` trap.
Arbitrary replacement of built-ins or prototype changes from reentrant
monkeypatched intrinsics remain outside the experimental contract. The
original production decoder's complete monkeypatch/reentry behavior has not
been reproduced by either experimental parser.

Both variants still construct every JavaScript object, array and string, and
freeze every container. Decimal/exponent and unsafe-integer conversion still
uses a selected-token string and native `Number` for rounding. There is no
cross-document key cache, schema generation or hidden eager materialization.

## New harness fairness and verification

`bench-worker.mjs` imports the original parser, guarded parser and unchanged
native helpers in every worker. Parser choice occurs before timing. Both native
labels resolve to the exact same native function. Every arm times output-array
allocation and complete parsing of the same immutable shared-byte fixture.
Every output is retained through the timer, then checked through a full-content
fingerprint and a recursive frozen-container check. Startup, fixture generation
and verification are excluded equally.

`run.mjs` creates a fresh worker for every isolated sample without parser
warmup. Four arms rotate their order by pair. The identical native arms provide
a same-build noise control. All completed samples are retained, and an existing
output file is rejected rather than overwritten.

For reader measurements, the runner uses the unchanged PR #75 worker proof:
two fresh readers, 10,000 products, 1,000 requested IDs and 910 hits. Each arm
uses a fresh process. The two native labels use the exact same build, and the
three arms rotate their order. The existing workload verifies first reads,
repeats, edited results and retained snapshots against independent expected
answers outside their timers.

`prepare.mjs` requires exactly one expected decode marker and exactly one
freeze marker before patching. It changes object materialization only; nested
codecs, caches, traversal, writer code and transport remain in the baseline
bundle. The parser freezes internally, so the candidate avoids a redundant
second freeze pass. This comparison tests the complete alternative materializer,
including that intended benefit.

## Source and build identity

At inspection, every source hash already embedded in the new codec output
matched the file on disk. The covered runtime dependencies include the runner,
worker, both parsers, fixtures, native helpers, catalog source/reference and
the unchanged reader worker proof. The catalog fixture has no additional
unhashed runtime import beyond the recorded catalog source.

Every current native/guarded build-file hash matched its generated manifest.
Those builds differ only in `chunk-hp088bng.js` and the added
`_direct-json-guarded.mjs`. Executable Wasm content is embedded in the recorded
JavaScript bundles; the dist directory has no separate runtime Wasm files
omitted from the manifest. Preparation and correctness-check sources should
also be covered by the final evidence manifest, although their effects are
already represented by the generated runtime hashes.

## Interpretation limits

This audit inspected the new harness while the timing suite was in progress;
it does not certify the final sample counts or summary arithmetic. Those must
be checked when the complete results are summarized.

The first-query experiment measures cold readers with initialized modules and
workers; it does not measure package download, Wasm compilation, module startup
or total application startup. The isolated materializer does not include map
traversal, publication or construction. The shared host and small number of
pairs limit precision even with the native/native control. Results from Node
do not establish performance in Chromium, Bun, Safari or Firefox.

The previous parser's result rules out that measured implementation, not all
direct UTF-8 parsers. A Rust or AssemblyScript parser returning the existing
objects must still account for JavaScript string creation, property insertion,
container allocation and freezing. Selective byte queries avoid more of that
work, but their earlier late-field and missing-field controls show that byte
scanning also has a real cost.

## Final evidence audit after all measurements completed

The completed compressed runs and `summary.json` were independently checked
after the timing processes ended. This section supersedes the earlier
in-progress qualification about sample counts and summary arithmetic.

The auditor used a separate Python implementation to recompute medians,
ratios of medians, paired geometric ratios, sample standard deviations of log
ratios, the stated seven-pair Student-t intervals, and pair-win counts. All
**20 codec comparison groups and 18 reader phase comparison groups** match
`summary.json` within floating-point rounding. Every arm has exactly pairs
0 through 6 with no duplicate or missing pair.

Exact independent audit output:

```text
{"status": "pass", "codecSamples": 140, "readerSamples": 21, "sourceAndBuildHashes": "all match", "losslessGzip": "both match uncompressed", "pairedSummaryGroupsVerified": 38, "sameBuildControlGroups": 14, "controlIntervalsExcludingOne": 0, "readySums": "all exact", "readerFingerprints": "all expected", "arenaUsedBytes": 2715440, "arenaCapacityBytes": 2752512, "runtimeBuildDifferences": ["_direct-json-guarded.mjs", "chunk-hp088bng.js"]}
```

Both compressed files decompress byte-for-byte to their uncompressed outputs.
All recorded source hashes and every executable build hash still match. The
native runtime is byte-identical to the earlier prepared baseline. The parser
copied into the guarded runtime exactly matches the measured source. All
reader outputs have lookup/validation fingerprint `2425954933`, 910 hits and
90 misses, and use the same arena sizes. Every `readyMs` equals its own
construction + publication + first-query sum exactly.

The five fixtures were regenerated without executing timed parser samples.
Every recorded codec output matches its fixture's content fingerprint, record
count and stored-byte count:

| Fixture | Records | Bytes | Expected fingerprint | Verified samples |
| --- | ---: | ---: | ---: | ---: |
| Catalog | 10,000 | 2,191,326 | 3840087261 | 28 |
| Unicode | 10,000 | 6,817,326 | 2418102687 | 28 |
| Numeric | 2,000 | 4,947,697 | 3561456315 | 28 |
| Large, early category | 10,000 | 41,461,112 | 2608766841 | 28 |
| Large, late category | 10,000 | 41,461,112 | 3285051147 | 28 |

The headline figures are supported:

- Catalog materialization medians: native-a **56.102412 ms**, original direct
  parser **187.420922 ms**, guarded direct parser **122.429209 ms**.
- Fresh-reader first-query medians: native-a **49.663007 ms**, guarded
  **76.594067 ms**. The guarded parser loses all **7/7** pairs.
- The first-query ratio of medians is **1.542276**, while the paired geometric
  ratio is **1.648812**, with exploratory 95% interval
  **[1.177364, 2.309042]**. These are different statistics and must not be
  presented as interchangeable percentages.
- Across all five isolated fixtures the guarded parser loses **34/35** pairs
  against native-a. Its large-early paired interval still includes 1, so that
  fixture alone does not establish a precise slowdown.

All 14 native/native control intervals include 1. Several are wide: this
does not demonstrate negligible timing noise. The controls were not used to
normalize or adjust the candidate measurements. The combined ready-time
interval includes 1, and construction code is unchanged, so the report should
not claim a dependable aggregate startup improvement, aggregate regression,
or writer improvement from the observed medians.

The supported decision remains narrow: this improved generic JavaScript
materializer does not earn replacement of the native parser on the tested
Node workloads. Rust/Wasm execution, memory consumption and browser latency
remain unmeasured. No additional production-readiness or cross-runtime claim
follows from these results.
