# Supported-session decoded-value reuse screen

Preparation only. This packet has not been imported, syntax-checked, built, tested,
calibrated, or timed. The coordinator must approve the final candidate correctness
gate, review this packet, supply retained builds and exact hashes, and release the
measurement slot. No command below is authorization to execute. The source-reviewed
candidate patch is `a35ea546b7e51ffb27aa34e0baf484f23cfd99c4007a3060ffc640156a390d29`;
the final retained build digests remain unbound until the build/correctness gate.

## Question and exclusions

Compare authenticated main `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e` with the approved
candidate using supported public sessions, one actual reader worker, and a cheap
deterministic read checksum. The fixed-hot-set source resembles some demo data;
this is not timing of the actual demo, whose raw initWorker path is separate.
There is no production-code edit, cache introspection, synthetic memory rewind,
private allocator mutation, forced GC, retry, extra sample, or favorable rerun.
Correctness, lifetime, heap retention, exact-head CI, and merge clearance are
separate gates. A configured backing ceiling is not a bound or measure of RSS.

## Frozen workload and allocation arithmetic

Keys are `k0000` through `k1023`, with five ASCII bytes. A source-only arithmetic
check found 1,024 distinct full 32-bit FNV-1a hashes. The runner repeats this check
without importing production code; collision buckets are therefore absent.

JSON records contain six-digit scalar fields, a boolean, a nested three-element
numeric array, a short Unicode label, and `café-東京-🚀|` repeated 24 times. They
encode to 567 bytes for true and 568 for false, totaling 581,120 initial bytes for
1,024 values. The small-workload guard uses the same records with 64 entries,
totaling 36,320 bytes. Full-churn records have three six-digit scalar fields and
encode to 46 bytes each, totaling 47,104 bytes. String records have a fixed-width
ID/revision prefix and the Unicode body repeated 40 times: exactly 734 UTF-8 bytes
each, totaling 751,616 bytes. Numeric payload values occupy eight bytes each.
The fixtures report their measured encoding lengths outside the timed region.

The fixed hot set is the first floor(N/10) entries: 102/1,024 (9.9609375%) or6/64
(9.375%). It is intentionally described as approximately10%. The rotating case
uses ten floor-boundary bins, six of102 and four of103 entries, covering all1,024
within ten revisions. All shared cases explicitly set copy:false, including Bun.

| Case | Entries | Changes/revision | Measurement cap | Conservative final used bound |
| --- | ---: | ---: | ---: | ---: |
| JSON fixed hot, primary | 1,024 | 102 | 512 | 63.02 MiB |
| List string fixed hot, primary | 1,024 | 102 | 512 | 60.86 MiB |
| Small JSON guard | 64 | 6 | 4,096 | 27.73 MiB |
| Full-churn small JSON guard | 1,024 | 1,024 | 128 | 101.64 MiB |
| Primitive map guard | 1,024 | 102 | 1,024 | 63.95 MiB |
| String map guard | 1,024 | 102 | 512 | 72.40 MiB |
| Copied transport guard | 1,024 | 102 | 64 | 12.12 MiB |
| Raw attachment guard | 1,024 | 102 | 512 | 63.02 MiB |
| 64 independent numeric arenas | 64 | 1 | 1,024 | 4.66 MiB summed used |
| Rotating JSON guard | 1,024 | 102 or103 | 512 | 63.62 MiB |

These upper bounds include the initial record and all32warm revisions. For map
records, bound a branch path by eight nibble levels times72bytes, add leaf header,
five-byte key, encoded value, alignment, and applicable batch pointer/alignment.
Conservative per-record allowances are1,168bytes for wide JSON,646 for small JSON,
616 for number batches, and1,342 for string batches. MapBatch starts from its own
non-journal root; no allocation rewind is assumed. The list bound is744 aligned
bytes per string plus384 bytes per set (256-byte leaf+128-byte depth-one branch),
with the same generous allowance used for initial records. Multi-arena arithmetic
uses64 separate65,536-byte prefixes and612bytes for each initial/change record.

Public configureMemory sets128MiB maximum per single-arena fixture. The64-arena
case uses2MiB maximum per arena, with64 independent public resetMap calls; its
initial physical buffers total8MiB. Every case resets its relevant public default
arena. Only initial and current roots are retained. Each case gets a fresh worker
and session; fixture arrays of previous snapshots are never retained.
After every case, both public map and list defaults are replaced with empty arenas
under a2MiB configured limit, releasing the preceding fixture of either type.
This cleanup is outside endpoints and included in case-wall feasibility.

