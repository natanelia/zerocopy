# Ordinary `.get()` stage profiler — diagnostic tooling

This directory is scratch preparation for Track B. **No profile has been run.**
Only execute it after the benchmark integration lands and its exact harness
revision has been pinned.

The tooling copies production TypeScript/Wasm into a new directory, injects
source-level timers and counters, and optionally builds that separate copy.
It never edits the input checkout, installs prototype wrappers, or replaces
`TextDecoder`, `JSON.parse`, or `Object.freeze`. It preserves the native parse
and original freeze algorithm. The copy is diagnostic code, not a candidate
optimization.

## Prepare and build

Use a clean source checkout and a clean, pinned harness checkout. They can be
the same directory. The original four Wasm binaries are reused and hashed;
there is no new Rust compilation.

When copying the tooling into the performance branch, place this directory
beside the ordinary-get study, for example as `stage-profile/` and `study/`
inside one proof directory. The following commands run from that shared proof
directory. Every CLI path resolves from the shell's current directory;
`--fixtures ./study` must point to the directory containing `fixtures.mjs` and
`study-core.mjs`, not the repository root or `website/assets`.

```sh
node stage-profile/prepare.mjs \
  --repo /absolute/path/to/pinned-source \
  --harness /absolute/path/to/pinned-harness \
  --out /absolute/path/to/new-instrumented-copy \
  --build \
  --bun /absolute/path/to/bun
```

Omit `--build` to prepare source only. The command rejects an existing output
directory and fails if any source instrumentation anchor has changed. An
explicit `--allow-dirty` permits a diagnostic candidate tree, while retaining
its dirty status and file hashes in the manifest.

## Run diagnostic queries

The companion ordinary-get study supplies representative fixtures. Its
directory is explicit so the profiler does not invent a second fixture set.

```sh
node stage-profile/run.mjs \
  --repo /absolute/path/to/new-instrumented-copy \
  --harness /absolute/path/to/pinned-harness \
  --fixtures ./study \
  --out /absolute/path/to/new-stage-profile.json \
  --iterations 4
```

Before copying, the equivalent scratch invocation from the current workspace
is `node get-profile-draft/run.mjs ... --fixtures ./performance-harness-draft`.
Use the committed study path after landing so the recorded fixture hashes
refer to the reviewed version.

`--cases` accepts comma-separated IDs from the companion `fixtures.mjs`.
Defaults include the exact website full-object and legacy lookup/validation
queries, map/list shallow/deep/coordinate fixtures, and independent cache
entry/byte saturation cases. Node and Bun can execute the same portable build;
record them in separate output files. Output files may not already exist.

Every profile iteration attaches a fresh read-only reader. Counters are reset
**after** construction and attachment, immediately before first access. First
and immediate repeat results are both captured before any oracle or freeze
verification. Published bytes are checked afterward. Query output is retained
and verified, so no requested object materialization is discarded.

The pre-query byte canary hashes the published memory without reading the
collections. It can warm CPU data caches, so “cold” means empty decoded-value
caches, not untouched physical memory. Compilation/JIT state can also be warm.
Nested-descriptor cases use the companion study's `buildOwner` and verify
reconstructed child types/values only after first and repeat timers finish.

## Reading the output

- `api.SharedMap.get` and `api.SharedList.get`: complete instrumented API calls.
- `arena.valueDispatchInclusive` and `arena.leafValueInclusive`: complete map
  dispatch and leaf-header/typed-value paths, including their nested stages.
- `lookup.keyHashAndEncoding`: actual cold key hashing/encoding work.
- `lookup.prefixAndWasmCandidate`: prefix reuse, directory setup and candidate
  traversal; full key verification is separate.
- `memory.refresh`: current-view checks; `memory.viewRebuilds` counts changes.
- `cache.*`: object, primitive and leaf-slot probes; decoded admission; key
  admission/confirmation. Separate hit/miss counts identify warm-cache paths.
- `json.nativeParse`, `json.descriptor`, `json.nestedFactory`: the real native
  parser, descriptor decision and nested reconstruction, respectively.
- `utf8.*`: UTF-8 handling and any actual fallback copy work, including bytes.
- `utf8.decoderCallInclusive`: the original decoder invocation. The uncommon
  overridden-decoder fallback retains its defensive copy inside this stage.
- `freeze.traversalInclusive` and `freeze.nativeObjectFreeze`: full freezing
  and nested individual native freezes. Counts record arrays, objects and
  traversed element/property counts.
- `freeze.objectValues`: the original per-object enumeration/array allocation.

**Stage timers overlap. Never add them together.** Their purpose is to locate
work and reveal how many times it runs. Per-call clocks, counter updates,
additional locals and `try/finally` blocks change JIT optimization, allocation
and runtime costs. Even a stage with zero observed milliseconds may have real
cost below timer resolution.

The output includes a parent-stage map and explicit coverage limits. All
reported stage times are **inclusive**, meaning they include nested measured
work. There is no exclusive-time estimate. Unlisted branches, bookkeeping,
result assembly and legacy fingerprints are still present in the complete
query/API totals; do not assign that remainder to one operation or subtract
unrelated medians to estimate it.

Do not infer a stage cost by subtracting medians. Do not use these elapsed
times as before/after evidence. Once the profile suggests a hypothesis, prove
it with fresh, alternating, uninstrumented runs of the unchanged fixed study.

The runner measures local calls, without worker request/reply transport.
Catalog fixtures and query functions come directly from the pinned website
harness. Supplementary fixtures come from the pinned ordinary-get study.
Source/build/harness/fixture hashes and runtime versions remain in the output,
along with failures and partial stage observations.
