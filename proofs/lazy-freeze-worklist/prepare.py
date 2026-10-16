"""Finite actual-codec bundle admission; importing this file launches nothing.

CLI: prepare.py PROOF_DIR ADMISSION_DIR --node NODE --bun BUN
The output directory must be new. Exactly two bundle builds and four compiled
regression commands may run. No study, pilot, retry or installation runs here.

Shared API for run.py: sha/read/write, effective_headroom(),
check_ambient_config(cwd), and
Supervisor(output, labels=()). labels maps absolute paths to logical labels.
Supervisor.run(label, argv, cwd, deadline, wall, rss_limit=RSS_LIMIT) returns a
receipt or raises after bounded cleanup. deadline uses time.monotonic(). The
caller owns its whole-phase alarm and must include final serialization in it.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import subprocess
import sys
import time

from headroom import effective_memory

GIB = 1 << 30
RSS_LIMIT = GIB
MIN_AVAILABLE = 2 * GIB
WHOLE_SECONDS = 240
COMMAND_SECONDS = 30
CLEANUP_SECONDS = 2
POLL_SECONDS = 0.05
# All commands use the same minimal environment. Inherited loader/preload,
# heap, GC and engine tuning options cannot silently alter either arm.
CHILD_ENVIRONMENT = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                     'LC_ALL': 'C.UTF-8', 'CI': '1', 'NO_COLOR': '1', 'DO_NOT_TRACK': '1'}
ARMS = ('baseline', 'candidate')
ENGINES = ('node', 'bun')
RUNTIME_PINS = {
    'node': {'sha256': '8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d', 'version': 'v22.16.0'},
    'bun': {'sha256': 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c', 'version': '1.4.2'},
}
CLOSURE_PINS = {
    'codec.ts': 'b8db477ef09b39140604a89a6550a470ca03bb14447b82c1bebbb4094bad0164',
    'utf8.ts': '68d26ddad81f106d9cc463f1212085210bdb3f0d43c9a0cfa319adc1f9c260e3',
    'types.ts': '9deafce9cdcad8a0676c5c930ef8e069aac76391a2fea2ce8f0a13a443a8ba5e',
}
FREEZE_PINS = {
    'baseline': 'dd8de05df67a8770eff048b28b9697d20a3ef4ef87bfabfff7d7f5a6f01a8ec2',
    'candidate': 'f12919fb7cf31f2a276b8a83f9b66410dbe24d57314f7c418c67aa7e0a2e568e',
}
REGRESSION_CASES = [
    'flat-root-identity-values-and-descriptors',
    'object-values-snapshot-before-push',
    'first-push-throws-before-parent-freeze',
    'swallowed-write-uses-inherited-getter',
    'reentrant-traversal-keeps-separate-stacks',
    'parent-first-lifo-freeze-order',
    'values-getter-throws-before-any-push',
    'parent-freeze-throws-before-child-visit',
]


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


def effective_headroom():
    """Return sanitized numeric accounting from the unchanged public guard."""
    accounting = effective_memory()
    return {'effectiveAvailableBytes': accounting['effectiveAvailableBytes'],
            'effectiveLimitBytes': accounting['effectiveLimitBytes'],
            'hostTotalBytes': accounting['host']['MemTotal'],
            'hostAvailableBytes': accounting['host']['MemAvailable'],
            'hostLogicalCpuCount': accounting['cpu']['hostLogicalCount'],
            'affinityCpuCount': accounting['cpu']['affinityCount'],
            'effectiveCpuBudget': accounting['cpu']['effectiveCpuBudget']}


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


def authenticate_sources(proof, manifest):
    require(isinstance(manifest, dict) and manifest, 'source manifest must be a nonempty flat object')
    for name, digest in manifest.items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts and str(relative) == name,
                'source manifest path must be canonical and relative')
        require(isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest), 'invalid source digest')
        path = proof / relative
        require(path.is_file() and not any(part.is_symlink() for part in [path, *path.parents]
                                          if part == proof or part.is_relative_to(proof)),
                'source file absent or symlinked: ' + name)
        require(sha(path) == digest, 'source authentication failed: ' + name)
    required = {'prepare.py', 'headroom.py', 'entry.ts', 'regressions.mjs',
                'subject.mjs', 'run.py', 'analyze.py', 'METHOD.md', 'dependencies/tsconfig.json'}
    expected_names = {*CLOSURE_PINS, 'freeze-json.ts', 'entry.ts'}
    for arm in ARMS:
        directory = proof / 'sources' / arm
        require({path.name for path in directory.iterdir()} == expected_names,
                'source arm must contain only the pinned codec closure and entry')
        expected = {**CLOSURE_PINS, 'freeze-json.ts': FREEZE_PINS[arm], 'entry.ts': sha(proof / 'entry.ts')}
        for name, digest in expected.items():
            relative = 'sources/' + arm + '/' + name
            required.add(relative)
            require(sha(proof / relative) == digest, 'exact arm source differs: ' + relative)
    require(required.issubset(manifest), 'source manifest omits an execution input')
    return dict(sorted(manifest.items()))


def check_bundle(path):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 128 * 1024,
            'standalone codec artifact absent, symlinked or too large')
    text = path.read_text()
    require(text.count('\n') >= 20, 'non-minified bundle required')
    require(not re.search(r'\b(?:import\s*\(|require\s*\(|import\s+[^;]*from\s*|export\s+[^;]*from\s*)', text),
            'codec artifact has a residual runtime dependency')
    exports = re.findall(r'\bexport\s*\{([^}]+)\}', text)
    require(len(exports) == 1 and all(re.search(r'\b' + name + r'\b', exports[0])
                                    for name in ('freezeJSON', 'getCodec')),
            'codec artifact lacks expected ESM exports')
    return {'path': path.name, 'file': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size}


def regression_result(output, label, arm, artifact_hash):
    rows = [json.loads(line) for line in (output / (label + '.stdout')).read_text().splitlines()]
    require(len(rows) == 1, 'compiled regression must produce one complete result')
    result = rows[0]
    require(result.get('status') == 'passed' and result.get('sourceSha256') == artifact_hash,
            'compiled regression source/status mismatch')
    require(result.get('cases') == REGRESSION_CASES, 'compiled regression cases differ')
    require(result.get('expectedDifference') == {'name': 'initial-pop-replacement', 'arm': arm,
            'threwSentinel': arm == 'baseline', 'rootFrozen': arm == 'candidate'},
            'compiled regression lost the explicit initial-pop compatibility boundary')
    require(result.get('performanceInference') is False, 'regression is not a performance result')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('proof_dir', type=Path)
    parser.add_argument('admission_dir', type=Path)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--bun', default=shutil.which('bun'))
    args = parser.parse_args()
    proof, output = args.proof_dir.resolve(), args.admission_dir.resolve()
    require(args.node and args.bun, 'both pinned runtime executables are required')
    tools = {name: Path(getattr(args, name)).resolve(strict=True) for name in ENGINES}
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    deadline = started + WHOLE_SECONDS
    labels = [(str(proof), '$PROOF'), (str(output), '$ADMISSION'),
              *[(str(path), '$' + name.upper()) for name, path in tools.items()]]
    supervisor = Supervisor(output, labels)
    result = {'schemaVersion': 1, 'status': 'preparing', 'performanceInference': False,
              'startedUnix': time.time(), 'commandsStarted': 0,
              'limits': {'wholeSeconds': WHOLE_SECONDS, 'commandSeconds': COMMAND_SECONDS,
                         'cleanupReserveSeconds': CLEANUP_SECONDS, 'maxCommands': 6,
                         'sampledGroupRssBytes': RSS_LIMIT, 'minEffectiveAvailableBytes': MIN_AVAILABLE,
                         'sampleIntervalSeconds': POLL_SECONDS, 'hardCgroupCap': False}}
    write(output / 'admission.json', result)

    def alarm(number, frame):
        if supervisor.active is not None:
            supervisor.on_signal(number, frame)
        else:
            raise TimeoutError('whole admission cap with cleanup reserve')

    def check():
        require(not supervisor.interrupted and time.monotonic() < deadline - CLEANUP_SECONDS,
                'whole admission cap or interruption')
        require(sha(proof / 'source-pins.json') == result['sourceManifestSha256'], 'source manifest changed')
        authenticate_sources(proof, sources)
        for name, path in tools.items():
            require(sha(path) == RUNTIME_PINS[name]['sha256'], 'runtime executable differs: ' + name)
        for bundle in result.get('bundles', {}).values():
            require(sha(output / bundle['path']) == bundle['sha256'], 'artifact changed after build')

    signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, WHOLE_SECONDS - CLEANUP_SECONDS)
    try:
        require(sys.platform == 'linux' and platform.machine() == 'x86_64', 'Linux x86_64 pins required')
        sources = read(proof / 'source-pins.json')
        result['sourceManifestSha256'] = sha(proof / 'source-pins.json')
        result['sources'] = authenticate_sources(proof, sources)
        result['methodSha256'] = sha(proof / 'METHOD.md')
        result['driverSha256'] = sha(proof / 'subject.mjs')
        result['regressionDriverSha256'] = sha(proof / 'regressions.mjs')
        result['tools'] = {name: {'path': '$' + name.upper(), **RUNTIME_PINS[name],
                                  'versionVerification': 'exact executable SHA-256 pin'} for name in ENGINES}
        result['headroom'] = effective_headroom()
        require(result['headroom']['effectiveAvailableBytes'] >= MIN_AVAILABLE,
                'less than 2 GiB effective available memory at admission')
        result['compiler'] = {'runtime': 'bun', 'sha256': RUNTIME_PINS['bun']['sha256'],
                              'version': RUNTIME_PINS['bun']['version'], 'minified': False,
                              'target': 'node', 'format': 'esm',
                              'tsconfigSha256': sha(proof / 'dependencies/tsconfig.json'),
                              'argvTemplate': ['$BUN', 'build', 'entry.ts', '--target=node', '--format=esm',
                                               '--tsconfig-override', '$PROOF/dependencies/tsconfig.json',
                                               '--outfile', '$ADMISSION/{arm}.mjs'],
                              'cwdTemplate': '$PROOF/sources/{arm}'}
        result['bundles'] = {}
        for arm in ARMS:
            check()
            argv = [str(tools['bun']), 'build', 'entry.ts', '--target=node', '--format=esm',
                    '--tsconfig-override', str(proof / 'dependencies/tsconfig.json'),
                    '--outfile', str(output / (arm + '.mjs'))]
            supervisor.run('build-' + arm, argv, proof / 'sources' / arm,
                           deadline - CLEANUP_SECONDS, COMMAND_SECONDS)
            result['bundles'][arm] = check_bundle(output / (arm + '.mjs'))
            check()
            write(output / 'admission.json', result)
        regressions = {engine: {} for engine in ENGINES}
        for engine in ENGINES:
            for arm in ARMS:
                check()
                label = 'regressions-' + engine + '-' + arm
                artifact = result['bundles'][arm]
                argv = [str(tools[engine]), str(proof / 'regressions.mjs'),
                        str(output / artifact['path']), artifact['sha256'], arm]
                supervisor.run(label, argv, proof, deadline - CLEANUP_SECONDS, COMMAND_SECONDS)
                regressions[engine][arm] = {'command': label,
                    'result': regression_result(output, label, arm, artifact['sha256'])}
                check()
        require(len(supervisor.receipts) == 6, 'admission command count differs')
        result['regressions'] = regressions
        result['status'] = 'passed'
    except BaseException as error:
        result['status'] = 'incomplete'
        result['failureType'] = type(error).__name__
        # Validation failures are authored static/relative descriptions. OS
        # exceptions are recorded by type only to prevent path disclosure.
        result['failure'] = supervisor.display(str(error)) if isinstance(error, (ValueError, TimeoutError)) else type(error).__name__
    finally:
        result['commandsStarted'] = len(supervisor.receipts)
        result['commands'] = supervisor.receipts
        result['endedUnix'] = time.time()
        result['elapsedSecondsForSafety'] = time.monotonic() - started
        result['ownedGroupUnreaped'] = supervisor.active is not None
        if result['elapsedSecondsForSafety'] > WHOLE_SECONDS or supervisor.interrupted or supervisor.active is not None:
            result['status'] = 'incomplete'
            result['failure'] = result.get('failure', 'whole admission cap, interruption or unreaped owned group')

        def reporting_alarm(_number, _frame):
            raise TimeoutError('whole admission cap during final evidence serialization')

        # The first alarm reserves two seconds; the deadline alarm remains
        # active through final fsync/replace and the concise terminal report.
        signal.signal(signal.SIGALRM, reporting_alarm)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            result['status'] = 'incomplete'
            result['failure'] = 'whole admission cap before terminal report'
        else:
            signal.setitimer(signal.ITIMER_REAL, remaining)
            try:
                write(output / 'admission.json', result)
                print(json.dumps({'status': result['status'], 'commandsStarted': result['commandsStarted'],
                                  'performanceInference': False}), flush=True)
            except BaseException:
                # Retain the previous partial admission file, with no retry or
                # claim that terminal evidence completed within the cap.
                result['status'] = 'incomplete'
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
