#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?GitHub runner temporary directory required}"
activation_receipt="$RUNNER_TEMP/scalar-text-screen-activation.json"
SCALAR_TEXT_SCREEN_REVIEWED_TREE="$(node proofs/scalar-text-screen-activation.mjs "$activation_receipt")"
export SCALAR_TEXT_SCREEN_REVIEWED_TREE
test "$(git rev-parse HEAD^{tree})" = "$SCALAR_TEXT_SCREEN_REVIEWED_TREE"
git diff --exit-code HEAD -- .
screen_output="$RUNNER_TEMP/scalar-text-screen"
finish_summary() {
  if test -d "$screen_output"; then
    cp "$activation_receipt" "$screen_output/activation.json"
  fi
  if test -d "$screen_output/timing"; then
    node proofs/scalar-text-screen-summary.mjs "$screen_output"
  fi
}
trap finish_summary EXIT
cp proofs/scalar-text-screen-bun.lock bun.lock
bun install --frozen-lockfile
node proofs/scalar-text-screen-prepare.mjs "$screen_output" "$(command -v bun)"
node proofs/scalar-text-screen-run.mjs run "$screen_output"
