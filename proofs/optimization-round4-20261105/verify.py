#!/usr/bin/env python3
"""Verify saved round-4 evidence only; do not pin future runtime source."""
import hashlib
import json
from pathlib import Path
import re

archive = Path(__file__).resolve().parent
ledger = json.loads((archive / "artifact-manifest.json").read_text())
for item in ledger["files"]:
    path = archive / item["path"]
    raw = path.read_bytes()
    assert len(raw) == item["bytes"], item["path"]
    assert hashlib.sha256(raw).hexdigest() == item["sha256"], item["path"]

manifest = json.loads((archive / "integration-manifest.json").read_text())
raw_log = (archive / "integration-validation.txt").read_bytes()
assert hashlib.sha256(raw_log).hexdigest() == manifest["validationLogSha256"]
assert manifest["status"] == "passed"
assert len(manifest["steps"]) == 25
assert all(step["exitCode"] == 0 for step in manifest["steps"])
assert manifest["activeFiles"] == 60 and manifest["activeTests"] == 1159
assert hashlib.sha256((archive / "integration-gate.py").read_bytes()).hexdigest() == manifest["runnerSha256"]
log = re.sub(r"\x1b\[[0-9;]*m", "", raw_log.decode())
assert re.search(r"Test Files\s+60 passed", log)
assert re.search(r"Tests\s+1159 passed", log)
for step in manifest["steps"]:
    assert "\n$ " + " ".join(step["command"]) + "\n" in log
assert manifest["sourceSha256"] and manifest["portableBuildSha256"] and manifest["wasmSha256"]
assert manifest["purpose"].endswith("no combined performance claim.")
print(json.dumps({"status": "passed", "savedArtifacts": len(ledger["files"]),
    "successfulCommands": 25, "activeUnitFiles": 60, "activeUnitTests": 1159,
    "scope": "Saved evidence only; no comparison with current production source."}))
