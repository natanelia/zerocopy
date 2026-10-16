# Lazy freezeJSON worklist: prospective codec-decode screen

**Method only, 2026-10-16. No imports, builds, tests or timings have run for this proposal.** This is the smallest proposed screen: ten fixed rows, two engines, six fresh-process blocks, and one baseline-only calibration process per engine. It requests no memory-chart run or publication.

## Question and admission

Does delaying the private traversal worklist improve actual object-codec decoding of a flat record or flat primitive array? The measured operation is the existing `codecs.object.decode(bytes, ptr, len)`: UTF-8 decoding, `JSON.parse`, and `freezeJSON` together. A helper-only loop is unnecessary for this screen. The candidate omits one source-level traversal-array request for a root with no object children. Every object retains its `Object.values` snapshot; nested roots still request a worklist and each child push gains a lazy-initialization check. Physical allocations, GC savings, retained memory and application-wide speed cannot be inferred from that source change.

Baseline is the supplied main snapshot `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e` in `sources/baseline`. Candidate is that same snapshot with only `freeze-json.ts` replaced by `sources/candidate/freeze-json.ts`, SHA-256 `f12919fb7cf31f2a276b8a83f9b66410dbe24d57314f7c418c67aa7e0a2e568e`. Baseline helper SHA-256 is `dd8de05df67a8770eff048b28b9697d20a3ef4ef87bfabfff7d7f5a6f01a8ec2`. The included source files and their hashes bind this screen to those exact bytes.

The candidate deliberately omits the initial dynamic `Array.prototype.pop` lookup/call. Replacing or observing that operation can change errors or mutate decoded data in baseline only. Preserve this documented compatibility boundary; never claim universal equivalence. See the source comparison and compatibility boundary in README.md.

Timing requires the focused correctness gate to complete successfully on these exact source bytes in Node and Bun, including direct codec behavior, inherited-index/setter/snapshot/error/reentrancy cases and the expected initial-pop difference. Correctness receipts are separate from this prospective method. A failed or missing gate blocks the screen. Full repository or WASM builds are not a prerequisite for this narrow screen; public-collection integration and ordinary contributor validation remain later gates.

Pin Node **22.16.0** and Bun **1.4.2** using the exact executable hashes in `prepare.py`. Prepare and review one non-minified standalone ESM codec bundle per arm from the actual `codec.ts` dependency closure, with the same pinned compiler/options; both engines import the identical corresponding bundle. A narrow Bun 1.4.2 build with Node target and ESM format is the proposed preparation route. Keep emitted code, source inventories, compiler command/hash and artifact hashes. Do not hand-copy the decode routine, measure a rewritten helper, or mix source and bundled routes between arms. Artifact preparation is a separate bounded, reviewed step before this study; it has not occurred here. Seal the fixtures, driver, analysis, method, sources, dependencies and artifacts before calibration. No candidate-specific compilation or tuning.

## Fixed corpus and operation

Synthetic inputs represent a telemetry record, a sensor window, and ordinary API nesting. They are fixed before any measurements; no size sweep or winner selection within a row is allowed. Run the ten rows in the order below in every process.

| Row | Codec and exact fixture | Role / scalar consumed each call |
|---|---|---|
| P-record | object; the 16-field record below | Primary; `id + sequence` |
| P-array | object; 64 numbers, index `i=0…63`: `20 + ((17*i)%101)/10` | Primary; array `length` |
| E-object | object; `{}` | Empty-object control; `Object.keys(result).length` is **not** timed: consume `result.missing === undefined ? 1 : 0` |
| E-array | object; `[]` | Empty-array control; `length + 1` |
| N-record | object; `{requestId:"req-0042",ok:true,user:{id:42,name:"Ada",locale:"en-GB"},items:[{sku:"A1",qty:2,price:12.5},{sku:"B2",qty:1,price:7}],meta:{page:1,next:null}}` | Ordinary promoted-worklist control; `user.id + items.length` |
| D-array | object; 256 nested singleton arrays around numeric `1` | Iterative-depth control; outer `length` |
| W-array | object; 128 records, index `i=0…127`: `{id:i,active:i%2===0,value:i/8,label:"item-"+i}` | Many child pushes / wide worklist; `length` |
| C-string | string; `"worker-07 / café / 東京 / 🔔"` | Unchanged UTF-8 codec; string `length` |
| C-number | number; `12345.25` | Unchanged primitive codec; numeric result |
| C-boolean | boolean; `true` | Unchanged primitive codec; `result ? 1 : 0` |

