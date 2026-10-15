"""Finite command/cleanup routines extracted from the reviewed ordinary gate.
No entry point, subject imports, correctness commands or measurements.
"""
import json, os, re, signal, subprocess, time
from pathlib import Path
from supervisor import sha, read, write
RSS_LIMIT = 4294967296

def signal_group(group, number):
    try: os.killpg(group, number)
    except ProcessLookupError: pass

def group_memory(group):
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group: continue
            values = {name: int(value) * 1024 for name, value in re.findall(r'^(VmRSS|VmHWM):\s+(\d+) kB$', (path / 'status').read_text(), re.M)}
            rows.append({'pid': int(path.name), **values})
        except (FileNotFoundError, ProcessLookupError): pass
    return rows

class Commands:
    def event(self, row):
        with (self.artifact / 'progress.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        print(json.dumps(row), flush=True)

    def command(self, label, argv, cwd, cap, extra_env=None):
        self.result.update({'activeCommand': label, 'activeCommandStarted': False})
        self.check_inputs()
        assert not self.interrupted
        started = time.monotonic()
        limit = min(self.deadline, started + cap)
        assert limit > started, 'phase budget exhausted before ' + label
        logs = self.artifact / 'logs'; logs.mkdir(exist_ok=True)
        receipt = {'label': label, 'argv': [str(value) for value in argv], 'cwd': str(cwd),
                   'capSeconds': cap, 'effectiveCapSeconds': limit - started,
                   'sampledGroupRssLimitBytes': RSS_LIMIT, 'hardCgroupCap': False,
                   'peakObservedGroupRssBytes': 0, 'peakObservedProcessHwmBytes': 0,
                   'cleanupSignals': [], 'environmentOverrides': extra_env or {}}
        self.receipts.append(receipt)
        write(self.artifact / 'command-receipts.json', self.receipts)
        reason = None; seen = set(); next_progress = started + 15
        with (logs / (label + '.stdout')).open('xb') as out, (logs / (label + '.stderr')).open('xb') as err:
            child = subprocess.Popen(receipt['argv'], cwd=cwd, env={**self.env, **(extra_env or {})},
                                     stdout=out, stderr=err, start_new_session=True)
            self.active = child; receipt['ownedProcessGroup'] = child.pid
            self.result['activeCommandStarted'] = True
            if label in self.result['unrunCommands']:
                self.result['unrunCommands'].remove(label)
            self.event({'event': 'command-start', 'label': label})
            while True:
                exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if exited:
                    if time.monotonic() > limit: reason = reason or 'wall cap exceeded at terminal poll'
                    break
                rows = group_memory(child.pid)
                seen.update(row['pid'] for row in rows)
                rss = sum(row.get('VmRSS', 0) for row in rows)
                hwm = max([row.get('VmHWM', 0) for row in rows] or [0])
                receipt['peakObservedGroupRssBytes'] = max(receipt['peakObservedGroupRssBytes'], rss)
                receipt['peakObservedProcessHwmBytes'] = max(receipt['peakObservedProcessHwmBytes'], hwm)
                if self.interrupted: reason = reason or 'interrupted'
                if time.monotonic() >= limit: reason = reason or 'wall cap exceeded'
                if max(rss, hwm) > RSS_LIMIT: reason = reason or 'sampled RSS cap exceeded'
                if reason and not receipt['cleanupSignals']:
                    signal_group(child.pid, signal.SIGKILL)
                    receipt['cleanupSignals'].append('SIGKILL original group: ' + reason)
                if reason and time.monotonic() > limit + 2:
                    raise RuntimeError('original child did not terminate after kill')
                if time.monotonic() >= next_progress:
                    self.event({'event': 'command-running', 'label': label,
                                'stdoutBytes': (logs / (label + '.stdout')).stat().st_size,
                                'stderrBytes': (logs / (label + '.stderr')).stat().st_size})
                    write(self.artifact / 'command-receipts.json', self.receipts)
                    next_progress = time.monotonic() + 15
                time.sleep(0.02)
        descendants = lambda: [row for row in group_memory(child.pid) if row['pid'] != child.pid]
        leftover = descendants()
        if leftover:
            signal_group(child.pid, signal.SIGKILL)
            receipt['cleanupSignals'].append('SIGKILL descendants before leader reap')
            stop = min(self.end, time.monotonic() + 1)
            while descendants() and time.monotonic() < stop: time.sleep(0.01)
        remaining = descendants()
        # WNOWAIT retained the original identity. Clear signal authority before reaping.
        self.active = None
        pid, status, usage = os.wait4(child.pid, 0)
        child.returncode = os.waitstatus_to_exitcode(status)
        if usage.ru_maxrss * 1024 > RSS_LIMIT: reason = reason or 'terminal RSS high water exceeded'
        if time.monotonic() >= limit: reason = reason or 'wall cap exceeded at terminal cleanup'
        receipt.update({'exitCode': child.returncode, 'failure': reason,
                        'elapsedSecondsForCapOnly': time.monotonic() - started,
                        'seenPids': sorted(seen), 'leftoverDescendantsBeforeCleanup': leftover,
                        'descendantsAfterCleanup': remaining, 'leaderReapedAfterCleanup': True,
                        'wait4MaxRssBytes': usage.ru_maxrss * 1024})
        for stream in ['stdout', 'stderr']:
            path = logs / (label + '.' + stream)
            receipt[stream] = {'sha256': sha(path), 'bytes': path.stat().st_size}
        write(self.artifact / 'command-receipts.json', self.receipts)
        self.event({'event': 'command-end', 'label': label, 'exitCode': child.returncode, 'failure': reason})
        assert not reason and child.returncode == 0 and not leftover and not remaining and not self.interrupted, 'command failed; no retry: ' + label
        self.check_inputs()
        return receipt

    def output(self, label):
        return (self.artifact / 'logs' / (label + '.stdout')).read_text().strip()

    def cleanup(self):
        if self.active is None: return
        owned = self.active
        signal_group(owned.pid, signal.SIGKILL)
        stop = min(self.end, time.monotonic() + 2)
        while not os.waitid(os.P_PID, owned.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) and time.monotonic() < stop:
            time.sleep(0.01)
        descendants = lambda: [row for row in group_memory(owned.pid) if row['pid'] != owned.pid]
        if descendants():
            signal_group(owned.pid, signal.SIGKILL)
            while descendants() and time.monotonic() < stop: time.sleep(0.01)
        remains = descendants()
        self.active = None
        pid, status, usage = os.wait4(owned.pid, os.WNOHANG)
        if pid: owned.returncode = os.waitstatus_to_exitcode(status)
        self.result['exceptionCleanup'] = {'leaderReapedAfterCleanup': bool(pid), 'descendantsAfterCleanup': remains}
        for receipt in self.receipts:
            if receipt.get('ownedProcessGroup') == owned.pid:
                receipt['cleanupSignals'].append('SIGKILL exception cleanup before leader reap')
                receipt.update({'exitCode': owned.returncode, 'failure': receipt.get('failure') or 'exception while command active',
                                'descendantsAfterCleanup': remains, 'leaderReapedAfterCleanup': bool(pid)})
                if pid: receipt['wait4MaxRssBytes'] = usage.ru_maxrss * 1024
                for stream in ['stdout', 'stderr']:
                    path = self.artifact / 'logs' / (receipt['label'] + '.' + stream)
                    if path.exists(): receipt[stream] = {'sha256': sha(path), 'bytes': path.stat().st_size}
        assert pid and not remains, 'exception cleanup incomplete'