The copy guard's initial prefix is bounded by1,261,568bytes; each revision adds at
most119,136bytes. Its96 total revisions produce a final prefix≤12,698,624bytes and
sum of all97 published prefixes≤677,069,312bytes (645.71MiB). Enforce16MiB per prefix,
768MiB sum,128MiB writer backing per case, and40MiB final initial+current copied
reader backing. A prefix sum counts one logical published prefix; it does not
count every sender slice, structured clone, reader memory copy, GC lag, or RSS.
Those additional native allocations can exceed the prefix sum; no peak-RSS or
memory-benefit claim follows. Record actual public transport used/backing bytes
for each revision, final reader backing, and process RSS at case boundaries.
Reader backing is summed over distinct retained WebAssembly.Memory handles. Raw
shared attachment can have different handles for the same physical backing, so
that diagnostic may double count shared storage; the copy-reader cap has separate
physical copies and does not have that ambiguity.

## Cache behavior

The candidate admits at most2,048 entries and2MiB of encoded input per arena per
category, without eviction. Both primary fixtures fit the byte cap at2,048
entries. The initial1,024 and32×102 changed values address4,288 unique records by
the warm boundary; the entry cap fills during revision11. All922 unchanged
initial values remain eligible reusable hits; subsequently changing hot records
cannot displace them. This is a scoped fixed-hot-set question.

After32warm rotating revisions, no current record remains in the admitted first
2,048 entries. The full-churn case similarly has no current reusable records.
The small case addresses256 unique records at warm boundary and reaches2,048
after revision331; it is a separate small guard whose measured series may cross
saturation. Report all unique reader-addressed encoded records, including versions
that are not admitted, and per-frame size. The map-string latest-root path bypasses
Arena.string, so it is a control. Copied and raw attachments are also controls.
No observation here establishes an actual retained-JS-heap size or general memory
benefit from the encoded-input cap.

## Endpoint boundaries

Before timing, input generation prepares changed values and an independent
incremental scalar oracle. The timer starts immediately before the public update
(setMany, list.set, or single numeric map.set) and ends when the parent receives
the real worker's completed-read acknowledgement. It includes all writer work,
session capture/publication, transport, attachment, all-N reads, checksum, and
acknowledgement. Each measured operation waits for its reader-read acknowledgement
before the next update, so summed revision elapsed times are non-overlapping.
The subscriber's benchmark acknowledgement precedes the public protocol's own
acknowledgement; a following update can briefly queue behind that protocol ack.
There is no added publication-ack barrier. This is the declared completed-read
endpoint. Never add worker read times to parent elapsed times.
Worker read durations are diagnostic components, preserved for every revision.
Assertions, fixture generation, public memory inspection, and output are outside
the endpoint and identical between variants.

Record worker readiness (creation through imports and ready message) separately.
Initial attachment begins only after that ready message and ends at the worker's
attached acknowledgement. Initial read is a separate parent request-through-read
acknowledgement. The reader performs no initial read before this request. Then
both variants execute exactly32warm revisions, followed by the common calibrated
measurement count. Readiness, initial attachment, and initial read are cold guards;
the worker-only initial read component remains separately visible diagnostic data.

Public createSharedState's default publication strategy is used. For raw control,
full getWorkerData({copy:false})/initWorker is performed every revision. The copy
guard explicitly uses copy:true. Module imports use explicit retained absolute
shared.js and worker.js paths in both engines, avoiding package aliases and Bun
deduplication. No candidate-only warmup or import path is allowed.

## Calibration, budget, and order

Before either calibration, run a correctness-only shared-transport smoke for both
retained variants in Node and Bun (four fresh children,15s cap each). Each uses one
real worker, one numeric collection, explicit copy:false, an initial read, and one
updated read. Assert that the initial wire carries a WebAssembly.Memory backed by
SharedArrayBuffer, the second frame is descriptor-only, neither frame carries a
copy, and both read checksums match. No smoke latency is a measurement sample.
Any failure stops this two-engine study before calibration. Preserve the exact
clone error, timeout, or cleanup failure as shared transport not established;
do not infer unsupported transport merely from a timeout. Do not substitute a
MessageChannel or copied mode. A different supported-engine cohort requires a
new prospective review. Smoke time counts toward the12-minute whole-study cap.

The revised prospective target is1,000ms baseline aggregate per case, raised from
the initial200ms proposal before any calibration so a substantial gain need not
automatically fail the100ms candidate minimum. One baseline-only calibration child
per engine runs eight pilot revisions after the same initial/readiness/32warm
sequence. Count = ceil((1000 / pilot mean milliseconds) /8)×8, clipped to[8,case cap].
Freeze this count per engine/case and use it for both variants in every pair.
Calibration and measurement fixtures are fresh. Capped short cases remain unresolved.

