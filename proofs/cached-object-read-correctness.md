# Exact-root object-read correctness screen

This experiment changes one four-line branch in Arena.value. When an object or nested value already has an address-cache entry for this exact immutable root, it uses that entry's leaf and the existing decoder.

This is a correctness-only screen. It contains no latency measurement or speed claim. It does not establish performance on any engine or processor.

The runtime candidate contains only arena.ts and cached-object-read.test.ts, based on main3773c6e519c7c0958da13727ed1082f449f3ee25. The proof commit must be its direct child and add exactly the four proof/workflow files. The source guard verifies this structure and hashes every tracked file at both runtime pins.

Both source pins run the same new tests. Baseline expects three address-cache slot probes per exact-root generic hit; the candidate expects one. The probe is scoped to a test and restored in finally. These counts are mechanism evidence, not a latency estimate.

Coverage includes all three map kinds, slot zero, missing leaves, stale and alternating roots, deletion and reinsertion, Unicode aliases, long keys, hash collisions, object/entry/character cache limits, nested descriptors, growth, compaction, and read-only shared/copy attachments. Separate real Node workers test both transports for all three map kinds. Existing supported full Bun tests, built-worker tests, type checks and package checks remain required.

The baseline worktree receives the exact candidate test file before checks. This is the only untracked baseline source addition. Production baseline bytes stay unchanged. Each role runs independently, so a baseline failure cannot hide whether the candidate was attempted.

The workflow triggers only on the first non-forced proof push to the isolated branch, after the pinned runtime commit. It retains partial evidence on failures, with tested sources, version receipts, logs and build outputs in a portable tar.gz plus SHA-256 checksum. It does not merge or deploy.

Remaining work after this screen: independent inspection of results, prior local experiment comparison when the executor is restored, a fixed performance study with primitive/cold/stale-root/cache-pressure controls, and browser/ARM coverage. A passing correctness screen is not a performance clearance.

No dependency lockfile is tracked at these pins. The workflow uses the repository's normal bun install command and retains any generated lockfile and the compiler hash. The two jobs may resolve different transitive dependencies; inspect those receipts before making cross-build comparisons.
