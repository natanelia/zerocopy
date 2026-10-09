#!/usr/bin/env bash
set -euo pipefail
task_root="$PWD"
screen_out="$RUNNER_TEMP/text-screen"
mkdir -p "$screen_out/logs" "$screen_out/base"
git diff --exit-code HEAD -- .
node proofs/text-screen-summary-check.mjs > "$screen_out/logs/synthetic-summary-check.log" 2>&1
git archive ad2a19d65a836985a2364b181bc9bd8dce6e42ad | tar -x -C "$screen_out/base"
ln -s "$task_root/node_modules" "$screen_out/base/node_modules"
node scripts/build-wasm.mjs > "$screen_out/logs/candidate-wasm.log" 2>&1
node scripts/build-text-aux-experiment.mjs > "$screen_out/logs/aux-wasm.log" 2>&1
bun scripts/build-browser.ts > "$screen_out/logs/simd-build.log" 2>&1
cp -a dist "$screen_out/simd-built"
TEXT_AUX_ARM=scalar bun scripts/build-browser.ts > "$screen_out/logs/scalar-build.log" 2>&1
cp -a dist "$screen_out/scalar-built"
(
  cd "$screen_out/base"
  node scripts/build-wasm.mjs > "$screen_out/logs/base-wasm.log" 2>&1
  bun scripts/build-browser.ts > "$screen_out/logs/base-build.log" 2>&1
)
node node_modules/typescript/bin/tsc --noEmit > "$screen_out/logs/typecheck.log" 2>&1
node proofs/text-screen-stage.mjs "$screen_out" "$screen_out/base" "$screen_out/scalar-built" "$screen_out/simd-built" "$(command -v bun)" > "$screen_out/logs/inventory.json"
node --test proofs/text-aux-kernel.mjs > "$screen_out/logs/differential.log" 2>&1
for arm in A0 B0 C0; do
  kernel="$task_root/persistent-core.wasm"
  if [[ "$arm" = B0 ]]; then kernel="$task_root/text-aux-scalar.wasm"; fi
  if [[ "$arm" = C0 ]]; then kernel="$task_root/text-aux-simd.wasm"; fi
  TEXT_KERNEL_ENTRY="$kernel" QUERY_PROOF_ENTRY="file://$screen_out/runtime/$arm/shared.js" node --test proofs/text-kernel.mjs proofs/text-batch.mjs proofs/text-search.mjs > "$screen_out/logs/$arm-existing.log" 2>&1
done
for arm in B0 C0; do
  QUERY_PROOF_ENTRY="file://$screen_out/runtime/$arm/shared.js" node proofs/text-aux-activation.mjs > "$screen_out/logs/$arm-activation.json"
  TEXT_AUX_FORCE_UNSUPPORTED=1 QUERY_PROOF_ENTRY="file://$screen_out/runtime/$arm/shared.js" node proofs/text-aux-activation.mjs > "$screen_out/logs/$arm-unsupported.json"
done
node proofs/text-aux-format.mjs "file://$screen_out/runtime/A0/shared.js" "file://$screen_out/runtime/B0/shared.js" "file://$screen_out/runtime/C0/shared.js" > "$screen_out/logs/format.json"
node proofs/text-screen-run.mjs check "$screen_out" > "$screen_out/logs/cases.json"
mkdir "$screen_out/binaries"
cp persistent-core.wasm text-aux-scalar.wasm text-aux-simd.wasm text-aux-scalar.wat text-aux-simd.wat "$screen_out/binaries/"
# Only the reviewed dedicated branch push or explicit workflow dispatch activates timing.
TEXT_SCREEN_REVIEWED_TREE="$(git rev-parse HEAD^{tree})" node proofs/text-screen-run.mjs run "$screen_out"
