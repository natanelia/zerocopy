# Registry single-initialization preflight and prospective gate

This commit contains a correctness/build-only preflight. It is not a timing result, a validated optimization, or an ARM repair. The current executor could not start. No local Node/Bun checks, source build, tests, pilot, or timing run are claimed.

The preflight admits only its first push-triggered CI attempt on proof/registry-single-initialization-preflight-20261009. Its sole parent must be cleanup 6b4b436435955be5cedeeafa763df44c4e8004ec, tree d61ad90768846b3ae222baba7cadc73fec3e6982. Runtime and existing PR22 branches are unchanged by this proof commit.

## Exact references

- Main: 3773c6e519c7c0958da13727ed1082f449f3ee25.
- Original PR22: ab969f043e44d53f6ba7315c2b818c1a51ce49c9.
- Cleanup: 6b4b436435955be5cedeeafa763df44c4e8004ec.
- Original focused proof: 96b90882df5d5294489065bd303fbbede6a83184.
- Original focused subject: proofs/registry-attachment-subject.mjs at that proof, blob 789ff9f724a2453dc814231f42eb257e3e350781.
- Historical focused adverse run: https://github.com/natanelia/zerocopy/actions/runs/37834362984.

The original-subject.mjs file is the entire unchanged 7,458-byte original subject. Equality is checked against Git bytes and blob identity, not just a kernel or fixture substring. Its probes, producer lifetime, task boundaries, GC, retained attachment and assertions remain part of the workload. It supports attach/reexport/warmNestedRead with one or 512 arenas.

The separate owned-subject.mjs is a prospective control, not a replacement primary. It keeps the original 512-producer fixture and nested-read loop, reads the producer itself, constructs no attachment, and checks retained immutable owned snapshots. It has a distinct source hash. Both subjects are invoked only in correctness mode by this preflight; the controller asserts that no batch was emitted and no calibration, warmup or sample exists.

## Preflight prerequisites and evidence

Both Linux ARM64 and x64 use Node22.23.3, Bun1.4.2, AssemblyScript0.28.20 and TypeScript5.9.3. Three detached source worktrees use the same installed toolchain.

Before builds, tracked production bytes must equal their pinned commits. Main versus old may differ only in arena.ts/shared.ts. Old versus cleanup may differ only in arena.ts, exactly the two declared substitutions: remove the eager dependency Map initializer and assign the registry-or-new-Map value in the constructor. Unrelated runtime changes fail closed.

Build WASM, browser JavaScript and declarations for all three. Historical main/old source-with-WASM and emitted-JS aggregate hashes must match the original focused proof. All three WASM manifests must match. Cleanup hashes are deliberately unknown until successful preflight receipts; no expected cleanup checksum is invented.

Each source runs common focused tests (worker, workers, nested and JSON read-cache), its supported type checks, worker declarations, and the real packed-package Node/Bun/TypeScript consumer check. Only old/cleanup run registry-specific worker-attachment assertions. Four identical pinned real-worker proofs run against each independently staged package, covering retained views, copy/shared forwarding and worker sessions. The common Redux dependency installation is resolved from the parent checkout; every zerocopy self-reference resolves through the staged package's own identical package.json.

Before every neutral worker or fixture invocation, copy the full selected dist and original package.json into the same physical package path. Check full staged/source manifests afterward. Nine untimed fixture invocations cover attached1, attached512 and owned512 across the three sources. Expected original-subject dependency-set/traversal counters are N² for main and N for old/cleanup; these are not constructor Map-expression counts.

A successful preflight prints REGISTRY_PREFLIGHT_RECEIPT with exact runtime/proof pins, original subject SHA-256, source/emitted-JS/WASM/full-dist digests, Node/Bun binary hashes and compiler package/code hashes. It archives original source tar files, guarded source/generated WASM, full dist, package archives, proof/workflow bytes, historical evidence links, compiler files, commands and every stdout/stderr. Before success it verifies final source/build/proof/workflow/compiler/binary integrity. A finally block archives each role's available source/WASM/dist and a hash manifest even if a build or the initial historical digest guard failed. On failure it also retains the last neutral staging tree, including an offending package rejected by integrity checks. Input-retention errors fail the preflight and suppress a passing receipt. Failed checks retain partial evidence and never emit a passing receipt.