P-record, in this insertion order:

```json
{"id":104729,"kind":"metric","source":"worker-07","name":"queue.depth","value":37.5,"unit":"items","timestamp":1760000000123,"sequence":8192,"ok":true,"sampled":false,"region":"eu-west","host":"node-04","label":"café / 東京","note":null,"attempt":2,"ttl":60}
```

Prepare the JSON UTF-8 bytes once outside timing, using ordinary `JSON.stringify` except D-array, whose exact JSON is 256 `[` characters, `1`, and 256 `]` characters. Primitive bytes use their actual codec encodings. For every row place the payload at pointer **16** in a dedicated `Uint8Array` over a `SharedArrayBuffer` of payload length plus 32. Pass that full view, pointer 16 and exact payload length to the real codec. This exercises the shared-byte UTF-8 path and its existing runtime fallback, without substituting a different decoder. Do not mix normal/shared-buffer input within a row. Record payload byte hashes/lengths and the runtime's shared-input decode capability as descriptive metadata. Require each input below 64 KiB, total prepared bytes below 1 MiB and each decoded tree below 2,048 object/array nodes; the fixed corpus fits those conservative setup limits.

The timed region contains only a fixed-count loop, the actual codec call, latest-result assignment, and the specified scalar checksum update. Resolve the codec and row-specific loop before timing. Keep just the latest decoded result, never a history of outputs. Include the small consumption cost in the reported estimand; no empty-loop subtraction. All timed calls decode anew from the same immutable bytes. Initialization, encoding, imports, assertions, deep traversal and result serialization are outside the timer. Use a monotonic high-resolution clock with two reads per batch.

Before warming and after **every** batch, including pilots and discarded warm-ups, validate the latest output's full value and shape, expected checksum, unchanged source bytes, and recursively frozen JSON nodes. Traverse deep outputs iteratively. Check independent successive object decodes return distinct roots outside timing. Use ordinary unpatched built-ins throughout performance work; adversarial hooks belong to the correctness packet. Primitive controls must use their own codecs, not JSON-encoded primitives through the object codec. Wrong output or mutated input makes the study incomplete, never a fast result.

## Sampling, calibration and quality

Each engine has six blocks, each with independent fresh baseline **B**, candidate **C**, and second-baseline **A** processes. A imports exactly B's baseline artifact and has its own setup, warm-ups and measurements. Use the six process orders once each: `B C A`, `A B C`, `C A B`, `B A C`, `C B A`, `A C B`. Node goes first in odd-numbered blocks, Bun in even blocks. Children run sequentially on one quiet host, with no concurrent study build/test/benchmark work. Record public hosted run/job identity, CPU/architecture/OS, scalar effective-memory limits, runtime versions/flags, timestamps and order. A/B is an independent-process same-source control; it shares B with C/B statistically and is not a second candidate replicate.

One baseline-only calibration child per engine precedes all measurement blocks. For each row start at 256 operations. Each trial has five warm-up batches and three pilot batches. Accept a pilot median of **20–50 ms**, targeting **30 ms**; otherwise scale count by `30 ms / median`, round to the nearest positive integer and clip to the fixed cap. Maximum four trials per row. Cap JSON rows at `2^20` operations/batch and primitive codecs at `2^24`. Reject nonfinite/nonpositive pilot durations. Retain all pilot/warm-up records and exclude them from estimates. No candidate calibration. Freeze one count per row/engine, shared by B/C/A. Either uncalibrated primary stops measurement admission; an uncalibrated control keeps its final attempted count, is measured, and remains explicitly unresolved.

