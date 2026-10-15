"""One fixed ordinary correctness continuation. No retries or benchmark workloads."""
import base64, hashlib, json, os, re, shutil, signal, subprocess, sys, tarfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
BRANCH = 'proof/empty-prefix-correctness-20261015'
WORKFLOW = '.github/workflows/empty-prefix-correctness.yml'
TOTAL_SECONDS = 1500
PREPARATION_SECONDS = 300
CORRECTNESS_SECONDS = 1200
PRESERVATION_SECONDS = 60
RSS_LIMIT = 4294967296
MIN_AVAILABLE = 5368709120
ORDINARY_LABELS = ['native-build', 'portable-build', 'declarations', 'full-bun',
                  'docs-script-tests', 'docs-links', 'docs-examples', 'node-worker-integration',
                  'node-redux-integration', 'node-typed-json-worker-integration',
                  'package-dry-run', 'package-archive', 'package-consumer']

def sha(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def read(path): return json.loads(Path(path).read_text())

def write(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2, allow_nan=False) + '\n')

def source_files(folder):
    result = {}
    for directory, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = [name for name in dirs if name not in ['node_modules', 'dist', '.git']]
        for name in files:
            path = Path(directory) / name
            relative = path.relative_to(folder)
            assert not path.is_symlink(), str(relative)
            if not (len(relative.parts) == 1 and path.suffix in ['.wasm', '.wat']):
                result[relative.as_posix()] = sha(path)
    return dict(sorted(result.items()))

def generated(folder):
    paths = [*folder.glob('*.wasm'), *folder.glob('*.wat'), *(folder / 'dist').rglob('*')]
    return {p.relative_to(folder).as_posix(): {'sha256': sha(p), 'bytes': p.stat().st_size}
            for p in sorted(paths) if p.is_file()}

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

