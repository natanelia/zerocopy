"""Bounded Linux process supervision reused without changing function bodies."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

GIB = 1 << 30
RSS_LIMIT = GIB
CLEANUP_SECONDS = 2
POLL_SECONDS = 0.05
CHILD_ENVIRONMENT = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                     'LC_ALL': 'C.UTF-8', 'CI': '1', 'NO_COLOR': '1', 'DO_NOT_TRACK': '1'}

def require(condition, message):
    if not condition:
        raise ValueError(message)

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def read(path):
    return json.loads(Path(path).read_text())

def write(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)

def check_ambient_config(cwd):
    """Fail closed on ambient Bun configuration, without reading its contents."""
    cwd = Path(cwd).resolve(strict=True)
    names = ('bunfig.toml', '.env', '.env.local', '.env.development', '.env.production', '.env.test')
    for directory in (cwd, *cwd.parents):
        for name in names:
            try:
                (directory / name).lstat()
            except FileNotFoundError:
                continue
            except OSError:
                raise ValueError('cannot verify absence of ambient runtime configuration') from None
            raise ValueError('ambient runtime configuration blocks admission')

def group_members(group):
    """Read only process identities and RSS/HWM for this owned process group."""
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group:
                continue
            values = {name: int(value) * 1024 for name, value in re.findall(
                r'^(VmRSS|VmHWM):\s+(\d+) kB$', (path / 'status').read_text(), re.M)}
            rows.append({'pid': int(path.name), 'state': fields[0],
                         'rssBytes': values.get('VmRSS', 0), 'hwmBytes': values.get('VmHWM', 0)})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return rows

class Supervisor:
    def __init__(self, output, labels=()):
        self.output = Path(output)
        self.labels = sorted([(str(path), label) for path, label in labels],
                             key=lambda item: -len(item[0]))
        self.receipts = []
        self.active = None
        self.interrupted = None
        for number in (signal.SIGINT, signal.SIGTERM):
            signal.signal(number, self.on_signal)

    def on_signal(self, number, _frame):
        self.interrupted = number

    def display(self, text):
        for path, label in self.labels:
            text = str(text).replace(path, label)
        return str(text)

    def _sanitize_log(self, path):
        # Logs retain child output with known host paths replaced by logical
        # labels. No raw environment, hostname or process command is collected.
        if path.exists():
            raw = path.read_bytes()
            for source, label in self.labels:
                raw = raw.replace(source.encode(), label.encode())
            path.write_bytes(raw)

    def run(self, label, argv, cwd, deadline, wall, rss_limit=RSS_LIMIT):
        require(re.fullmatch(r'[a-z0-9][a-z0-9-]*', label) is not None, 'unsafe command label')
        check_ambient_config(cwd)
        require(self.active is None and not self.interrupted, 'owned group active or interruption before launch')
        require(wall > CLEANUP_SECONDS and time.monotonic() + wall <= deadline,
                'full child allowance does not fit before phase deadline')
        require(not any(row['label'] == label for row in self.receipts), 'no command retries')
        argv = [str(value) for value in argv]
        receipt = {
            'label': label, 'argv': [self.display(value) for value in argv],
            'cwd': self.display(str(cwd)), 'startedUnix': time.time(),
            'wallSeconds': wall, 'cleanupReserveSeconds': CLEANUP_SECONDS,
            'sampledGroupRssLimitBytes': rss_limit, 'sampleIntervalSeconds': POLL_SECONDS,
            'hardCgroupCap': False, 'peakObservedGroupRssBytes': 0,
            'peakObservedProcessHwmBytes': 0, 'cleanupSignals': [],
            'leaderReaped': False, 'descendantsAfterCleanup': [],
            'pathLabelsAppliedToLogs': True,
        }
        self.receipts.append(receipt)
        write(self.output / 'commands.json', self.receipts)
        out_path, err_path = (self.output / (label + suffix) for suffix in ('.stdout', '.stderr'))
        started = time.monotonic()
        end = min(deadline, started + wall)
        stop = end - CLEANUP_SECONDS
        child = None
        failure = None
        try:
            with out_path.open('xb') as out, err_path.open('xb') as err:
                # A fresh session makes the leader PID an owned process-group
                # identity. WNOWAIT retains it until all group checks finish.
                child = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=err, env=CHILD_ENVIRONMENT,
                                         start_new_session=True)
                self.active = child
                receipt['ownedProcessGroup'] = child.pid
                while True:
                    rows = group_members(child.pid)
                    rss = sum(row['rssBytes'] for row in rows)
                    hwm = max((row['hwmBytes'] for row in rows), default=0)
                    receipt['peakObservedGroupRssBytes'] = max(receipt['peakObservedGroupRssBytes'], rss)
                    receipt['peakObservedProcessHwmBytes'] = max(receipt['peakObservedProcessHwmBytes'], hwm)
                    if max(rss, hwm) > rss_limit:
                        failure = 'sampled group RSS or process high-water ceiling'
                    if self.interrupted:
                        failure = failure or 'interrupted'
                    if time.monotonic() >= stop:
                        failure = failure or 'wall cap with cleanup reserve'
                    if failure:
                        break
                    if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
                        break
                    time.sleep(min(POLL_SECONDS, max(0, stop - time.monotonic())))
        except BaseException as error:
            # Never serialize exception reprs containing uncontrolled host paths.
            failure = failure or ('command supervision exception: ' + type(error).__name__)
        finally:
            if child is not None:
                try:
                    exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    leftover = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                    receipt['descendantsBeforeCleanup'] = leftover
                    if failure or leftover or not exited:
                        failure = failure or 'unexpected surviving descendants'
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        receipt['cleanupSignals'].append('SIGKILL original owned group before leader reap')
                    cleanup_stop = min(end, time.monotonic() + CLEANUP_SECONDS)
                    while time.monotonic() < cleanup_stop:
                        exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                        remaining = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                        if exited and not remaining:
                            break
                        time.sleep(min(0.01, max(0, cleanup_stop - time.monotonic())))
                    receipt['descendantsAfterCleanup'] = [row for row in group_members(child.pid)
                                                          if row['pid'] != child.pid]
                    if receipt['descendantsAfterCleanup']:
                        failure = failure or 'owned descendants remain after bounded cleanup'
                    else:
                        # Keep the leader unreaped if descendants remain. Once
                        # wait4 releases the identity, no later signal is safe.
                        pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                        receipt['leaderReaped'] = bool(pid)
                        if pid:
                            child.returncode = os.waitstatus_to_exitcode(status)
                            self.active = None
                            receipt['exitCode'] = child.returncode
                            receipt['wait4MaxRssBytes'] = usage.ru_maxrss * 1024
                            if receipt['wait4MaxRssBytes'] > rss_limit:
                                failure = failure or 'terminal process high-water ceiling'
                        else:
                            failure = failure or 'leader not reaped within cap'
                except BaseException as error:
                    failure = failure or ('cleanup exception: ' + type(error).__name__)
                    # Ownership remains valid only if the original leader was
                    # not reaped. A failed cleanup is terminal, never a retry.
                    if not receipt['leaderReaped']:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        receipt['cleanupSignals'].append('SIGKILL original group after cleanup exception')
                        fallback_stop = min(end, time.monotonic() + CLEANUP_SECONDS)
                        while time.monotonic() < fallback_stop:
                            try:
                                exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                                remaining = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                                receipt['descendantsAfterCleanup'] = remaining
                                if exited and not remaining:
                                    pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                                    if pid:
                                        child.returncode = os.waitstatus_to_exitcode(status)
                                        self.active = None
                                        receipt.update(leaderReaped=True, exitCode=child.returncode,
                                                       wait4MaxRssBytes=usage.ru_maxrss * 1024)
                                    break
                            except (OSError, ValueError):
                                # Unknown descendant state cannot justify
                                # releasing the retained original identity.
                                break
                            time.sleep(min(0.01, max(0, fallback_stop - time.monotonic())))
            if time.monotonic() > end:
                failure = failure or 'command cap exceeded during cleanup'
            for path in (out_path, err_path):
                self._sanitize_log(path)
                if path.exists():
                    receipt[path.suffix[1:]] = {'file': path.name, 'sha256': sha(path),
                                               'bytes': path.stat().st_size}
            if time.monotonic() > end:
                failure = failure or 'command cap exceeded during evidence collection'
            receipt.update(endedUnix=time.time(), elapsedSecondsForSafety=time.monotonic() - started,
                           failure=failure)
            write(self.output / 'commands.json', self.receipts)
        require(not failure and receipt.get('exitCode') == 0 and not self.interrupted,
                'command failed; no retry: ' + label)
        return receipt