Each measurement row gets **five discarded warm-ups and nine measured batches** at that count. The process observation is the arithmetic mean of the nine elapsed-per-operation values. Report all raw durations, counts, checksums and validations. No explicit GC, trimming, outlier deletion, selective repeats, replacement children, added samples or optional stopping based on a favorable result.

For each process/row, quality is unresolved for any nonpositive/nonfinite duration, any measured batch **below 10 ms**, measured-batch sample CV **above 25%**, or the last-three/first-three measured batch-mean ratio outside **[0.85,1.15]**. These are measurement stability checks, not proof that the JIT is fully warm. A primary can qualify only if all of its B/C/A observations in both engines meet quality and calibration rules. Flagged control data remain in the full-sample analysis; they do not disappear. Missing children, wrong outputs, source mismatches, crashes, timeout/resource stops or incomplete raw records make the whole study incomplete.

## Finite budget

The complete screen has **38 experimental children**: 2 calibration plus `6 × 2 × 3 = 36` measurement children. One controller runs at most one child group at a time and performs analysis itself; do not add pilot, retry, validation-only or benchmark subprocesses. Validation is untimed inside the prescribed children. Source/bundle preparation and prior correctness execution are separate admissions, with their time and process counts disclosed separately.

Use **60 seconds per calibration child**, **30 seconds per measurement child**, and a **600-second whole-study wall cap** covering calibration, launch, fixture/validation work, raw collection, analysis and cleanup. Reserve the final 30 seconds of the whole cap for analysis/cleanup; stop launching when the next child's full cap would cross that boundary. Reserve two seconds within each child cap for termination/reaping. Caps are ceilings, not duration targets, and individual maxima need not all fit the whole cap.

Count-based projection: the 36 measurement children execute `36 × 10 × 14 = 5,040` timed batches. At the accepted 20–50 ms range this is **100.8–252 seconds**, or **151.2 seconds** at 30 ms. Calibration has at most `2 × 10 × 4 × 8 = 640` batches; 50 ms each would add 32 seconds, although initial uncalibrated trials may take longer and remain bounded by their child caps. Allowing a provisional two seconds of import/setup/validation/launch overhead per child adds 76 seconds, plus 30 seconds analysis/cleanup: about **289 seconds at the 30 ms target**, **390 seconds at 50 ms**. These are planning assumptions, not measured predictions; candidate and A durations can differ. The 600-second cap leaves finite headroom without granting reruns or a larger corpus. Report actual phase costs so a failed budget is visible.

Require at least **2 GiB available within the effective host/container limit** at admission. Sample summed owned-child-group RSS every **50 ms** and stop at **1 GiB**, also checking terminal process high-water evidence before accepting completion. Natural transient allocations are permitted; retaining only the latest result bounds the live workload rather than cumulative allocation. Fixture caps are guards, not a prediction of engine memory. The RSS guard can overshoot and may double-count shared pages; it is a safety limit, **not a comparative memory endpoint**. Use identical sampler/flags in every arm, no virtual-address limit or heap/GC retuning. On any cap or interruption, terminate/reap only owned groups, preserve partial evidence and stop without retry. Do not shrink fixtures, increase limits or extend counts to salvage the result.

## Analysis and fixed decision

For every engine/row/block calculate `d = log(C/B)` from process means. The independent replication unit is the **block**, n=6, not the nine batches. Report `R = exp(mean(d))` and the ordinary two-sided 95% paired Student-t interval:

`exp(mean(d) ± 2.570582 * sampleSD(d) / sqrt(6))`, with df=5.

Also report the corresponding A/B and chronological later-baseline/earlier-baseline intervals, each using six block values. Show all process means, block ratios and time order. Do not pool engines, switch baseline labels, average A with B, bootstrap, or select favorable subsets. This small-sample t screen assumes approximately independent, reasonably behaved block log-ratios. Process balance and quality checks do not establish that model or remove shared-host confounding.

