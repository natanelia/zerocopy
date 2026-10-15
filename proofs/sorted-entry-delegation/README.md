# Natural sorted-entry latency screen

This is a prospective, bounded comparison of complete `SharedSortedMap.entries()` consumption. The baseline is `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`; the only production change in the candidate inlines the existing natural-order loop inside the public generator. Comparator behavior and the helper remain unchanged. No performance result is claimed by these sources.

[The fixed method](METHOD.md) specifies all nine workloads. Complete natural numeric iteration over 4,097 keys is the sole primary. The consumer includes public iterator creation, every yielded item, terminal exhaustion and a scalar checksum. Exact untimed traversal validation occurs before warmed batches and after every batch. First-drain and startup observations stay separate. Partial iteration, allocation savings and application-wide or portable benefit are outside this study.

The source gate passed both typechecks and the same 59 focused cases under Node and Bun in both arms, for 236 case executions. The common regression fixture is copied into the baseline before hosted admission. The hosted plan then requires six ordinary commands: `bun run prepublishOnly`, `node proofs/node-worker.mjs` and `node proofs/typed-json-worker.mjs` in each arm. Aggregate-log guards require all four focused suites during each Bun prepublish check. A failure stops admission and preserves its evidence.

The workflow uses Node 22.16.0 and Bun 1.4.2 with the committed dependency lockfile. Node imports the built public `dist/shared.js`; Bun imports public `shared.ts`. The screen runs at most two baseline calibration children and 36 measurement children, sequentially, with six fixed balanced blocks per engine. Counts, source/build/runtime/dependency identities and every raw batch are retained. No replacement child, post-result tuning or selective exclusion is permitted.

The method's fixed 5% primary confidence-bound criterion must hold in both engines. All eight controls retain their regression vetoes and unresolved diagnostics. Passing this screen supplies only a promising hosted latency lead. It does not replace browser/platform and contributor checks or establish publication readiness.

The inert harness checks can run without importing the library:

```sh
node --test proofs/sorted-entry-delegation/harness.node.mjs
PYTHONDONTWRITEBYTECODE=1 python3 proofs/sorted-entry-delegation/harness_test.py
```

`run.py` admits the exact tracked source overlay before using the fixed screen. It retains stdout/stderr, command and cleanup receipts, partial status on failure, source/build/runtime pins, calibration, all batches and paired-process analysis. Resource sampling is a safety mechanism, not a memory measurement.
