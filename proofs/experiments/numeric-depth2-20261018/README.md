# Stage 13/14: complete evidence and targeted safety repair

20 October 2026. **Evidence and validation only. Neither candidate has performance clearance.** Root production files and all acceptance thresholds remain unchanged.

## Complete retained evidence

`retained.tar.xz.parts/01` through `11` contain all 26 original evidence files, including both raw archives, all 48 child reports and journals, benchmark drivers, source, binaries, and original reproduction/audit scripts. The files inside the archive retain their original bytes. The split archive is 62,572 bytes; SHA-256 `5ef478ea767ca458ab81f3473bbe22775cb9ad035bf5ac04f3810f4428f90e56`. It does not depend on a conversation attachment or an expiring Actions artifact.

The original conversation ZIP remains unchanged: SHA-256 `92ae391f8b57be4faa0c72de4ce3ed3537fa2e9ff7c12deffaf13b0eb7063dc9`. The new tar packaging is not the original ZIP. `RECOVERY.md` records the earlier, partial publication; this record supersedes its publication status, not its results.

From the repository root, choose output paths that do not exist:

```sh
P=proofs/experiments/numeric-depth2-20261018
python3 "$P/restore.test.py" -v
python3 "$P/restore.py" /tmp/zerocopy-retained
curl --fail --location 'https://raw.githubusercontent.com/natanelia/zerocopy/b7f5a0604b78b5fb6db562ed6d674d2380da20e5/proofs/experiments/numeric-pairing-20261018/inputs/numeric-tree-X64-d16d82c9.zip' -o /tmp/zerocopy-input.zip
python3 "$P/prepare.py" /tmp/zerocopy-input.zip /tmp/zerocopy-retained /tmp/zerocopy-build
RETAINED_DIR=/tmp/zerocopy-retained MODULE_DIR=/tmp/zerocopy-build/candidate-build node --test "$P/stage14-boundaries.node.mjs"
```

The restore checks every part, archive seal, file length and original manifest hash. It replays both retained audits and requires exact gate flags, raw-derived block ratios and identities. Only the derived exp/log estimates allow at most four floating-point units in the last place for cross-platform replay; this is not a performance margin. Sealed originals are never overwritten. Both local replay outputs are byte-identical. Missing, extra, truncated and changed parts fail. Existing outputs are never overwritten. Ten restore regression tests pass locally.

The compiler input is already preserved in Git at the exact commit above. `prepare.py` verifies ZIP SHA-256 `c47098bfa2c34c916b058fd38b3178dc85289b68b69141c88afeeea90ef837fb`, verifies its AssemblyScript 0.28.20 toolkit and licenses, then rebuilds all six Stage 10/13/14 scalar/SIMD binaries. All six match the original retained bytes locally. No install or dependency update occurs. This new build path avoids reliance on the expiring Stage 10 artifact used by the original reproduction script.

## Confirmed safety-verification gap and repair

The prior poisoned-pointer test had 1,056 tree values, below Stage 14's 2,048-value dispatch threshold. The old exhaustive tail test covered depth one. They did not establish safety for the added depth-two branch.

`stage14-boundaries.node.mjs` adds below/at/above-threshold fixtures, all 32 tail lengths, partial final groups, poisoned unused pointers, memory-end leaf and tail loads, deeper partial subtrees, raw binary64 values, invalid bounds, read-only public attachments, retained forks, and whole-memory comparisons. It pins the Stage 10 SIMD, Stage 14 SIMD and Stage 14 scalar binaries by hash.

Local Node 22.16.0 x64 results: all five tests passed with no skips; 46,112 oracle checks across 1,272 direct fixtures plus public snapshots. The largest fixture arena was 8,650,752 bytes, below the 64 MiB test limit. This is an arena bound, not an RSS bound. The earlier six upstream safety tests also passed locally with 37,855 checks; their log is retained separately.

Public checks use the archived JavaScript bundle with exactly one verified SIMD literal replaced. They are not a fresh Bun build, browser check, real-worker check, full-suite run or public-API performance test. Build logs, new boundary logs and upstream safety logs are in `local-validation/`. The new workflow runs restoration, exact rebuilding and the targeted suite on Node/Bun and x64/ARM64. Its results must be inspected separately; this document does not presume hosted success.

## Failed performance decisions remain failed

The retained direct-Wasm screen compares against Stage 10, not main. It uses four process blocks, seven warm-ups and 21 measured rounds, with ABBA/BAAB timed arms. Regression floor: 0.95. Improvement floor: strictly greater than 1.05. A/A ceiling: 1/0.95. None changed.

Stage 13: A/A 3/3, A/B 0/3. Stage 14: A/A 2/3, A/B 2/3. The failed size-32,768 identical-build control and size-1,025 A/B check remain failures. The two large-input gains do not clear the whole screen. All 4,032 measured arm-batches and 1,344 warm-up arm-batches remain retained. No timing run was repeated for this repair. Source/runtime limitations of these historical records remain unchanged.

No new production PR, merge, release, force-push or performance approval is part of this repair.
