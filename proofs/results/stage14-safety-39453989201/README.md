# Stage 14 evidence and safety: completed hosted validation

20 October 2026. **Evidence publication and targeted safety verification are complete. Performance acceptance is not.**

Tested source commit: `43463d517cc0127ceafb1171b47478c6dc0d2d45`.
[Hosted run 39453989201](https://github.com/natanelia/zerocopy/actions/runs/39453989201) completed with success. All four jobs passed restoration, ten corruption/replay tests, exact rebuilding of six Stage 10/13/14 binaries, and all five targeted safety tests. Every safety job reported 46,112 oracle checks, 1,272 direct fixtures, public snapshot checks enabled, and a maximum fixture arena of 8,650,752 bytes. Node reports zero skipped tests; Bun reports five passed and zero failed tests. The arena bound is not an RSS bound.

| Runtime | Architecture | Job | Outcome |
| --- | --- | --- | --- |
| Node 22.16.0 | x64 | 118735892247 | PASS |
| Node 22.16.0 | ARM64 | 118735891807 | PASS |
| Bun 1.4.2 | x64 | 118735892651 | PASS |
| Bun 1.4.2 | ARM64 | 118735892741 | PASS |

## Permanent logs and verification

`validation.tar.xz` contains the 40 original files extracted from the four uploaded CI artifacts, plus `VERIFIED.json`. Runtime executable hashes, exact source commit, build hashes, test output, and both retained-data replay outputs are included. No log was edited. `VERIFIED.json` binds each original file to its SHA-256 and each source artifact ZIP to GitHub's reported digest.

Archive: 6,496 bytes; SHA-256 `54f0ca0fb29b0676bda411ef099ba531a121cb888b38270c97d871d144a81962`.
This is new tar packaging, not the original artifact ZIP files. Each downloaded ZIP was checked against its GitHub digest before extraction. The original ZIPs expire on 19 November 2026; these committed log bytes do not depend on their continued availability.

| Source artifact | ZIP SHA-256 |
| --- | --- |
| ARM64 Node 12279920589 | `88bbd3b4471093f49e8bfad40daa08adf21ff732bfcb131240fc46233b65c70a` |
| x64 Node 12279418750 | `73fb6cf88e4cc56eab6a544e844334792c9217cbc44fa2ff98c60bcf7722071f` |
| x64 Bun 12278979409 | `c038cb9e5438398b59ba52de37f230c4cfa360c3dc0991e6f13f22bbe5aee7aa` |
| ARM64 Bun 12278864593 | `91a0fcefcfd860f61ab9f0a63e1c0c9df1583d8be1341f20107a8c950fa73f1c` |

Run `python3 proofs/results/stage14-safety-39453989201/verify.py` from the repository root to verify all committed logs without extracting files or running measurements. To reproduce the safety checks, use `proofs/experiments/numeric-depth2-20261018/README.md` and the workflow at the tested source commit. Node and Bun use their explicit test runners.

## Retained setup failures

[Run 39453331252](https://github.com/natanelia/zerocopy/actions/runs/39453331252), at `81d725d`, was rejected before jobs started. Its workflow used the unavailable runner context in job-level environment definitions. Commit `3dc53fb` changed those paths to the supported github.workspace context.

[Run 39453817990](https://github.com/natanelia/zerocopy/actions/runs/39453817990), at `3dc53fb`, passed Node x64 and ARM64. Both Bun jobs stopped before tests because the command invoked the test file as a normal script. Commit `43463d5` invokes `bun test` and `node --test`. The test source and expected coverage did not change. Earlier run records and failed setup artifacts remain on GitHub Actions; their logs are not included in this success-run archive.

No performance cohort was rerun. These were workflow setup repairs and correctness/replay executions, not selection of favorable benchmark samples.

## Review and remaining limits

[CodeRabbit review 6295270502](https://github.com/natanelia/zerocopy/pull/41#issuecomment-6295270502) independently verified all retained Stage 13/14 data and performance decisions. It confirmed complete evidence access and the missing safety paths in the new test source. It did not execute repository scripts and initially left hosted execution unverified because the first workflow was rejected. The completed job results above now supply that execution evidence; they do not imply a later independent reviewer execution.

The complete original 26-file performance evidence is retained under `proofs/experiments/numeric-depth2-20261018/retained.tar.xz.parts`. All 48 original process reports and raw journals remain unchanged. All hosted replay outputs are byte-identical to the original derived reports. Stage 13 remains A/A 3/3 and A/B 0/3. Stage 14 remains A/A 2/3 and A/B 2/3. No below-floor result passed.

Public API checks use the archived JavaScript bundle with exactly one verified SIMD literal replaced. They are not a fresh bundle, browser run, real-worker run, full-suite run or public-API performance test. Cross-runtime correctness does not clear the failed performance controls. No root production file, dependency version, benchmark workload, performance threshold, PR state or shared history was changed by these repairs.
