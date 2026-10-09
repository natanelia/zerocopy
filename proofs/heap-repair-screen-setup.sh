#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RUNNER_TEMP/heap-repair-evidence/setup"
cp .github/workflows/heap-repair-screen.yml "$RUNNER_TEMP/heap-repair-evidence/setup/workflow.yml"
node proofs/heap-repair-screen-runner.mjs verify > "$RUNNER_TEMP/heap-repair-evidence/setup/protocol-sha256.txt"
node --version > "$RUNNER_TEMP/heap-repair-evidence/setup/node-version.txt"
bun --version > "$RUNNER_TEMP/heap-repair-evidence/setup/bun-version.txt"
uname -a > "$RUNNER_TEMP/heap-repair-evidence/setup/uname.txt"
lscpu > "$RUNNER_TEMP/heap-repair-evidence/setup/lscpu.txt"
timeout --signal=TERM --kill-after=5s 300s bun install 2>&1 | tee "$RUNNER_TEMP/heap-repair-evidence/setup/install.log"
cp bun.lock "$RUNNER_TEMP/heap-repair-evidence/setup/bun.lock"
bun pm ls --all > "$RUNNER_TEMP/heap-repair-evidence/setup/dependencies.txt"
timeout --signal=TERM --kill-after=5s 600s bunx playwright install --with-deps firefox 2>&1 | tee "$RUNNER_TEMP/heap-repair-evidence/setup/firefox-install.log"
for role in baseline current repair; do
  case "$role" in
    baseline) commit=3773c6e519c7c0958da13727ed1082f449f3ee25 ;;
    current) commit=994c0fc3929f64df6303739c79f71d45252350d9 ;;
    repair) commit=7a32ef7006a34202af7cdf5dccca3e2169abfffe ;;
  esac
  git worktree add --detach "$RUNNER_TEMP/heap-repair-$role" "$commit"
done
