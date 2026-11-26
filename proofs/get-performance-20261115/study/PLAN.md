# Standard `.get()` study — fixed measurement plan

No timings were collected while preparing this harness. Track A landed at `1242908762b554e3574365c486d5a6c52d5e568f`; its website workload checkout stays pinned to that commit for every experiment. This study is committed in the separate performance branch before collecting formal before/after evidence. Pilot failures and tooling corrections remain separate from the formal study.

## Tool-only checks

From this study directory, run:

```bash
node --test fixtures.node.mjs archive.node.mjs
```

These check deterministic fixtures, exact-value comparisons and synthetic
archive/summary data. They do not import or execute the ZeroCopy runtime.
Their `.node.mjs` filenames keep them outside the repository's default Vitest
discovery when this directory is copied under `proofs/`.

## What the two measurement paths mean

**Primary browser scores use the exact frozen website workers.** `browser.mjs --mode website` calls the pinned `sampleReadCase(readCase('full-shared-get'), 10000)` and the unchanged legacy `feature-owner.mjs` protocol. Only the served library directory switches between baseline and candidate. Both the owner and its two readers are fresh workers for every sample, with empty reader caches and new module instances. Browser module and Wasm compilation caches may already be warm; no fully cold compiler claim is made. The full-object result records local parallel maximum, both reader times, round-trip time with full result transport, construction, publication, edits, retained results, and the per-sample construction-through-first-answer total. Legacy fingerprint generation remains timed. Its independent reference checks are unchanged. Imported code and worker startup stay separately labelled. No `getView()` variant is measured.

**The supplementary local matrix uses warm code and a fresh read-only attachment.** Node/Bun and optional browser-local cases import the same exact Track A `runReadQuery` or legacy `calculate` functions. Generic fixtures call unchanged `SharedMap.get(key)` or `SharedList.get(index)`. One separate fixture warmup precedes a measured fresh reader. Its decoded-value cache is empty, but JIT-compiled code can be warm. Before the first query, an untimed byte-canary copy touches the published payload without calling collection reads or decoding values. That copy can warm CPU caches; these local cases do not claim CPU-cache-cold memory access. Construction includes resetting a fresh arena; local publication means `getWorkerData({copy:false})` plus `initWorker`, with no worker transport. These measurements explain individual paths and protect general workloads; they do not replace the primary website scores.

## Fixed matrix

- Primary website: full-object `.get()` and unchanged legacy catalog; 10,000 products, 1,000 requested IDs, 910 hits, 90 misses, two parallel readers, 100 edits, retained revision zero.
- Exact catalog local controls: full-object `.get()`, legacy lookup, legacy validation. The latter two are separate local queries, preserving their fingerprint work and output checks.
- Both map and list: shallow objects; depth-48 trees; coordinate arrays; Unicode, escapes and reserved property names; long strings; large records; heterogeneous shapes; permitted JSON scalar roots.
- Independent cache limits: 1,984 versus 2,112 small records, staying below 2 MiB; 128 records with total serialized JSON below versus above 2 MiB, staying below 2,048 entries. The byte number is serialized payload size, not decoded heap.
- Both map and list: number primitives and misses.
- Both map and list: nested `SharedMap<number>` descriptors. Timers capture the ordinary outer `.get()` result; child type, frozen handle and complete child contents are verified afterwards. Construction/edit guardrails include child creation. Descriptor sizes include arena identity, so serialized input size is marked unavailable and arena bytes are reported.
- Every local case: cold unique reads, immediate repeat, 16 captured repeat passes, first edited read, retained read, and mixed old/new roots in a common reader arena. Mixed-root timing is explicitly warm. The local `editMs` guardrail replaces `min(100, fixture size)` records; its actual count is recorded as `edits`. The website cases always replace 100 records.

The Unicode oracle does **not** apply NFC/NFD normalization. Composed and decomposed keys remain distinct; lone UTF-16 surrogates follow UTF-8 replacement behavior. Number primitive checks preserve negative zero. Object expected values follow the existing JSON representation.

## Sequence

1. After Track A lands, pin three full SHAs: baseline runtime, candidate runtime and Track A harness. Rebuild both libraries with the pinned Rust/Bun toolchains. Do not copy one runtime's build over the other.
2. Run a **separate correctness pilot**, using all cases and available engines. Pilot timings are exploratory and never pooled with formal results. Resolve any unsupported engine/API or oracle bug before freezing the final study files. Existing runtime suites still cover nested collection descriptors, collision behavior, growth/reset/compaction, reader isolation, allocation failure and API identity guarantees beyond this fixture matrix.
3. Profile the baseline. Use the sampling-only profile first; optional Arena wrappers provide call counts and inclusive/exclusive diagnostic estimates. They modify the program and cannot establish costs in the uninstrumented program. TextDecoder is deliberately not overridden because doing so changes its fallback selection.
4. Test one runtime hypothesis at a time. Keep rejected code and evidence in separate commits/directories. Commit the chosen candidate before measurements. Record all trials rather than selecting favorable runs.
5. Predetermine **seven fresh baseline/candidate process pairs per runtime/engine**, alternating A/B then B/A. One separate fixture warmup per case/process; one measured fresh-reader sample per case/process. Browser worker cases likewise receive one fresh-worker warmup and one measured fresh-worker sample per process. The seven measured pairs are independent process pairs, not 16 inner repetitions.
6. Run serially on the same host, with no concurrent project builds/benchmarks. Optional `--cpu` pins Node/Bun processes to an allowed core; record it. Browser scheduling remains under the OS. Do not stop early when a favorable result appears.
7. If variation is material, run a separately named **seven-pair identical-build control**, preserving the same matrix and ordering. Never subtract those observations from A/B results. A new candidate needs a new fixed study, not a replacement for selected slow samples.
8. Recompute summaries from saved raw files. Check all seven pairs, correctness, fixture hashes, timer boundaries, construction/publication, primitives, warm reads, saturation, identity observations and memory before describing a gain.

