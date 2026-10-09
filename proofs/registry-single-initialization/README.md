# Registry single-initialization: prospective ARM-first gate

This is an unpublished, proof-only timing protocol for cleanup `6b4b436435955be5cedeeafa763df44c4e8004ec`. The runtime change removes an immediately discarded dependency Map during shared-registry attachment. It is not a validated ARM fix or a blanket no-regression claim. Original PR22 remains the historical comparison; the adverse ARM result stays in the record.

The gate must be one reviewed proof-only child of the cleanup commit, published once by non-forced push to `perf/registry-single-initialization-20261008`. The workflow admits push attempt 1 only, with no PR or dispatch trigger. The proof commit must have exactly one parent, the frozen cleanup. No local timing mode, resume, replacement subjects, or favorable rerun is available.

## Frozen evidence and source identity

- Main: `3773c6e519c7c0958da13727ed1082f449f3ee25`.
- Original PR22: `ab969f043e44d53f6ba7315c2b818c1a51ce49c9`.
- Cleanup: `6b4b436435955be5cedeeafa763df44c4e8004ec`, tree `d61ad90768846b3ae222baba7cadc73fec3e6982`.
- Original focused proof: `96b90882df5d5294489065bd303fbbede6a83184`.
- Original focused subject Git blob: `789ff9f724a2453dc814231f42eb257e3e350781`; SHA-256 `5afbc414c9dcb593aae6bb6b1a10be9b1303e9b51c5b4bcefbc0cdfa09c7b646`.
- Separate owned subject SHA-256: `4805fbac4259ba26a17d90329f4e3c9c059c8058d74d8ba960857a7244c5bcb1`.

The entire 7,458-byte original subject is unchanged, including producer construction, Map probes, task boundaries, GC, retained attachment, assertions and timed code. Its supported operations are attach, reexport and warmNestedRead at 1 or 512 arenas. Child output now goes directly to pre-opened artifact files so emitted JSONL survives controller interruption; this prospective controller change is shared by all variants and does not replace historical measurements. Comparing just the timed loop is insufficient. The separate owned control uses the 512-producer fixture and reads that producer without creating an attachment; it is not substituted for the primary.

