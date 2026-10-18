# Numeric scalar two-item experiment — 18 October 2026

**Evidence only. No accepted speed improvement. No production PR or merge.**

## Source identities
- Fixed historical reference: `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`.
- Existing experimental Stage 5 baseline: PR #41 at `e578b26dc1392ca7efdbfebd5c3721b6d4c2fc5e`.
- Stage 5 SIMD: SHA-256 `302d98e7f6d6633d49b27d56f2303b9e8ce91b81922f6a384119a2c399deb3cf`.
- New Stage 10 source: SHA-256 `47e29792cf9129d89e0a9bea6e1b7c5cb5eda23f1aa94a1a6ae021f2baa0750e`; Git blob `df9a4c35a07d7804f7bce004d12d96d52a62dc95`.
- New Stage 10 SIMD: SHA-256 `94c1c2849be996188673cecded3d3107c71b903b4780d7d73c46798d58b7b219`.
- New and existing scalar Wasm: byte-identical SHA-256 `5a5114191016599a916768e6141babe2a3ec265ef00e28389e194177ad821d95`. Built locally with the pinned AssemblyScript 0.28.20 toolkit from the archived comparison input.
- Only the SIMD function for lists of one or two numbers changes. The original sibling-leaf traversal, span kernel for lists of three or more, snapshot layout and public API remain unchanged. The original source is stored verbatim inside this branch, and the proof branch's root `numeric-kernels.as.ts` uses these same bytes.

## Retained negative and partial diagnostics
Stage 8 tried direct span dispatch for all short lists, but the screen was interrupted. Stage 9b tried a two-value scalar path plus a 3–32 value span path. Its original 8M-work/1M-cap A/A size-2 control failed, and the 28-child screen stopped at child 15 with an empty new journal. The separately planned longer-batch follow-up also stopped. These unfavorable results were not removed or pooled with later results.

The complete independent size-2 Stage 9b third diagnostic used four paired A/A blocks and four paired A/B blocks, 7 warm-ups and 21 timed batches per arm, and double-call controls. Direct SIMD ratio 1.1594 (95% CI 1.1171–1.2032); public API ratio 0.9990 (0.9691–1.0298); scalar control ratio 1.0045 (0.9817–1.0280). All nine A/A checks passed in this diagnostic. It did NOT establish a public API speed improvement, Bun or ARM64 results, or full v2 clearance. The nominal 24M work target was capped at 3M calls for size 2: actual timed volume was six million numeric values per arm. Do not confuse the target with executed work.

A separately predeclared size-32/1024 follow-up then completed 20/20 processes with unmodified 0.95/1.05 thresholds and all raw samples: 32 direct SIMD 1.0238 (1.0116–1.0361), **short of the target lower bound >1.05**; 32 public 0.9984 (0.9855–1.0115). Size 1024 direct SIMD 1.0153 (0.9672–1.0658); public 1.0067 (0.9960–1.0175). Every A/A and A/B interval in this targeted cohort passed the 0.95 regression floor. Its 1024 public double-call control measured 0.5016 (0.4908–0.5125). The auditor initially failed because it assumed slow controls had three endpoints, while the fixed plan intentionally had one. The failed audit was retained; the corrected auditor replayed the **same** 20 child reports and raw journals without repeating measurements.

The narrower Stage 10 removes the unconvincing 3–32 dispatch entirely. Its local correctness proof checked **484** range cases over 22 sizes, including invalid bounds and full snapshot bytes. A new size-2 3M-call paired cohort stopped at child 4 due to the execution limit: only 3/32 scheduled children completed; child 4 retained 83 partial warm-up/measurement records. No complete confidence estimate is claimed, and no sample was discarded. Local partial raw data and exact scripts remain in the conversation evidence files, not in this initial Git commit.

## Hosted full-gate run

[Workflow 39112654757](https://github.com/natanelia/zerocopy/actions/runs/39112654757) compares **the exact Stage 10 candidate to the fixed historical baseline**. It runs the unchanged official 63-endpoint version-2 benchmark gate with Node and Bun, A/A and A/B, x64 and ARM64, full tests, worker checks and x64 browsers. Seven warm-ups, 21 samples, four balanced process blocks, unchanged 0.95 floor and >1.05 large-range target are retained. Its results may fail; never substitute the more favorable focused results for the official gate. The GitHub Action retains all raw child journals and exact candidate/source archive as downloadable run artifacts for 30 days, including failures. It does not publish or merge anything.

The hosted workflow has no automatic merge. Keep original PRs #38–#41 open and preserve all unfavorable runs. No dependency update, release, force push or main change.