## Commands (after the prerequisites)

```bash
node run.mjs \
  --baseline /absolute/baseline-checkout \
  --candidate /absolute/candidate-checkout \
  --harness /absolute/track-a-checkout \
  --baseline-commit BASELINE_FULL_SHA \
  --candidate-commit CANDIDATE_FULL_SHA \
  --harness-commit TRACK_A_FULL_SHA \
  --runtimes node=/absolute/node,bun=/absolute/bun \
  --pairs 7 --warmups 1 --out /absolute/new-evidence-directory

node browser.mjs --manifest /absolute/new-evidence-directory/manifest.json \
  --browser firefox --mode both --out /absolute/new-firefox-directory

# Use --executable /usr/bin/chromium when deliberately testing that installation.
# Repeat for Chromium and WebKit where available; record unavailable engines.
node summarize.mjs /absolute/new-evidence-directory
node summarize.mjs /absolute/new-firefox-directory

node profile.mjs --repo /absolute/baseline-checkout \
  --harness /absolute/track-a-checkout --case catalog-full-get \
  --iterations 16 --out /absolute/new-profile-directory

# Separate run, for diagnostic stage call counts only:
node profile.mjs --repo /absolute/baseline-checkout \
  --harness /absolute/track-a-checkout --case map-coordinates \
  --instrument true --iterations 16 --out /absolute/new-instrumented-profile-directory
```

## Compact evidence without replacing originals

After creating the summary, archive to a **new** directory:

```bash
node archive.mjs /absolute/new-evidence-directory /absolute/new-archive-directory
node summarize.mjs /absolute/new-archive-directory --verify-only
```

The archiver leaves the source study intact and gzip-compresses raw NDJSON in
the new copy. Manifest, completions, summary, stderr and other metadata retain
their original bytes, including runtime/harness/build hashes and saved medians.
`archive.json` records original and compressed checksums/sizes. Completion
checksums always describe the **uncompressed** bytes. The summarizer accepts
explicit `.jsonl.gz` paths and resolves a retained `.jsonl` completion path to
an adjacent `.jsonl.gz` when needed, gunzips it, then verifies the original
SHA-256 before computing statistics. `--verify-only` reproduces and compares
all saved summary rows without rewriting them. To create another derived
summary, use `--out /absolute/new-summary.json`; existing files are refused.

Freeze these tools before formal studies. Archival is lossless storage only;
it never reruns queries, drops failed records or edits a source/harness hash.

The runner rejects moved commits, tracked source modifications and pre-existing output directories. It records source, Wasm, built-module, fixture and study hashes; full runtime versions; fixed scheduling; every warmup/sample; failures and stderr. Results are NDJSON so earlier records survive a later failure. Browser serving keeps workload assets fixed and switches only the library mount. All browser results name the actual browser version. Summaries verify raw checksums, missing/duplicate cases, exact per-sample totals and paired fixture identity. Incomplete studies stay explicitly incomplete.

## Correctness and memory interpretation

Cold results and immediate repeats are captured before any decoding verification. Afterwards every returned value is compared, including fields, IDs, order, missing values, negative zero and reserved keys. Object graphs must remain deeply frozen. Source arena bytes are checked for reader writes before edits. Current and retained snapshots are checked after edits. Captured cold/repeat identity is recorded without imposing a new identity promise above cache admission limits.

All timed queries retain their outputs. The 16-pass warm batch can therefore temporarily retain uncached decoded objects beyond cache capacity. Peak process RSS includes these outputs, fixture inputs, audit buffers, runtime/JIT state and previous process work. Node/Bun snapshots before construction, after reads, after releasing the query captures and after edits make that cost visible. `maxRSSKiB` is a cumulative process high-water mark, not a per-case increment. Arena used/capacity bytes are recorded separately. Browser `performance.memory`, when present, is a browser-specific estimate; other engines report it unavailable. Portable worker-heap measurements are unavailable. Do not label serialized admission bytes as a JS heap bound or infer browser heap parity from Node.

Descriptive before/after medians and paired ratios are reported separately; ratios of medians need not equal paired ratios. No automatic significance claim is made. Investigate repeated >5% warm regressions, >10% construction/publication or primitive regressions, and material retained/peak-memory growth. A twofold cold-read gain is an aspiration, not a required result or a reason to alter a workload. Report smaller gains and adverse tradeoffs honestly.
