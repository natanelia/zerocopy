"""One fresh hosted cohort; no benchmark logic or local result reuse lives here."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time

BASE = "afdffdcfcbd61013f120de82411c0c4a6b2d1e0e"
PATCH = "44d29c932a4a14b420d382c062dcaa057f2f67813556b158dc57934dba77d0ac"
NODE_HASH = "8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d"
BUN_HASH = "a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c"
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
ROOT = Path(sys.argv[1]).resolve()
START = time.monotonic()
LIMIT = 1500
ENV = {**os.environ, "NODE_OPTIONS": "", "BUN_OPTIONS": ""}
receipts = []
created = False
result = {"cohort": "github-hosted-ubuntu-24.04", "sourceBase": BASE,
          "candidatePatchSha256": PATCH, "complete": False,
          "localTimingSamplesReused": False, "localCalibrationCountsReused": False}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def load(path):
    return json.loads(Path(path).read_text())


def command(label, argv, cwd, cap):
    remaining = LIMIT - (time.monotonic() - START)
    if remaining <= 0:
        raise RuntimeError("Hosted preparation/execution budget exhausted")
    log = ROOT / "logs" / (label + ".log")
    log.parent.mkdir(exist_ok=True)
    started = time.monotonic()
    timed_out = False
    with log.open("xb") as output:
        child = subprocess.Popen([str(x) for x in argv], cwd=cwd, env=ENV,
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait(timeout=min(cap, remaining))
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGKILL)
            code = child.wait(timeout=5)
    leftover = False
    try:
        os.killpg(child.pid, 0)
        leftover = True
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    receipt = {"label": label, "command": [str(x) for x in argv],
               "seconds": time.monotonic() - started, "capSeconds": cap,
               "exitCode": code, "timedOut": timed_out, "leftoverProcessGroup": leftover,
               "logSha256": sha(log)}
    receipts.append(receipt)
    write(ROOT / "command-receipts.json", receipts)
    print(json.dumps({k: receipt[k] for k in ["label", "seconds", "exitCode", "timedOut", "leftoverProcessGroup"]}), flush=True)
    if code or timed_out or leftover:
        raise RuntimeError("Command failed; no retry: " + label)
    return receipt


def source_files(root):
    output = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if rel.parts[0] in {"node_modules", "dist"}:
            continue
        if p.is_symlink():
            raise RuntimeError("Unexpected source symlink: " + str(rel))
        if p.is_file() and not (len(rel.parts) == 1 and p.suffix in {".wasm", ".wat"}):
            output[rel.as_posix()] = sha(p)
    return output


def generated(root):
    files = [p for p in root.iterdir() if p.suffix in {".wasm", ".wat"}]
    files += [p for p in (root / "dist").rglob("*") if p.is_file()]
    return {p.relative_to(root).as_posix(): {"sha256": sha(p), "bytes": p.stat().st_size}
            for p in sorted(files)}


def preserve():
    artifact = ROOT / "artifact"
    artifact.mkdir()
    for name in ["README.md", "SCREEN-PLAN.md", "local-feasibility.json", "candidate.patch",
                 "candidate-files.json", "INPUT-SHA256.json", "run-hosted.py",
                 "screen-controller.mjs", "screen-child.mjs", "draft-workload.mjs"]:
        shutil.copyfile(HERE / name, artifact / name)
    for name in ["logs", "correctness-v1", "baseline-build-v1", "smoke-v1", "screen-v1"]:
        if (ROOT / name).exists():
            shutil.copytree(ROOT / name, artifact / name)
    for name in ["command-receipts.json", "hosted-result.json", "SOURCE-SHA256SUMS",
                 "smoke-release.json", "screen-release.json"]:
        if (ROOT / name).is_file():
            shutil.copyfile(ROOT / name, artifact / name)
    if (ROOT / "screen-preparation" / "PROVENANCE.json").exists():
        shutil.copyfile(ROOT / "screen-preparation" / "PROVENANCE.json", artifact / "PROVENANCE.json")
    for arm in ["baseline", "candidate"]:
        source = ROOT / arm
        if (source / "dist").exists():
            retained = artifact / "retained" / arm
            retained.mkdir(parents=True)
            shutil.copytree(source / "dist", retained / "dist")
            shutil.copyfile(source / "package.json", retained / "package.json")
            for p in source.iterdir():
                if p.is_file() and p.suffix in {".wasm", ".wat"}:
                    shutil.copyfile(p, retained / p.name)
    write(artifact / "ARTIFACT-SHA256.json", {
        p.relative_to(artifact).as_posix(): sha(p) for p in sorted(artifact.rglob("*")) if p.is_file()})


try:
    ROOT.mkdir()  # Refuse to overwrite any earlier cohort.
    created = True
    proof_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    assert subprocess.check_output(["git", "rev-parse", "HEAD^"], cwd=REPO, text=True).strip() == BASE, "Proof must be a direct child of the fixed source baseline"
    assert subprocess.check_output(["git", "rev-parse", BASE + "^{commit}"], cwd=REPO, text=True).strip() == BASE
    result["proofCommit"] = proof_commit
    for name, expected in load(HERE / "INPUT-SHA256.json").items():
        p = HERE / name
        assert not p.is_symlink() and sha(p) == expected, "Public proof input differs: " + name
    assert sha(HERE / "candidate.patch") == PATCH
    node = Path(shutil.which("node")).resolve()
    assert sha(node) == NODE_HASH, "Node executable differs from official pinned binary"
    toolchain = ROOT / "toolchain"
    shutil.copytree(HERE / "toolchain", toolchain)
    npm = node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
    ENV["PATH"] = str(node.parent) + os.pathsep + ENV["PATH"]
    command("locked-dependencies", [node, npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], toolchain, 180)
    bun = (toolchain / "node_modules/@oven/bun-linux-x64/bin/bun").resolve()
    assert sha(bun) == BUN_HASH, "Bun executable differs from official pinned binary"
    ENV["PATH"] = str(bun.parent) + os.pathsep + ENV["PATH"]
    assert subprocess.check_output([node, "--version"], env=ENV, text=True).strip() == "v22.16.0"
    assert subprocess.check_output([bun, "--version"], env=ENV, text=True).strip() == "1.4.2"
    archive = ROOT / "main.tar"
    command("archive-exact-main", ["git", "archive", "--format=tar", BASE, "-o", archive], REPO, 30)
    baseline, candidate = ROOT / "baseline", ROOT / "candidate"
    baseline.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(baseline, filter="data")
    shutil.copytree(baseline, candidate)
    command("apply-fixed-candidate", ["git", "apply", "-p2", HERE / "candidate.patch"], candidate, 30)
    originals = {"baseline": source_files(baseline), "candidate": source_files(candidate)}
    changed = {name for name in set(originals["baseline"]) | set(originals["candidate"])
               if originals["baseline"].get(name) != originals["candidate"].get(name)}
    expected = load(HERE / "candidate-files.json")
    assert changed == set(expected["candidate"]), "Patch exceeds the fixed five-file candidate"
    for arm in ["baseline", "candidate"]:
        for name, digest in expected[arm].items():
            assert originals[arm][name] == digest
        (ROOT / arm / "node_modules").symlink_to(toolchain / "node_modules", target_is_directory=True)
    shutil.copyfile(HERE / "candidate.patch", ROOT / "SOURCE.patch")
    (ROOT / "SOURCE-SHA256SUMS").write_text("".join(
        f"{digest}  {arm}/{name}\n" for arm in ["baseline", "candidate"] for name, digest in expected[arm].items()) + f"{PATCH}  SOURCE.patch\n")

    tsc = toolchain / "node_modules/typescript/bin/tsc"
    builds = [("native-build", 90, [node, "scripts/build-wasm.mjs"]),
              ("portable-build", 60, [bun, "scripts/build-browser.ts"]),
              ("declarations", 60, [node, tsc, "--emitDeclarationOnly", "--noEmit", "false", "--declarationMap", "false", "--outDir", "dist/types"])]
    gates = [("types-main", 60, [node, tsc, "--noEmit"])]
    for kind in ["redux", "typed-values", "geometry", "worker"]:
        gates.append(("types-" + kind, 60, [node, tsc, "--noEmit", "-p", "tsconfig." + kind + ".json"]))
    gates += [("types-values-inexact", 60, [node, tsc, "--noEmit", "-p", "tsconfig.typed-values.json", "--exactOptionalPropertyTypes", "false"]),
              ("full-bun-vitest", 300, [bun, "--bun", "node_modules/vitest/vitest.mjs", "run"]),
              ("focused-node-vitest", 300, [node, "node_modules/vitest/vitest.mjs", "run",
                  "shared-set-insert.test.ts", "shared-set.test.ts", "map-set-index.test.ts",
                  "map-set-path.test.ts", "map-set-utf8.test.ts", "allocation-failure.test.ts", "--maxWorkers=1"]),
              ("real-node-worker", 30, [node, "proofs/node-worker.mjs"]),
              ("redux-node", 30, [node, "proofs/redux-node.mjs"]),
              ("typed-json-worker", 30, [node, "proofs/typed-json-worker.mjs"]),
              ("real-worker-tasks", 60, [node, "--test", "--test-concurrency=1", "--test-timeout=15000", "proofs/worker-tasks.mjs", "proofs/worker-task-lifecycle.node.mjs"]),
              ("packed-package-consumer", 180, [node, "scripts/check-package.mjs"])]
    for arm in ["baseline", "candidate"]:
        folder = ROOT / ("baseline-build-v1" if arm == "baseline" else "correctness-v1")
        folder.mkdir()
        commands = builds + (gates if arm == "candidate" else [])
        write(folder / "plan.json", {"baselineCommit": BASE, "proofCommit": proof_commit,
            "sourcePatchSha256": PATCH, "runnerSha256": sha(__file__),
            "sourceFiles": {(f"candidate/{name}" if arm == "candidate" else name): digest
                            for name, digest in originals[arm].items()},
            "commands": [[label, cap, [str(x) for x in argv]] for label, cap, argv in commands]})
        arm_receipts = []
        for label, cap, argv in commands:
            arm_receipts.append(command(arm + "-" + label, argv, ROOT / arm, cap))
            write(folder / "receipts.json", arm_receipts)
        assert source_files(ROOT / arm) == originals[arm], "Source changed during ordinary gates"
        files = generated(ROOT / arm)
        write(folder / ("generated.json" if arm == "baseline" else "final-generated.json"), files if arm == "baseline" else {
            "native": {k: v for k, v in files.items() if not k.startswith("dist/")},
            "portable": {k: v for k, v in files.items() if k.startswith("dist/")}})
        write(folder / "result.json", {"status": "passed", "commands": len(commands), "sourceFiles": len(originals[arm])})

    preparation = ROOT / "screen-preparation"
    preparation.mkdir()
    harness = ["SCREEN-PLAN.md", "draft-workload.mjs", "screen-child.mjs", "screen-controller.mjs"]
    for name in harness:
        shutil.copyfile(HERE / name, preparation / name)
    pinned_receipts = ["SOURCE-SHA256SUMS"]
    for name in ["baseline-build-v1", "correctness-v1"]:
        pinned_receipts += [p.relative_to(ROOT).as_posix() for p in sorted((ROOT / name).iterdir())]
    pinned_receipts += [p.relative_to(ROOT).as_posix() for p in sorted((ROOT / "logs").iterdir())]
    engines = {name: {"path": str(path), "sha256": sha(path), "bytes": path.stat().st_size}
               for name, path in [("node", node), ("bun", bun)]}
    write(preparation / "PROVENANCE.json", {"receipts": {name: sha(ROOT / name) for name in pinned_receipts},
        "toolchainRoot": str(toolchain), "engines": engines, "toolchainFiles": {
            name: sha(toolchain / name) for name in ["package.json", "package-lock.json", "node_modules/assemblyscript/package.json", "node_modules/assemblyscript/bin/asc.js"]}})
    # Inner immutable controller limits remain 60/300 seconds. Five seconds here
    # allow its deadline cleanup and output sealing, never extra measurements.
    for mode, cap in [("smoke", 65), ("screen", 305)]:
        release = ROOT / (mode + "-release.json")
        write(release, {"protocol": "set-insert-screen-v1", "authorize": mode,
            "baselineCommit": BASE, "sourcePatchSha256": PATCH, "proofCommit": proof_commit,
            "cohort": "github-hosted-ubuntu-24.04", "provenanceSha256": sha(preparation / "PROVENANCE.json"),
            "harness": {name: sha(preparation / name) for name in harness}})
        command(mode, [node, preparation / "screen-controller.mjs", mode, release, ROOT / (mode + "-v1")], ROOT, cap)
        assert load(ROOT / (mode + "-v1") / "study.json")["complete"] is True
    assert time.monotonic() - START <= LIMIT, "Hosted aggregate budget exhausted"
    result["complete"] = True
    result["screenVerdict"] = load(ROOT / "screen-v1/summary.json")["verdict"]
except Exception as error:
    result["error"] = str(error)
finally:
    if created:
        result["seconds"] = time.monotonic() - START
        write(ROOT / "hosted-result.json", result)
        preserve()
    print(json.dumps(result), flush=True)
if not result["complete"]:
    raise SystemExit(1)