class Run:
    def __init__(self, root):
        self.root = root
        self.root.mkdir()
        self.artifact = root / 'artifact'
        self.artifact.mkdir()
        self.start = time.monotonic()
        self.end = self.start + TOTAL_SECONDS
        self.deadline = self.start + PREPARATION_SECONDS
        self.phase = 'preparation'
        self.active = None
        self.interrupted = None
        self.sources = None
        self.frozen_generated = None
        self.executables = {}
        self.receipts = []
        self.input_pins = read(HERE / 'INPUT-SHA256.json')
        self.pins = read(HERE / 'SOURCE-PINS.json')
        self.candidate = root / 'candidate'
        self.env = {**os.environ, 'CI': '1', 'NODE_OPTIONS': '', 'BUN_OPTIONS': '',
                    'npm_config_audit': 'false', 'npm_config_fund': 'false'}
        for name in ['BULK_INPUT_ARM', 'BULK_INPUT_RUNTIME', 'BULK_INPUT_REPORT']:
            self.env.pop(name, None)
        self.result = {'kind': 'ordinary-correctness-continuation', 'baseCommit': BASE,
                       'candidatePatchSha256': self.pins['candidatePatchSha256'], 'complete': False,
                       'passingCommands': [], 'failedCommand': None, 'unrunCommands': list(ORDINARY_LABELS),
                       'benchmarksRun': False, 'memoryRegressionClearance': False,
                       'entireRepositoryCIClearance': False, 'publicationRelease': False,
                       'runId': os.environ.get('GITHUB_RUN_ID'), 'attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
                       'priorEvidenceSha256': sha(HERE / 'prior-evidence.json')}
        write(self.artifact / 'hosted-result.json', self.result)

    def event(self, row):
        with (self.artifact / 'progress.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        print(json.dumps(row), flush=True)

    def check_inputs(self):
        for name, digest in self.input_pins.items():
            path = HERE / name
            assert path.resolve().is_relative_to(REPO) and not path.is_symlink() and sha(path) == digest, name
        if self.sources is not None:
            assert source_files(self.candidate) == self.sources, 'candidate source changed'
        if self.frozen_generated is not None:
            assert generated(self.candidate) == self.frozen_generated, 'generated output changed'
        for name, record in self.executables.items():
            assert sha(record['path']) == record['sha256'], name
        toolchain = self.root / 'toolchain'
        if toolchain.exists():
            for name in ['package.json', 'package-lock.json']:
                assert sha(toolchain / name) == sha(HERE / 'toolchain' / name), name

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

    def prepare(self):
        self.check_inputs()
        for name, pin in [('candidate.patch', 'candidatePatchSha256'), ('baseline-sources.json', 'baselineSourcesSha256'),
                          ('candidate-sources.json', 'candidateSourcesSha256'), ('baseline-native.json', 'baselineNativeSha256'),
                          ('candidate-generated.json', 'candidateGeneratedSha256')]:
            assert sha(HERE / name) == self.pins[pin], name
        assert os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy'
        assert os.environ.get('GITHUB_RUN_ATTEMPT') == '1'
        assert os.environ.get('GITHUB_REF') == 'refs/heads/' + BRANCH
        assert os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64'
        memory = {key: int(value) * 1024 for key, value in re.findall(r'^(MemTotal|MemAvailable):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M)}
        write(self.artifact / 'host.json', {'memoryAtStart': memory,
              'minimumAvailableMemoryBytes': MIN_AVAILABLE, 'sampledGroupRssLimitBytes': RSS_LIMIT,
              'runner': {key: os.environ.get(key) for key in ['RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion']},
              'runId': self.result['runId'], 'attempt': self.result['attempt']})
        assert memory['MemAvailable'] >= MIN_AVAILABLE, 'insufficient headroom for declared sampled guard'
        self.command('proof-head', ['git', 'rev-parse', 'HEAD'], REPO, 10)
        self.command('proof-parent', ['git', 'rev-list', '--parents', '-n', '1', 'HEAD'], REPO, 10)
        head = self.output('proof-head')
        assert self.output('proof-parent').split() == [head, BASE]
        assert head == os.environ['GITHUB_SHA']
        self.result['proofCommit'] = head
        node = Path(shutil.which('node')).resolve()
        assert sha(node) == self.pins['engines']['Node']['sha256']
        assert node.stat().st_size == self.pins['engines']['Node']['bytes']
        npm = node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
        assert sha(npm) == self.pins['npmCliSha256']
        toolchain = self.root / 'toolchain'
        shutil.copytree(HERE / 'toolchain', toolchain)
        self.env['PATH'] = str(node.parent) + os.pathsep + self.env['PATH']
        self.command('locked-dependencies', [node, npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                     toolchain, 180, {'npm_config_offline': 'false', 'npm_config_registry': 'https://registry.npmjs.org/'})
        bun = (toolchain / 'node_modules/@oven/bun-linux-x64/bin/bun').resolve()
        assert sha(bun) == self.pins['engines']['Bun']['sha256']
        assert bun.stat().st_size == self.pins['engines']['Bun']['bytes']
        self.env['PATH'] = str(bun.parent) + os.pathsep + str(toolchain / 'node_modules/.bin') + os.pathsep + self.env['PATH']
        self.env['npm_config_offline'] = 'true'
        for engine, path in [('Node', node), ('Bun', bun)]:
            self.command(engine + '-version', [path, '--version'], toolchain, 5)
            assert self.output(engine + '-version').lstrip('v') == self.pins['engines'][engine]['version']
            self.command(engine + '-identity', [path, '-p', 'JSON.stringify({execPath:process.execPath,version:process.version,versions:process.versions})'], toolchain, 5)
            identity = json.loads(self.output(engine + '-identity'))
            assert Path(identity['execPath']).resolve() == path
            assert sha(path) == self.pins['engines'][engine]['sha256']
            self.executables[engine] = {'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size,
                                        'version': self.pins['engines'][engine]['version'], 'identity': identity}
        write(self.artifact / 'executables.json', self.executables)
        self.node, self.bun, self.npm = node, bun, npm
        archive = self.root / 'main.tar'
        self.command('archive-exact-main', ['git', 'archive', '--format=tar', BASE, '-o', archive], REPO, 30)
        self.candidate.mkdir()
        with tarfile.open(archive) as source: source.extractall(self.candidate, filter='data')
        baseline = read(HERE / 'baseline-sources.json')
        assert len(baseline) == 502 and source_files(self.candidate) == baseline
        self.command('check-fixed-patch', ['git', 'apply', '--check', '-p1', HERE / 'candidate.patch'], self.candidate, 10)
        self.command('apply-fixed-patch', ['git', 'apply', '-p1', HERE / 'candidate.patch'], self.candidate, 10)
        self.sources = read(HERE / 'candidate-sources.json')
        assert len(self.sources) == 503 and source_files(self.candidate) == self.sources
        assert {p for p in baseline if baseline[p] != self.sources[p]} == {'arena.ts'}
        assert set(self.sources) - set(baseline) == {'map-empty-prefix.test.ts'}
        assert self.sources['arena.ts'] == self.pins['sourceRuntimeSha256']
        assert self.sources['map-empty-prefix.test.ts'] == self.pins['sourceTestSha256']
        assert read(HERE / 'test-inventory.json')['rootFiles'] == {name: digest for name, digest in self.sources.items() if '/' not in name and name.endswith('.test.ts')}
        native_inputs = {p: digest for p, digest in baseline.items() if p.endswith('.as.ts') or p in ['scripts/build-wasm.mjs', 'package.json']}
        assert all(self.sources[p] == digest for p, digest in native_inputs.items())
        write(self.artifact / 'native-inputs.json', native_inputs)
        write(self.artifact / 'source-files.json', self.sources)
        (self.candidate / 'node_modules').symlink_to(toolchain / 'node_modules', target_is_directory=True)
        self.check_inputs()

    def authenticate_portable(self):
        core = (self.candidate / 'persistent-core.wasm').read_bytes()
        graph, embedded = {}, []
        for path in (self.candidate / 'dist').glob('*.js'):
            text = path.read_text()
            graph[path.name] = re.findall(r'(?:from\s*|import\s*)[\'"](\./[^\'"]+\.js)[\'"]', text)
            for match in re.finditer(r'function loadWasm\(\)\s*\{\s*const text = atob\("([A-Za-z0-9+/=]+)"\)', text):
                assert base64.b64decode(match.group(1), validate=True) == core
                embedded.append(path.name)
        assert len(embedded) == 1
        pending, seen = ['shared.js'], set()
        while pending:
            name = pending.pop()
            if name in seen: continue
            assert name in graph
            seen.add(name)
            pending.extend(Path(item).name for item in graph[name])
        assert embedded[0] in seen
        write(self.artifact / 'portable-authentication.json', {'coreSha256': sha(self.candidate / 'persistent-core.wasm'),
              'embeddedFile': embedded[0], 'embeddedFileSha256': sha(self.candidate / 'dist' / embedded[0]),
              'sharedEntryReachableFiles': sorted(seen), 'embeddedBytesEqualAuthenticatedNative': True})

    def correctness(self):
        reports = self.artifact / 'reports'; reports.mkdir()
        packages = self.root / 'package'; packages.mkdir()
        node, bun, npm = self.node, self.bun, self.npm
        commands = [
            ('native-build', 90, [node, 'scripts/build-wasm.mjs']),
            ('portable-build', 60, [bun, 'scripts/build-browser.ts']),
            ('declarations', 60, [node, 'node_modules/typescript/bin/tsc', '--emitDeclarationOnly', '--noEmit', 'false', '--declarationMap', 'false', '--outDir', 'dist/types']),
            ('full-bun', 300, [bun, '--bun', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(reports / 'full-bun.json')]),
            ('docs-script-tests', 60, [node, '--test', 'scripts/check-docs.node.mjs']),
            ('docs-links', 60, [node, 'scripts/check-docs.mjs']),
            ('docs-examples', 90, [node, 'scripts/check-doc-examples.mjs']),
            ('node-worker-integration', 60, [node, 'proofs/node-worker.mjs']),
            ('node-redux-integration', 60, [node, 'proofs/redux-node.mjs']),
            ('node-typed-json-worker-integration', 60, [node, 'proofs/typed-json-worker.mjs']),
            ('package-dry-run', 60, [node, npm, 'pack', '--dry-run', '--json']),
            ('package-archive', 60, [node, npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', packages]),
            ('package-consumer', 180, [node, 'scripts/check-package.mjs']),
        ]
        assert [label for label, _, _ in commands] == ORDINARY_LABELS
        write(self.artifact / 'command-plan.json', {'commands': [{'label': label, 'capSeconds': cap, 'argv': [str(value) for value in argv]} for label, cap, argv in commands],
              'defaultVitestScheduling': True, 'sampledRssLimitBytes': RSS_LIMIT, 'hardCgroupCap': False,
              'wholeControllerSeconds': TOTAL_SECONDS, 'correctnessPhaseSeconds': CORRECTNESS_SECONDS,
              'alreadyPassedTypeChecks': read(HERE / 'prior-evidence.json')['localOrdinaryGate']['passingCommands'][3:]})
        for label, cap, argv in commands:
            receipt = self.command(label, argv, self.candidate, cap)
            if label == 'native-build':
                actual = {name: record for name, record in generated(self.candidate).items() if '/' not in name}
                assert actual == read(HERE / 'baseline-native.json'), 'native bytes differ from authenticated main'
            if label == 'portable-build': self.authenticate_portable()
            if label in ['native-build', 'portable-build', 'declarations']:
                write(self.artifact / (label + '-generated.json'), generated(self.candidate))
            if label == 'declarations':
                self.frozen_generated = read(HERE / 'candidate-generated.json')
                assert generated(self.candidate) == self.frozen_generated, 'fresh generated output differs from pinned candidate'
            if label == 'full-bun':
                report = read(reports / 'full-bun.json')
                inventory = read(HERE / 'test-inventory.json')
                files = {}
                for suite in report['testResults']:
                    name = Path(suite['name']).resolve().relative_to(self.candidate).as_posix()
                    assert name not in files and suite['status'] == 'passed'
                    assert all(case['status'] == 'passed' for case in suite['assertionResults'])
                    files[name] = len(suite['assertionResults'])
                assert set(files) == set(inventory['rootFiles']) and len(files) == 51
                assert files[inventory['requiredFocusedFile']] == inventory['requiredFocusedCases'] == 8
                assert report['success'] and report['numTotalTests'] == report['numPassedTests'] == sum(files.values())
                assert report['numFailedTests'] == report['numPendingTests'] == report.get('numTodoTests', 0) == report.get('numRuntimeErrorTestSuites', 0) == 0
                assert not report.get('unhandledErrors', [])
                self.result['fullSuite'] = {'files': files, 'totalCases': sum(files.values()), 'reportSha256': sha(reports / 'full-bun.json')}
            if label in ['package-dry-run', 'package-archive']:
                package_report = json.loads(self.output(label))
                write(reports / (label + '.json'), package_report)
                if label == 'package-archive':
                    assert len(package_report) == 1
                    archive = packages / package_report[0]['filename']
                    self.result['packageArchive'] = {'filename': archive.name, 'sha256': sha(archive), 'bytes': archive.stat().st_size}
            self.check_inputs()
            receipt['validationPassed'] = True
            self.result['passingCommands'].append(label)
            self.result.update({'activeCommand': None, 'activeCommandStarted': None})
            write(self.artifact / 'command-receipts.json', self.receipts)
            write(self.artifact / 'hosted-result.json', self.result)
        self.result['allOrdinaryCommandsPassed'] = True

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

    def preserve(self):
        inputs = self.artifact / 'inputs'
        shutil.copytree(HERE, inputs)
        shutil.copyfile(REPO / WORKFLOW, self.artifact / 'workflow.yml')
        if (self.root / 'main.tar').exists(): shutil.copyfile(self.root / 'main.tar', self.artifact / 'main.tar')
        if self.candidate.exists():
            actual_sources = source_files(self.candidate)
            write(self.artifact / 'final-source-files.json', actual_sources)
            actual_generated = generated(self.candidate)
            write(self.artifact / 'final-generated.json', actual_generated)
            with tarfile.open(self.artifact / 'candidate-source.tar', 'w') as archive:
                for relative in actual_sources:
                    assert time.monotonic() < self.end
                    archive.add(self.candidate / relative, arcname=relative, recursive=False)
            for relative in actual_generated:
                assert time.monotonic() < self.end
                destination = self.artifact / 'generated' / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(self.candidate / relative, destination)
                assert sha(destination) == actual_generated[relative]['sha256']
        if (self.root / 'package').exists(): shutil.copytree(self.root / 'package', self.artifact / 'package')

def main():
    run = Run(Path(sys.argv[1]).resolve())
    def alarm(_number=None, _frame=None):
        if run.active is not None: signal_group(run.active.pid, signal.SIGKILL)
        if run.phase != 'preservation': raise TimeoutError(run.phase + ' deadline exhausted')
        run.result.update({'complete': False, 'hardStop': True, 'cleanupVerified': False, 'artifactManifestStale': True})
        try: write(run.artifact / 'hosted-result.json', run.result)
        finally: os._exit(124)
    def arm(deadline):
        if deadline <= time.monotonic(): alarm()
        signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.monotonic()))
    def interrupted(number, _frame): run.interrupted = number
    signal.signal(signal.SIGALRM, alarm)
    for number in [signal.SIGTERM, signal.SIGINT]: signal.signal(number, interrupted)
    failed = False
    try:
        arm(run.deadline); run.prepare()
        run.phase = 'correctness'
        run.deadline = min(run.end - PRESERVATION_SECONDS, time.monotonic() + CORRECTNESS_SECONDS)
        arm(run.deadline); run.correctness()
    except BaseException as error:
        failed = True
        run.result.update({'error': repr(error), 'failedCommand': run.result.get('activeCommand'),
                           'failedCommandStarted': run.result.get('activeCommandStarted'), 'failedPhase': run.phase})
    finally:
        run.phase = 'preservation'
        run.deadline = min(run.end, time.monotonic() + PRESERVATION_SECONDS)
        arm(run.deadline)
        try:
            run.cleanup()
            run.result['cleanupVerified'] = all(receipt.get('leaderReapedAfterCleanup') and not receipt.get('descendantsAfterCleanup')
                                                for receipt in run.receipts if 'ownedProcessGroup' in receipt)
            assert run.result['cleanupVerified'], 'one or more owned groups lack verified cleanup'
            run.check_inputs(); run.result['finalIntegrityVerified'] = True
        except BaseException as error:
            failed = True; run.result['cleanupOrIntegrityError'] = repr(error)
        try: run.preserve()
        except BaseException as error:
            failed = True; run.result['preservationError'] = repr(error)
        run.result['complete'] = bool(not failed and run.result.get('allOrdinaryCommandsPassed'))
        run.result.update({'activeCommand': None, 'activeCommandStarted': None})
        write(run.artifact / 'command-receipts.json', run.receipts)
        write(run.artifact / 'hosted-result.json', run.result)
        write(run.artifact / 'ARTIFACT-SHA256.json', {p.relative_to(run.artifact).as_posix(): sha(p)
              for p in sorted(run.artifact.rglob('*')) if p.is_file() and p.name != 'ARTIFACT-SHA256.json'})
        signal.setitimer(signal.ITIMER_REAL, 0)
    return 0 if run.result['complete'] else 1

if __name__ == '__main__': sys.exit(main())
