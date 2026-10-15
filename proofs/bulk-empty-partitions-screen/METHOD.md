# Prospective public setMany screen

Status: method preparation only, revision 2, 2026-10-14. No driver is implemented; no subject import, build, test, benchmark, network call or publication ran for this preparation. Separate correctness run 38641407273 completed with authenticated artifacts; its independent review is sealing. This document authorizes no execution. The scope is this fixed fresh-process suite, not steady-state throughput or browser performance. Original revision 1 files remain unchanged under v1/.

## Fixed fixture and endpoints

Keys are item:00000 through item:04095, in increasing index order. Numeric seed values are i. Each numeric replacement cell starts with its own 4,096-entry root built by one public setMany; it alternates prebuilt values i+10000 and i+20000, starting with +10000 and continuing the alternation across every chunk. All replacement keys already exist.

Canonical case order and calls-per-chunk planning limits:

| Case | Role / operation | Calibration G0 | Arithmetic Gmax |
|---|---|---:|---:|
| P8 | Primary: replace first 8 numeric records | 256 | 1024 |
| P128 | Primary: replace first 128 numeric records | 16 | 64 |
| Large | Secondary: build 4096 object records from retained empty map | 1 | 2 |
| Dense16 | Control: replace one numeric record per root digit | 128 | 512 |
| Empty | Control: setMany([]) on existing numeric root | 16384 | 1048576 |
| One | Control: replace first numeric record | 1024 | 8192 |
| Four | Control: replace first 4 numeric records | 256 | 2048 |
| Read | Control: one get per operation, fixed 128 hits / 128 misses | 4096 | 1048576 |

Large values have property order {id:i, label:"item-"+i, active:i%2===0}; the same ordinary keys are used. Each call uses the retained empty snapshot, not the preceding populated result. Read keys cycle through first 128 fixture keys followed by absent:00000 through absent:00127. Read index restarts at zero in each chunk. Every other case chains its returned snapshot.

FNV-1a fixture arithmetic: P8 has 1 partition frame / 8 empty digit visits; P128 has 17 / 144 (dense root, sparse second level); Large has 295 / 1704 (root and second level dense). All 4096 full hashes differ. Dense16 uses indexes [4,21,2,5,8,3,6,9,22,7,19,23,0,18,20,1], in digit order; its sole batch frame has no empty digit. No key selection uses timing. The special correctness fixture is not a timing endpoint.

The write timer encloses the entire public setMany call, current-result assignment and one identical integer root sink per operation. This includes deduplication, preparation, native work and snapshot construction. Read timing includes get and an integer sink using 1 for undefined. Inputs and expected answers are prepared outside timers. No hashing, validation, transport calls or memory sampling occurs inside a timed loop.

## Import and startup contract

Freeze and verify the full source inventories plus generated-artifact manifest before execution. The sealed package.json exports select ./dist/shared.js for Node ESM and ./shared.ts for native Bun; the consumer must use dynamic import("zerocopy") from an arm-local package installation. Before measurement, verify resolution targets those exact arm-local paths and reject custom browser/export conditions. No internal-module or raw-WASM substitute is allowed.

