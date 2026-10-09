# Registry attachment diagnostic: prospective protocol

This is a separate proof-only diagnostic of baseline `3773c6e519c7c0958da13727ed1082f449f3ee25` and candidate `ab969f043e44d53f6ba7315c2b818c1a51ce49c9`. Production code, old proofs, their four-quartet protocol, and old evidence are unchanged. The complete machine-readable declaration is [registry-attachment-controls.manifest.json](registry-attachment-controls.manifest.json). Its SHA-256 and every proof input are retained before execution.

## Why this diagnostic exists

The [ab969 push replica](https://github.com/natanelia/zerocopy/actions/runs/37822788650) found a Node x64 single-arena attachment ratio of 1.13175, with pointwise 95% quartet-t interval [1.07404, 1.19257]. Absolute process-median scale was 25.08 → 29.11 μs. All four quartets and both orientations showed the loss. No warmup or measured batch was short. Its maximum same-variant process drift passed the historical 15% bound, so that bound cannot retrospectively reject it.

The separate [PR replica](https://github.com/natanelia/zerocopy/actions/runs/37822796941) was inconclusive at 1.02639 [0.98233, 1.07242]. Original 1229 was also inconclusive at 0.97481 [0.88755, 1.07065]. Both new x64 runs used AMD EPYC 9V74; original 1229 used EPYC 7763. Sources and emitted bundles were identical across these candidate revisions. This does not identify a cause or establish that the loss is noise.

The old harness used separate physical baseline/candidate import paths and independently calibrated process work. Its a2/a1 and b2/b1 values are repeated-process drift checks inside A/B quartets, not separate A/A experiments. This diagnostic addresses those limitations prospectively. It does not adopt a new acceptance criterion for old data, combine runs, replace the adverse result, or claim to resolve architecture/CPU sensitivity by itself.

Before any diagnostic timing, one ARM secondary was added: Node 512-arena warm reads. Original, PR and push point estimates were +3.58%, +5.66% and +6.31%, respectively, with all intervals spanning 1. The sustained direction motivates one bounded check now. Those estimates remain separate and inconclusive.

## Scope, controls, and stopping

- Node 22.23.3 Linux x64: one-arena attachment (primary), 512-arena shared re-export (positive control).
- Node 22.23.3 Linux ARM64: 512-arena warm nested reads (targeted secondary).
- Every case has eight A/B quartets, eight independent baseline A/A quartets, and eight independent candidate A/A quartets: 96 new processes per case. A/A subjects are newly launched; no A/B process is reused as a control.
- Each arm has exactly four ABBA and four BAAB quartets. Seed 2026100809, plus the case's fixed manifest index, determines prospective order. Mode order is shuffled within each quartet. The full schedule is saved before pilots.
- One fixed batch per architecture. No timing-based exclusions, retries, extra quartets, architecture/runtime pooling, or favorable-run selection. Every batch and failed invocation is retained. A hard failure stops the job and retains partial results. A short batch does not stop or replace a sample; it invalidates inference after the fixed run finishes.

## Package, source and toolchain guards

Both variants require the exact original source and emitted-JavaScript digests already verified in the historical replicas. The only baseline/candidate production differences allowed are arena.ts and shared.ts. Guarded tracked bytes are also checked directly against each pinned Git commit. Root WASM hashes must match the historical aggregate. Source guard coverage remains root production/configuration and direct build-script scope, not a universal recursive build graph.

Builds use Bun 1.4.2 and AssemblyScript 0.28.20, with the original build scripts. Every child uses the same hashed Node executable, exact version, architecture, default JIT settings, and only --expose-gc. A clean environment excludes original source paths, variant/role labels, CI metadata, NODE_OPTIONS and persistent compile caches. Arena IDs retain the production Date.now/Math.random behavior; the schedule seed does not override runtime randomness.

Before every child, the entire selected dist tree and byte-identical original package.json are physically copied to one private canonical package directory. The child always starts at the same physical subject.mjs and imports ./dist/shared.js, with the same cwd. There are no variant import paths, symlinks, package-type rewrites, or stale chunks. Content-hashed chunk filenames remain original. Source and complete staged-tree manifests are checked before and after each child. Each role's distribution, original package bytes, guarded source, and all proof files are archived.

## Kernel, fixture and warm work

The original fixture/setup block and three timed loop bodies are byte-for-byte preserved from worker-arena-benchmark.mjs (SHA-256 ee538f455747d6a734922ff952e310ab80e54503b7bb0d2d67e88df518b424df). Protocol tests enforce this. The shared payload, producer lifetime pin, Map instrumentation probes, retained attachment, GC calls and initial nested-read checks are preserved. Imports, file copying, hashing, producer creation, correctness checks and GC are outside the timed interval. Attachment still awaits S.initWorker and consumes root.size; re-export still calls shared getWorkerData and consumes arenas.length; warm reads still traverse the same cyclic nested keys.

Intentional protocol changes: each measured process runs only its focused operation. A re-export or warm-read process therefore does not first run other operations' timed calibration/warmup/sample blocks. All variants receive equal fixed work instead of per-process adaptive calibration. Results describe this prospective setup; they cannot replace the earlier multi-operation process measurements.

Disposable pilots for both variants finish before any measured subjects. Each uses up to eight recorded adaptive calibration batches, targeting 40 ms, then three recorded pilot warmup batches. The faster pilot warmup determines each pilot's prescription. One common iteration count per case is frozen as the maximum prescription across both variants. Prospective caps are 8,192 attachment iterations, 1,000,000 re-exports, or 10,000,000 reads; an inadequate capped pilot fails before measurement rather than silently reducing the floor. These are calibration bounds, not data-driven sample exclusions.

Each measured process runs exactly three warmup batches and seven measured batches at that common count, with no local calibration or extension. Every retained warmup and measured batch must reach the common 20 ms floor. The slow baseline re-export can consequently take much longer than the candidate; work is still identical. Complete pilot records and frozen plans are written and hashed before measurements and verified afterward.

## Inference and interpretation

Every process contributes the median of seven ms/op batch values. Within a quartet, average the two adjacent-pair log(B/A) ratios. Use the geometric mean of eight quartet ratios and a two-sided pointwise 95% Student-t interval, df=7, critical value 2.3646242510102993. Timed batches are not independent inferential units. The eight fresh-process quartets are the sampling units; shared-host temporal dependence remains a limitation. There is no familywise or exact-zero claim.

For A/B: lower CI >1.02 is a material slowdown signal; upper CI ≤1.02 is within the declared relative margin; otherwise inconclusive. Descriptive absolute medians and raw pairs accompany the ratio; ratios of pooled medians are not the estimator.

For either separate A/A arm: a point estimate outside [1/1.02, 1.02] AND a confidence interval excluding 1 is material role drift. It invalidates that case's A/B inference. Any short warmup/measured batch in any of the three arms also invalidates that case's inference. No A/A value is subtracted, divided out, or otherwise used to normalize A/B. All raw numerical intervals remain visible when invalidated. No new across-process drift cutoff silently replaces these rules.

The x64 positive control must have valid inference and an A/B upper bound below 1 to count as confirmed. Until confirmed, x64 primary results cannot support acceptance. Its success does not negate adverse attachment results. All outcomes remain diagnostics requiring review; successful workflow status only means the execution and correctness checks completed.

## Correctness and evidence

Before pilots, both exact builds run the same original worker-arenas, node-worker and typed-json-worker proofs at the neutral package path. These use actual worker_threads, check shared and copied forwarding, repeated attachment, retained old snapshots, cold old leaf access and read-only views. Each focused fixture is also checked without executing a timed kernel. Every measured subject repeats nested-value validation and shared re-export/read-only assertions outside timing. Expected structural counts are count² for the baseline and count for the candidate.

Evidence includes every stdout/stderr, JSON result, command, exit/signal/error, ordinal, role, start time, elapsed setup/process time, complete CPU metadata, load average, OS, Node versions/binary hash/flags, build tools, build/install logs, source guards, full stage manifests, correctness results, pilot history, fixed plans and partial/completed summaries. Subjects synchronously emit start/setup and every completed batch as JSONL outside the timed interval, so earlier completed batches survive a later timeout or failure. Measurement-time memory deltas are setup diagnostics only, not new retained-heap or peak-memory claims. No timing was collected while preparing this protocol.

Run proof-only checks explicitly:

```sh
node --test proofs/worker-arena-source-guard.node.mjs proofs/registry-attachment-tests.node.mjs
```

After separate review/publication authorization, the new push-only workflow runs only on proof/registry-attachment-controls-20261008. It does not trigger standard main/PR CI, dispatch the old workflow, or run a full benchmark matrix. The artifact name includes architecture and the proof commit. The original baseline/candidate commits remain fixed regardless of later proof-only commits.

The runner also supports --correctness-only, which cannot execute pilots or measured kernels and labels its result correctness-completed-no-timings. This mode records the actual local Node version rather than claiming the Node 22.23.3 timing prerequisite was met.
