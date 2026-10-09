# Optional text candidate detector: correctness experiment

Pinned baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`. This is an
experimental tree, not an adoption or performance recommendation. No timings,
browser launches, runtime flags, remote changes, or broad platform matrix were
used to prepare it.

## Three arms

1. Baseline: the pinned source with the existing scalar core detector.
2. Scalar auxiliary control: the same lazy auxiliary loading and memory cache as
   the SIMD arm, containing the original scalar detector. Its WASM is byte-for-byte
   equal to an independently compiled original `shared-text-reader.as.ts`.
3. SIMD auxiliary: sixteen first-byte candidates per vector iteration, followed
   by the existing scalar verifier, eight-start SWAR remainder, byte remainder,
   and complete negative-search Unicode fallback. It retains 16-row batching.

`text-aux-reader.as.ts` deliberately copies the original scalar reader so the
mandatory core source and its output remain unchanged. `ASC_FEATURE_SIMD` removes
the vector detector entirely from the scalar control. The SIMD loop's
`pointer + 16 <= end - size + 1` condition is a load bound, not a tuned dispatch
threshold. Vector high bits are accumulated and combined with the unchanged
scalar remainder and tail before deciding whether JavaScript fallback is needed.

The public API, query eligibility, stored bytes, and worker descriptors do not
change. Long, empty, unpaired-surrogate, and ineligible case-folding queries keep
their existing paths. The optional kernel is selected only on the first valid
short-query block access. An unsupported SIMD probe uses the existing core;
the scalar auxiliary binary is only an experimental control, not a fallback.

`textKernelFor` compiles once per imported module/realm and caches one auxiliary
instance per searched `WebAssembly.Memory`, using a lazily allocated WeakMap.
It never creates another memory. The per-predicate function cache avoids another
WeakMap lookup for each scanned block. A first eligible query on a second memory
still instantiates the auxiliary module. The compiled module stays live for the
module lifetime; instance-cache keys are weak. Actual engine allocation sizes
have not been measured.

## Local results, 2026-10-09

Built with Bun 1.4.2, Node 22.23.3, AssemblyScript 0.28.20, and Binaryen
131.0.0-nightly.20260721 on Linux x64. Reused installed dependencies were checked
against their pinned versions and the existing Bun lockfile. No install occurred.

- Both auxiliary modules import only shared `env.memory`, 2..65536 pages. They
  export the two integer-argument text calls and that imported memory. Generated
  WAT has no start, data segment, globals, stores, atomics, or memory growth/copy/
  fill/init. Instantiation leaves all imported bytes and memory extent unchanged.
- 284,672 direct cases compare exact `0/1/-1` returns against the original core,
  covering 1..16-byte needles, 15/16/17 candidate starts, every alignment modulo
  16, eight-start and byte remainders, Unicode prefixes/tails, and the final
  memory byte. Batch tests compare full 32-bit match/fallback flags for every
  count 1..16, including fallback bit 31 and row arrays at memory's final byte.
- Existing `text-kernel`, `text-batch`, and `text-search` proofs pass all 12 tests
  for each portable auxiliary arm on Node. These include 184,428 seeded Unicode
  comparisons, retained snapshots, and actual worker readers during writer growth.
- Fresh-process activation checks pass for both portable arms on Node, and for
  SIMD portable and source entries on Bun. All modes also pass with the feature
  probe forced false. Import, arena construction, unused queries, empty queries,
  empty lists, invalid indices, and ineligible queries cause no probe, auxiliary
  decoding, compilation, or instance. First valid eligible use causes one probe,
  one module, and one instance. A second query, same-memory shared attachment,
  and writer growth reuse it. Copied and independent memories get new instances.
  Feature-disabled use probes once and never decodes/compiles/instantiates an
  auxiliary module.
- All 12 original WASM outputs compare byte-for-byte with a fresh baseline build,
  including the mandatory core and eight legacy aliases. All 41 original emitted
  declaration files and ordinary public exports are identical. Two new internal
  declarations describe the loader. Type checking passes.
- Eighteen cross-arm shared/copy producer-reader combinations pass 324 predicates.
  The complete initial 131,072-byte arenas and normalized v4 descriptors match.
  Searches and attachments preserve every original byte. Arena IDs are normalized
  only across independent producers; snapshot addresses and data are not.

## Costs are present

| Build | Auxiliary WASM | Embedded base64 | Ordinary entry reachable JS | Per-file gzip sum |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 0 | 0 | 137,992 | 35,758 |
| Scalar auxiliary | 1,104 | 1,472 | 140,448 | 37,109 |
| SIMD auxiliary | 1,417 | 1,892 | 140,868 | 37,289 |

Reachable JS grows by 2,456 bytes for the control and 2,876 bytes for SIMD. Gzip
deltas are 1,351 and 1,531 bytes. These sums compress each reachable file separately;
they are not a network measurement. All emitted JS totals are respectively
227,310, 229,766, and 230,186 bytes. The synchronous portable loader makes the
auxiliary source bytes reachable on ordinary imports even though byte decoding,
compilation, cache allocation, and instantiation are lazy.

The first valid search adds feature validation, loading/decoding, synchronous
compilation, and instance creation. Short strings can pay vector setup without
entering the vector loop. Predicate initialization adds lazy-selection work, and
the block call retains a cached-function check. These costs are deliberately
present in both auxiliary arms. Cold latency, warm throughput, retained engine
allocations, browser behavior, and ARM behavior are unmeasured. No gain follows
from these correctness results, and no length/list-size threshold is proposed.

## Reproduce the bounded checks

Use the pinned tool versions. Commands below assume `node` and `bun` resolve to
them and dependencies have already been installed. The generated `build/` trees,
control binaries, and WAT are experiment evidence, not release artifacts.

```sh
node scripts/build-wasm.mjs
node scripts/build-text-aux-experiment.mjs
bun scripts/build-browser.ts
rm -rf build/text-aux-experiment/simd
cp -a dist build/text-aux-experiment/simd
TEXT_AUX_ARM=scalar bun scripts/build-browser.ts
rm -rf build/text-aux-experiment/scalar
cp -a dist build/text-aux-experiment/scalar
bun scripts/build-browser.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --emitDeclarationOnly --noEmit false --declarationMap false --outDir dist/types
node --test proofs/text-aux-kernel.mjs
```

For each `arm` in `scalar` and `simd`, in a fresh process:

```sh
TEXT_KERNEL_ENTRY="$PWD/text-aux-$arm.wasm" QUERY_PROOF_ENTRY="file://$PWD/build/text-aux-experiment/$arm/shared.js" node --test proofs/text-kernel.mjs proofs/text-batch.mjs proofs/text-search.mjs
QUERY_PROOF_ENTRY="file://$PWD/build/text-aux-experiment/$arm/shared.js" node proofs/text-aux-activation.mjs
TEXT_AUX_FORCE_UNSUPPORTED=1 QUERY_PROOF_ENTRY="file://$PWD/build/text-aux-experiment/$arm/shared.js" node proofs/text-aux-activation.mjs
```

Use `TEXT_AUX_SOURCE=1 QUERY_PROOF_ENTRY="file://$PWD/shared.ts" bun
proofs/text-aux-activation.mjs` for the Bun source loader, with and without
`TEXT_AUX_FORCE_UNSUPPORTED=1`. The Node `node:test` files do not execute directly
with `bun file.mjs`; that invocation was tried and rejected by Bun's runner.
The passing Bun coverage uses the standalone assertion proof, without changing
the repository's prescribed test runner.

Create a separate source copy of the pinned baseline under
`build/text-aux-baseline`, reuse the same dependencies, and run its original
WASM/browser/declaration builds. Then run:

```sh
node proofs/text-aux-build.mjs
node proofs/text-aux-format.mjs "file://$PWD/build/text-aux-baseline/dist/shared.js" "file://$PWD/build/text-aux-experiment/scalar/shared.js" "file://$PWD/build/text-aux-experiment/simd/shared.js"
```

The build inspector records exact hashes, exports, declaration comparisons, and
the static dependency closure of `shared.js`. The format proof checks byte and
descriptor equality and cross-build attachment. There is no timing harness in
this experiment. Before measuring, freeze the proposed workload/access patterns
and cold/no-text controls, pair baseline/control/SIMD with A/A checks, and retain
adverse results. Broad tests, package-release checks, browser gates, and performance
gates have not been claimed as complete.
