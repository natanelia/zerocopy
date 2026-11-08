# Redux heap view reuse: prospective measurement plan

Baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.

Candidate: capture one immutable memory view while the portable Redux codec
encodes a numeric or boolean priority queue containing at least 32 nodes, with
unmodified native Arena readers. Keep generic values, custom readers and small
queues on the original dynamic-read path. Production changes are confined to
`redux-heap-codec.ts`. WASM, binary formats and public APIs are unchanged.

## Primary questions

- Does complete public `createZerocopyCodec().encode()` improve for numeric
  min-heaps and boolean max-heaps, with all row values and child indexes retained?
- Is a benefit visible through complete `stringify()`, including JSON encoding?
- Does the 32-node activation boundary justify its fixed descriptor-check cost?
- Do the small numeric and generic JSON fallback controls show regressions?

## Method frozen before the pilot

`workloads.mjs` declares seven workloads: four targets, the 32-node boundary,
eight-node small fallback, and 256-node JSON fallback. A two-pair pilot measures
the six declared pilot cases; the larger 32,768-node target joins confirmation
if the pilot supports proceeding. Reject the patch rather than continuing an
unfavorable screen. Any revised source is a new candidate with separate evidence.

Run baseline/candidate in separate fresh processes at an identical neutral import
path. Alternate AB/BA and runtime/case order per pair, pin all runs to one CPU,
and hold `/tmp/zerocopy-perf-20261108.lock` for the study. Node and Bun both use
portable bundles built with identical WASM. Only the full public call and output
retention are timed; complete verification follows every timed batch.

The pilot uses two pairs, at least 150 ms timed warmup, at least eight warmup
batches, then nine measured batches. Confirmation uses six pairs and at least
500 ms timed warmup, with the same batch minimums. A separately declared
same-baseline diagnostic uses four pairs for numeric min-heap encoding and JSON
fallback; its estimates describe noise and never adjust candidate ratios.

Preserve every raw measurement, source/build/workload identity, short batch,
failed run and slower result. Summaries use per-process medians and geometric
means of matched after/before ratios. Six-pair and four-pair intervals use
unadjusted Student-t intervals on paired log ratios. Do not claim a universal
speedup or the absence of regressions from inconclusive controls.

An independent JavaScript leftist heap and value encoder define expected wire
rows and numeric tags. Every result is checked in full; source snapshots, source
bytes and allocation size must remain unchanged. Regression tests cover boundary
sizes, min/max and tied priorities, special values, reader overrides, exact
errors/budgets, growth/reentry, retained forks and read-only attachments.

## V2 correctness revision before confirmation

The completed V1 pilot remains unchanged. Pre-confirmation review found that
manually constructed heaps can carry object-valued roots or sizes whose numeric
coercion invokes callbacks. The V1 reader could retain its captured view after
such a callback replaced the Arena view accessor. The new regression fails V1
and passes the unchanged baseline. V2 adds `typeof` checks before the size
comparison so these descriptors retain the original dynamic-read path without
an additional coercion. Its source is separately identified in the confirmation
record; V1 source is archived under `candidate-v1/`. Do not pool V1 timings with
V2 confirmation. The workload, timing driver, thresholds and selected cases are
unchanged. No second pilot is used to select a favorable performance result.

## V3 Proxy compatibility revision

Independent review after V2 measurement found another callback boundary: an
Arena wrapped in a Proxy can intercept `dv` or `decode` while presenting native
property descriptors, or throw on a newly introduced `getPrototypeOf` trap. The
original reader supported these owners. V3 first checks the native-WASM private
brand using the same helper as the independent compaction change. This rejects
Proxy owners without invoking their reflection traps, before inspecting Arena
descriptors. Custom readers continue through the original loop.

The completed V2 confirmation and A/A records remain unchanged and have their
own archived source under `candidate-v2/`. They are historical evidence for V2,
not results for V3. V3 has no new pilot and runs one complete confirmation plus
one A/A study. The timing driver is unchanged. `workloads-v3.mjs` preserves all
seven original fixtures and adds one fixed 32-repetition public constructor
control (`resetSharedList()` plus `new SharedList('number')`) because the private
identity adds one field to every Arena. V3 A/A includes the original numeric and
JSON controls plus this constructor control. All measurements and unfavorable
controls remain in their original records. Only V3 results support final claims.