The [Node 22 correctness/build preflight](https://github.com/natanelia/zerocopy/actions/runs/37867223456) succeeded on ARM64 and x64 at proof commit `3a3c05d96c989721e7bfdb5e6400cf1a7312edbf`, tree `7434337e595217782262abf4b6f0bca1bf649a5e`. Its ZIP digests, internal tar checksums, source snapshots, emitted JavaScript, WASM, complete distributions, compilers and proof inputs were independently reconciled. Each architecture passed 61 commands, 10 protocol tests, focused suites of 78/104/104 tests, 12 real-worker proofs and nine untimed fixtures. There were zero pilots or measured batches.

`frozen-pins.json` retains the exact receipts and audit boundaries. Node/Bun executable bytes were not archived by that preflight, so their hashes are CI-recorded rather than independently rehashed from those ZIPs. This gate requires the same executable hashes before pilots and checks the Node hash inside every fresh timing process. AssemblyScript and TypeScript implementation/package files were independently rehashed.

Source, JavaScript, WASM and complete-dist hashes agree across the two preflight architectures. Cleanup source digest is `9bcde3bee8420b36b8a03ee054bf39916862c5f95a6c2f838fc6dd058c3b1e7c`; emitted-JS digest is `2136957d182ab6b48d07c189ddaa1b441150cea3196513062cf2ba20bc2ebe6c`. Complete-dist includes JavaScript and declarations and uses the recursive physical-tree definition; it is not the prior local completePackage metric.

## Bounded stages and stopping

The exact machine-readable declaration is `gate.json`. Stage 1 is Node 22.23.3 Linux ARM64:

| Case | Direct contrasts | Dedicated A/A | Quartets per arm | Fresh measured processes |
|---|---|---|---:|---:|
| Original attached warmNestedRead/512 primary | main→old, old→cleanup, main→cleanup | main/main, old/old, cleanup/cleanup | 8 | 192 |
| Original attached warmNestedRead/1 singleton | old→cleanup, main→cleanup | all three | 4 | 80 |
| Separate owned warmNestedRead/512 | old→cleanup, main→cleanup | all three | 4 | 80 |

Stage 1 totals 352 measured processes. Only a completed, integrity-valid ARM stage meeting every primary and control decision admits stage 2. Stage 2 is Node 22.23.3 Linux x64: original warmNestedRead/512, attach/1 and reexport/512, each with the two cleanup contrasts plus three dedicated A/A arms, four quartets per arm. It totals 240 measured processes. A failed, invalid or inconclusive ARM gate leaves x64 explicitly not run.

Every primary arm has four ABBA and four BAAB quartets; every control arm has two each. Seed 2026100901 plus the fixed manifest case index selects the prospective arm order. Arms are shuffled within each quartet. Case order is fixed. A/A processes are newly launched, not reused from direct contrasts. The complete schedule is written and hashed before pilots.

No timing-selected variant, exclusions, normalization, pooling, extra quartets, substitutions or reruns are permitted. Hard errors stop that stage and preserve partial results. Short batches remain in the fixed run and invalidate inference. An inconclusive control blocks progression; a later confirmation would require a separately declared reviewed protocol and cannot replace or pool this evidence. Each child has a prospective 240-second timeout; each architecture job has a 120-minute limit.

## Prerequisites and neutral packages

Before any pilot in a stage, `prepare.mjs` reruns supported builds/types/focused tests/packed-package consumers/real workers/fixtures using exact Node 22.23.3, Bun 1.4.2, AssemblyScript 0.28.20 and TypeScript 5.9.3. All sources must match their pinned Git bytes. Main→old production differences are exactly arena.ts/shared.ts. Old→cleanup is exactly the two declared substitutions in arena.ts. Guarded source includes the established 81-file source/WASM scope; full source archives remain available as well.

Every emitted-JS, WASM, complete-dist and compiler hash must match the independently reviewed preflight. Owned/singleton semantics remain covered. Main runs supported common tests; registry-specific assertions run only on old/cleanup. The original four real-worker proofs are source-pinned and identical across variants. Protocol tests must pass in CI before pilots.

Separate untimed mechanism probes verify Map-expression allocation attribution, settled observed Maps, untouched-dist topology, own-property order/descriptors, lifetime identity, retained snapshots, read-only behavior, compatibility getters and traversal. They use separately archived original/instrumented copies and fresh processes; their instrumentation never enters a timing package. See `map-probes.md`. The 54-cell probe matrix is a prerequisite, not latency evidence. A passing probe summary and unchanged source inputs are required.

Before every timing child, physically copy the entire selected distribution plus original package.json and the selected frozen subject into one neutral physical package path. The child receives the same cwd/import path, the same hashed Node executable, only --expose-gc, and a cleaned environment without role labels, original source paths, JIT overrides or compile caches. Complete source/staged manifests are checked before and after every invocation. Content-hashed chunk names remain original. Production Date.now/Math.random behavior is unchanged.

## Common work and inference

All disposable pilots for all three sources and all three cases in a stage finish before its first measurement. Each pilot uses the original adaptive calibration protocol, common initial work and bounds, a 40 ms target, then three pilot warmups. Freeze one count per case as the maximum of all three prescriptions based on the fastest pilot warmup. Caps remain 8192 attachment iterations, 1000000 reexports and10000000 reads. A prescription above the cap stops before measurement.

Every measured process executes exactly three common-count warmups and seven common-count samples, with no per-process calibration or extension. Every retained warmup and sample must reach 20 ms. Setup, hashing, producer creation, assertions, copying and GC are outside timing exactly as defined by the frozen subject. Slow baseline reexport may consequently take much longer; work remains equal.

A process contributes the median of seven ms/op values. Within each quartet, average the two adjacent-pair log(B/A) ratios. Estimate the geometric mean and two-sided pointwise 95% Student-t interval over independent-process quartets: df7/t = 2.3646242510102993 for the primary; df3/t = 3.182446305284263 for controls. Batches are not independent inferential units. Shared-host temporal dependence remains a limitation; there is no familywise claim.

Direct-contrast lower CI>1.02 is a material-slowdown signal; upper CI≤1.02 is within the declared margin; otherwise it is inconclusive. A dedicated A/A point outside[1/1.02,1.02] with CI excluding1 invalidates its case. Any short measured-process warmup/sample, missing work, failed prerequisite or final integrity failure also invalidates inference. All raw intervals remain visible and are never corrected by A/A.

The ARM primary needs three separate decisions, all valid:

1. Cleanup/main upper CI≤1.02.
2. Cleanup/old upper CI<1.
3. Old/main lower CI>1.02, reproducing the original material loss.

Both ARM controls require cleanup/main and cleanup/old upper CI≤1.02. Failed bridge reproduction cannot support attributing a repair to the original loss. Stage2 applies the same control margins; reexport additionally requires cleanup/main upper CI<1. The stage2 controller verifies the ARM summary checksum, binds it to the same proof/run/protocol and recomputes its decisions before admitting x64 timing.

## Memory, history and claims

The cleanup removes 512 discarded constructor Maps for 512 shared-registry arenas. It does not reduce settled topology/Map counts. Prior Node 24 diagnostics found 37 slots / 320 bytes unchanged and dependency field feedback broadened to mutable/Any, including owned/singleton contexts. Those physical object-layout numbers are not assumed to be portable Node 22 measurements.

Map-expression evaluations, WeakRef-observed settled Maps, Map.prototype traversal counts and retained/process memory are distinct metrics. The original subject's GC-bracketed setup heapUsed/external/arrayBuffers deltas remain descriptive only. Neither fewer transient Maps nor those setup deltas establishes retained-heap savings. No dense-map priming, unrelated read-cache rewrite or blanket memory claim is introduced.

The [original focused ARM loss](https://github.com/natanelia/zerocopy/actions/runs/37834362984) remains +3.9104%, pointwise 95% CI[3.0640%,4.7638%], all eight quartets adverse. Its 155.04→160.85ns scale and the same run's inconclusive x64 attach result remain in `history.json`. Separate causal controls changed setup context and cannot replace the original acceptance subject. Later Bun/browser and x64 owned/singleton validation remain required before a broad repair claim.

## Complete and partial evidence

The archive retains every command/stdout/stderr, synchronous subject JSONL, parsed results, stage schedule, pilots/frozen work, source/staged manifests, source snapshots, compiled packages/WASM/compiler files, instrumentation copies and site-level counts, prerequisites, source history, CPU/OS/runtime/executable metadata, start/end times and final decisions. The controller keeps offending staging intact after errors.

The workflow always attempts tar.gz plus SHA-256 and upload. It retains worktrees and neutral packages as well as dedicated input archives so an interrupted process cannot lose available build inputs merely because its finally block did not execute. Only dependency symlinks and package-consumer scratch are excluded. The ARM transfer checksum is generated from the retained summary even for partial runs. Runner loss can still prevent artifact upload; absent evidence never counts as acceptance.

Successful CI means execution completed; the numerical gate decision is separate. This protocol has collected no timing at authoring. Independent source review and deterministic checks are required before publication. The unchanged historical preflight implementation and its recorded local preparation caveats remain available in the other preflight files.
