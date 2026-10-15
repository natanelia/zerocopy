"""Exact-source correctness admission and one fixed hosted latency screen on Linux."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import statistics
import subprocess
import sys
import time

BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
CASES = ['P', 'L1', 'E0', 'E1', 'W24', 'U1', 'F']
METHOD_SHA256 = '552387a3eb0494ccb90e75052c2205d21822bbbadbd604fe3e21742e52e70d79'
PRODUCTION_PINS = {
    'worker.ts': {'baseline': '5bb4e740785dd133199c82f23f7eb462801a4ad285b43509e3badcd0e6b05cea',
                  'candidate': 'cdd49268cc3d91a66b1728e8bc6e2d5f76a0d0c4308546788f94a3d2de4aaaef'},
    'worker-protocol.ts': {'baseline': '21868d3b9b0d2479837b733f342a2980adbe2dadee0ea7692a27611be73085d2',
                           'candidate': '693fbcdc1d40a505c1d49e7716bdf66531562cf8c45436c9507224c17e65261c'},
}
UNCHANGED_PINS = {
    'shared.ts': 'fd08edcab8aed06bed9401edc16c1da67ca10a5c8c1601f127461dd17d3943e3',
    'worker.test.ts': 'f6dc5ed3b72b4eee16e87f99a97e955877d699ca462e6d42ea8591d5da393c9c',
}
FOCUSED_TEST = 'worker-empty-recipient.test.ts'
FOCUSED_SHA256 = '9c7445f4c2955925b65123a4a3e939901c3a4e8619f9e0969929c11aa07e8619'
ENTRIES = {'node': ['dist/shared.js', 'dist/worker.js'], 'bun': ['shared.ts', 'worker.ts']}
ORDERS = ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB']
SCIENCE_SECONDS = 870
CHILD_SECONDS = 90
SCIENCE_RSS = 2 * 1024 ** 3
ADMISSION_SECONDS = 1620
ADMISSION_RSS = 4 * 1024 ** 3
POLL_SECONDS = .05

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()

def read(path): return json.loads(Path(path).read_text())
def write(path, value): Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
def command(argv, cwd, deadline, supervisor):
    remaining = deadline - time.monotonic()
    assert remaining > 2, 'Admission deadline before metadata command and cleanup'
    label = 'metadata-' + str(len(supervisor.receipts) + 1)
    supervisor.run(label, argv, cwd, deadline, min(10, remaining), ADMISSION_RSS)
    return (supervisor.output / (label + '.stdout')).read_text().strip()

def tree(root, excluded=()):
    result = {}
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(name for name in folders if name not in excluded)
        for name in sorted(files + [name for name in folders if (Path(directory) / name).is_symlink()]):
            path = Path(directory) / name
            relative = str(path.relative_to(root))
            result[relative] = {'link': os.readlink(path)} if path.is_symlink() else {'sha256': sha(path)}
    return result

def group_members(group):
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group: continue
            match = re.search(r'^VmRSS:\s+(\d+) kB$', (path / 'status').read_text(), re.M)
            rows.append({'pid': int(path.name), 'rss': int(match[1]) * 1024 if match else 0, 'state': fields[0]})
        except (FileNotFoundError, ProcessLookupError): pass
    return rows

class Supervisor:
    def __init__(self, output, labels=()):
        self.output = output
        self.labels = sorted(labels, key=lambda pair: -len(pair[0]))
        self.receipts = []
        self.interrupted = None
        self.active = None
        for number in [signal.SIGINT, signal.SIGTERM]: signal.signal(number, self.on_signal)

    def on_signal(self, number, _frame): self.interrupted = number

    def display(self, text):
        for path, label in self.labels: text = text.replace(path, label)
        return text

    def run(self, label, argv, cwd, deadline, wall, rss_limit, ready=False):
        assert not self.interrupted and time.monotonic() < deadline, 'deadline or interruption before launch'
        receipt = {'label': label, 'argv': [self.display(x) for x in argv], 'cwd': self.display(str(cwd)), 'startedUnix': time.time(),
                   'wallSeconds': wall, 'sampledGroupRssLimitBytes': rss_limit, 'sampleIntervalSeconds': POLL_SECONDS,
                   'peakObservedGroupRssBytes': 0, 'cleanupSignals': [], 'spawnToReadyNs': None}
        self.receipts.append(receipt)
        write(self.output / 'commands.json', self.receipts)
        out_path = self.output / (label + '.stdout')
        err_path = self.output / (label + '.stderr')
        start = time.monotonic()
        # Reserve two seconds for cleanup inside both the child and whole-study caps.
        stop = min(start + wall, deadline) - 2
        child = None
        failure = None
        try:
            with out_path.open('xb') as out, err_path.open('xb') as err:
                child = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=err, start_new_session=True)
                self.active = child
                receipt['ownedProcessGroup'] = child.pid
                while True:
                    if ready and receipt['spawnToReadyNs'] is None:
                        lines = out_path.read_text().splitlines()
                        if lines:
                            try: event = json.loads(lines[0])
                            except json.JSONDecodeError: event = {}
                            if event.get('event') == 'ready': receipt['spawnToReadyNs'] = (time.monotonic() - start) * 1e9
                    rows = group_members(child.pid)
                    sampled = sum(row['rss'] for row in rows)
                    receipt['peakObservedGroupRssBytes'] = max(receipt['peakObservedGroupRssBytes'], sampled)
                    if sampled > rss_limit: failure = 'sampled group RSS ceiling'
                    if self.interrupted: failure = 'interrupted'
                    if time.monotonic() >= stop: failure = failure or 'wall cap'
                    if failure: break
                    if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT): break
                    time.sleep(POLL_SECONDS)
        except BaseException as error:
            failure = self.display(repr(error))
        finally:
            if child is not None:
                # Never reap the leader before checking descendants: retain ownership.
                leftover = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                receipt['descendantsBeforeCleanup'] = leftover
                exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if failure or leftover or not exited:
                    failure = failure or 'unexpected surviving descendants'
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    receipt['cleanupSignals'].append('SIGKILL original group')
                cleanup_stop = min(deadline, start + wall, time.monotonic() + 2)
                while time.monotonic() < cleanup_stop:
                    exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    descendants = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                    if exited and not descendants: break
                    time.sleep(.01)
                receipt['descendantsAfterCleanup'] = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                if pid:
                    child.returncode = os.waitstatus_to_exitcode(status)
                    receipt['exitCode'] = child.returncode
                else: failure = failure or 'leader not reaped by cleanup deadline'
                receipt['leaderReaped'] = bool(pid)
                if receipt['descendantsAfterCleanup']: failure = failure or 'descendants remain'
                self.active = None
            receipt.update({'endedUnix': time.time(), 'elapsedSecondsForSafety': time.monotonic() - start, 'failure': failure})
            for path in [out_path, err_path]:
                if path.exists(): receipt[path.suffix[1:]] = {'file': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size}
            write(self.output / 'commands.json', self.receipts)
        assert not failure and receipt.get('exitCode') == 0 and not self.interrupted, f'No retry after failure: {label}: {failure}'
        return receipt

def events(output, label):
    rows = [json.loads(line) for line in (output / (label + '.stdout')).read_text().splitlines()]
    assert rows[0]['event'] == 'ready'
    result = [row for row in rows if row.get('event') == 'result']
    assert len(result) == 1 and rows[-1] is result[0]
    assert set(result[0]['cases']) == set(CASES)
    # Keep all child fixture/copy metadata and every peer drain field verbatim.
    # stdout and analysis-input.json retain them; analysis never rewrites batches.
    return result[0]

def interval(ratios):
    assert len(ratios) == 6 and all(math.isfinite(x) and x > 0 for x in ratios)
    logs = list(map(math.log, ratios))
    center = statistics.mean(logs)
    half = 2.570582 * statistics.stdev(logs) / math.sqrt(6)
    return {'ratios': ratios, 'ratio': math.exp(center), 'lower': math.exp(center - half), 'upper': math.exp(center + half)}

def analyze(records, calibrations):
    assert len(records) == 36
    engines, unresolved, regressions, blockers = {}, [], [], []
    for engine in ['node', 'bun']:
        rows = {}
        for case in CASES:
            blocks = []
            for index, order in enumerate(ORDERS):
                group = [r for r in records if r['engine'] == engine and r['block'] == index + 1]
                assert len(group) == 3 and {r['arm'] for r in group} == set('ABC')
                values = {}
                for record in group:
                    batches = record['result']['cases'][case]['measured']
                    assert len(batches) == 9
                    xs = [b['elapsedNs'] / b['count'] if isinstance(b['elapsedNs'], (int, float)) else None for b in batches]
                    if not all(x is not None and math.isfinite(x) and x > 0 for x in xs):
                        values[record['arm']] = {'nsPerOp': None, 'cv': None, 'drift': None, 'reasons': ['invalid duration']}
                        continue
                    cv = statistics.stdev(xs) / statistics.mean(xs)
                    drift = statistics.mean(xs[-3:]) / statistics.mean(xs[:3])
                    reasons = []
                    if any(b['elapsedNs'] < 10e6 for b in batches): reasons.append('batch below 10 ms')
                    if cv > .25: reasons.append('batch CV above 25%')
                    if drift < .85 or drift > 1.15: reasons.append('batch drift outside 0.85–1.15')
                    values[record['arm']] = {'nsPerOp': statistics.mean(xs), 'cv': cv, 'drift': drift, 'reasons': reasons}
                later, earlier = ('A', 'B') if order.index('A') > order.index('B') else ('B', 'A')
                def ratio(a, b):
                    return values[a]['nsPerOp'] / values[b]['nsPerOp'] if values[a]['nsPerOp'] is not None and values[b]['nsPerOp'] is not None else None
                blocks.append({'block': index + 1, 'order': order, 'values': values,
                               'paired': ratio('C', 'B'), 'aa': ratio('A', 'B'), 'chronologicalBaseline': ratio(later, earlier)})
            row = {}
            for name, key in [('candidate', 'paired'), ('aa', 'aa'), ('chronologicalBaseline', 'chronologicalBaseline')]:
                ratios = [b[key] for b in blocks]
                row[name] = interval(ratios) if all(x is not None for x in ratios) else {'ratios': ratios, 'ratio': None, 'lower': None, 'upper': None, 'unresolved': 'invalid duration'}
            row.update({'blocks': blocks, 'calibrationResolved': calibrations[engine]['cases'][case]['accepted'],
                        'qualityResolved': all(not v['reasons'] for b in blocks for v in b['values'].values()),
                        'absoluteNsPerOp': {arm: [b['values'][arm]['nsPerOp'] for b in blocks] for arm in 'ABC'}})
            row['bias'] = any(row[name]['lower'] is not None and (row[name]['lower'] > 1.05 or row[name]['upper'] < .95) for name in ['aa', 'chronologicalBaseline'])
            rows[case] = row
        primary = rows['P']
        if not (primary['candidate']['ratio'] is not None and primary['candidate']['ratio'] <= .95 and primary['candidate']['upper'] <= .95): blockers.append(engine + ': P does not meet 5% criterion')
        if not primary['calibrationResolved'] or not primary['qualityResolved'] or primary['bias'] or rows['F']['bias']: blockers.append(engine + ': P admission or P/F A/A bias')
        for case in CASES[1:]:
            row = rows[case]
            if row['candidate']['lower'] is not None and row['candidate']['lower'] > 1.02: regressions.append(engine + ':' + case)
            if row['candidate']['upper'] is None or row['candidate']['upper'] > 1.02 or not row['calibrationResolved'] or not row['qualityResolved'] or row['bias']: unresolved.append(engine + ':' + case)
        engines[engine] = rows
    lead = 'promising hosted recipient-free publication-latency lead, with unresolved controls: ' + ', '.join(unresolved + ['first-publication/startup'])
    return {'engines': engines, 'regressions': regressions, 'unresolvedControls': unresolved, 'blockers': blockers,
            'verdict': 'parked: control regression' if regressions else 'no qualified hosted lead' if blockers else lead,
            'firstPublicationAndStartup': [{key: r[key] for key in ['engine', 'block', 'arm', 'spawnToReadyNs', 'startedUnix', 'endedUnix']} | {'firstPublishNs': r['result']['firstPublishNs']} for r in records],
            'firstPublicationStatus': 'unresolved descriptive observations; apparent material adverse result requires review before promotion',
            'limitations': ['six process blocks per engine; batches are not independent replicates', 'shared host and sampled supervisor overhead', 'peer rows measure synchronous latest-mode burst submission; draining and reader callbacks are outside timing', 'no memory, end-to-end worker delivery, worker-computation, application-wide, portability or full no-regression claim']}

def runtime_pins(node, bun, deadline, supervisor):
    versions = {'node': command([node, '--version'], Path.cwd(), deadline, supervisor), 'bun': command([bun, '--version'], Path.cwd(), deadline, supervisor), 'python': sys.version}
    assert versions['node'] == 'v22.16.0' and versions['bun'] == '1.4.2'
    return {name: {'path': path, 'sha256': sha(path), 'version': versions[name]} for name, path in [('node', node), ('bun', bun), ('python', str(Path(sys.executable).resolve()))]}

def main():
    candidate, baseline, output = map(lambda p: Path(p).resolve(), sys.argv[1:])
    proof = candidate / 'proofs/empty-recipient'
    output.mkdir(parents=True, exist_ok=False)
    node, bun = (str(Path(shutil.which(name)).resolve()) for name in ['node', 'bun'])
    supervisor = Supervisor(output, [(str(candidate), '$CANDIDATE'), (str(baseline), '$BASELINE'), (str(output), '$EVIDENCE'), (node, '$NODE'), (bun, '$BUN')])
    status = {'status': 'preparing', 'performanceClaim': False, 'studyChildrenStarted': 0}
    write(output / 'status.json', status)
    started = time.monotonic()
    admission_deadline = started + ADMISSION_SECONDS
    science_start = None
    manifest = None
    phase = 'admission'
    def whole_alarm(number, _frame):
        if supervisor.active is not None: supervisor.interrupted = number
        else: raise TimeoutError(phase + ' whole wall cap; cleanup reserve')
    signal.signal(signal.SIGALRM, whole_alarm)
    signal.setitimer(signal.ITIMER_REAL, ADMISSION_SECONDS - 2)
    try:
        assert command(['git', 'rev-parse', 'HEAD'], baseline, admission_deadline, supervisor) == BASE
        commit = command(['git', 'rev-parse', 'HEAD'], candidate, admission_deadline, supervisor)
        assert commit == os.environ['GITHUB_SHA']
        assert command(['git', 'rev-parse', 'HEAD^'], candidate, admission_deadline, supervisor) == BASE
        base_files = read(proof / 'baseline-sources.json')
        overlay = read(proof / 'source-pins.json')
        changed = set(command(['git', 'diff', '--name-only', BASE, 'HEAD'], candidate, admission_deadline, supervisor).splitlines())
        assert changed == set(overlay) | {'proofs/empty-recipient/source-pins.json'}
        for relative, digest in base_files.items():
            assert sha(baseline / relative) == digest, relative
            assert sha(candidate / relative) == overlay.get(relative, digest), relative
        for relative, digest in overlay.items(): assert sha(candidate / relative) == digest, relative
        assert sha(proof / 'METHOD.md') == METHOD_SHA256
        assert {relative for relative, digest in base_files.items() if overlay.get(relative, digest) != digest} == set(PRODUCTION_PINS)
        for relative, pins in PRODUCTION_PINS.items():
            assert base_files[relative] == sha(baseline / relative) == pins['baseline'], relative
            assert overlay[relative] == sha(candidate / relative) == pins['candidate'], relative
        for relative, digest in UNCHANGED_PINS.items():
            assert sha(baseline / relative) == sha(candidate / relative) == digest, relative
        assert sha(candidate / FOCUSED_TEST) == FOCUSED_SHA256
        # Same focused fixture is admitted in both complete suites; production stays pinned.
        shutil.copyfile(candidate / FOCUSED_TEST, baseline / FOCUSED_TEST)
        dependencies = proof / 'dependencies/node_modules'
        assert dependencies.is_dir(), 'Missing pre-provisioned locked dependencies'
        for root in [baseline, candidate]:
            assert (root / 'node_modules').is_symlink() and (root / 'node_modules').resolve() == dependencies
        tracked = command(['git', 'ls-files', '-z'], candidate, admission_deadline, supervisor).split('\0')
        tracked = [relative for relative in tracked if relative]
        source_pins = {arm: {relative: sha(root / relative) for relative in (list(base_files) + [FOCUSED_TEST] if arm == 'baseline' else tracked)} for arm, root in [('baseline', baseline), ('candidate', candidate)]}
        dep_pins = tree(dependencies, excluded=('.vite', '.vite-temp', '.cache'))
        executables = runtime_pins(node, bun, admission_deadline, supervisor)
        write(output / 'admission-inputs.json', {'sourceFiles': source_pins, 'dependencies': dep_pins,
              'executables': {name: {'command': name, 'sha256': record['sha256'], 'version': record['version']} for name, record in executables.items()},
              'dependencyLockSha256': sha(proof / 'dependencies/package-lock.json')})
        commands = []
        for arm, root in [('baseline', baseline), ('candidate', candidate)]:
            commands.extend([(arm + '-prepublishOnly', [bun, 'run', 'prepublishOnly'], root, 600),
                             (arm + '-node-worker', [node, 'proofs/node-worker.mjs'], root, 90),
                             (arm + '-typed-json-worker', [node, 'proofs/typed-json-worker.mjs'], root, 90)])
        write(output / 'admission-plan.json', [{'label': label, 'argv': [supervisor.display(x) for x in argv], 'cwd': supervisor.display(str(cwd)), 'wallSeconds': wall} for label, argv, cwd, wall in commands])
        for label, argv, cwd, wall in commands:
            supervisor.run(label, argv, cwd, admission_deadline, wall, ADMISSION_RSS)
            if label.endswith('prepublishOnly'):
                log = (output / (label + '.stdout')).read_text() + (output / (label + '.stderr')).read_text()
                for name, count in [(FOCUSED_TEST, 7), ('worker.test.ts', 35)]:
                    assert re.search(re.escape(name) + r'[^\n]*\(' + str(count) + r' tests?\)', log), f'Focused suite not observed: {name}'
        artifacts = {arm: {**{str(path.relative_to(root)): sha(path) for path in root.glob('*.wasm')}, **{str(path.relative_to(root)): sha(path) for path in (root / 'dist').rglob('*') if path.is_file()}} for arm, root in [('baseline', baseline), ('candidate', candidate)]}
        expected_wasm = {'persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm', 'linked-list.wasm', 'singly-linked-list.wasm',
                         'doubly-linked-list.wasm', 'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm',
                         'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'}
        assert all({name for name in files if '/' not in name and name.endswith('.wasm')} == expected_wasm and all(entry in files for entry in ENTRIES['node']) for files in artifacts.values())
        manifest = {'baselineCommit': BASE, 'candidateCommit': commit, 'candidateTree': command(['git', 'rev-parse', 'HEAD^{tree}'], candidate, admission_deadline, supervisor),
                    'sourceFiles': source_pins, 'artifacts': artifacts, 'executables': {name: {'command': name, 'sha256': record['sha256'], 'version': record['version']} for name, record in executables.items()}, 'dependencies': dep_pins,
                    'lockSha256': sha(proof / 'dependencies/package-lock.json'), 'methodSha256': sha(proof / 'METHOD.md'),
                    'buildFlagsSourceSha256': sha(candidate / 'scripts/build-wasm.mjs'),
                    'entries': ENTRIES,
                    'host': {'os': os.uname().sysname, 'release': os.uname().release, 'architecture': os.uname().machine,
                             'cpuCount': os.cpu_count(), 'cpuModel': next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), 'unavailable'),
                             **{name: os.environ.get(name) for name in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_REPOSITORY', 'RUNNER_OS', 'RUNNER_ARCH']}},
                    'flags': {'NODE_OPTIONS': os.environ.get('NODE_OPTIONS', ''), 'BUN_OPTIONS': os.environ.get('BUN_OPTIONS', '')},
                    'admissionSeconds': time.monotonic() - started,
                    'limits': {'wholeStudySeconds': SCIENCE_SECONDS, 'perChildSeconds': CHILD_SECONDS, 'sampledGroupRssBytes': SCIENCE_RSS, 'rssSampleSeconds': POLL_SECONDS, 'maximumChildren': 38},
                    'cacheAllowance': 'node_modules/.vite, .vite-temp and .cache may change; excluded from dependency pins'}
        assert not manifest['flags']['NODE_OPTIONS'] and not manifest['flags']['BUN_OPTIONS'], 'Unexpected runtime flags'
        def verify():
            for arm, root in [('baseline', baseline), ('candidate', candidate)]:
                for relative, digest in {**source_pins[arm], **artifacts[arm]}.items(): assert sha(root / relative) == digest, (arm, relative)
            for record in executables.values(): assert sha(record['path']) == record['sha256']
            assert tree(dependencies, excluded=('.vite', '.vite-temp', '.cache')) == dep_pins
        verify()
        write(output / 'manifest.json', manifest)
        frozen_manifest_sha = sha(output / 'manifest.json')
        write(output / 'manifest-seal.json', {'sha256': frozen_manifest_sha})
        assert time.monotonic() < admission_deadline and not supervisor.interrupted
        science_start = time.monotonic()
        deadline = science_start + SCIENCE_SECONDS
        phase = 'science'
        signal.setitimer(signal.ITIMER_REAL, SCIENCE_SECONDS - 2)
        status.update({'status': 'calibrating', 'admission': 'passed', 'manifestSha256': frozen_manifest_sha})
        write(output / 'status.json', status)
        calibrations, counts_files, records = {}, {}, []
        driver = str(proof / 'latency.mjs')
        for engine, executable in [('node', node), ('bun', bun)]:
            entries = [str(baseline / relative) for relative in manifest['entries'][engine]]
            label = engine + '-calibration'
            status['studyChildrenStarted'] += 1
            supervisor.run(label, [executable, driver, 'child', *entries, 'calibrate'], baseline, deadline, CHILD_SECONDS, SCIENCE_RSS, True)
            calibrations[engine] = events(output, label)
            counts_files[engine] = output / (engine + '-counts.json')
            write(counts_files[engine], {id: calibrations[engine]['cases'][id]['count'] for id in CASES})
            write(output / 'calibrations.json', calibrations)
            assert calibrations[engine]['cases']['P']['accepted'], 'Primary P was not calibrated; no measurement'
        count_pins = {engine: sha(path) for engine, path in counts_files.items()}
        write(output / 'counts-seal.json', count_pins)
        status['status'] = 'measuring'
        for index, order in enumerate(ORDERS):
            engines = ['node', 'bun'] if index % 2 == 0 else ['bun', 'node']
            for engine in engines:
                for arm in order:
                    assert sha(counts_files[engine]) == count_pins[engine]
                    root = candidate if arm == 'C' else baseline
                    label = f'{engine}-block{index + 1}-{arm}'
                    status['studyChildrenStarted'] += 1
                    write(output / 'status.json', status)
                    receipt = supervisor.run(label, [node if engine == 'node' else bun, driver, 'child', *[str(root / relative) for relative in manifest['entries'][engine]], 'measure', str(counts_files[engine])], root, deadline, CHILD_SECONDS, SCIENCE_RSS, True)
                    result = events(output, label)
                    records.append({'engine': engine, 'block': index + 1, 'arm': arm, 'result': result, 'spawnToReadyNs': receipt['spawnToReadyNs'], 'startedUnix': receipt['startedUnix'], 'endedUnix': receipt['endedUnix']})
                    write(output / 'analysis-input.json', {'records': records, 'calibrations': calibrations})
        assert status['studyChildrenStarted'] == 38 and len(records) == 36
        analysis = analyze(records, calibrations)
        write(output / 'analysis.json', analysis)
        verify()
        assert all(sha(path) == count_pins[engine] for engine, path in counts_files.items())
        assert sha(output / 'manifest.json') == frozen_manifest_sha
        assert time.monotonic() < deadline and not supervisor.interrupted
        status.update({'status': 'complete', 'verdict': analysis['verdict'], 'performanceClaim': False, 'requiresFirstPublicationReviewAndPromotionChecks': True})
    except BaseException as error:
        status.update({'status': 'incomplete', 'error': supervisor.display(repr(error))})
        raise
    finally:
        status['admissionAndStudySecondsForSafety'] = time.monotonic() - started
        if science_start is not None: status['studySecondsForSafety'] = time.monotonic() - science_start
        write(output / 'status.json', status)
        write(output / 'evidence-sha256.json', {path.name: sha(path) for path in sorted(output.iterdir()) if path.is_file() and path.name != 'evidence-sha256.json'})
        signal.setitimer(signal.ITIMER_REAL, 0)

if __name__ == '__main__': main()
