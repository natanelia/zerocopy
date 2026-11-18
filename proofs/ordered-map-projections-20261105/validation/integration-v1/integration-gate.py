#!/usr/bin/env python3
"""Run a recorded correctness/package gate; acquire the timing lock externally."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root, output = (Path(p).resolve() for p in sys.argv[1:3])
output.mkdir(parents=True, exist_ok=True)
base = "77599337867dbf785a5f0311d34637d0b36678fc"
env = dict(os.environ, npm_config_offline="true", FORCE_COLOR="0", NO_COLOR="1")
def git(*args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def runtime_sources():
    return {p.name: digest(p) for p in sorted(root.glob("*.ts")) if not p.name.endswith(".test.ts")}
commands = [
    ["bun", "run", "build:wasm"],
    ["bun", "run", "build:browser"],
    ["bun", "run", "build:types"],
    ["bun", "run", "typecheck"],
    ["bun", "run", "typecheck:redux"],
    ["bun", "run", "typecheck:values"],
    ["bun", "run", "typecheck:geometry"],
    ["bun", "run", "test"],
    ["node", "proofs/block-traversal-worker-check.mjs"],
    ["node", "proofs/ordered-map-projections-20261105/worker.mjs"],
    ["node", "proofs/tanstack-values-20261105/worker.mjs"],
    ["node", "--test", "proofs/checkpoint-base64-20261105/correctness.mjs"],
    ["node", "--test", "proofs/list-batch-tail-20261105/worker.mjs"],
    ["node", "--test", "proofs/map-values-view/worker.mjs"],
    ["node", "proofs/redux-node.mjs"],
    ["node", "--test", "scripts/check-docs.node.mjs"],
    ["node", "scripts/check-docs.mjs", "--base", base, "--preserve"],
    ["npm", "pack", "--dry-run", "--json"],
    ["bun", "run", "check:package"],
]
manifest = {
    "purpose": "Correctness/package integration only; performance was measured on each standalone candidate.",
    "started": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "base": base,
    "commit": git("rev-parse", "HEAD"),
    "tree": git("rev-parse", "HEAD^{tree}"),
    "runtimeSourceSha256": runtime_sources(),
    "node": subprocess.check_output(["node", "--version"], text=True).strip(),
    "bun": subprocess.check_output(["bun", "--version"], env=env, text=True).strip(),
    "runnerSha256": digest(Path(__file__)),
    "environment": {"npm_config_offline": "true", "timingLock": "perf.lock held by caller"},
    "steps": [],
}
path = output / "integration-manifest.json"
with (output / "integration-validation.txt").open("w") as log:
    for command in commands:
        print(json.dumps({"starting": command}), flush=True)
        log.write("\n$ " + " ".join(command) + "\n")
        log.flush()
        start = time.monotonic()
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
        step = {"command": command, "exitCode": result.returncode, "seconds": time.monotonic() - start}
        manifest["steps"].append(step)
        path.write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps(step), flush=True)
        if result.returncode:
            manifest["status"] = "failed"
            path.write_text(json.dumps(manifest, indent=2) + "\n")
            sys.exit(result.returncode)
assert manifest["runtimeSourceSha256"] == runtime_sources(), "Runtime source changed during verification"
assert manifest["commit"] == git("rev-parse", "HEAD"), "Integration commit changed during verification"
manifest.update(status="passed", finished=datetime.datetime.now(datetime.timezone.utc).isoformat())
manifest["validationLogSha256"] = digest(output / "integration-validation.txt")
path.write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"status": "passed", "steps": len(commands), "commit": manifest["commit"]}), flush=True)
