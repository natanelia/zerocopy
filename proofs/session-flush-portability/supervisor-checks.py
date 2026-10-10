#!/usr/bin/env python3
"""Proposed ten-case supervisor preparation gate; source only, never run here.

Future invocation: python3 supervisor-checks.py --output-dir results/supervisor-gate
The cases use bounded synthetic Python children only. They do not import the
candidate, baseline, Playwright, or benchmark modules and take no performance
samples. The frozen suite budget is 48 seconds, plus at most one second to reap
a timed-out launcher and four seconds for bounded synthetic children to expire.
The separate built-in-only writer check has a seven-second budget, making the
combined proposed synthetic gate at most 60 seconds, excluding blocked host I/O.
No execution authorization is implied by this source file.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


COMMAND_BUDGET_SECONDS = 48
LAUNCHER_REAP_SECONDS = 1
FIXTURE_EXPIRY_SECONDS = 4
DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024


COMMON = """import json, os, select, signal, subprocess, sys, time
def emit(value):
    print(json.dumps(value), flush=True)
"""

FIXTURES = {
    "valid-detached-handshake": COMMON + """
grandchild = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(4)'], start_new_session=True)
try:
    emit({'event': 'containment-ready', 'rootPids': [os.getpid(), grandchild.pid]})
    if not select.select([sys.stdin], [], [], 3)[0]:
        raise RuntimeError('bounded fixture did not receive handshake')
    ack = json.loads(sys.stdin.readline())
    if ack.get('event') != 'containment-verified':
        raise RuntimeError('unexpected acknowledgment')
    emit(ack)
finally:
    grandchild.terminate()
    grandchild.wait(timeout=1)
emit({'event': 'ordinary-fixture-complete'})
""",
    "orphaned-detached-child": COMMON + """
grandchild = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(4)'], start_new_session=True)
emit({'event': 'synthetic-start', 'pid': os.getpid(), 'detachedPid': grandchild.pid})
# Deliberately leave a live detached child for the subreaper to own and kill.
""",
    "missing-handshake": COMMON + """
emit({'event': 'synthetic-start'})
""",
    "deadline-partial-output": COMMON + """
emit({'event': 'synthetic-start'})
sys.stdout.write('partial-without-newline')
sys.stdout.flush()
time.sleep(4)
""",
    "injection-environment": COMMON + """
emit({'event': 'environment', 'environment': dict(os.environ)})
""",
    "refuse-output-overwrite": COMMON + """
raise RuntimeError('an overwrite fixture must never launch')
""",
    "stdout-overflow": COMMON + """
signal.alarm(4)
block = bytes(range(256)) * 256
for unused in range(129):
    pending = memoryview(block)
    while pending:
        pending = pending[os.write(1, pending):]
time.sleep(4)
""",
    "stderr-overflow": COMMON + """
signal.alarm(4)
block = bytes(range(256)) * 256
for unused in range(129):
    pending = memoryview(block)
    while pending:
        pending = pending[os.write(2, pending):]
time.sleep(4)
""",
    "unowned-root-rejection": COMMON + """
signal.alarm(4)
emit({'event': 'containment-ready', 'rootPids': [os.getpid(), int(sys.argv[1])]})
if select.select([sys.stdin], [], [], 3)[0]:
    received = sys.stdin.readline()
    if received:
        emit({'event': 'unexpected-ack', 'data': received})
time.sleep(4)
""",
    "signal-abort-detached-escalation": COMMON + """
signal.alarm(4)
detached_source = '''import os, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.alarm(4)
os.write(int(sys.argv[1]), b'ready')
os.close(int(sys.argv[1]))
time.sleep(4)
'''
ready_read, ready_write = os.pipe()
grandchild = subprocess.Popen([sys.executable, '-I', '-c', detached_source, str(ready_write)],
                             start_new_session=True, pass_fds=(ready_write,))
os.close(ready_write)
try:
    if not select.select([ready_read], [], [], 1)[0] or os.read(ready_read, 5) != b'ready':
        raise RuntimeError('detached signal handler was not ready')
