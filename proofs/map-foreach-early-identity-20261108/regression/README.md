# Map traversal identity before the root import

The initial public-entry experiment combined PR #71's optional `fromFloat64`
numeric factory with baseline Map and then with the original PR #68 Map. Both
runs used Bun 1.4.2 and actual `zerocopy/numeric` and `zerocopy` package exports.
The numeric factory returned a list before `shared-map.ts` initialized. Through
the returned constructor's public inherited `owner()` method, the caller could
install an `Arena.prototype.leaves` hook before importing the root entry.

`original-run.mjs.txt` is the exact original experiment. Its untouched results
are `baseline-map.json` and `map-pr68.json`. Baseline invoked the hook once and
propagated its original error before callbacks. Original PR #68 skipped the
hook and invoked both callbacks because its late module initialization captured
the replacement as the default traversal.

The baseline run used local PR #71 commit
`e12afc54354a371b06e53a356d7d388078b9a755`; the second run replaced only
`shared-map.ts` with original PR #68's source from local commit
`97d09254b2c096c5a40fee8776bafb592b811a30`. Those local trees match the
published PR heads recorded in their original evidence. Each result contains
the exact numeric, Map, Arena and package source hashes. Absolute paths identify
the disposable checkout used for that original experiment.

The repair captures `nativeMapLeaves` in `arena.ts` before an optional entry can
expose an owner. The Map module imports that identity. The native traversal loop
and the custom-iterator fallback are otherwise unchanged.

## Repeat the fixed regression

From the repository root, after building WASM:

```sh
node proofs/map-foreach-early-identity-20261108/integration-check.mjs
```

`BUN_BINARY` can name a Bun executable when it is not on `PATH`. The runner
creates and removes a disposable installed-package tree, copies the current
runtime TypeScript/WASM/package files, and overlays only the checked fixture
`fixtures/numeric-pr71.ts.txt` as `numeric.ts`. The fixture is the reviewed
PR #71 source with SHA-256
`b22d734d47523ca408605971c991b87aa499b6e9f3ec0c0c4ede7d6625cb786d`.
No network, other checkout, or Git history is needed.

The fresh Bun subject uses only the public package entries. It requires the
preinstalled hook to run exactly once, the original exception to propagate, and
zero callbacks before that error. After restoring the hook, it checks ordinary
native traversal against entries. `fixed-map.json` records the passing run,
all copied source/WASM hashes, the fixture hash, and both runner hashes.

These are correctness checks, not timing measurements. The old Map timing
studies remain unchanged in `proofs/map-foreach-20261108`; a new study records
performance of the repaired source separately.
