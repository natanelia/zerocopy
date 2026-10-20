# Depth-two SIMD experiment: publication recovery

20 October 2026. Evidence only. No performance clearance.

`stage14.as.ts` is the exact retained candidate source (SHA-256 `d825ab4f96c590e9ff9cfca23581ed4f6e4fff8da9ec7c21fc89134ee7d1cb63`). `baseline.as.ts` is the exact Stage 10 comparison source (SHA-256 `47e29792cf9129d89e0a9bea6e1b7c5cb5eda23f1aa94a1a6ae021f2baa0750e`). `numeric-spatial.as.ts` is the unchanged imported source (SHA-256 `79d7788a73e271849c4d87c5c9f8ac0923826a62873a7d2adc46508a63cf4f57`). These are experiment copies. The root production source is unchanged.

## Retained result

The paired Node 22.16.0 x64 screen used four process blocks, seven warm-up rounds and 21 measured rounds. It measured direct Wasm calls, not the public JavaScript API. Each timed round used ABBA or BAAB order. The baseline was Stage 10, not main. The original regression floor is 0.95; the improvement floor is strictly greater than 1.05; the A/A ceiling is 1/0.95.

Stage 14 A/B speedup at 32,768 values was approximately 1.107x (95% interval 1.055–1.162). At 65,536 values it was approximately 1.123x (1.094–1.153). The size-32,768 A/A control failed (lower bound approximately 0.945). The size-1,025 A/B check also failed. Thus the complete screen failed. Do not use the two large-input results as performance approval.

On recovery, both retained Python audit scripts replayed all 48 Stage 13/14 child reports and journals. The regenerated audit JSON hashes match the original reports exactly. No new timing cohort was run. See RECOVERY.md for the original archive identity and audit hashes.

## Scope and remaining evidence

This commit publishes readable Stage 14 and baseline source for review. The complete original raw archives, benchmark drivers, Stage 13 source, binaries and reproduction script remain in the conversation attachment `zerocopy-stage13-stage14-evidence-20261018.zip`, SHA-256 `92ae391f8b57be4faa0c72de4ce3ed3537fa2e9ff7c12deffaf13b0eb7063dc9`. They are not claimed to be committed in this directory yet.

The pinned compiler/input artifact is 12133040881 from run 39116000194 at commit `67ff1669e1855458686d52c7fc2632ec84f5bbd2`, ZIP SHA-256 `d277039330042e483562934f131b3c0c1ec585bf24e4c5e96e0ffc06acbab36a`. Retained Stage 14 SIMD SHA-256 is `f6b02c82ea39c9f9092dc72955faf8aefb370e5747220e237c6baed64c8b7109`. Scalar Wasm SHA-256 is `5a5114191016599a916768e6141babe2a3ec265ef00e28389e194177ad821d95` for both builds.

Bun, ARM64, browser, worker and full public-API validation remain outstanding for Stage 14. Shared-process pairing does not isolate JIT, GC or CPU caches. Historical source and failed samples must not be replaced with a favorable rerun. No production changes, benchmark threshold changes, merges, dependency updates, releases or force-pushes are part of this publication.