finally:
    os.close(ready_read)
emit({'event': 'abort-ready', 'pid': os.getpid(), 'detachedPid': grandchild.pid})
time.sleep(4)
""",
}


UNRELATED_SENTINEL = """import os, signal, sys, time
from pathlib import Path
signals = Path(sys.argv[1])
signals.write_bytes(b'')
def record_signal(number, frame):
    with signals.open('ab', buffering=0) as target:
        target.write((str(number) + '\\n').encode())
for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(number, record_signal)
signal.alarm(4)
Path(sys.argv[2]).write_text('ready')
time.sleep(4)
"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def json_lines(raw):
    result = []
    for line in raw.splitlines():
        try:
            result.append(json.loads(line))
        except ValueError:
            pass
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    destination = Path(args.output_dir).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    supervisor = Path(__file__).resolve().with_name("supervise.py")
    result = {
        "schema": 1, "state": "failed", "scope": "synthetic-supervisor-preparation-gate",
        "supervisorSHA256": hashlib.sha256(supervisor.read_bytes()).hexdigest(),
        "commandBudgetSeconds": COMMAND_BUDGET_SECONDS,
        "timeoutCleanupBudgetSeconds": LAUNCHER_REAP_SECONDS + FIXTURE_EXPIRY_SECONDS,
        "performanceSamples": 0, "cases": [], "error": None,
    }
    started = time.monotonic()
    deadline = started + COMMAND_BUDGET_SECONDS
    summary_path = destination / "summary.json"
    base_env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL") if key in os.environ}
    base_env["CI"] = "true"
    process = None
    unrelated = None
    try:
        for name, source in FIXTURES.items():
            process = None
            case_dir = destination / name
            case_dir.mkdir()
            fixture = case_dir / "fixture.py"
            fixture.write_text(source)
            stdout = case_dir / "stdout.jsonl"
            stderr = case_dir / "stderr.txt"
            receipt_path = case_dir / "receipt.json"
            case = {"name": name, "state": "failed", "error": None}
            result["cases"].append(case)
            cap = "4.5" if name == "deadline-partial-output" else "5.5"
            if name in ("stdout-overflow", "stderr-overflow"):
                cap = "8.5"
            command = [sys.executable, "-I", str(supervisor), "--cwd", str(case_dir),
                       "--seconds", cap, "--rss-mib", "256", "--output", str(stdout),
                       "--stderr", str(stderr), "--receipt", str(receipt_path)]
            if name in ("valid-detached-handshake", "missing-handshake", "unowned-root-rejection"):
                command.append("--handshake")
            command += ["--", sys.executable, "-I", "-u", str(fixture)]
            environment = dict(base_env)
            if name == "injection-environment":
                environment.update({
                    "NODE_OPTIONS": "--invalid-synthetic-injection",
                    "BUN_OPTIONS": "synthetic-injection",
                    "BUN_JSC_forceGCSlowPaths": "true",
                    "PLAYWRIGHT_DOWNLOAD_HOST": "https://invalid.example.invalid",
                    "PLAYWRIGHT_BROWSERS_PATH": "/synthetic-wrong-browser-cache",
                })
            sentinel = b"existing scientific evidence must remain byte-identical\n"
            if name == "refuse-output-overwrite":
                stdout.write_bytes(sentinel)
            if name == "unowned-root-rejection":
                sentinel_source = case_dir / "sentinel.py"
                sentinel_source.write_text(UNRELATED_SENTINEL)
                sentinel_signals = case_dir / "sentinel-signals.txt"
                sentinel_ready = case_dir / "sentinel-ready.txt"
                with (case_dir / "sentinel.stderr").open("xb") as sentinel_stderr:
                    unrelated = subprocess.Popen(
                        [sys.executable, "-I", str(sentinel_source), str(sentinel_signals), str(sentinel_ready)],
                        env=base_env, stdout=subprocess.DEVNULL, stderr=sentinel_stderr,
                        start_new_session=True,
                    )
                readiness_deadline = min(deadline, time.monotonic() + 1)
                while not sentinel_ready.exists() and unrelated.poll() is None and time.monotonic() < readiness_deadline:
                    time.sleep(0.010)
                require(sentinel_ready.exists() and unrelated.poll() is None, "unrelated sentinel did not become ready")
                case["unrelatedSentinelPid"] = unrelated.pid
                command.append(str(unrelated.pid))
            case["command"] = command
            remaining = deadline - time.monotonic()
            require(remaining > 0, "aggregate 48-second command budget exhausted")
            completed = None
            process = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, start_new_session=True)
            launcher_deadline = min(deadline, time.monotonic() + float(cap) + 0.5)
            try:
                if name == "signal-abort-detached-escalation":
                    abort_deadline = min(launcher_deadline, time.monotonic() + 1)
                    abort_rows = []
                    while process.poll() is None and time.monotonic() < abort_deadline:
                        if stdout.exists():
                            abort_rows = json_lines(stdout.read_bytes())
                            if any(row.get("event") == "abort-ready" for row in abort_rows):
                                break
                        time.sleep(0.010)
                    require(any(row.get("event") == "abort-ready" for row in abort_rows),
                            "detached child was not ready before supervisor abort")
                    process.send_signal(signal.SIGTERM)
                    case["signalSentToSupervisor"] = int(signal.SIGTERM)
                remaining = launcher_deadline - time.monotonic()
                require(remaining > 0, "aggregate or per-command budget exhausted")
                launcher_stdout, launcher_stderr = process.communicate(timeout=remaining)
                completed = process.returncode
            except subprocess.TimeoutExpired as error:
                # This is a failed gate, never a replacement subject. Fixture
                # children have their own <=4-second finite lifetimes even if
                # their supervisor is broken. Terminate the gate command group.
                raise AssertionError("supervisor exceeded the bounded gate command timeout") from error
            (case_dir / "launcher.stdout").write_bytes(launcher_stdout)
            (case_dir / "launcher.stderr").write_bytes(launcher_stderr)
            case["exitCode"] = completed
            if name == "refuse-output-overwrite":
                require(completed != 0, "overwrite was not refused")
                require(stdout.read_bytes() == sentinel, "existing output bytes changed")
                require(not stderr.exists() and not receipt_path.exists(), "overwrite refusal created other artifacts")
                require(b"refusing to overwrite" in launcher_stderr, "overwrite refusal reason missing")
            else:
                require(receipt_path.is_file(), "terminal receipt missing")
                receipt = json.loads(receipt_path.read_text())
                raw = stdout.read_bytes()
                raw_stderr = stderr.read_bytes()
                rows = json_lines(raw)
                require(receipt["schema"] == 1, "wrong receipt schema")
                require(receipt["cleanup"]["confirmedEmpty"], "owned processes remain or containment is unverified")
                require(not receipt["cleanup"]["remainingAfterCleanup"], "leftover descendants recorded")
                require(not receipt["cleanup"]["errors"], "cleanup encountered errors")
                require(receipt["elapsedSeconds"] <= float(cap), "wall cap including cleanup exceeded")
                for kind, retained in (("stdout", raw), ("stderr", raw_stderr)):
                    counts = receipt["output"][kind]
                    require(counts["capBytes"] == DEFAULT_OUTPUT_BYTES, "wrong default stream cap")
                    require(counts["retainedBytes"] == len(retained) <= counts["capBytes"], "retained byte bound or receipt mismatch")
                    require(counts["observedBytes"] == counts["retainedBytes"] + counts["discardedBytes"], "output byte accounting does not reconcile")
                    require(counts["discardedBytes"] >= 0, "negative discarded-byte count")
                    require(counts["truncated"] is (counts["discardedBytes"] > 0), "wrong truncation state")
                require(receipt["stdoutEOF"] and receipt["stderrEOF"], "stream drain was incomplete")
                if name == "valid-detached-handshake":
                    require(completed == 0 and receipt["state"] == "passed", "valid subject did not pass")
                    ack = receipt["handshake"]
                    require(ack and ack["method"] == "linux-subreaper-descendant-census", "containment acknowledgment absent")
                    require(len(ack["roots"]) == 2, "both detached roots were not verified")
                    require(ack["roots"][0]["pgrp"] != ack["roots"][1]["pgrp"], "fixture did not create distinct process groups")
                    require(not receipt["cleanup"]["interventionRequired"], "ordinary fixture required supervisor intervention")
                    require(any(row.get("event") == "ordinary-fixture-complete" for row in rows), "ordinary completion evidence missing")
                elif name == "orphaned-detached-child":
                    require(completed != 0 and receipt["state"] == "failed", "leaked child was accepted")
                    started_row = next(row for row in rows if row.get("event") == "synthetic-start")
                    leaked_pid = started_row["detachedPid"]
                    require(receipt["cleanup"]["interventionRequired"], "orphan cleanup was not recorded")
                    require(any(row["pid"] == leaked_pid for row in receipt["observedProcesses"]), "detached orphan was never observed")
                    require(any(row["pid"] == leaked_pid for row in receipt["cleanup"]["signals"]), "detached orphan was not terminated")
                elif name == "missing-handshake":
                    require(completed != 0 and receipt["state"] == "failed", "missing handshake was accepted")
                    require(receipt["handshake"] is None, "handshake was fabricated")
                    require("handshake" in (receipt["error"] or ""), "missing-handshake reason absent")
                elif name == "deadline-partial-output":
                    require(completed != 0 and receipt["state"] == "failed", "deadline did not fail")
                    require(receipt["limit"] == "wall-time-reserving-cleanup", "wrong deadline limit")
                    require(raw.endswith(b"partial-without-newline"), "partial stdout was changed or lost")
                    require(len(rows) == 1 and rows[0].get("event") == "synthetic-start", "start was lost or completion/duration was invented")
                elif name == "injection-environment":
                    require(completed == 0 and receipt["state"] == "passed", "clean-environment subject did not pass")
                    observed = next(row["environment"] for row in rows if row.get("event") == "environment")
                    allowed = {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "PLAYWRIGHT_BROWSERS_PATH"}
                    require(set(observed) <= allowed, "an inherited injection variable reached the child")
                    expected_cache = str(supervisor.parent / "browser-cache")
                    require(observed.get("PLAYWRIGHT_BROWSERS_PATH") == expected_cache, "browser cache path was not fixed")
                    require(observed == receipt["cleanEnvironment"], "recorded child environment differs")
                elif name in ("stdout-overflow", "stderr-overflow"):
                    kind = name.split("-", 1)[0]
                    counts = receipt["output"][kind]
                    retained = raw if kind == "stdout" else raw_stderr
                    require(completed != 0 and receipt["state"] == "failed", "output overflow was accepted")
                    require(receipt["limit"] == kind + "-bytes", "wrong output-overflow limit")
                    require(retained == bytes(range(256)) * (DEFAULT_OUTPUT_BYTES // 256), "exact accepted output prefix was not retained")
                    require(counts["capBytes"] < counts["observedBytes"] <= DEFAULT_OUTPUT_BYTES + 65536,
                            "overflow byte count is absent or exceeds fixture output")
                    require(counts["truncated"] and counts["discardedBytes"] > 0, "output loss was not recorded")
                elif name == "unowned-root-rejection":
                    require(completed != 0 and receipt["state"] == "failed", "unowned root was accepted")
                    require(receipt["handshake"] is None, "unowned root was acknowledged")
                    require("not a current owned descendant" in (receipt["error"] or ""), "unowned-root refusal reason missing")
                    require(not any(row.get("event") == "unexpected-ack" for row in rows), "an unowned-root acknowledgment reached the child")
                    require(unrelated.poll() is None, "unrelated sentinel was terminated")
                    require(sentinel_signals.read_bytes() == b"", "unrelated sentinel received a signal")
                    require(not any(row["pid"] == unrelated.pid for row in receipt["observedProcesses"]), "unrelated sentinel entered owned inventory")
                    require(not any(row["pid"] == unrelated.pid for row in receipt["cleanup"]["signals"]), "supervisor signaled unrelated sentinel")
                    case["unrelatedSentinelAliveAfterRefusal"] = True
                    unrelated.kill()
                    unrelated.wait(timeout=LAUNCHER_REAP_SECONDS)
                    case["sentinelCleanupByGate"] = "SIGKILL after unchanged signal log and live status were verified"
                    unrelated = None
                elif name == "signal-abort-detached-escalation":
                    require(completed != 0 and receipt["state"] == "failed", "supervisor abort was accepted")
                    require(receipt["signal"] == int(signal.SIGTERM), "supervisor abort signal missing")
                    require(receipt["error"] == "supervisor interrupted", "supervisor interruption reason missing")
                    ready = next(row for row in rows if row.get("event") == "abort-ready")
                    detached = next(row for row in receipt["observedProcesses"] if row["pid"] == ready["detachedPid"])
                    controller = next(row for row in receipt["observedProcesses"] if row["pid"] == ready["pid"])
                    require(detached["pgrp"] != controller["pgrp"], "abort fixture child was not detached")
                    signals = [row["signal"] for row in receipt["cleanup"]["signals"]
                               if row["pid"] == detached["pid"] and row["starttime"] == detached["starttime"]]
                    require(int(signal.SIGTERM) in signals and int(signal.SIGKILL) in signals,
                            "detached child was not escalated from SIGTERM to SIGKILL")
                    require(signals.index(int(signal.SIGTERM)) < signals.index(int(signal.SIGKILL)), "escalation order was incorrect")
                    require(receipt["cleanup"]["interventionRequired"], "abort cleanup intervention missing")
            case["state"] = "passed"
            summary_path.write_text(json.dumps(result, indent=2) + "\n")
        require(time.monotonic() <= deadline, "aggregate 48-second command budget exhausted")
        result["state"] = "passed"
    except BaseException as error:
        result["error"] = type(error).__name__ + ": " + str(error)
        if result["cases"]:
            result["cases"][-1]["state"] = "failed"
            result["cases"][-1]["error"] = result["error"]
        # On every failure, stop any still-running launcher/sentinel and retain
        # launcher evidence. Both reaps share one second, rather than granting
        # an extra second per process. Detached fixture lifetimes are <=4 s.
        cleanup_deadline = time.monotonic() + LAUNCHER_REAP_SECONDS
        result["gateCleanupErrors"] = []
        for running in (process, unrelated):
            if running is not None and running.poll() is None:
                try:
                    os.killpg(running.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError as cleanup_error:
                    result["gateCleanupErrors"].append(str(cleanup_error))
        if process is not None:
            try:
                launcher_stdout, launcher_stderr = process.communicate(timeout=max(0, cleanup_deadline - time.monotonic()))
                (case_dir / "launcher.stdout").write_bytes(launcher_stdout)
                (case_dir / "launcher.stderr").write_bytes(launcher_stderr)
            except subprocess.TimeoutExpired as cleanup_error:
                (case_dir / "launcher.stdout").write_bytes(cleanup_error.output or b"")
                (case_dir / "launcher.stderr").write_bytes(cleanup_error.stderr or b"")
                result["gateCleanupErrors"].append("launcher reap exceeded shared one-second cleanup budget")
        if unrelated is not None:
            try:
                unrelated.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                result["gateCleanupErrors"].append("sentinel reap exceeded shared one-second cleanup budget")
        # This expiry wait is safety cleanup, never a replacement or resampling.
        time.sleep(FIXTURE_EXPIRY_SECONDS)
    finally:
        result["elapsedSeconds"] = time.monotonic() - started
        summary_path.write_text(json.dumps(result, indent=2) + "\n")
    return 0 if result["state"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