The always-run archive step creates tar.gz plus SHA-256. Temporary worktrees, staging packages and package-consumer scratch are excluded because their needed source/build inputs are separately retained. No pilot or timing follows a preflight receipt automatically.

## Prospective timing protocol, not implemented here

Stage1 ARM64:
- Original attached warmNestedRead/512 primary: three direct contrasts (main→old, old→cleanup, main→cleanup), plus three dedicated A/A arms; eight quartets per arm =192 fresh measured subjects.
- Original attached warmNestedRead/1 singleton: old→cleanup and main→cleanup, plus three A/A arms; four quartets per arm =80.
- Separate owned warmNestedRead/512: the same five arms and four quartets =80.
- Stage1 total352.

Only if stage1 finishes with valid integrity, all three primary repair decisions and both control decisions does stage2 run:
- x64 original warmNestedRead/512, attach/1 and reexport/512.
- Each uses the two cleanup contrasts and three A/A arms, four quartets per arm =80; stage2 total240.
- No main→old bridge is added to diagnostic controls.

Every quartet uses fresh processes and independently staged complete packages. Each arm has equal numbers of ABBA/BAAB orders, prospectively seeded and interleaved. A/A subjects are dedicated, not reused A/B measurements. No role/source metadata reaches the subject.

All disposable pilots finish before measurement; freeze one common iteration count per cell as the maximum prescription across all three sources. Each process performs exactly three fixed-work warmups and seven fixed-work samples. Target40ms pilots,20ms minimum for every retained warmup/sample. Original prospective caps remain8192 attachments,1000000 reexports and10000000 reads. No local calibration, short-batch replacement, exclusions, extra quartets or favorable reruns.

A process contributes its seven-sample median. Average the two adjacent-pair log ratios per quartet. Report geometric estimates and two-sided pointwise Student-t intervals: df7/t2.3646242510102993 for the primary; df3/t3.182446305284263 for controls. Batches are not independent inferential units; shared-host dependence remains a limitation. There is no familywise inference claim.

A/A point estimates outside[1/1.02,1.02] with intervals excluding1 invalidate that case. Any short measured-subject warmup/sample invalidates the case. Incomplete work, failed correctness or final integrity failure also invalidates it. Report all raw intervals anyway; never normalize by A/A.

The primary requires all three independent decisions:
1. cleanup/main upper interval≤1.02.
2. cleanup/old upper interval<1.
3. old/main lower interval>1.02, reproducing the historical material loss.

Both ARM controls require valid cleanup/main and cleanup/old upper intervals≤1.02. A failed bridge allows only a narrow bounded outcome, not attribution of repair to the original ARM loss. Any invalid/inconclusive control blocks stage2; a later confirmation needs a separately declared reviewed protocol, retaining this result without pooling or replacement. Stage2 controls use the same2% conditions, with reexport additionally requiring cleanup/main upper<1.

Before any pilot, a separate reviewed timing commit must freeze the successful preflight digests, exact compiler artifacts and all subject/protocol files; rerun the supported prerequisites and meaningful protocol tests in CI. It must also revalidate transient Map-expression counts using separate untimed instrumented copies with archived original/instrumented bytes and hashes, and confirm old/cleanup settled topology and lifetime identity. Such instrumentation must never enter the frozen primary package.

Original setup heapUsed/external/arrayBuffers deltas remain descriptive diagnostics. They do not prove retained savings. The cleanup removes one discarded Map per shared attachment,512 at512 arenas; it does not reduce settled topology/Map counts,37 slots or320-byte Arena size. Owned/singleton dependency field feedback widens to mutable/Any. No dense-map priming, unrelated read-cache rewrite, timing-selected variant or local latency run is allowed.

The historical +3.9104% ARM result,95% interval[3.0640%,4.7638%], remains adverse. Separate causal controls changed setup context and cannot replace it. Later Bun/browser and x64 owned/singleton controls remain required before a broad repair claim.
