#!/usr/bin/env python3
"""Source-only Linux subject supervisor; not executed during preparation.

Own a child subtree with PR_SET_CHILD_SUBREAPER, rather than assuming that
Playwright's detached browser process groups remain in the controller's PGID.
RSS is a 50 ms target-cadence census, not a kernel-enforced peak-memory limit.
Four seconds of the wall cap are reserved for bounded teardown and evidence.
Each output stream retains at most its declared byte cap. Overflow fails the
command while teardown continues bounded reads and discards excess bytes.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time


POLL_SECONDS = 0.050
CLEANUP_RESERVE = 4.0
TERM_GRACE = 0.5
FINALIZE_RESERVE = 0.25
MAX_HANDSHAKE_LINE = 1024 * 1024
DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024
OUTPUT_BYTE_CHOICES = (DEFAULT_OUTPUT_BYTES, 32 * 1024 * 1024)
PACKET_ROOT = Path(__file__).resolve().parent
ALLOWED_ENV = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI")
SELECTORS = {
    "SCREEN_BROWSER": {"chromium", "firefox", "webkit"},
    "SCREEN_ARM": {"baseline", "candidate"},
    "DEBUG": {"pw:install"},
}


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--seconds", required=True, type=float)
    parser.add_argument("--rss-mib", required=True, type=float)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stderr", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--stdout-bytes", type=int, choices=OUTPUT_BYTE_CHOICES,
                        default=DEFAULT_OUTPUT_BYTES)
    parser.add_argument("--stderr-bytes", type=int, choices=OUTPUT_BYTE_CHOICES,
                        default=DEFAULT_OUTPUT_BYTES)
    parser.add_argument("--handshake", action="store_true")
    parser.add_argument("--env", action="append", default=[])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("a command after -- is required")
    if not (CLEANUP_RESERVE < args.seconds < 3600):
        parser.error("--seconds must be finite, greater than 4, and below 3600")
    if not (0 < args.rss_mib < 1048576):
        parser.error("--rss-mib must be finite and positive")
    return args


def clean_environment(extra):
    result = {key: os.environ[key] for key in ALLOWED_ENV if key in os.environ}
    result.setdefault("PATH", os.defpath)
    result.setdefault("LANG", "C.UTF-8")
    result.setdefault("CI", "true")
    result["PLAYWRIGHT_BROWSERS_PATH"] = str(PACKET_ROOT / "browser-cache")
    for assignment in extra:
        key, separator, value = assignment.partition("=")
        if not separator or key not in SELECTORS or value not in SELECTORS[key]:
            raise ValueError("--env only accepts declared SCREEN_BROWSER/SCREEN_ARM or DEBUG=pw:install")
        if key in result:
            raise ValueError("duplicate --env selector: " + key)
        result[key] = value
    return result


def become_subreaper():
    if sys.platform != "linux":
        raise RuntimeError("this supervisor requires Linux /proc and prctl")
    libc = ctypes.CDLL(None, use_errno=True)
    # prctl is variadic; explicit ctypes values avoid pointer truncation.
    if libc.prctl(ctypes.c_int(36), ctypes.c_ulong(1), ctypes.c_ulong(0),
                  ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
    enabled = ctypes.c_int(0)
    if libc.prctl(ctypes.c_int(37), ctypes.byref(enabled), ctypes.c_ulong(0),
                  ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0 or enabled.value != 1:
        raise RuntimeError("PR_GET_CHILD_SUBREAPER did not confirm ownership")


def process_stat(pid):
    raw = Path("/proc", str(pid), "stat").read_text()
    fields = raw[raw.rfind(")") + 2:].split()
    if len(fields) < 22:
        raise ValueError("short /proc stat")
    return {
        "pid": pid,
        "state": fields[0],
        "ppid": int(fields[1]),
        "pgrp": int(fields[2]),
        "starttime": int(fields[19]),
        "rssPages": max(0, int(fields[21])),
    }


def census(supervisor_pid):
    table = {}
    for entry in os.scandir("/proc"):
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        try:
            table[pid] = process_stat(pid)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError as error:
            # An incomplete PPid table cannot establish an empty owned tree.
            raise RuntimeError("incomplete /proc ancestry census") from error
    descendants = {}
    frontier = {supervisor_pid}
    while frontier:
        following = set()
        for pid, item in table.items():
            if pid != supervisor_pid and pid not in descendants and item["ppid"] in frontier:
                descendants[pid] = item
                following.add(pid)
        frontier = following
    return descendants, table.get(supervisor_pid)


def identity(item):
    return item["pid"], item["starttime"]


def public_process(item):
    return {key: item[key] for key in ("pid", "starttime", "pgrp", "ppid")}


def save_receipt(path, receipt):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp." + str(os.getpid()))
    with temporary.open("x") as handle:
        handle.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)


def reserve_artifacts(paths):
    if len({path.resolve() for path in paths}) != len(paths) or any(path.exists() or path.is_symlink() for path in paths):
        raise RuntimeError("refusing to overwrite or alias a subject artifact")
    reserved = []
    try:
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb"):
                pass
            reserved.append(path)
    except BaseException:
        for path in reserved:
            path.unlink()
        raise


class ExecutableInventory:
    """Hash open executable descriptors incrementally outside measured work.

    The descriptor preserves the observed file if its process exits. A short
    hashing slice leaves the next ancestry/RSS census responsive. Initial hashes
    complete before a handshake ACK; newly observed executables after ACK are
    hashed only after subject exit or during teardown.
    """

    def __init__(self):
        self.records = {}
        self.files = {}
        self.errors = []

    def observe(self, processes):
        for item in processes.values():
            key = identity(item)
            record = self.records.setdefault(key, {
                **public_process(item), "executable": None,
                "executableSHA256": None, "cmdline": [],
                "executableHistory": [],
            })
            record["lastPPid"] = item["ppid"]
            record["lastPgrp"] = item["pgrp"]
            try:
                proc_dir = Path("/proc", str(item["pid"]))
                executable = os.readlink(proc_dir / "exe")
                with (proc_dir / "exe").open("rb", buffering=0) as probe:
                    metadata = os.fstat(probe.fileno())
                    file_key = (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns)
                    if file_key not in self.files:
                        self.files[file_key] = {
                            "fd": os.dup(probe.fileno()), "digest": hashlib.sha256(),
                            "sha256": None, "error": None,
                        }
                current = process_stat(item["pid"])
                if identity(current) != key:
                    continue
                cmdline = (proc_dir / "cmdline").read_bytes().split(b"\0")
                if record.get("_fileKey") != file_key or record["executable"] != executable:
                    if record["executable"] is not None:
                        record["executableHistory"].append({
                            "path": record["executable"],
                            "sha256": record["executableSHA256"],
                            "_fileKey": record.get("_fileKey"),
                        })
                    record["executable"] = executable
                    record["_fileKey"] = file_key
                record["cmdline"] = [part.decode("utf-8", "replace") for part in cmdline if part]
                record["executableSHA256"] = self.files[file_key]["sha256"]
                record.pop("executableReadError", None)
            except (OSError, ValueError) as error:
                # Exited/zombie processes can lose /proc/PID/exe between census
                # and observation. Preserve the missing observation honestly.
                record["executableReadError"] = str(error)

    def work(self, seconds=0.010):
        deadline = time.monotonic() + seconds
        for file_key, file in self.files.items():
            if file["fd"] is None:
                continue
            while time.monotonic() < deadline:
                try:
                    chunk = os.read(file["fd"], 1024 * 1024)
                    if chunk:
                        file["digest"].update(chunk)
                    else:
                        file["sha256"] = file["digest"].hexdigest()
                        os.close(file["fd"])
                        file["fd"] = None
                        break
                except OSError as error:
                    file["error"] = str(error)
                    self.errors.append(str(error))
                    os.close(file["fd"])
                    file["fd"] = None
                    break
            if time.monotonic() >= deadline:
                break
        for record in self.records.values():
            if record.get("_fileKey") in self.files:
                record["executableSHA256"] = self.files[record["_fileKey"]]["sha256"]

    def pending(self):
        return any(file["fd"] is not None for file in self.files.values())

    def close(self):
        for file in self.files.values():
            if file["fd"] is not None:
                os.close(file["fd"])
                file["fd"] = None

    def output(self):
        result = []
        for _, record in sorted(self.records.items()):
            row = {key: value for key, value in record.items() if not key.startswith("_")}
            row["executableHistory"] = [{
                "path": old["path"],
                "sha256": self.files.get(old.get("_fileKey"), {}).get("sha256", old["sha256"]),
            } for old in record["executableHistory"]]
            result.append(row)
        return result


def run(args):
    started = time.monotonic()
    absolute_deadline = started + args.seconds
    active_deadline = absolute_deadline - CLEANUP_RESERVE
    teardown_deadline = absolute_deadline - FINALIZE_RESERVE
    receipt_path = Path(args.receipt).absolute()
    output_path = Path(args.output).absolute()
    stderr_path = Path(args.stderr).absolute()
    reserve_artifacts([output_path, stderr_path, receipt_path])
    receipt = {
        "schema": 1, "state": "failed", "phase": "started", "command": args.command,
        "cwd": str(Path(args.cwd).resolve()), "cleanEnvironment": {},
        "secondsCap": args.seconds, "rssMiBCap": args.rss_mib,
        "exitCode": None, "limit": None, "error": "supervisor incomplete",
        "signal": None, "elapsedSeconds": 0, "peakPolledRSS": 0,
        "rssUnits": "bytes", "rssSampleIntervalMs": 50,
        "supervisorPeakPolledRSS": 0, "cleanupReserveSeconds": CLEANUP_RESERVE,
        "handshake": None, "observedProcesses": [],
        "output": {
            kind: {"capBytes": cap, "observedBytes": 0, "retainedBytes": 0,
                   "discardedBytes": 0, "truncated": False}
            for kind, cap in (("stdout", args.stdout_bytes), ("stderr", args.stderr_bytes))
        },
        "cleanup": {"confirmedEmpty": False, "remainingBeforeCleanup": [],
                    "remainingAfterCleanup": [], "signals": [], "errors": []},
    }
    save_receipt(receipt_path, receipt)
    child = None
    output = None
    stderr = None
    selector = selectors.DefaultSelector()
    inventory = ExecutableInventory()
    page_size = os.sysconf("SC_PAGE_SIZE")
    supervisor_pid = os.getpid()
    received_signal = None
    handshake_buffer = bytearray()
    requested_roots = None
    pending_ack = None
    ack_bytes = b""
    owned = {}
    stdout_eof = False
    stderr_eof = False
    failed_output_streams = set()

    def on_signal(number, frame):
        nonlocal received_signal
        received_signal = number

    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, on_signal)

    def sample():
        nonlocal owned
        if child is not None:
            child.poll()  # Popen reaps its direct child before orphan waitpid.
        owned, own_stat = census(supervisor_pid)
        for pid, item in list(owned.items()):
            if item["ppid"] == supervisor_pid and (child is None or pid != child.pid):
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
        # Re-read after reaping; reparented detached descendants remain rooted
        # here even after the original controller/browser parent exits.
        owned, own_stat = census(supervisor_pid)
        rss = sum(item["rssPages"] * page_size for item in owned.values())
        receipt["peakPolledRSS"] = max(receipt["peakPolledRSS"], rss)
        if own_stat is not None:
            receipt["supervisorPeakPolledRSS"] = max(
                receipt["supervisorPeakPolledRSS"], own_stat["rssPages"] * page_size)
        inventory.observe(owned)
        return rss

    def drain(timeout, finalizing=False):
        nonlocal stdout_eof, stderr_eof, requested_roots, ack_bytes, pending_ack
        for selected, mask in selector.select(max(0, timeout)):
            kind = selected.data
            if kind == "stdin":
                if finalizing or receipt["limit"] is not None:
                    selector.unregister(selected.fd)
                    continue
                try:
                    written = os.write(selected.fd, ack_bytes)
                    ack_bytes = ack_bytes[written:]
                    if not ack_bytes:
                        receipt["handshake"] = pending_ack
                        pending_ack = None
                        selector.unregister(selected.fd)
                except BlockingIOError:
                    pass
                continue
            try:
                chunk = os.read(selected.fd, 65536)
            except BlockingIOError:
                continue
            if not chunk:
                selector.unregister(selected.fd)
                if kind == "stdout":
                    stdout_eof = True
                else:
                    stderr_eof = True
                continue
            target = output if kind == "stdout" else stderr
            counts = receipt["output"][kind]
            # Counts describe bytes actually drained, not bytes a process may
            # have attempted to emit. EOF separately records drain completion.
            counts["observedBytes"] += len(chunk)
            if counts["observedBytes"] > counts["capBytes"] and receipt["limit"] is None:
                receipt["limit"] = kind + "-bytes"
            accepted = memoryview(chunk)[:max(0, counts["capBytes"] - counts["retainedBytes"])]
            try:
                if kind not in failed_output_streams:
                    while accepted:
                        written = target.write(accepted)
                        if written is None or written <= 0:
                            raise OSError("no progress retaining " + kind + " prefix")
                        counts["retainedBytes"] += written
                        accepted = accepted[written:]
                    target.flush()
            except BaseException:
                # A broken artifact sink must not prevent later pipe draining
                # and owned-process cleanup. Preserve only its written prefix.
                failed_output_streams.add(kind)
                raise
            finally:
                counts["discardedBytes"] = counts["observedBytes"] - counts["retainedBytes"]
                counts["truncated"] = counts["discardedBytes"] > 0
            if (finalizing or receipt["limit"] is not None or kind != "stdout"
                    or not args.handshake or receipt["handshake"] is not None):
                continue
            handshake_buffer.extend(chunk)
            while b"\n" in handshake_buffer:
                line, _, rest = handshake_buffer.partition(b"\n")
                handshake_buffer[:] = rest
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(message, dict) and message.get("event") == "containment-ready":
                    roots = message.get("rootPids")
                    if requested_roots is not None:
                        raise RuntimeError("duplicate containment-ready message")
                    if (not isinstance(roots, list) or len(roots) not in (1, 2)
                            or any(type(pid) is not int or pid <= 0 for pid in roots)
                            or len(set(roots)) != len(roots) or roots[0] != child.pid):
                        raise RuntimeError("invalid containment-ready rootPids")
                    requested_roots = roots
            if len(handshake_buffer) > MAX_HANDSHAKE_LINE:
                raise RuntimeError("containment line exceeds 1 MiB; raw bytes were retained")

    def cleanup_sample():
        try:
            sample()
            return True
        except BaseException as error:
            receipt["cleanup"]["errors"].append(type(error).__name__ + ": " + str(error))
            return False

    def cleanup_drain(timeout):
        try:
            drain(timeout, finalizing=True)
        except BaseException as error:
            receipt["cleanup"]["errors"].append(type(error).__name__ + ": " + str(error))

    def signal_owned(number):
        cleanup_sample()
        # Individual identity-checked signals cover groups that detached with
        # setsid without risking a reused or unrelated process-group number.
        for item in list(owned.values()):
            key = identity(item)
            try:
                current = process_stat(item["pid"])
                if identity(current) != key or current["state"] == "Z":
                    continue
                # A pidfd binds the target across PID reuse after stat. Without
                # pidfd support, fail containment instead of a racy os.kill.
                pidfd = os.pidfd_open(item["pid"], 0)
                try:
                    after_open = process_stat(item["pid"])
                    if identity(after_open) != key:
                        continue
                    signal.pidfd_send_signal(pidfd, number, None, 0)
                    receipt["cleanup"]["signals"].append({
                        "pid": item["pid"], "starttime": item["starttime"],
                        "signal": int(number),
                    })
                finally:
                    os.close(pidfd)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except OSError as error:
                receipt["cleanup"]["errors"].append(str(error))

    try:
        if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
            raise RuntimeError("Python/Linux pidfd APIs are required for race-free cleanup")
        probe = os.pidfd_open(supervisor_pid, 0)
        try:
            signal.pidfd_send_signal(probe, 0, None, 0)
        finally:
            os.close(probe)
        environment = clean_environment(args.env)
        receipt["cleanEnvironment"] = environment
        output = output_path.open("r+b", buffering=0)
        stderr = stderr_path.open("r+b", buffering=0)
        become_subreaper()
        receipt["error"] = None
        save_receipt(receipt_path, receipt)
        child = subprocess.Popen(
            args.command, cwd=receipt["cwd"], env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, bufsize=0, close_fds=True,
        )
        try:
            owned[child.pid] = process_stat(child.pid)
        except (FileNotFoundError, ProcessLookupError):
            pass
        for stream, name in ((child.stdout, "stdout"), (child.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        os.set_blocking(child.stdin.fileno(), False)
        while True:
            tick_started = time.monotonic()
            rss = sample()
            if received_signal is not None:
                receipt["signal"] = received_signal
                receipt["error"] = "supervisor interrupted"
                break
            if receipt["limit"] is not None:
                break
            if rss > args.rss_mib * 1024 * 1024:
                receipt["limit"] = "rss"
                break
            if tick_started >= active_deadline:
                receipt["limit"] = "wall-time-reserving-cleanup"
                break
            if receipt["handshake"] is None or child.returncode is not None:
                inventory.work()
            if args.handshake and requested_roots is not None and receipt["handshake"] is None and pending_ack is None:
                if any(pid not in owned for pid in requested_roots):
                    raise RuntimeError("a containment root is not a current owned descendant")
                if not inventory.pending():
                    sample()
                    if any(pid not in owned for pid in requested_roots):
                        raise RuntimeError("a containment root exited before acknowledgment")
                    if inventory.pending():
                        continue
                    roots = [public_process(owned[pid]) for pid in requested_roots]
                    for root in roots:
                        record = inventory.records[identity(root)]
                        if not record["executableSHA256"]:
                            raise RuntimeError("a containment root lacks executable identity")
                    pending_ack = {
                        "event": "containment-verified", "roots": roots,
                        "method": "linux-subreaper-descendant-census",
                    }
                    ack_bytes = (json.dumps(pending_ack, separators=(",", ":")) + "\n").encode()
                    selector.register(child.stdin, selectors.EVENT_WRITE, "stdin")
            if child.returncode is not None:
                receipt["exitCode"] = child.returncode
                break
            drain(min(POLL_SECONDS, max(0, POLL_SECONDS - (time.monotonic() - tick_started)),
                      max(0, active_deadline - time.monotonic())))
    except BaseException as error:
        receipt["error"] = type(error).__name__ + ": " + str(error)
    finally:
        try:
            complete_census = cleanup_sample()
            receipt["cleanup"]["remainingBeforeCleanup"] = [public_process(item) for item in owned.values()]
            intervention = bool(owned)
            grace_end = min(time.monotonic() + TERM_GRACE, teardown_deadline)
            empty_censuses = 0
            last_empty_census = float("-inf")
            term_sent = set()
            # Repeated ancestry censuses include new/reparented descendants.
            # Two empty censuses separated by a polling interval are required.
            # Retain only exact accepted prefixes; keep bounded draining and
            # discarding after overflow while cleanup uses the same wall cap.
            # An incomplete stdout line is never given an invented newline.
            while time.monotonic() < teardown_deadline:
                if owned:
                    intervention = True
                    if time.monotonic() >= grace_end:
                        signal_owned(signal.SIGKILL)
                    elif any(identity(item) not in term_sent for item in owned.values()):
                        signal_owned(signal.SIGTERM)
                        term_sent.update(identity(item) for item in owned.values())
                inventory.work()
                cleanup_drain(min(POLL_SECONDS, max(0, teardown_deadline - time.monotonic())))
                complete_census = cleanup_sample()
                if complete_census and not owned:
                    if time.monotonic() - last_empty_census >= POLL_SECONDS:
                        empty_censuses += 1
                        last_empty_census = time.monotonic()
                else:
                    empty_censuses = 0
                    last_empty_census = float("-inf")
                streams_done = child is None or (stdout_eof and stderr_eof)
                if empty_censuses >= 2 and streams_done and not inventory.pending():
                    break
            receipt["cleanup"]["remainingAfterCleanup"] = [public_process(item) for item in owned.values()]
            receipt["cleanup"]["confirmedEmpty"] = complete_census and not owned and empty_censuses >= 2
            receipt["cleanup"]["emptyCensuses"] = empty_censuses
            receipt["cleanup"]["interventionRequired"] = intervention
            receipt["stdoutEOF"] = stdout_eof
            receipt["stderrEOF"] = stderr_eof
            receipt["executableHashingComplete"] = not inventory.pending()
            receipt["executableHashErrors"] = inventory.errors
            if child is not None:
                receipt["exitCode"] = child.poll()
            if args.handshake and receipt["handshake"] is None and receipt["error"] is None:
                receipt["error"] = "required containment handshake was not completed"
            if received_signal is not None:
                receipt["signal"] = received_signal
            if time.monotonic() >= absolute_deadline and receipt["limit"] is None:
                receipt["limit"] = "wall-time-including-cleanup"
            if (receipt["error"] is None and receipt["limit"] is None
                    and receipt["signal"] is None and receipt["exitCode"] == 0
                    and not intervention and receipt["cleanup"]["confirmedEmpty"] and not receipt["cleanup"]["errors"]
                    and not inventory.pending() and not inventory.errors and stdout_eof and stderr_eof):
                receipt["state"] = "passed"
        except BaseException as error:
            receipt["cleanup"]["errors"].append(type(error).__name__ + ": " + str(error))
        finally:
            inventory.close()
            receipt["observedProcesses"] = inventory.output()
            receipt["elapsedSeconds"] = time.monotonic() - started
            receipt["phase"] = "finished"
            for stream in ((child.stdin, child.stdout, child.stderr) if child is not None else ()):
                try:
                    stream.close()
                except OSError:
                    pass
            selector.close()
            if output is not None:
                output.close()
            if stderr is not None:
                stderr.close()
            save_receipt(receipt_path, receipt)
    return 0 if receipt["state"] == "passed" else 1


if __name__ == "__main__":
    try:
        sys.exit(run(arguments()))
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(2)
