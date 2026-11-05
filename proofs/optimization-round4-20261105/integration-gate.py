#!/usr/bin/env python3
"""Record one combined correctness gate. The caller holds perf.lock."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

root, output = (Path(p).resolve() for p in sys.argv[1:3])
assert not output.exists(), "Use a new output directory"
output.mkdir(parents=True)
base = "77599337867dbf785a5f0311d34637d0b36678fc"
env = dict(os.environ, npm_config_offline="true", FORCE_COLOR="0", NO_COLOR="1")

def git(*args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def sources():
    return {p.name: digest(p) for p in sorted(root.glob("*.ts"))}

assert not git("status", "--porcelain", "--untracked-files=no"), "Freeze tracked inputs first"
for path in (root / "proofs").rglob("*.test.ts"):
    assert not any(word in str(path.relative_to(root)) for word in ("rejected", "superseded", "measured-source", "/archive/")), str(path)

commands = [
    ["bun", "run", "build:wasm"],
    ["bun", "run", "build:browser"],
    ["bun", "run", "build:types"],
    ["bun", "run", "typecheck"],
    ["bun", "run", "typecheck:redux"],
    ["bun", "run", "typecheck:values"],
    ["bun", "run", "typecheck:geometry"],
    ["node", "node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.worker.json"],
    ["bun", "run", "test"],
    ["node", "--test", "--test-concurrency=1", "--test-timeout=15000", "proofs/worker-tasks.mjs", "proofs/worker-task-lifecycle.node.mjs"],
    ["node", "proofs/block-traversal-worker-check.mjs"],
    ["node", "proofs/ordered-map-projections-20261105/worker.mjs"],
    ["node", "proofs/tanstack-values-20261105/worker.mjs"],
    ["node", "--test", "proofs/checkpoint-base64-20261105/correctness.mjs"],
    ["node", "--test", "proofs/list-batch-tail-20261105/worker.mjs"],
    ["node", "--test", "proofs/map-values-view/worker.mjs"],
    ["node", "proofs/sorted-foreach-20261105/worker.mjs"],
    ["node", "proofs/node-worker.mjs"],
    ["node", "proofs/redux-node.mjs"],
    ["node", "proofs/typed-json-worker.mjs"],
    ["node", "proofs/block-callback-20261105/verify.mjs"],
    ["node", "proofs/sorted-foreach-20261105/verify.mjs"],
    ["node", "--test", "scripts/check-docs.node.mjs"],
    ["node", "scripts/check-docs.mjs", "--base", base, "--preserve"],
    ["bun", "run", "check:package"],
]
if len(sys.argv) > 3:
    extra = json.loads(Path(sys.argv[3]).read_text())
    assert all(isinstance(command, list) and all(isinstance(arg, str) for arg in command) for command in extra)
    commands.extend(extra)

manifest = {
    "purpose": "Combined correctness and installed-package validation; no combined performance claim.",
    "started": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "base": base,
    "commit": git("rev-parse", "HEAD"),
    "tree": git("rev-parse", "HEAD^{tree}"),
    "sourceSha256": sources(),
    "node": subprocess.check_output(["node", "--version"], text=True).strip(),
    "bun": subprocess.check_output(["bun", "--version"], env=env, text=True).strip(),
    "runnerSha256": digest(Path(__file__)),
    "environment": {"npm_config_offline": "true", "timingLock": "perf.lock held by caller"},
    "steps": [],
}
record = output / "integration-manifest.json"
log_path = output / "integration-validation.txt"
with log_path.open("w") as log:
    for command in commands:
        print(json.dumps({"starting": command}), flush=True)
        log.write("\n$ " + " ".join(command) + "\n")
        log.flush()
        started = time.monotonic()
        process = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
        step = {"command": command, "exitCode": process.returncode, "seconds": time.monotonic() - started}
        manifest["steps"].append(step)
        record.write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps(step), flush=True)
        if process.returncode:
            manifest["status"] = "failed"
            record.write_text(json.dumps(manifest, indent=2) + "\n")
            sys.exit(process.returncode)
assert manifest["sourceSha256"] == sources(), "Source changed during validation"
assert manifest["commit"] == git("rev-parse", "HEAD"), "Commit changed during validation"
raw = log_path.read_bytes()
clean = re.sub(r"\x1b\[[0-9;]*m", "", raw.decode())
files = re.search(r"Test Files\s+(\d+) passed", clean)
tests = re.search(r"Tests\s+(\d+) passed", clean)
assert files and tests, "Missing default Vitest totals"
manifest.update(status="passed", finished=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    activeFiles=int(files.group(1)), activeTests=int(tests.group(1)), validationLogSha256=hashlib.sha256(raw).hexdigest(),
    portableBuildSha256={p.name: digest(p) for p in sorted((root / "dist").glob("*.js"))},
    wasmSha256={p.name: digest(p) for p in sorted(root.glob("*.wasm"))})
record.write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"status": "passed", "steps": len(commands), "commit": manifest["commit"],
    "activeFiles": manifest["activeFiles"], "activeTests": manifest["activeTests"]}), flush=True)
