"""Small original-process-group owner, adapted from the accepted focused gate."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

RSS = 2147483648


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def write(path, data):
    Path(path).write_text(json.dumps(data, indent=2, allow_nan=False) + '\n')


def invalidate_terminal(result, interrupted, elapsed, limit=900, analysis=None):
    """Pure final guard, also exercised by fabricated preflight state."""
    if interrupted is None and elapsed < limit:
        return False
    reason = 'late interruption' if interrupted is not None else 'whole-phase cap'
    result.update(status='stopped', failure=reason, interrupted=interrupted)
    if 'ready' in result:
        result['ready'] = False
    if analysis is not None:
        analysis['terminalComplete'] = analysis['promisingPrimary'] = analysis['regressionClear'] = False
    return True


def group_memory(group):
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group:
                continue
            values = {key: int(value) * 1024 for key, value in re.findall(
                r'^(VmRSS|VmHWM):\s+(\d+) kB$', (path / 'status').read_text(), re.M)}
            rows.append({'pid': int(path.name), **values})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return rows


class Runner:
    def __init__(self, root, seconds=900):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=False)
        (self.root / 'STARTED').touch(exist_ok=False)
        (self.root / 'logs').mkdir()
        self.start = time.monotonic()
        self.end = self.start + seconds
        self.work_end = self.end - 2  # Keep the fixed original-group cleanup reserve.
        self.receipts, self.interrupted = [], None
        for number in (signal.SIGINT, signal.SIGTERM):
            signal.signal(number, self.interrupt)

    def interrupt(self, number, _frame):
        self.interrupted = number

    def budget(self):
        if self.interrupted or time.monotonic() >= self.work_end:
            raise RuntimeError('whole-phase cap or interruption')

    def run(self, label, argv, cwd, env, seconds):
        self.budget()
        assert not any(r['label'] == label for r in self.receipts), 'no command retry'
        receipt = {'label': label, 'argv': argv, 'cwd': str(cwd), 'environment': env,
                   'wallLimitSeconds': seconds, 'sampledRssLimitBytes': RSS,
                   'memoryCapIsSampled': True, 'cleanupSignals': [], 'startedUnix': time.time()}
        self.receipts.append(receipt)
        child, error, seen, peak, hwm = None, None, set(), 0, 0
        start = time.monotonic()
        stdout, stderr = [self.root / 'logs' / (label + '.' + name) for name in ('stdout', 'stderr')]
        try:
            with stdout.open('wb') as out, stderr.open('wb') as err:
                child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out, stderr=err, start_new_session=True)
            receipt['ownedProcessGroup'] = child.pid
            while True:
                rows = group_memory(child.pid)
                seen.update(row['pid'] for row in rows)
                peak = max(peak, sum(row.get('VmRSS', 0) for row in rows))
                hwm = max([hwm] + [row.get('VmHWM', 0) for row in rows])
                self.budget()
                if time.monotonic() - start >= seconds or max(peak, hwm) > RSS:
                    raise RuntimeError('child wall or sampled RSS cap')
                if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
                    break
                time.sleep(.02)
        except BaseException as exc:
            error = repr(exc)
        finally:
            if child is not None:
                descendants = lambda: [r for r in group_memory(child.pid) if r['pid'] != child.pid]
                leftover = descendants()
                receipt['leftoverDescendantsBeforeCleanup'] = leftover
                if error or leftover:
                    error = error or 'leftover descendants after leader exit'
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                        receipt['cleanupSignals'].append('SIGKILL original owned group')
                    except ProcessLookupError:
                        pass
                # Even a host pause beyond the whole deadline must not skip
                # post-kill reaping. Such an overrun is a failed run, never a
                # release to another command; cleanup remains bounded to 2 s.
                cleanup_start = time.monotonic()
                stop = cleanup_start + 2
                while time.monotonic() < stop:
                    exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    if exited and not descendants():
                        break
                    time.sleep(.01)
                remaining = descendants()
                exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                pid, status, usage = os.wait4(child.pid, os.WNOHANG) if exited and not remaining else (0, 0, None)
                child.returncode = os.waitstatus_to_exitcode(status) if pid else None
                receipt.update(descendantsAfterCleanup=remaining, leaderReapedAfterCleanup=bool(pid),
                               exitCode=child.returncode, wait4MaxRssBytes=usage.ru_maxrss * 1024 if pid else None,
                               cleanupSeconds=time.monotonic() - cleanup_start,
                               cleanupExceededWholeDeadline=time.monotonic() >= self.end)
                if not pid or remaining:
                    receipt['cleanupFailure'] = '2-second original-group cleanup incomplete; leader ownership retained'
                    error = error or receipt['cleanupFailure']
                elif child.returncode != 0 or usage.ru_maxrss * 1024 > RSS:
                    error = error or 'nonzero exit or terminal RSS cap'
                if time.monotonic() >= self.end or self.interrupted:
                    error = error or 'whole cap or interruption during cleanup'
            receipt.update(failure=error, seenPids=sorted(seen), peakObservedGroupRssBytes=peak,
                           peakObservedProcessHwmBytes=hwm, elapsedSecondsForCapOnly=time.monotonic() - start)
            for name, path in [('stdout', stdout), ('stderr', stderr)]:
                if path.exists():
                    receipt[name] = {'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path)}
            write(self.root / 'command-receipts.json', self.receipts)
        if error:
            raise RuntimeError(label + ': ' + error)
        self.budget()
        return stdout