Node's dist/shared.js and its imported chunks must be freshly built from that arm's exact core; authenticate the embedded WASM digest and all reachable bundle bytes. Bun's shared.ts loads that arm's persistent-core.wasm through wasm-utils.ts. Source and native-core pins are in SOURCE-PINS.json. Completed correctness run [38641407273](https://github.com/natanelia/zerocopy/actions/runs/38641407273), head d59e3f157c19e051088c1f8996972dce9aa5bb34, now provides authenticated generated outputs and matching embedded cores. Use its authenticated artifact manifest and portable-authentication record, referenced in SOURCE-PINS.json, to verify every selected export/chunk; do not invent new generated pins or assume the source paths alone authenticate built files. Independent correctness review remains a prerequisite while sealing.

Each child starts with no subject imported. Prepare startup inputs, then separately time: (1) awaited dynamic public import; (2) first new SharedMap("number"); (3) that empty snapshot's setMany of the first eight keys with values i. After import, call public configureMemory({maximumBytes:67108864}) outside the timers. Do NOT resetMap before the first constructor: its timer intentionally includes the lazy first arena and instance. Validate empty size/content and populated size 8/content after all three timers; retain both snapshots and their arena.

Before each subsequent case, call public resetMap outside timers, then construct its empty snapshot and seed. resetMap creates a new arena; it is not a heap rewind. All cases start from normal 128 KiB backing and the same 64 MiB maximum. Process-fresh startup does not mean machine-cold filesystem caches. Whole-process time is diagnostic only.

## Exact allocation and calibration rules

Each case uses exactly two warm chunks and four measured chunks of G calls. Seed construction, both warm chunks and all four measured chunks are included in its arena bound. Retain startup and every case arena until child exit; never rewind, pre-grow, compact or dispose a live arena.

SOURCE-PINS.json and FIXTURE.json bind source-derived allocation bounds. Numeric seed heapEnd is bounded by S=2605070 bytes; Large starts at S=65536. Per-call allocation upper bounds D are P8=4974, P128=79374, Large=2653808, Dense16=9934, One=634, Four=2494 bytes. Empty and Read allocate no arena payload.

The simple source bound charges at most eight hash levels times 72 branch bytes per input record, plus numeric staging (44n+14 bytes) or the exact summed object leaf bytes (294512 for Large). It is independent of seed-trie arities and pilot deltas. A successful overlay allocates 12 bytes instead of a branch; a failed overlay allocates nothing; fullBranch traverses old overlays in scratch and allocates one branch, even after repeated replacements. Detailed charging and alignment assumptions are in FIXTURE.json. This deliberately loose bound may force short, unresolved timing endpoints.

Let M=67108864 and H=4194304. For D>0:
Gmemory = largest power of two <= floor((M-H-S)/(6*D)).
Gmax = min(Gmemory, the operation ceiling in FIXTURE.json).
For D=0 use the operation ceiling directly. The table above gives the resulting fixed ceilings. Require S+6*Gmax*D <= M-H. Every observed endpoint delta must be <= calls_since_previous_endpoint*D, and used must be <= S+cumulative_calls*D. Capacity must not exceed max(131072,roundUp65536(used)) for this monotonic allocator. Any bound excess is a correctness/planning stop; never silently revise bounds or counts.

Run exactly four baseline calibration children: Node twice, then Bun twice, with canonical case rotations 0,2,4,6. Each uses its fixed G0 for both warm and all four diagnostic chunks. Candidate data cannot enter planning.

In EVERY calibration and observation child, before subject import, perform the same clock-quantum preflight: take 4096 consecutive monotonic-clock reads and define q_child as the smallest positive adjacent difference. Preserve that child's readings and q_child; stop the screen if no positive difference exists. This preflight also supplies the observation child's startup-resolution checks.

For calibration j, let Tj be the sum of its four diagnostic chunk times in milliseconds and q=q_child from that child's preflight. If all four diagnostic chunks are >= max(1 ms,1000*q), define:
Pj = smallest power of two >= max(G0, G0*40/Tj).
Otherwise define Pj=Gmax and mark calibration_short=true, target_duration_unknown=true.
For each case freeze G=min(Gmax,max(P1,P2,P3,P4)), common to both arms and engines. Save every Tj, q, uncapped Pj, cap reason and final G before candidate timing. A cap below a proposed count must be explicit. Forty milliseconds is a planning target, never an asserted achieved duration or a replacement for observed resolution tests. Noisy/short valid calibrations get no retry. Any validation, allocation, process or resource failure aborts the screen.

## Fixed observation schedule and limits

Run eight paired repetitions per engine: 32 observation children, plus four calibration children. Every child runs two warm and four measured chunks per case, with the frozen G. Within repetition r=0..7, rotate canonical case order left by r identically in both arms. Engine order is Node/Bun for even r and Bun/Node for odd r. For engine index e (Node=0, Bun=1), arm order is baseline/candidate when (r+e) is even and candidate/baseline otherwise.

Children run sequentially. A child cap is 20 seconds wall time and 1 GiB RSS, including startup, setup and validation. Each of nine retained arenas has a 64 MiB maximum: absolute backing ceiling 576 MiB. Fixture-derived live used-byte bounds are tighter and remain visible. The complete screen cap is 36*20+120 preparation+60 reconciliation = 900 seconds. Cap enforcement terminates and records the original child/process group; it never launches a replacement. Missing pairs and unrun endpoints stay visible. No additional repeats, warmup, workload cells or driver variants.

Readiness is assessed separately for each engine/arm/case from its eight children:
- Every measured chunk and the second warm chunk must be >= max(1 ms,1000*q_child); each child's four measured chunks must total >=20 ms.
- Warm-to-measure z = log(M1/W2), using equal operation counts.
- Measured stability z = log((M1+M2)/(M3+M4)).
For each of the two z series, its 90% two-sided mean interval must be entirely within [log(0.95),log(1.05)]. With n=8 and df=7, use mean +/- 1.894578605061305*s/sqrt(8), where s is sample standard deviation. Both checks must pass in all four engine/arm groups. All warm and measured chunks remain in raw output. Failure means unsettled/unresolved, with no repair by discarding chunks or increasing counts.

These checks constrain conclusions to this prescribed two-warm-chunk fresh-process suite. They do not establish long-run JIT equilibrium. Shared module/JIT/cache history across the eight cells is part of the interpretation and is counterbalanced, not erased.

## Validation, memory and decision rules

Outside timers, record public getWorkerData({map},{copy:false}) descriptors' used bytes and memory.buffer.byteLength before warmup and after every chunk. Preserve seed, warm endpoint, measured midpoint and final snapshots. Validate their full contents/sizes against independent expected maps after timing, including retained old values, untouched entries and misses. Capture and later rehash the published payload prefix [65536,used_before_measuring); scratch below 65536 is excluded from the immutability assertion. Save deterministic root, used, capacity, payload and full-linear-memory endpoint digests before post-timing semantic reads.

Compare corresponding arm endpoints under identical calls. Any root, used, capacity or byte divergence stops as correctness failure. Growth time stays inside operation timing. Report pages added and timed chunks crossing capacity; do not infer exact memory.grow event counts from chunk endpoints. There is no memory-saving claim.

For each observed endpoint, use one time/op per child: total four measured durations divided by 4G. Let x_r=log(candidate/baseline) for eight paired children. Report exp(mean(x)) and analytic t bounds from s/sqrt(8), retaining every pair. No bootstrap, resampling, outlier removal, replacement or effect-driven recalibration.

- primaryQualified: the SAME P8 or P128 passes all resolution/readiness checks and has one-sided 97.5% upper ratio <=0.90 in BOTH engines. Use t_0.975,7=2.3646242515927844. The two predeclared primary opportunities use this conservative multiplicity allowance.
- regressionVeto: any measured primary, control, large-build or startup endpoint with eight complete pairs has one-sided 95% lower ratio >1.02. Use t_0.95,7=1.894578605061305. A quality flag does not erase this conservative veto; short/noisy one-shot timing alone is not causal evidence of a stable regression. Incomplete endpoints have no substituted interval and remain unresolved.
- guardsClear: every remaining endpoint in both engines has point ratio <=1.00 AND one-sided 95% upper ratio <=1.02, plus its resolution/readiness checks. This includes the nonqualifying primary and all secondary/control/startup endpoints. A point-adverse, short, unsettled or noisy guard remains explicitly unresolved.
- Each startup phase has eight observation pairs per engine and the same analytic bounds, but no within-process warm/stability claim. Require each measured phase >=max(1 ms,1000*q_child); shorter phases remain descriptive/unresolved. Calibration startup data cannot augment observation pairs.
- Report primaryQualified, regressionVeto and guardsClear separately. primaryQualified=true with regressionVeto=false can justify ONE separately reviewed follow-on validation even if guardsClear=false. List all unresolved controls beside that decision. This is not promotion, no-regression clearance, publication approval or a general performance claim. Do not enlarge this study to settle startup.

Retain all raw startup/warm/measured durations, counts, order, clock summaries, sink values, memory endpoints, validation digests, source/runtime manifests, stdout/stderr and terminal statuses. Separate calibration from observations. Eight process pairs may leave 2% controls unresolved; that is an acceptable bounded-screen outcome.

## Evidence and limits

Main is afdffdcfcbd61013f120de82411c0c4a6b2d1e0e. Candidate runtime SHA-256 is eacf630af6466cf4a8bfaa8eadaf32f155fa027a41dd2a2d69965662b7d9caec; baseline is baa5d5a7682af2738a216566d3a8b61ee8f298e3abb61e34eb597d3ae277f976. Native outputs remain 26180/26191 bytes and the completed correctness run reproduces their prior hashes. Its AUTHENTICATION.json SHA-256 is ef9b6442096c005ae79f0c2ca61b8df6850be74338c0c16704b7f646adfd4b9b; independent correctness review is sealing. This status update changes no performance endpoint, count, source, allocation bound or statistical rule.

Source evidence: shared-map.ts setMany; arena.ts bulk/leaf; memory.ts public limits; persistent-core.as.ts batchAt, branch, replaceChild, fullBranch and mergeHashed; package.json exports; scripts/build-browser.ts embedding. CONTRIBUTING.md was read. No applicable AGENTS.md was present in checked ancestry. Historical holds were read; held implementations and proof payloads were not opened.
