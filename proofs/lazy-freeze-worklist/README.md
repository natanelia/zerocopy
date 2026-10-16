# Lazy freezeJSON worklist codec screen

This is a fixed prospective latency screen for the actual object codec in
natanelia/zerocopy main commit `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.
The candidate delays its traversal-array initialization until the first object
child. `Object.values` snapshots, real child `push` calls, LIFO traversal and
parent-before-child freezing remain in the source. See [METHOD.md](METHOD.md)
for the exact corpus, sampling, analysis, limits and decision rules.

The candidate omits the initial dynamic `Array.prototype.pop` lookup/call.
Replacing that operation can make baseline throw or mutate the root while the
candidate proceeds. That expected difference is retained explicitly in
`regressions.mjs`; universal equivalence is not claimed. Inherited array index
setters, snapshots, thrown pushes/getters/freezes, swallowed writes, reentrancy
and later dynamically replaced worklist methods have separate regression cases.

## Three distinct gates

1. Focused source correctness must already have passed on these exact bytes in
   Node 22.16.0 and Bun 1.4.2, including the existing helper/object-codec tests.
   This prerequisite is separate from this screen and is not rerun here.
2. `prepare.py` authenticates the source closure and exact runtime executables,
   then performs two identical non-minified Bun builds and four compiled-bundle
   regression invocations. Its maximum is six children, 30 seconds per child,
   240 seconds overall, 1 GiB sampled owned-group RSS, and at least 2 GiB effective
   available memory. It saves emitted bundles, commands, logs and admission.
   Review those exact outputs and their source diff before creating
   `artifacts/ARTIFACT-SEAL.json`, a flat relative-file SHA-256 inventory of all
   preparation outputs except the seal itself.
3. The hosted workflow consumes the reviewed bundles and seal. `run.py` performs
   the fixed 38-child study with no build, extra validation child or retry. It
   reauthenticates source/runtime/artifact bytes around every child. A fresh
   output directory is mandatory. Its 600-second budget includes analysis and
   cleanup; every failed, partial and adverse result is retained.

The standalone entries export the real `getCodec` and `freezeJSON`; identical
`codec.ts`, `utf8.ts` and `types.ts` bytes are included in both arms. Only
`freeze-json.ts` differs. `source-pins.json` binds all source preparation and
measurement inputs. The compiled artifacts are shared between both engines.

Example preparation command, after source review:

```sh
python3 proofs/lazy-freeze-worklist/prepare.py \
  proofs/lazy-freeze-worklist proofs/lazy-freeze-worklist/artifacts \
  --node /path/to/pinned/node --bun /path/to/pinned/bun
```

The hosted workflow supplies the sealed artifact directory to `run.py`. Runtime
versions alone do not admit execution: their executable SHA-256 hashes must
match `prepare.py`. The workflow uses a distinct proof branch, read-only
repository permissions and no persisted checkout credential. It preserves the
source package and complete or partial study outputs as an artifact.

## Evidence and limits

`subject.mjs` checks all ten fixtures before timing and checks full values,
shape, deep freezing, checksums and unchanged shared bytes after every batch.
Its event stream retains discarded warm-ups and calibration pilots. The timer
contains only the fixed loop, real decode, latest-result assignment and the
predeclared scalar consumption. The controller preserves authenticated complete
row prefixes even after a later failure, so independently valid six-block harm
evidence survives an incomplete study.

`analysis.json` contains all process and block estimates, quality/calibration
flags, A/B and chronological baseline diagnostics, intervals and the fixed
decision. `study.json`, `commands.json`, raw stdout/stderr, specification files,
corpus bindings and `RESULT-SEAL.json` make that result auditable. Public host
provenance is limited to hosted run/job identifiers, OS/architecture/CPU/runtime
and numeric effective-resource data. Child process metadata concerns only the
owned group. No environment dump, hostname or private filesystem metadata is
collected.

A passing screen supports a named direct-codec latency lead only. Collection
integration, contributor checks and production suitability remain separate work.
The RSS guard is a safety ceiling, not a comparative memory measurement.
