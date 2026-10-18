# Retained-data replay repair — 18 October 2026

## Status

The hosted diagnostic completed in [run 39103580864](https://github.com/natanelia/zerocopy/actions/runs/39103580864). Commit `b7f5a0604b78b5fb6db562ed6d674d2380da20e5` preserves its full raw records, readable measurement source and exact fixed input ZIP in this evidence branch. A successful evidence workflow is NOT performance clearance.

No production file, dependency version, original version-2 threshold or measured sample changed. No measurement was repeated for this repair. All performance PRs remain open and uncleared.

## Independent review and repairs

[CodeRabbit review](https://github.com/natanelia/zerocopy/pull/40#issuecomment-6246514632) identified two gaps in the first diagnostic replay. Four internally consistent size-2 reports could replace size-1024 reports without rejection. Also, the separate-process cohort runtime was only compared within its own cohort, not against the paired runtime and intended environment.

The replacement replay binds every paired report to its scheduled size, block and kind BEFORE grouping. Separate-process records must match Node 22.16.0, x64 and the paired cohort's V8 and CPU metadata. Paired records must match the planned binary hash, executable path and empty runtime flags across every cohort. The full schedule is independently reconstructed. Build manifests are anchored to a canonical digest independently derived from the fixed input ZIP, rather than merely trusting matching child and plan claims.

Both the Node and Python implementations reject coordinated cross-size substitutions, whole-cohort runtime substitutions and changed build identities. The new suite has 18 tests. It passed against both the local and hosted retained datasets. These are replay tests; they do not run benchmark operations. The 34 existing PR #40 harness tests also passed locally before this repair.

## Replayed results — failures remain failures

Each environment contains 88 completed processes: 76 for method 1 and 12 for method 2. Replaying BOTH independent environments covers 176 processes, 43,008 measured arm-batches and 14,336 warm-up arm-batches. The two replay implementations agree on all 202 endpoint summaries. Local and hosted performance estimates are NOT pooled.

The HOSTED method-1 separate-process A/A control passed 20/27 confidence checks. Paired A/A passed 25/27; the two larger sizes passed all 18 checks, but the tiny-input controls still failed two checks. Paired A/B passed 25/27 confidence checks.

The HOSTED method-2 fixed fourfold-batch follow-up passed all 9/9 tiny-input A/A confidence checks. A/B passed 8/9. The remaining failure is direct SIMD range counting at size 2: speedup **0.961642**, 95% interval **0.937351–0.986562**. The lower bound is below the unchanged 0.95 floor. The pass flag remains false. The deliberately slower double-call control also remains correctly rejected: 0.504790, interval 0.499508–0.510127.

For context only, the HOSTED method-1 public range estimates were 1.331753x at size 1024 (1.293621–1.371009) and 1.406542x at size 32768 (1.364621–1.449750). They do not override the failed controls or the small-input confidence failure. Earlier local estimates were different; both datasets remain retained.

## Honest identity limit

The first diagnostic's 48 separate-process reports per environment contain runtime family/version/architecture/CPU metadata and a controller plan with whole-run binary checks. They do NOT contain a per-child binary attestation. Replay cannot create that missing historical evidence. The new report explicitly counts those missing attestations and states the limit. The runtime metadata substitution gap is closed; full per-child binary identity for those historical separate-process records is not claimed. Any new timing controller should capture binary identity before and after each child.

## Immutable evidence and reproduction

Hosted artifact 12127985337: SHA-256 `9d5041b7627237af6311e26fbe0f242181160b3cd4f36c44c7ebb3530d2f0c67`.
Committed hosted raw archive, `../runs/39103580864/raw.tar.xz`: SHA-256 `7afbdb14c8c75f812e085e82c742d5c72af35d014f4545a84a07c85c7a04f51d`.
Committed fixed input ZIP, `../inputs/numeric-tree-X64-d16d82c9.zip`: SHA-256 `c47098bfa2c34c916b058fd38b3178dc85289b68b69141c88afeeea90ef837fb`.
Replay source archive: SHA-256 `e6297698d1697f4669b8c16aee48083bcdc546a8b982c7c229ca5c3949bbb6d8`.
Canonical build-manifest digest: `3f49dd934a3950240a09a0765b27716151f860cb7288dd3a1d1ed8687bb910d4`.

The local full raw archive remains the conversation attachment named in the parent report; it is not misrepresented as the hosted dataset. No unfavorable record is deleted or substituted.

Extract the sealed replay source and hosted raw archive into new directories. Obtain `proofs/numeric-tree-process.mjs` from `candidate-source.tar` inside the fixed input ZIP. The verifier checks its exact SHA-256 before importing it.

```sh
sha256sum -c replay-source.sha256
mkdir replay-source retained
tar -xJf replay-source.tar.xz -C replay-source
tar -xJf ../runs/39103580864/raw.tar.xz -C retained
node replay-source/verify-retained.mjs retained/pairing /absolute/path/to/proofs/numeric-tree-process.mjs method1.json
python3 replay-source/verify-retained.py retained/pairing method1.json method1-independent.json
node replay-source/verify-retained.mjs retained/pairing-longbatch /absolute/path/to/proofs/numeric-tree-process.mjs method2.json
python3 replay-source/verify-retained.py retained/pairing-longbatch method2.json method2-independent.json
EVIDENCE_STAGE="$PWD/retained/pairing" ORIGINAL_DRIVER=/absolute/path/to/proofs/numeric-tree-process.mjs node --test replay-source/verify-retained.test.mjs
```

The separate retained-replay workflow verifies all input seals, runs these tests and both auditors, and checks that every retained input file is unchanged. It saves replay reports and readable source in Git without a force push. Its path filter does not start the measurement workflow. Check its actual completion status; this report does not predeclare a hosted replay pass.

## Remaining blocker

Pairing plus longer fixed batches is promising for the selected A/A controls on two Node x64 hosts. The candidate still fails the size-2 SIMD confidence floor. Full 63-endpoint coverage, Bun, ARM64, small-loss calibration and review of a new acceptance method remain outstanding. The original acceptance gates stay unchanged. No new production PR is justified by this screen.
