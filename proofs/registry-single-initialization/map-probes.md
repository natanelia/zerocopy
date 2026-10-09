# Untimed registry cleanup probes

Run from the proof checkout that already has TypeScript 5.9.3 installed:

```sh
node path/to/run-map-probes.mjs MAIN_BUILT_ROOT OLD_BUILT_ROOT CLEANUP_BUILT_ROOT NEW_EVIDENCE_OUTPUT
node --test path/to/map-probes.node.mjs
```

The three built roots contain `package.json` and `dist/`. Output must not exist.
The runner exports `runMapProbes(main, old, cleanup, output, options)` as well.
The focused test file deliberately uses `.node.mjs` so ordinary Vitest
discovery does not select it; run it explicitly with `node --test`.
`REGISTRY_TYPESCRIPT_PATH` or `options.typescriptPath` can point to an existing
TypeScript 5.9.3 `lib/typescript.js`; no dependency is downloaded or installed.
The runner uses the calling Node binary and records its executable hash,
versions and architecture. It is written with Node 22 built-in APIs; local
evidence records the actual runtime and must not be relabeled as Node 22.

Run this gate before any timing pilot. `summary.json` has `passed: true` only
after all 54 fresh-process cells, comparisons, and original/archive integrity
checks pass. The runner throws/exits nonzero otherwise. Each child's start,
result or failure JSONL, stderr, exit code and signal are saved. Completed cells
remain available after a later failure. Failed or partial outputs are never
reused or overwritten.

## Separate evidence lanes

- Allocation: instrumented dist copies wrap each AST `new Map` expression with a
  pass-through WeakRef recorder. The original native expression and arguments
  stay intact, and global Map is never replaced. Counting begins after fixture
  preparation and covers one attachment or 512 owned Arena constructors. No
  nested read or cache priming occurs before the settled census. Each call site
  reports evaluated, settled-alive, and discarded counts.
- Topology and lifetime: untouched archived dist checks settled dependency map
  identity, entries, natural sharing, own property names/order/descriptors,
  read-only behavior, reexport, independent attachment isolation, a retained
  nested view's lifetime, collection after releasing it, and compatibility-getter
  materialization for one owner in an independent attachment. Every read and
  assertion is untimed. Inspection does not rewrite dependency Maps or caches.
- Traversal: separate untouched-dist processes temporarily wrap Map.prototype
  set/values to count Arena-valued calls/yields during attachment/reexport.
  These are traversal operations, not allocation counts.
- Heap: separate untouched-dist processes report descriptive process.memoryUsage
  before/after GC with exactly one fresh attachment retained and producer graph
  and payload pinned. No exact byte assertion or memory non-inferiority claim
  is made. Allocation, traversal, settled Map and heap metrics remain separate.

All roles run attachment at 1 and 512 arenas for both shared and copied payloads.
Allocation and topology also run 512 owned Arenas. Natural main attachment may
construct its all-to-all graph; the probes never add dense priming. Old and
cleanup must have identical settled topology/layout/lifetime, a 512 discarded
Map reduction at 512 attachment, and no allocation delta at singleton or owned
controls. Per-process exact counts fail hard. Main is checked against its
natural topology and counts independently.

`ownLayout` reports observable own-property slots, not V8 physical in-object
slots. Historical diagnostics recorded 37 in-object slots and 320-byte Arena
instances on their recorded engine. These probes do not claim or assert that
physical size for Node 22 or any architecture.

## Evidence and integrity

`archives/{main,old,cleanup}/original` contains complete original package/dist
bytes. `instrumented` contains separate complete copies. `instrumentation.json`
records source spans, exact original expressions, inserted wrapper text and
per-file before/after SHA-256 hashes. Both archives have complete manifests.
Only the instrumented copies are edited. Neither the supplied built inputs nor
any primary timing subject is read for instrumentation or changed. The harness
is snapshotted into output and each child runs that snapshot. Input and archive
hashes are rechecked even after failed children.

Runtime Git pin verification remains the enclosing gate's responsibility. This
module measures the exact built bytes provided and records them, rather than
pretending that a label or package.json authenticates a source commit.

The integrated controller records each pending child and its raw paths before launch. Child stdout/stderr go directly to exclusive evidence files; validation reads those files after exit. The shared `run-to-files.mjs` helper preserves already-emitted records if the controller is interrupted.
