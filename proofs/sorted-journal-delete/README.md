# Sorted pending-delete study

This prospective study compares an eager native sorted-map deletion with main commit `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. The candidate filters the deleted pending key before folding the remaining updates. It still returns a canonical radix tree, removes an older base version, and preserves the fallback that keeps equal-content session notifications observable. The only production source change is `persistent-core.as.ts`.

The [fixed method](METHOD.md) defines all eleven rows, the primary and controls, admission gates, arena lifecycle, GC and timer checks, process order, resource limits, and independent latency/allocation decisions. The [focused correctness result](CORRECTNESS.md) reports the completed preliminary checks. There is no hosted performance result yet.

The workflow runs on `proof/sorted-journal-delete-screen-20261016` and requires attempt 1. It verifies the exact parent commit, complete baseline inventory, candidate overlay hashes, runtimes, dependencies, and build artifacts. Node is 22.16.0 and Bun is 1.4.2. Both arms run ordinary `bun run prepublishOnly`, `node proofs/node-worker.mjs`, and `node proofs/typed-json-worker.mjs` before any calibration. The added allocation test receives an authenticated `ZEROCOPY_SORTED_DELETE_ARM` value for each aggregate admission.

The entire hosted job has a 55-minute limit. Workflow provisioning and inert harness checks occur before the controller starts. The controller then allows 27 minutes for exact-source and ordinary correctness admission, followed by the separate 870-second study window, including its analysis and cleanup. Provisioning is outside the controller's 27-minute allowance.

The study then runs two baseline calibration children and 36 measurement children, serially, in the fixed six B/C/A orders. Node imports the ordinary fresh `dist/shared.js` build and uses `--expose-gc`; Bun imports matching `shared.ts`. Every batch uses a fresh public compaction and the same explicit GC schedule. The subject retains scalar receipts after each synchronous batch completes. Native payload growth, backing capacity, latency, and cumulative allocation are reported separately.

The controller records exact commands with portable directory labels, source/build/runtime hashes, raw timer and batch observations, cumulative allocation accounting, process cleanup, and fixed analysis. The hosted artifact is public evidence. Original hosted diagnostics may contain verified ephemeral paths to this public checkout and its public dependencies/toolchain. No private archive is claimed. Any future derived public copy must be labeled as derived and retain its original-file hash.

A successful result requires completed evidence finalization and a zero controller exit. A stopped child's completed boundary receipts remain available, with cumulative allocation explicitly marked as a lower bound when unreported unfinished work may exist.

The workflow does not publish a package. A completed study is still subject to its declared control gates, limitations, and later browser/platform and contributor checks. A specific native-allocation reduction does not establish retained-memory savings or an application-wide speedup.
