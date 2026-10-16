"""Exact-source correctness-only admission with bounded diagnostic observations."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
METHOD_SHA256 = 'f071ed199c68dfd5112c69532930344fdc88821a416573a63683c9f8aecc3907'
PRODUCTION_PINS = {
    'persistent-core.as.ts': {'baseline': 'baa5d5a7682af2738a216566d3a8b61ee8f298e3abb61e34eb597d3ae277f976',
                              'candidate': '6a0e16e08270221c581e2604adac842aeaed221256dd03d9792c45359299018d'},
}
FOCUSED_TEST = 'sorted-journal-delete.test.ts'
FOCUSED_SHA256 = 'b2bb9c9a3e54457fc09024a087ca52bc1e1da400950536fbebd234ba276866bb'
WORKER_PROOF = 'proofs/sorted-journal-delete-worker.mjs'
WORKER_SHA256 = 'c77b32c4508ed9bf180d91b07083ce511110885fa08a8203fb494c946e13be37'
ADMISSION_SECONDS = 1620
ADMISSION_RSS = 4 * 1024 ** 3
POLL_SECONDS = .05
PROCESS_SECONDS = 1
PROCESS_MAX_ROWS = 64
PROCESS_MAX_RECORDS = 2000
PROCESS_MAX_BYTES = 8 * 1024 ** 2
REPORTER_FAILURE = b'Admission diagnostic reporter failure'

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

def group_members(group, details=False):
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group: continue
            match = re.search(r'^VmRSS:\s+(\d+) kB$', (path / 'status').read_text(), re.M)
            row = {'pid': int(path.name), 'rss': int(match[1]) * 1024 if match else 0, 'state': fields[0]}
            if details:
                row.update({'ppid': int(fields[1]), 'processStartTicks': int(fields[19]),
                            'userCpuTicks': int(fields[11]), 'systemCpuTicks': int(fields[12]), 'threads': int(fields[17])})
            rows.append(row)
        except (FileNotFoundError, ProcessLookupError): pass
    return rows

def tail(path, limit=65536):
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - limit))
        return stream.read(limit)

def process_record(stream, counter, rows, elapsed, out_path, err_path, terminal=False):
    assert len(rows) <= PROCESS_MAX_ROWS, 'process telemetry row cap'
    record = {'v': 1, 'seq': counter['records'] + 1, 'observedElapsedSeconds': elapsed,
              'observedUnix': time.time(), 'terminal': terminal, 'processes': sorted(rows, key=lambda row: row['pid']),
              'stdoutBytes': out_path.stat().st_size, 'stderrBytes': err_path.stat().st_size}
    line = (json.dumps(record, allow_nan=False, separators=(',', ':')) + '\n').encode()
    assert counter['records'] < PROCESS_MAX_RECORDS and counter['bytes'] + len(line) <= PROCESS_MAX_BYTES, 'process telemetry output cap'
    stream.write(line); stream.flush()
    counter['records'] += 1; counter['bytes'] += len(line)

def validate_reporter(path):
    assert path.is_file() and path.stat().st_size <= 8 * 1024 ** 2, 'reporter evidence absent or oversized'
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert 2 <= len(rows) <= 16000 and all(row['seq'] == index for index, row in enumerate(rows, 1))
    assert rows[0]['event'] == 'run-start' and rows[-1]['event'] == 'run-end' and rows[-1]['reason'] == 'passed', 'reporter did not complete cleanly'
    assert not any(row['event'] == 'limit' for row in rows), 'reporter cap reached'
    return {'records': len(rows), 'bytes': path.stat().st_size, 'sha256': sha(path)}

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

    def run(self, label, argv, cwd, deadline, wall, rss_limit, ready=False, environment=None):
        assert not self.interrupted and time.monotonic() < deadline, 'deadline or interruption before launch'
        receipt = {'label': label, 'argv': [self.display(x) for x in argv], 'cwd': self.display(str(cwd)), 'startedUnix': time.time(),
                   'wallSeconds': wall, 'sampledGroupRssLimitBytes': rss_limit, 'sampleIntervalSeconds': POLL_SECONDS,
                   'peakObservedGroupRssBytes': 0, 'cleanupSignals': [], 'spawnToReadyNs': None, 'environmentOverrides': environment or {}}
        self.receipts.append(receipt)
        write(self.output / 'commands.json', self.receipts)
        out_path = self.output / (label + '.stdout')
        err_path = self.output / (label + '.stderr')
        process_path = self.output / (label + '.process.jsonl')
        counter = {'records': 0, 'bytes': 0}
        next_process = 0
        start = time.monotonic()
        # Reserve two seconds for cleanup inside both the command and admission caps.
        stop = min(start + wall, deadline) - 2
        child = None
        failure = None
        try:
            with out_path.open('xb') as out, err_path.open('xb') as err, process_path.open('xb') as process_stream:
                child = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=err, start_new_session=True, env={**os.environ, **(environment or {})})
                self.active = child
                receipt['ownedProcessGroup'] = child.pid
                while True:
                    if ready and receipt['spawnToReadyNs'] is None:
                        lines = out_path.read_text().splitlines()
                        if lines:
                            try: event = json.loads(lines[0])
                            except json.JSONDecodeError: event = {}
                            if event.get('event') == 'ready': receipt['spawnToReadyNs'] = (time.monotonic() - start) * 1e9
                    elapsed = time.monotonic() - start
                    observe = elapsed >= next_process
                    rows = group_members(child.pid, details=observe)
                    if observe:
                        process_record(process_stream, counter, rows, elapsed, out_path, err_path)
                        next_process = elapsed + PROCESS_SECONDS
                        if environment and 'ZEROCOPY_ADMISSION_DIAGNOSTIC_FILE' in environment:
                            if any(REPORTER_FAILURE in tail(path) for path in [out_path, err_path]):
                                failure = 'reporter instrumentation failure'
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
                try:
                    with process_path.open('ab') as process_stream:
                        process_record(process_stream, counter, group_members(child.pid, details=True), time.monotonic() - start, out_path, err_path, terminal=True)
                except BaseException as error:
                    failure = failure or self.display(repr(error))
                if environment and 'ZEROCOPY_ADMISSION_DIAGNOSTIC_FILE' in environment:
                    try:
                        if any(REPORTER_FAILURE in tail(path) for path in [out_path, err_path]): failure = failure or 'reporter instrumentation failure'
                    except BaseException as error: failure = failure or self.display(repr(error))
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
            receipt['processTelemetry'] = {'records': counter['records'], 'bytes': counter['bytes'], 'intervalSeconds': PROCESS_SECONDS, 'cpuTicksPerSecond': os.sysconf('SC_CLK_TCK')}
            for path in [out_path, err_path, process_path]:
                if path.exists(): receipt['processLog' if path == process_path else path.suffix[1:]] = {'file': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size}
            write(self.output / 'commands.json', self.receipts)
        assert not failure and receipt.get('exitCode') == 0 and not self.interrupted, f'No retry after failure: {label}: {failure}'
        return receipt

def built_artifacts(root):
    expected = {'persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm', 'linked-list.wasm', 'singly-linked-list.wasm',
                'doubly-linked-list.wasm', 'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm',
                'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'}
    wasm = {path.name: sha(path) for path in root.glob('*.wasm')}
    assert set(wasm) == expected and (root / 'geometry-kernels.wat').is_file()
    for name in wasm:
        assert (root / name).read_bytes()[:8] == b'\x00asm\x01\x00\x00\x00'
        if name not in {'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'}:
            assert wasm[name] == wasm['persistent-core.wasm']
    chunks = {str(path.relative_to(root)): sha(path) for path in (root / 'dist').rglob('*') if path.is_file()}
    assert all('dist/' + name in chunks for name in ['shared.js', 'worker.js', 'state.js', 'redux.js', 'tanstack-db-collection.js', 'numeric.js', 'geometry.js'])
    js = {name: (root / name).read_text() for name in chunks if name.endswith('.js')}
    assert 7 <= len(js) <= 32
    embedded = {}
    for name in ['persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm']:
        token = base64.b64encode((root / name).read_bytes()).decode('ascii')
        found = [chunk for chunk, text in js.items() if token in text]
        assert found, 'Fresh native bytes missing from portable output: ' + name
        embedded[name] = {'sha256': wasm[name], 'chunks': sorted(found)}
    return {**wasm, 'geometry-kernels.wat': sha(root / 'geometry-kernels.wat'), **chunks}, embedded

def runtime_pins(node, bun, deadline, supervisor):
    versions = {'node': command([node, '--version'], Path.cwd(), deadline, supervisor), 'bun': command([bun, '--version'], Path.cwd(), deadline, supervisor), 'python': sys.version}
    assert versions['node'] == 'v22.16.0' and versions['bun'] == '1.4.2'
    return {name: {'path': path, 'sha256': sha(path), 'version': versions[name]} for name, path in [('node', node), ('bun', bun), ('python', str(Path(sys.executable).resolve()))]}

def main():
    candidate, baseline, output = map(lambda p: Path(p).resolve(), sys.argv[1:])
    proof = candidate / 'proofs/sorted-journal-delete-admission'
    output.mkdir(parents=True, exist_ok=False)
    node, bun = (str(Path(shutil.which(name)).resolve()) for name in ['node', 'bun'])
    supervisor = Supervisor(output, [(str(candidate), '$CANDIDATE'), (str(baseline), '$BASELINE'), (str(output), '$EVIDENCE'), (node, '$NODE'), (bun, '$BUN')])
    status = {'status': 'preparing', 'performanceClaim': False, 'studyChildrenStarted': 0, 'cumulativePayloadBytes': 0}
    write(output / 'status.json', status)
    started = time.monotonic()
    admission_deadline = started + ADMISSION_SECONDS
    phase = 'admission'
    def whole_alarm(number, _frame):
        if supervisor.active is not None: supervisor.interrupted = number
        else: raise TimeoutError(phase + ' whole wall cap; cleanup reserve')
    signal.signal(signal.SIGALRM, whole_alarm)
    signal.setitimer(signal.ITIMER_REAL, ADMISSION_SECONDS - 2)
    try:
        assert os.environ['GITHUB_REPOSITORY'] == 'natanelia/zerocopy'
        assert candidate == Path(os.environ['GITHUB_WORKSPACE']).resolve()
        assert baseline == (Path(os.environ['RUNNER_TEMP']) / 'sorted-journal-delete-admission-baseline').resolve()
        assert output == (Path(os.environ['RUNNER_TEMP']) / 'sorted-journal-delete-admission-evidence').resolve()
        assert os.environ['GITHUB_RUN_ATTEMPT'] == '1'
        assert os.environ['GITHUB_REF'] == 'refs/heads/proof/sorted-journal-delete-admission-diagnostic-20261016'
        assert not os.environ.get('NODE_OPTIONS') and not os.environ.get('BUN_OPTIONS'), 'Unexpected runtime flags'
        assert command(['git', 'rev-parse', 'HEAD'], baseline, admission_deadline, supervisor) == BASE
        commit = command(['git', 'rev-parse', 'HEAD'], candidate, admission_deadline, supervisor)
        assert commit == os.environ['GITHUB_SHA']
        assert command(['git', 'rev-parse', 'HEAD^'], candidate, admission_deadline, supervisor) == BASE
        base_files = read(proof / 'baseline-sources.json')
        overlay = read(proof / 'source-pins.json')
        assert len(base_files) == 502
        changed = set(command(['git', 'diff', '--name-only', BASE, 'HEAD'], candidate, admission_deadline, supervisor).splitlines())
        assert changed == set(overlay) | {'proofs/sorted-journal-delete-admission/source-pins.json'}
        for relative, digest in base_files.items():
            assert sha(baseline / relative) == digest, relative
            assert sha(candidate / relative) == overlay.get(relative, digest), relative
        for relative, digest in overlay.items(): assert sha(candidate / relative) == digest, relative
        assert sha(proof / 'METHOD.md') == METHOD_SHA256
        assert {relative for relative, digest in base_files.items() if overlay.get(relative, digest) != digest} == set(PRODUCTION_PINS) | {'vitest.config.ts'}
        assert base_files['vitest.config.ts'] == '6bae9f4e513173dec6c089c4fcaf3957c5cb9aa3195173f1d5ace6a60140a489'
        assert (candidate / 'vitest.config.ts').read_text() == (baseline / 'vitest.config.ts').read_text().replace(
            "    bundler: 'rolldown',", "    reporters: ['default', './proofs/sorted-journal-delete-admission/reporter.mjs'],\n    logHeapUsage: true,\n    bundler: 'rolldown',")
        for relative, pins in PRODUCTION_PINS.items():
            assert base_files[relative] == sha(baseline / relative) == pins['baseline'], relative
            assert overlay[relative] == sha(candidate / relative) == pins['candidate'], relative
        assert sha(candidate / FOCUSED_TEST) == FOCUSED_SHA256
        assert sha(candidate / WORKER_PROOF) == WORKER_SHA256
        # Identical added tests accompany the ordinary complete admissions.
        reporter_relative = 'proofs/sorted-journal-delete-admission/reporter.mjs'
        (baseline / reporter_relative).parent.mkdir(parents=True, exist_ok=True)
        for name in [FOCUSED_TEST, WORKER_PROOF, 'vitest.config.ts', reporter_relative]: shutil.copyfile(candidate / name, baseline / name)
        dependencies = proof / 'dependencies/node_modules'
        assert dependencies.is_dir(), 'Missing pre-provisioned locked dependencies'
        for root in [baseline, candidate]:
            assert (root / 'node_modules').is_symlink() and (root / 'node_modules').resolve() == dependencies
            assert not list(root.glob('*.wasm')) and not list(root.glob('*.wat')) and not (root / 'dist').exists(), 'Native and portable outputs must be fresh'
        tracked = [relative for relative in command(['git', 'ls-files', '-z'], candidate, admission_deadline, supervisor).split('\0') if relative]
        source_pins = {arm: {relative: sha(root / relative) for relative in (list(base_files) + [FOCUSED_TEST, WORKER_PROOF, reporter_relative] if arm == 'baseline' else tracked)} for arm, root in [('baseline', baseline), ('candidate', candidate)]}
        dep_pins = tree(dependencies, excluded=('.vite', '.vite-temp', '.cache'))
        executables = runtime_pins(node, bun, admission_deadline, supervisor)
        write(output / 'admission-inputs.json', {'sourceFiles': source_pins, 'dependencies': dep_pins,
              'executables': {name: {'command': name, 'sha256': record['sha256'], 'version': record['version']} for name, record in executables.items()},
              'dependencyLockSha256': sha(proof / 'dependencies/package-lock.json')})
        commands = []
        for arm, root in [('baseline', baseline), ('candidate', candidate)]:
            commands.extend([(arm + '-prepublishOnly', [bun, 'run', 'prepublishOnly'], root, 600, {'ZEROCOPY_SORTED_DELETE_ARM': arm, 'ZEROCOPY_ADMISSION_DIAGNOSTIC_FILE': str(output / (arm + '-reporter.jsonl'))}),
                             (arm + '-node-worker', [node, 'proofs/node-worker.mjs'], root, 90, {}),
                             (arm + '-typed-json-worker', [node, 'proofs/typed-json-worker.mjs'], root, 90, {})])
        write(output / 'admission-plan.json', [{'label': label, 'argv': [supervisor.display(x) for x in argv], 'cwd': supervisor.display(str(cwd)), 'wallSeconds': wall, 'environmentOverrides': env} for label, argv, cwd, wall, env in commands])
        for label, argv, cwd, wall, env in commands:
            supervisor.run(label, argv, cwd, admission_deadline, wall, ADMISSION_RSS, environment=env)
            if label.endswith('prepublishOnly'):
                validate_reporter(Path(env['ZEROCOPY_ADMISSION_DIAGNOSTIC_FILE']))
                log = (output / (label + '.stdout')).read_text() + (output / (label + '.stderr')).read_text()
                assert REPORTER_FAILURE.decode() not in log, 'reporter instrumentation failure'
                for name, count in [(FOCUSED_TEST, 20), ('shared-sorted.test.ts', 8), ('performance-revision.test.ts', 21), ('allocation-failure.test.ts', 32)]:
                    assert re.search(re.escape(name) + r'[^\n]*\(' + str(count) + r' tests?\)', log), f'Focused suite not observed: {name}'
                allocation = re.findall(r'SORTED_DELETE_ALLOCATION (\{[^\r\n]*\})', log)
                assert len(allocation) == 1
                observed = json.loads(allocation[0])
                assert observed == {'arm': env['ZEROCOPY_SORTED_DELETE_ARM'], 'allocatedBytes': 0 if env['ZEROCOPY_SORTED_DELETE_ARM'] == 'candidate' else 24}
        reporter_evidence = {arm: validate_reporter(output / (arm + '-reporter.jsonl')) for arm in ['baseline', 'candidate']}
        artifacts, portable_bindings = {}, {}
        for arm, root in [('baseline', baseline), ('candidate', candidate)]: artifacts[arm], portable_bindings[arm] = built_artifacts(root)
        for name in ['numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm', 'geometry-kernels.wat']:
            assert artifacts['baseline'][name] == artifacts['candidate'][name]
        manifest = {'baselineCommit': BASE, 'candidateCommit': commit, 'candidateTree': command(['git', 'rev-parse', 'HEAD^{tree}'], candidate, admission_deadline, supervisor),
                    'diagnosticsProvenance': 'Original public hosted diagnostics; verified ephemeral public checkout, dependency and toolchain paths may appear in raw logs.',
                    'sourceFiles': source_pins, 'reporterEvidence': reporter_evidence, 'artifacts': artifacts, 'portableNativeBindings': portable_bindings,
                    'executables': {name: {'command': name, 'sha256': record['sha256'], 'version': record['version']} for name, record in executables.items()}, 'dependencies': dep_pins,
                    'lockSha256': sha(proof / 'dependencies/package-lock.json'), 'methodSha256': sha(proof / 'METHOD.md'),
                    'buildFlagsSourceSha256': sha(candidate / 'scripts/build-wasm.mjs'), 'portableBuildSourceSha256': sha(candidate / 'scripts/build-browser.ts'),
                    'host': {'os': os.uname().sysname, 'release': os.uname().release, 'architecture': os.uname().machine,
                             'cpuCount': os.cpu_count(), 'cpuModel': next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), 'unavailable')},
                    'run': {name: os.environ[name] for name in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA']},
                    'flags': {'node': [], 'bun': []}, 'admissionSeconds': time.monotonic() - started,
                    'limits': {'admissionSeconds': ADMISSION_SECONDS, 'aggregateCommandSeconds': 600, 'workerCommandSeconds': 90, 'sampledGroupRssBytes': ADMISSION_RSS, 'rssSampleSeconds': POLL_SECONDS, 'maximumAdmissionCommands': 6, 'processTelemetrySeconds': 1, 'processTelemetryRowsPerSample': 64, 'processTelemetryRecordsPerCommand': 2000, 'processTelemetryBytesPerCommand': 8 * 1024 ** 2},
                    'cacheAllowance': 'node_modules/.vite, .vite-temp and .cache may change; excluded from dependency pins'}
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
        status.update({'status': 'finalizing', 'admission': 'passed', 'manifestSha256': frozen_manifest_sha,
                       'diagnosticDisposition': 'non-reproduction; original failure remains unresolved',
                       'requiresSuccessfulControllerExit': True})
    except BaseException as error:
        status.update({'status': 'incomplete', 'error': supervisor.display(repr(error))})
        raise
    finally:
        try:
            status['admissionSecondsForSafety'] = time.monotonic() - started
            if status['status'] == 'finalizing':
                assert time.monotonic() < admission_deadline and not supervisor.interrupted
                status['status'] = 'complete'
            write(output / 'status.json', status)
            write(output / 'evidence-sha256.json', {path.name: sha(path) for path in sorted(output.iterdir()) if path.is_file() and path.name != 'evidence-sha256.json'})
            if status['status'] == 'complete': assert time.monotonic() < admission_deadline and not supervisor.interrupted
            signal.setitimer(signal.ITIMER_REAL, 0)
        except BaseException as error:
            signal.setitimer(signal.ITIMER_REAL, 0)
            status.update({'status': 'incomplete', 'finalizationError': supervisor.display(repr(error)), 'requiresSuccessfulControllerExit': True})
            write(output / 'status.json', status)
            raise

if __name__ == '__main__': main()