Major same-source systematic bias means an entire A/B or chronological-baseline interval lies above **1.05** or below **0.95**. Such bias on a primary blocks that primary's gain verdict; bias on any unchanged primitive-codec control blocks every gain verdict. Other biased control rows remain unresolved. An interval crossing one or an isolated noisy point is not evidence of equivalence or harm.

The two primary choices are fixed prospectively. **The same primary must have a 95% two-sided interval upper bound ≤0.95 in BOTH engines**, with complete admission, calibration, quality and no blocking bias. Do not combine a record win in Node with an array win in Bun. Two-primary multiplicity is handled as follows: each reported upper bound is also a **97.5% one-sided bound**. Allocate one-sided alpha 0.025 to each primary's cross-engine claim. Requiring both engines is an intersection-union test; if either engine lacks the required gain, the chance of falsely qualifying that primary is at most 0.025 under the model. Bonferroni across the two predeclared primary choices therefore bounds the false-lead probability at 0.05 without assuming independent engines. This is decision-family control, not a claim that all four displayed two-sided intervals have simultaneous 95% coverage.

**Any source-authenticated, value-valid row with a computable full-sample 95% lower bound >1.02 in either engine vetoes the unchanged candidate**, including the other primary and every control. This adverse-evidence rule applies even if calibration, CV, drift, short-batch or A/A issues elsewhere or on that row would block favorable inference. Preserve and label those limitations; they cannot waive the conservative stop. Wrong-source/value results cannot establish candidate latency; missing/nonfinite values that prevent an interval remain incomplete/unresolved, never passed. Independently valid adverse evidence remains visible even when another failure makes the whole study incomplete. The unadjusted harm rule intentionally favors stopping; it is not familywise 95% proof that all controls are safe.

A control is only provisionally clear for this screen if its complete calibrated/quality/bias-qualified interval upper bound is ≤1.02. Anything between the veto and clearance rules, or failing those prerequisites, is **unresolved**. A primary lead with unresolved controls can justify only a separately proposed targeted validation and must name every unresolved engine/row. It is not full regression clearance. Failure to meet either cross-engine primary rule ends this screen without resampling or threshold changes. An incomplete run supplies no lead.

Report absolute ns/decode, source-byte sizes, all nine-batch/process/block results, interval endpoints, calibration, quality, A/A diagnostics, limits and execution receipts. Preserve commands/cwd, source/artifact/runtime/driver/method hashes, environment, stdout/stderr/exits and all raw records, including warm-ups, failed trials and partial results. No favorable-only summary.

## What a positive result would mean

A qualifying outcome is a **promising direct-codec latency lead on the named flat shape in Node 22.16.0 and Bun 1.4.2**, with listed unresolved controls. It supports further validation, not a PR or broad performance claim. Actual public-collection reads still need integration measurement and correctness coverage, including their arena, allocation and worker paths, before the change is useful as a production performance PR. Existing contributor/platform checks remain necessary. No memory chart, retained-heap claim, collection-wide speed claim or existing benchmark figure changes follow from this screen.

## Source references and preparation record

- Actual codec: [sources/baseline/codec.ts](sources/baseline/codec.ts), SHA-256 `b8db477ef09b39140604a89a6550a470ca03bb14447b82c1bebbb4094bad0164`.
- UTF-8 path: [sources/baseline/utf8.ts](sources/baseline/utf8.ts), SHA-256 `68d26ddad81f106d9cc463f1212085210bdb3f0d43c9a0cfa319adc1f9c260e3`.
- Type parser: [sources/baseline/types.ts](sources/baseline/types.ts), SHA-256 `9deafce9cdcad8a0676c5c930ef8e069aac76391a2fea2ce8f0a13a443a8ba5e`.
- The source-only change is visible between [baseline](sources/baseline/freeze-json.ts) and [candidate](sources/candidate/freeze-json.ts). All source, driver, method and runtime bindings are recorded by source-pins.json and the separate preparation admission.

This prospective document defines the fixed experiment. It does not itself report experimental evidence. Preparation and measurement receipts must identify their separately bounded phases, preserve failures and bind the emitted artifacts before calibration.
