# Earlier optional-factory validation

The initial optional-entry implementation copied ordinary fixed inputs directly. Its native Arena identities were captured when `zerocopy/numeric` loaded. An isolated load-order review then demonstrated a correctness defect: replacing `Arena.prototype.alloc` before importing the optional module could mutate the source before it was copied.

The following records belong to that **pre-fix implementation**, not the subsequent private-snapshot/scratch design:

- `implementation-validation-results.json` and its unsuffixed build, type, package, documentation, and main-test logs.
- `contract-node.txt` and `contract-bun.txt`, which passed the initial ten contract cases but did not include the failing load order.
- `review-late-import-before.txt`, which preserves the reproduced failure and the old source/bundle/driver identities.
- The initial `shared-graph-comparison.json` and `shared-graph-comparison-final.json` in the parent proof directory. They establish the unchanged shared-entry graph for that build, not the correctness of its import function.

No performance run was made for this pre-fix optional implementation. The separate static-factory worktree and its measurements remain a different candidate.

The replacement snapshots every nonempty input before owner acquisition or target hooks. It retains at most one MiB of reusable scratch and borrows it exclusively. Calls above the limit, or calls that reenter while that buffer is borrowed, use uncached storage. Its destination decision uses the Arena identities captured before optional imports and the current view after allocation. Current regression evidence is explicitly named `contract-scratch-*` and `late-import-contract-*`; the final production-validation summary and logs use the `scratch-final` suffix. Earlier records are preserved and are not presented as testing the replacement design.