Run both calibrations before measurements. Project each case's whole wall cost
as observed fixed creation/readiness/initial/warm/cleanup time plus pilot measured
loop wall time×selected count/8. This includes generation/check/output overhead,
not merely the latency endpoint. Require each predicted subject≤36s and elapsed
calibration plus all28 projected subjects≤576s, preserving20% slack under the hard
45s subject and720s whole-study caps. Each calibration has a60s hard cap. If this
fails, stop before measurement; do not reduce32warm, alter fixture sizes, extend
budgets, or tune based on the candidate. A new study requires a new reviewed plan.

Measured schedule is sequential with no competing work. Node22.16.0 runs first,
then Bun1.4.2. Each has seven pairs of fresh processes. Zero-based pairs alternate
AB,BA,AB,BA,AB,BA,AB (A=baseline,B=candidate); rotate case order by3×pair mod10 and
use the same order in both arms. Failed slots consume their place. Preserve every
attempt and failure; continue the remaining declared slots only while the study
budget permits. No replacements or extra sampling.

## Estimation and decision rules

For each engine/case, the process update value is mean elapsed time across its
measured revisions. Pair ratio is candidate mean/baseline mean. Estimate is
exp(mean of the seven log pair ratios). Revisions are not independent trials.
Also report absolute arm medians/ranges and all seven pair ratios. Bootstrap
10,000 resamples of seven paired log ratios using xorshift32, seed0x5e5510c4,
left/right/left shifts13/17/5, uint32/2^32 uniform, floor(u×7) indices; reset the seed
for each endpoint. Interval endpoints are sorted bootstrap ratios at zero-based
indices249 and9749, the nearest-rank2.5th and97.5th percentiles. This is descriptive
uncertainty, not a general statistical guarantee on a shared host.

An update endpoint is short if any arm's measured aggregate is below100ms. A cold
endpoint is short if any individual observation is below0.1ms. Excess variability
means max(pair ratios)/min(pair ratios)>1.25 or sample SD(log ratios)>log(1.10).
Missing/failed/capped subjects, short endpoints, excessive variability, invalidated
bindings, an adverse ratio estimate>1, or interval spanning the1.02 margin are
explicitly unresolved. Preserve durations and checksums even for failures.

The same named primary must have upper97.5% ratio≤0.95 in both engines, with no
short/variability/missing issue. The other primary is still a guard. All warm case
endpoints and all readiness/attachment/initial-read endpoints remain guards. A
guard clears only with upper≤1.02, non-adverse estimate, and no unresolved issue.
Any guard's lower>1.02 blocks promotion. Never hide unresolved guards behind a
winning primary. The machine report always sets noRegressionClaim:false and
mergeClearance:false, even if all scoped guards clear.

## Release and execution contract

The coordinator supplies a new JSON manifest with:

- release: "session-cache-screen-v1"
- baselineCommit: exact current-main commit above
- candidatePatchFile and candidatePatchSha256: the absolute final reviewed patch file
  and exact digest above
- harnessSha256: canonical inventory digest of these five packet files
- engines: ordered node,bun records containing name, executable, sha256, version
- variants.baseline and variants.candidate: sourceRoot, sourceSha256, buildRoot,
  buildSha256. Build roots must be distinct retained directories with shared.js,
  worker.js, and all relative shared chunks. Both use portable builds.

Inventory is a relative-path→SHA256 JSON object sorted by deterministic JavaScript
code-unit ordering (ASCII for these paths), hashed as UTF-8 with no whitespace.
No locale-sensitive sorting is used. Source inventory includes all root regular
.ts/.json/.wasm files and all
regular files recursively under scripts/. Build inventory includes every regular
file recursively; symlinks are rejected. Harness inventory contains exactly
cases.mjs,subject.mjs,run.mjs,summarize.mjs,method.md. Bindings and the runtime binary
digest are checked before measurements and after the complete study. Retain the
full inventories and engine/platform/CPU/memory metadata in binding.json.
Digest equality binds the files being executed; the coordinator must separately
link the retained builds to successful exact-source build/correctness receipts.

After explicit release, invoke the pinned Node executable with run.mjs, the
manifest's absolute path, and a new output-directory absolute path. The driver
creates only that fresh directory. It writes each immutable child config, raw
NDJSON and stderr, every termination/failure receipt, calibration/feasibility data,
study.json, and summary.json. All raw revision records live in their original
NDJSON file; study.json keeps only initial/case/cleanup/failure records to avoid
repeatedly duplicating raw data. Do not edit or reuse an old output directory.

Every normal child must acknowledge reader disposal, remove its message handlers,
close its port, and exit. Parent expectations reject on worker error/unexpected
exit, clear their timers, and remove listeners. Cleanup failures invalidate the
subject. Hard-killed children preserve partial output and the kill receipt; they
cannot be represented as clean completions.
