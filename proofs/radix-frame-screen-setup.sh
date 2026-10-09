#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RUNNER_TEMP/radix-frame-evidence/setup"
cp .github/workflows/radix-frame-screen.yml "$RUNNER_TEMP/radix-frame-evidence/setup/workflow.yml"
node proofs/radix-frame-screen-runner.mjs verify > "$RUNNER_TEMP/radix-frame-evidence/setup/protocol-sha256.txt"
node --version > "$RUNNER_TEMP/radix-frame-evidence/setup/node-version.txt"
bun --version > "$RUNNER_TEMP/radix-frame-evidence/setup/bun-version.txt"
uname -a > "$RUNNER_TEMP/radix-frame-evidence/setup/uname.txt"
lscpu > "$RUNNER_TEMP/radix-frame-evidence/setup/lscpu.txt"
timeout --signal=TERM --kill-after=5s 300s bun install 2>&1 | tee "$RUNNER_TEMP/radix-frame-evidence/setup/install.log"
cp bun.lock "$RUNNER_TEMP/radix-frame-evidence/setup/bun.lock"
bun pm ls --all > "$RUNNER_TEMP/radix-frame-evidence/setup/dependencies.txt"
for role in baseline current helper; do
  case "$role" in
    baseline) commit="$BASELINE_COMMIT" ;;
    current) commit="$CURRENT_COMMIT" ;;
    helper) commit="$HELPER_COMMIT" ;;
  esac
  git worktree add --detach "$RUNNER_TEMP/radix-frame-$role" "$commit"
  ln -s "$GITHUB_WORKSPACE/node_modules" "$RUNNER_TEMP/radix-frame-$role/node_modules"
done
