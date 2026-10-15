"""Prospective fixed-cohort controller. Importing this file never launches a subject.

Execution requires a separately reviewed, released EXECUTION-PINS.json. Exactly
400 subject processes are planned; analysis runs here, with no extra runtime.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
RSS_LIMIT = 1 << 30
CHILD_SECONDS = 10
STUDY_SECONDS = 600
ENGINES = ('node', 'bun')
VARIANTS = ('baseline', 'candidate')
CASES = ('P1', 'P2', 'C1', 'C2', 'C3', 'C4')
EXECUTABLE_SHA = {
    'node': '8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d',
    'bun': 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c',
}
SOURCE_MANIFEST_SHA = {
    'baseline': '9a68795d3c96706ddcad035e7e0cf37c8635753eeb18afe128dbf32ac27f5b59',
    'candidate': 'c6ee127afa2abdb09602f0dfaef2826970c371e5ce561bed12f234ae65d93986',
}
PATCH_SHA = '77f05fa906d9ccfc6d0afdaebc04cf181f3a7dea23d8b88b82c2a9d11a6077bb'
METHOD_PINS = {
    'method': '86214bef6beb0eddb320d1240cab3d535736c10ae944305da1b3bf16a7b9f3c8',
    'fixtures': '019cc30dd93c240a6b6387dcdda642a6284f1789591a6552efb60bd1c7a4696a',
    'staticCoverage': '43be33df8f74c54356030aa8f81ad6ef95790de4fc76d41f289b787808b0bfda',
    'sourcePins': '5e882d7567ee22438eadca0d75be41df785141ae913fc6f68781fa2d915fa9be',
    'methodReview': 'ed0d9ab61f688d395de2a5b2043e74e26fc2bae0bd98a2dd88d935f85ac143e4',
}
DECISION_FIELDS = ('primaryQualified', 'materialHarmVeto', 'controlsCleared', 'promisingLead',
                   'diagnosticFollowOnEligible', 'regressionClearance', 'eligible', 'controlsClear', 'blocked',
                   'eligibleForSeparatelyReviewedFollowOn')


def clear_decisions(record):
    record.update({key: False for key in DECISION_FIELDS})


ORDINARY_FIRST_PASSES = ['native-build', 'portable-build', 'declarations', 'full-bun', 'docs-script-tests']
ORDINARY_REMAINING = ['docs-links', 'docs-examples', 'node-worker-integration', 'node-redux-integration',
                      'node-typed-json-worker-integration', 'package-dry-run', 'package-archive', 'package-consumer']
ORDINARY_STAGE1_RESULT_SHA = 'd4fbe06501cd55c5a63f228369a1babeff18f19f112e23467430b21b6f46e707'
ORDINARY_STAGE1_MANIFEST_SHA = 'ac254b7276ac1b4112984e57204ae0f0083992f3c359b1206d335ff48aae9bef'
ORDINARY_FULL_REPORT_SHA = 'd08df62385886d0a6cb170ee26239ef0938aa3ef30d79c9ab50d0c43bc98cb4d'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    """Replace one result atomically; all accepted events are also fsynced."""
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def event(path, value):
    with Path(path).open('a') as stream:
        stream.write(json.dumps(value, allow_nan=False) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def file_pin(descriptor):
    path = Path(descriptor['path']).resolve(strict=True)
    require(path.is_file() and sha(path) == descriptor['sha256'], 'file pin: ' + str(path))
    return path


def inventory(folder, generated=False):
    result = {}
    for directory, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules') and (generated or d != 'dist')]
        for name in files:
            path = Path(directory) / name
            relative = path.relative_to(folder)
            native = len(relative.parts) == 1 and path.suffix in ('.wasm', '.wat')
            if (native or relative.parts[0] == 'dist') != generated:
                continue
            require(not path.is_symlink(), 'subject file symlink: ' + str(path))
            result[relative.as_posix()] = ({'sha256': sha(path), 'bytes': path.stat().st_size}
                                                if generated else sha(path))
    return dict(sorted(result.items()))


def authenticate_portable(folder, expected):
    core = (folder / 'persistent-core.wasm').read_bytes()
    graph, embedded = {}, []
    for path in sorted((folder / 'dist').glob('*.js')):
        source = path.read_text()
        graph[path.name] = re.findall(r'(?:from\s*|import\s*)[\'"](\./[^\'"]+\.js)[\'"]', source)
        for match in re.finditer(r'function loadWasm\(\)\s*\{\s*const text = atob\("([A-Za-z0-9+/=]+)"\)', source):
            require(base64.b64decode(match[1], validate=True) == core, 'embedded core differs')
            embedded.append(path.name)
    require(embedded == [expected['embeddedFile']], 'embedded core identity')
    pending, seen = ['shared.js'], set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        require(name in graph, 'portable import graph missing ' + name)
        seen.add(name)
        pending.extend(Path(dependency).name for dependency in graph[name])
    require(sorted(seen) == expected['sharedEntryReachableFiles'], 'portable import graph differs')
    require(sha(folder / 'persistent-core.wasm') == expected['coreSha256'], 'native core pin')
    require(sha(folder / 'dist' / embedded[0]) == expected['embeddedFileSha256'], 'embedded chunk pin')


def source_closure(folder):
    """Conservative static relative-import closure, including type-only imports."""
    pending, result = ['shared.ts'], {}
    while pending:
        name = pending.pop()
        if name in result:
            continue
        path = (folder / name).resolve(strict=True)
        require(path.is_relative_to(folder), 'source import escaped arm')
        source = path.read_text()
        result[name] = sha(path)
        for specifier in re.findall(r'(?:from\s*|import\s*\(?\s*)[\'"](\.[^\'"]+)[\'"]', source):
            target = path.parent / specifier
            if not target.suffix:
                target = target.with_suffix('.ts')
            pending.append(target.resolve(strict=True).relative_to(folder).as_posix())
    return dict(sorted(result.items()))


def ordinary_composite_claims(first, second, stages):
    """Pure required-command coverage; the first failed result stays failed."""
    for result in (first, second):
        require(result.get('baseCommit') == BASE and result.get('candidatePatchSha256') == PATCH_SHA,
                'ordinary stage source identity differs')
        require(result.get('cleanupVerified') is True and result.get('finalIntegrityVerified') is True,
                'ordinary stage cleanup/integrity incomplete')
    require(first.get('kind') == 'ordinary-correctness-continuation' and first.get('complete') is False,
            'first ordinary stage must retain original failure')
    require(str(first.get('runId')) == '38668352050' and str(first.get('attempt')) == '1', 'first stage run identity')
    require(first.get('passingCommands') == ORDINARY_FIRST_PASSES and first.get('failedCommand') == 'docs-links'
            and first.get('unrunCommands') == ORDINARY_REMAINING[1:], 'first stage command history differs')
    require(first.get('fullSuite', {}).get('totalCases') == 1063
            and first['fullSuite'].get('reportSha256') == ORDINARY_FULL_REPORT_SHA, 'first stage full suite differs')
    require(second.get('kind') == 'remaining-ordinary-correctness' and second.get('complete') is True,
            'remaining ordinary stage not complete')
    require(second.get('passingCommands') == ORDINARY_REMAINING and second.get('unrunCommands') == []
            and second.get('failedCommand') is None, 'remaining ordinary command coverage incomplete')
    require(second.get('preparationBuildsPassed') == ORDINARY_FIRST_PASSES[:3], 'separate build prerequisites incomplete')
    carried = second.get('carriedForwardHostedGate', {})
    require(str(carried.get('runId')) == '38668352050' and carried.get('complete') is False
            and carried.get('resultSha256') == ORDINARY_STAGE1_RESULT_SHA
            and carried.get('artifactManifestSha256') == ORDINARY_STAGE1_MANIFEST_SHA,
            'remaining stage did not preserve exact first-stage receipt')
    return {
        'kind': 'ordinary-correctness-composite', 'complete': True,
        'baseCommit': BASE, 'candidatePatchSha256': PATCH_SHA,
        'requiredCommands': ORDINARY_FIRST_PASSES + ORDINARY_REMAINING,
        'stages': stages,
        'commandCoverage': {label: {'stage': 1 if label in ORDINARY_FIRST_PASSES else 2, 'result': 'passed'}
                            for label in ORDINARY_FIRST_PASSES + ORDINARY_REMAINING},
        'preservedFailure': {'stage': 1, 'command': 'docs-links', 'complete': False,
                             'classification': 'archived-candidate-missing-git-context',
                             'unrunCommands': ORDINARY_REMAINING[1:]},
        'secondStageBuildPrerequisites': ORDINARY_FIRST_PASSES[:3],
    }


def authenticate_ordinary(evidence, expected_sources, expected_generated):
    require(evidence['ordinaryStage1Result']['sha256'] == ORDINARY_STAGE1_RESULT_SHA
            and evidence['ordinaryStage1Manifest']['sha256'] == ORDINARY_STAGE1_MANIFEST_SHA,
            'original failed ordinary evidence was replaced')
    results, stages = [], []
    for stage in (1, 2):
        result_pin = evidence[f'ordinaryStage{stage}Result']
        manifest_pin = evidence[f'ordinaryStage{stage}Manifest']
        result_path, manifest_path = file_pin(result_pin), file_pin(manifest_pin)
        manifest, result = read(manifest_path), read(result_path)
        require(manifest['hosted-result.json'] == result_pin['sha256'], 'ordinary result/manifest binding')
        names = ['hosted-result.json', 'command-receipts.json', 'final-source-files.json',
                 'final-generated.json', 'portable-authentication.json']
        if stage == 1:
            names += ['reports/full-bun.json', 'logs/docs-links.stderr']
        else:
            names += ['source-index.json', 'git-context.json']
        for name in names:
            require(sha(manifest_path.parent / name) == manifest[name], 'ordinary artifact binding: ' + name)
        require(read(manifest_path.parent / 'final-source-files.json') == expected_sources,
                'ordinary stage source differs from measured candidate')
        require(read(manifest_path.parent / 'final-generated.json') == expected_generated,
                'ordinary stage generated bytes differ from measured candidate')
        commands = read(manifest_path.parent / 'command-receipts.json')
        required = ORDINARY_FIRST_PASSES if stage == 1 else ORDINARY_FIRST_PASSES[:3] + ORDINARY_REMAINING
        for label in required:
            matches = [row for row in commands if row['label'] == label]
            require(len(matches) == 1 and matches[0].get('exitCode') == 0 and not matches[0].get('failure')
                    and matches[0].get('leaderReapedAfterCleanup') is True
                    and not matches[0].get('descendantsAfterCleanup'), 'ordinary passing receipt missing: ' + label)
        if stage == 1:
            failed = [row for row in commands if row['label'] == 'docs-links']
            require(len(failed) == 1 and failed[0].get('exitCode') == 1, 'original docs-links failure lost')
            require(manifest['reports/full-bun.json'] == ORDINARY_FULL_REPORT_SHA, 'original full-suite report differs')
            require(manifest['logs/docs-links.stderr'] == '4ff2a6f14db35a642d0da297a1463c5164d40bbdd15261e03fcf900d2760d3d8',
                    'original Git-context failure evidence differs')
        else:
            require(not any(row['label'] == 'full-bun' for row in commands), 'full suite was rerun in remaining stage')
        results.append(result)
        stages.append({'stage': stage, 'runId': str(result['runId']), 'resultSha256': result_pin['sha256'],
                       'artifactManifestSha256': manifest_pin['sha256'],
                       'commandReceiptsSha256': manifest['command-receipts.json'],
                       'sourceManifestSha256': manifest['final-source-files.json'],
                       'generatedManifestSha256': manifest['final-generated.json']})
    expected = ordinary_composite_claims(*results, stages)
    composite = read(file_pin(evidence['ordinaryComposite']))
    require(all(composite.get(key) == value for key, value in expected.items()),
            'explicit ordinary composite coverage summary differs or is incomplete')
    return composite


def group_memory(group):
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
            rows.append({'pid': int(path.name), **values})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return rows


def kill_owned(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def sampled_descendants(receipt, memory, leader):
    """An observed extra member remains a failure after that member exits."""
    found = set(receipt.get('unexpectedSampledGroupMembers', []))
    found.update(row['pid'] for row in memory if row['pid'] != leader)
    receipt['unexpectedSampledGroupMembers'] = sorted(found)
    return bool(found)


def recover(config, path):
    """Never manufacture completed batches from an interrupted timer."""
    result = {**config, 'complete': False, 'qualityClear': False, 'warmup': [], 'measured': [],
              'verification': [], 'pilots': [], 'startup': {}, 'validation': []}
    if path.exists():
        try:
            result.update(read(path))
        except json.JSONDecodeError:
            result['terminalJsonIncomplete'] = True
    events = Path(str(path) + '.events.jsonl')
    if events.exists():
        for line in events.read_text().splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                break
            if item.get('event') == 'clock':
                result['clock'] = item['clock']
            elif item.get('event') == 'ready':
                result['startup']['importToReadyNs'] = item['importToReadyNs']
                result['resolution'] = item['resolution']
            elif item.get('event') == 'batch':
                category = item['category']
                if category in ('warmup', 'measured', 'verification', 'pilots'):
                    batch = item['batch']
                    if not any(b.get('index') == batch.get('index') for b in result[category]):
                        result[category].append(batch)
            elif item.get('event') == 'count':
                result['N'] = item['N']
            elif item.get('event') == 'setup':
                result['setupNs'] = item['setupNs']
            elif item.get('event') == 'validated-fixture':
                if not any(v['caseId'] == item['validation']['caseId'] for v in result['validation']):
                    result['validation'].append(item['validation'])
    return result


class Run:
    def __init__(self, pins_path, root):
        from protocol import schedule, summarize
        self.root, self.pins_path = root, pins_path
        self.pins = read(pins_path)
        for arm in self.pins.get('arms', {}).values():
            if arm.get('root'):
                source_root = Path(arm['root']).resolve()
                require(not root.is_relative_to(source_root) and not source_root.is_relative_to(root),
                        'output directory must be outside subject roots')
        self.initial_pins_sha = sha(pins_path)
        self.rows, self.commands, self.active = [], [], None
        self.start = None
        self.deadline = None
        self.interrupted = None
        self.sources, self.generated = {}, {}
        self.main_schedule = schedule()
        self.plan = ([{'kind': 'validation', 'engine': e, 'variant': v} for e in ENGINES for v in VARIANTS]
                     + [{'kind': 'calibration', 'engine': e, 'variant': 'baseline', 'caseId': c} for e in ENGINES for c in CASES]
                     + [{'kind': 'main', **cell} for cell in self.main_schedule])
        for i, spec in enumerate(self.plan):
            spec['id'] = f'{i:03d}-' + '-'.join(str(spec.get(k, 'all')) for k in ('kind', 'engine', 'variant', 'caseId', 'round'))
        require(len(self.plan) == 400, 'fixed child count')
        self.result = {'complete': False, 'eligibleForSeparatelyReviewedFollowOn': False,
                       'base': BASE, 'plannedChildren': 400, 'executedChildren': 0,
                       'rssGuard': 'sampled process-group RSS and per-process HWM; terminal wait4 leader HWM',
                       'caps': {'rssBytes': RSS_LIMIT, 'childSeconds': 10, 'studySeconds': 600}}
        clear_decisions(self.result)
        root.mkdir()
        for directory in ('children', 'logs', 'consumers', 'inputs'):
            (root / directory).mkdir()
        write(root / 'schedule.json', self.plan)
        self.result['scheduleSha256'] = sha(root / 'schedule.json')
        write(root / 'analysis.json', {**summarize([]), 'terminalIntegrityClear': False,
                                      'eligibleForSeparatelyReviewedFollowOn': False})
        self.save()

    def save(self):
        write(self.root / 'rows.json', self.rows)
        write(self.root / 'command-receipts.json', self.commands)
        write(self.root / 'schedule-status.json', [
            {**spec, 'status': next(('complete' if r.get('complete') else 'failed'
                                    for r in self.rows if r['id'] == spec['id']), 'unrun')}
            for spec in self.plan])
        write(self.root / 'result.json', self.result)

    def check_time(self):
        require(not self.interrupted, 'screen interrupted; no next child may launch')
        if self.deadline is not None:
            require(time.monotonic() < self.deadline, 'whole-screen deadline exhausted')

    def check_terminal_state(self):
        self.check_time()

    def invalidate(self, reason, **fields):
        """Every late failure clears both user-visible eligibility records."""
        clear_decisions(self.result)
        self.result.update(complete=False, eligibleForSeparatelyReviewedFollowOn=False,
                           finalIntegrityVerified=False, finalizationError=str(reason),
                           artifactManifestStale=True, status='unresolved', **fields)
        try:
            analysis = read(self.root / 'analysis.json')
            clear_decisions(analysis)
            analysis.update(terminalIntegrityClear=False, eligibleForSeparatelyReviewedFollowOn=False,
                            eligible=False, status='unresolved')
            write(self.root / 'analysis.json', analysis)
        except BaseException:
            self.result['analysisInvalidOrMissing'] = True
        write(self.root / 'result.json', self.result)

    def integrity(self):
        self.check_time()
        require(sha(self.pins_path) == self.initial_pins_sha, 'execution pins changed')
        require(sha(self.root / 'schedule.json') == self.result['scheduleSha256'], 'fixed schedule changed')
        for name, expected in self.pins['implementationFiles'].items():
            require(sha(HERE / name) == expected, 'implementation changed: ' + name)
        for descriptor in self.pins['evidence'].values():
            file_pin(descriptor)
            self.check_time()
        for engine, descriptor in self.pins['executables'].items():
            require(descriptor['sha256'] == EXECUTABLE_SHA[engine], 'unexpected executable pin')
            file_pin(descriptor)
            self.check_time()
        for variant, arm in self.pins['arms'].items():
            folder = Path(arm['root']).resolve(strict=True)
            require(inventory(folder) == self.sources[variant], 'source tree differs: ' + variant)
            require(inventory(folder, True) == self.generated[variant], 'generated tree differs: ' + variant)
            authenticate_portable(folder, read(file_pin(arm['portableAuthentication'])))
            require(source_closure(folder) == read(file_pin(arm['bunSourceClosure'])), 'Bun source closure differs')
            require(arm['entries'] == {'node': {'relativePath': 'dist/shared.js', 'sha256': sha(folder / 'dist/shared.js')},
                                      'bun': {'relativePath': 'shared.ts', 'sha256': sha(folder / 'shared.ts')}},
                    'public entry pins differ')
            exports = read(folder / 'package.json')['exports']['.']
            require(exports['bun'] == './shared.ts' and exports['import'] == './dist/shared.js', 'public export conditions differ')
            self.check_time()

    def prepare(self):
        require(self.pins.get('executionReleased') is True, 'screen execution not released')
        require(self.pins.get('baseCommit') == BASE, 'base commit pin')
        required = {'method', 'fixtures', 'staticCoverage', 'sourcePins', 'methodReview', 'driverReview',
                    'executionRelease', 'ordinaryStage1Result', 'ordinaryStage1Manifest',
                    'ordinaryStage2Result', 'ordinaryStage2Manifest', 'ordinaryComposite',
                    'focusedCorrectness', 'sourceReview'}
        require(set(self.pins['evidence']) == required, 'complete evidence pins required')
        require(all(self.pins['evidence'][key]['sha256'] == value for key, value in METHOD_PINS.items()),
                'reviewed v5 method packet differs')
        for name, descriptor in self.pins['evidence'].items():
            path = file_pin(descriptor)
            shutil.copyfile(path, self.root / 'inputs' / (name + path.suffix))
        release = read(file_pin(self.pins['evidence']['executionRelease']))
        require(release.get('approved') is True and release.get('subjectChildren') == 400,
                'explicit fixed screen release missing')
        require(release.get('methodSha256') == self.pins['evidence']['method']['sha256'], 'release method mismatch')
        require(release.get('implementationFiles') == self.pins['implementationFiles'], 'release driver mismatch')
        require(release.get('arms') == self.pins['arms'] and release.get('executables') == self.pins['executables'],
                'release subject or executable bindings differ')
        require(release.get('evidence') == {k: v for k, v in self.pins['evidence'].items() if k != 'executionRelease'},
                'release evidence bindings differ')
        require(set(self.pins['arms']) == set(VARIANTS) and set(self.pins['executables']) == set(ENGINES), 'arm/runtime pins')
        baseline_root = Path(self.pins['arms']['baseline']['root']).resolve()
        candidate_root = Path(self.pins['arms']['candidate']['root']).resolve()
        require(not baseline_root.is_relative_to(candidate_root) and not candidate_root.is_relative_to(baseline_root),
                'subject source/output roots must be separate')
        for variant, arm in self.pins['arms'].items():
            require(arm['sources']['sha256'] == SOURCE_MANIFEST_SHA[variant], 'source manifest pin differs')
            self.sources[variant] = read(file_pin(arm['sources']))
            self.generated[variant] = read(file_pin(arm['generated']))
            require(len(self.sources[variant]) == (502 if variant == 'baseline' else 503), 'source file count')
            consumer = self.root / 'consumers' / variant
            (consumer / 'node_modules').mkdir(parents=True)
            (consumer / 'node_modules' / 'zerocopy').symlink_to(Path(arm['root']).resolve(), target_is_directory=True)
            for name in ('child.mjs', 'protocol.mjs'):
                shutil.copyfile(HERE / name, consumer / name)
            for key in ('sources', 'generated', 'portableAuthentication', 'bunSourceClosure'):
                shutil.copyfile(file_pin(arm[key]), self.root / 'inputs' / (variant + '-' + key + '.json'))
        authenticate_ordinary(self.pins['evidence'], self.sources['candidate'], self.generated['candidate'])
        self.integrity()
        require(self.generated['baseline']['persistent-core.wasm'] == self.generated['candidate']['persistent-core.wasm'],
                'native core differs between arms')
        native = lambda generated: {name: pin for name, pin in generated.items()
                                    if '/' not in name and Path(name).suffix in ('.wasm', '.wat')}
        require(native(self.generated['baseline']) == native(self.generated['candidate']), 'native outputs differ between arms')
        self.env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ') if key in os.environ}
        self.env.update({'CI': '1', 'NODE_OPTIONS': '', 'BUN_OPTIONS': ''})
        host = {'uname': list(os.uname()), 'pythonVersion': sys.version, 'pythonExecutable': sys.executable,
                'cpuinfo': Path('/proc/cpuinfo').read_text(),
                'meminfo': Path('/proc/meminfo').read_text(), 'affinity': sorted(os.sched_getaffinity(0)),
                'environment': self.env, 'executablePaths': {e: p['path'] for e, p in self.pins['executables'].items()},
                'run': {key: os.environ.get(key) for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion')}}
        write(self.root / 'host.json', host)
        self.result['hostSha256'] = sha(self.root / 'host.json')
        shutil.copyfile(self.pins_path, self.root / 'inputs' / 'EXECUTION-PINS.json')
        for name in self.pins['implementationFiles']:
            target = self.root / 'inputs' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(HERE / name, target)

    def diagnostics(self):
        from protocol import clock_summary
        readings = [time.perf_counter_ns() for _ in range(10001)]
        deltas = [b - a for a, b in zip(readings, readings[1:])]
        pairs = []
        for _ in range(1000):
            begin = time.perf_counter_ns()
            end = time.perf_counter_ns()
            pairs.append(end - begin)
        self.clock = clock_summary(deltas, pairs)
        write(self.root / 'supervisor-clock.json', {'domain': 'time.perf_counter_ns', 'deltasNs': deltas,
                                                  'pairsNs': pairs, **self.clock})
        require(self.clock['clear'], 'supervisor clock has no usable increment/cost estimates')

    def child(self, spec, count=None):
        self.check_time()
        consumer = self.root / 'consumers' / spec['variant']
        for name in ('child.mjs', 'protocol.mjs'):
            require(sha(consumer / name) == self.pins['implementationFiles'][name], 'consumer driver differs')
        root = Path(self.pins['arms'][spec['variant']]['root']).resolve()
        require((consumer / 'node_modules' / 'zerocopy').resolve() == root, 'arm-local package binding differs')
        config = {**spec, 'armRoot': str(root), 'N': count,
                  'expectedEntry': self.pins['arms'][spec['variant']]['entries'][spec['engine']],
                  'methodSha256': self.pins['evidence']['method']['sha256'],
                  'fixtureSha256': self.pins['evidence']['fixtures']['sha256'],
                  'fixturesPath': str(file_pin(self.pins['evidence']['fixtures']))}
        path = self.root / 'children' / (spec['id'] + '.json')
        config_path = path.with_suffix('.config.json')
        write(config_path, config)
        receipt = {'id': spec['id'], 'argv': [self.pins['executables'][spec['engine']]['path'],
                   str(consumer / 'child.mjs'), str(config_path), str(path)],
                   'cwd': str(consumer), 'complete': False, 'peakObservedGroupRss': 0,
                   'peakObservedProcessHwm': 0, 'cleanupSignals': [], 'sampleIntervalSeconds': .01}
        self.commands.append(receipt)
        self.result['executedChildren'] += 1
        self.save()
        failure, child, leftover = None, None, False
        started = time.perf_counter_ns()
        limit = min(self.deadline, time.monotonic() + CHILD_SECONDS)
        receipt['spawnStartedNs'] = started
        stdout_path, stderr_path = self.root / 'logs' / (spec['id'] + '.stdout'), self.root / 'logs' / (spec['id'] + '.stderr')
        try:
            with stdout_path.open('xb') as output, stderr_path.open('xb') as error:
                self.check_time()
                child = subprocess.Popen(receipt['argv'], cwd=consumer, env=self.env, stdout=subprocess.PIPE,
                                         stderr=error, start_new_session=True)
                self.active = child
                receipt['ownedProcessGroup'] = child.pid
                os.set_blocking(child.stdout.fileno(), False)
                pending = b''
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ)
                    def drain():
                        nonlocal pending
                        while True:
                            try:
                                data = os.read(child.stdout.fileno(), 65536)
                            except BlockingIOError:
                                return
                            if not data:
                                return
                            observed = time.perf_counter_ns()
                            output.write(data)
                            output.flush()
                            pending += data
                            while b'\n' in pending:
                                line, pending = pending.split(b'\n', 1)
                                item = json.loads(line)
                                if item.get('event') == 'ready':
                                    require('spawnToReadyNs' not in receipt, 'duplicate ready event')
                                    receipt['spawnToReadyNs'] = observed - started
                                elif item.get('event') == 'setup':
                                    receipt['launchStartupSetupNs'] = observed - started
                    while True:
                        drain()
                        memory = group_memory(child.pid)
                        if sampled_descendants(receipt, memory, child.pid):
                            failure = failure or 'unexpected sampled child descendant'
                        rss = sum(p.get('VmRSS', 0) for p in memory)
                        hwm = max([p.get('VmHWM', 0) for p in memory] or [0])
                        receipt['peakObservedGroupRss'] = max(receipt['peakObservedGroupRss'], rss)
                        receipt['peakObservedProcessHwm'] = max(receipt['peakObservedProcessHwm'], hwm)
                        if self.interrupted:
                            failure = failure or 'signal interrupted'
                        if time.monotonic() >= limit:
                            failure = failure or 'child or whole-study wall cap exceeded'
                        if max(rss, hwm) > RSS_LIMIT:
                            failure = failure or 'sampled RSS cap exceeded'
                        exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                        if failure and not receipt['cleanupSignals']:
                            kill_owned(child.pid)
                            receipt['cleanupSignals'].append('SIGKILL owned original group: ' + failure)
                        if exited:
                            drain()
                            break
                        selector.select(timeout=.01)
                # WNOWAIT preserves the leader PID while any descendants are killed.
                descendants = [p for p in group_memory(child.pid) if p['pid'] != child.pid]
                leftover = bool(descendants)
                if leftover:
                    kill_owned(child.pid)
                    receipt['cleanupSignals'].append('SIGKILL descendants before leader reap')
                    failure = failure or 'unexpected child descendants'
                    while time.monotonic() < limit and descendants:
                        time.sleep(.001)
                        descendants = [p for p in group_memory(child.pid) if p['pid'] != child.pid]
                receipt['remainingDescendantsBeforeReap'] = descendants
                self.active = None  # No signal authority survives the releasing reap.
                _, status, usage = os.wait4(child.pid, 0)
                child.returncode = os.waitstatus_to_exitcode(status)
                receipt['exitCode'] = child.returncode
                receipt['wait4MaxRssBytes'] = usage.ru_maxrss * 1024
                receipt['leaderReapedAfterCleanup'] = True
                if receipt['wait4MaxRssBytes'] > RSS_LIMIT:
                    failure = failure or 'terminal RSS high-water cap exceeded'
                if time.monotonic() >= limit:
                    failure = failure or 'wall cap exceeded at terminal reap'
                require(not failure and child.returncode == 0 and not leftover, failure or 'child exit failure')
            row = read(path)
            require(all(row.get(k) == v for k, v in config.items() if k != 'N'), 'child identity mismatch')
            require(row.get('complete') is True, 'child incomplete')
            require('spawnToReadyNs' in receipt, 'missing ready event')
            require(spec['kind'] == 'validation' or 'launchStartupSetupNs' in receipt, 'missing setup observation')
            if spec['kind'] == 'main':
                require(row['N'] == count, 'child changed frozen count')
            receipt['complete'] = True
        except BaseException as exc:
            failure = failure or repr(exc)
            row = recover(config, path)
            row['childReportedComplete'] = row.get('complete', False)
            row['complete'], row['qualityClear'] = False, False
            row['parentFailure'] = failure
            raise
        finally:
            if self.active is not None:
                owned = self.active
                kill_owned(owned.pid)
                # This process still owns an unreaped leader. Cleanup precedes reap.
                descendants = [p for p in group_memory(owned.pid) if p['pid'] != owned.pid]
                receipt['terminalCleanupDescendants'] = descendants
                self.active = None
                _, status, usage = os.wait4(owned.pid, 0)
                owned.returncode = os.waitstatus_to_exitcode(status)
                receipt.update(exitCode=owned.returncode, wait4MaxRssBytes=usage.ru_maxrss * 1024)
                receipt['leaderReapedAfterCleanup'] = True
            if 'row' not in locals():
                row = recover(config, path)
                row.update(complete=False, qualityClear=False, parentFailure=failure)
            receipt['elapsedNs'] = time.perf_counter_ns() - started
            if child is not None and child.stdout is not None:
                child.stdout.close()
            receipt['failure'] = failure
            for name, log in (('stdout', stdout_path), ('stderr', stderr_path)):
                if log.exists():
                    receipt[name] = {'sha256': sha(log), 'bytes': log.stat().st_size}
            row['startup']['spawnToReadyNs'] = receipt.get('spawnToReadyNs')
            row['supervisorClock'] = self.clock
            row['launchStartupSetupNs'] = receipt.get('launchStartupSetupNs')
            row['supervisorReceiptId'] = spec['id']
            self.rows.append(row)
            self.save()
        return row

    def study(self):
        from protocol import feasibility
        self.start = time.monotonic()
        self.deadline = self.start + STUDY_SECONDS
        signal.setitimer(signal.ITIMER_REAL, STUDY_SECONDS)
        self.diagnostics()
        for spec in self.plan[:4]:
            self.child(spec)
        for spec in self.plan[4:16]:
            row = self.child(spec)
            require(row['qualityClear'], 'baseline calibration unresolved')
        calibrations = self.rows[4:16]
        receipt = feasibility(calibrations, time.monotonic() - self.start)
        frozen = {'calibrations': calibrations, 'feasibility': receipt,
                  'counts': {r['engine'] + '/' + r['caseId']: r['N'] for r in calibrations}}
        write(self.root / 'frozen-counts.json', frozen)
        frozen_sha = sha(self.root / 'frozen-counts.json')
        self.result['frozenCountsSha256'] = frozen_sha
        require(receipt['clear'], 'budget-infeasible before candidate performance')
        for spec in self.plan[16:]:
            require(sha(self.root / 'frozen-counts.json') == frozen_sha, 'counts or feasibility changed')
            self.child(spec, frozen['counts'][spec['engine'] + '/' + spec['caseId']])
        require(len(self.rows) == 400 and all(r['complete'] for r in self.rows), 'incomplete fixed cohort')
        self.result['complete'] = True

    def finish(self):
        from protocol import summarize
        self.finalizing = True
        try:
            self.check_terminal_state()
            analysis = summarize([r for r in self.rows if r['kind'] == 'main'])
            decisions = {key: bool(analysis.get(key)) for key in DECISION_FIELDS}
            data_status = analysis['status']
            clear_decisions(analysis)
            analysis['status'] = 'unresolved'
            analysis['terminalIntegrityClear'] = False
            analysis['eligibleForSeparatelyReviewedFollowOn'] = False
            write(self.root / 'analysis.json', analysis)
            self.integrity()
            self.check_terminal_state()
            analysis['terminalIntegrityClear'] = bool(self.result['complete'])
            if self.result['complete']:
                analysis.update(decisions)
                analysis['eligibleForSeparatelyReviewedFollowOn'] = analysis['diagnosticFollowOnEligible']
                analysis['status'] = data_status
            write(self.root / 'analysis.json', analysis)
            manifest = {}
            for path in sorted(self.root.rglob('*')):
                if path.is_file() and not path.is_symlink() and 'consumers' not in path.parts and path.name not in ('ARTIFACT-SHA256.json', 'result.json'):
                    self.check_terminal_state()
                    manifest[path.relative_to(self.root).as_posix()] = sha(path)
            write(self.root / 'ARTIFACT-SHA256.json', manifest)
            self.check_terminal_state()
            self.result['artifactManifestSha256'] = sha(self.root / 'ARTIFACT-SHA256.json')
            self.result['artifactManifestExcludes'] = ['result.json', 'ARTIFACT-SHA256.json', 'consumers/']
            self.result.update({key: analysis[key] for key in DECISION_FIELDS})
            self.result['status'] = analysis['status']
            self.result['cleanupVerified'] = all(r.get('leaderReapedAfterCleanup') and
                not r.get('remainingDescendantsBeforeReap') and not r.get('terminalCleanupDescendants')
                for r in self.commands)
            self.result['finalIntegrityVerified'] = True
            self.result['seconds'] = None if self.start is None else time.monotonic() - self.start
            self.check_terminal_state()
            # This terminal file is excluded from and binds the final manifest.
            write(self.root / 'result.json', self.result)
            self.check_terminal_state()
        except BaseException as exc:
            self.result['seconds'] = None if self.start is None else time.monotonic() - self.start
            expired = self.deadline is not None and time.monotonic() >= self.deadline
            self.invalidate(repr(exc), deadlineExceeded=expired)


def main():
    require(len(sys.argv) == 3, 'usage: supervisor.py EXECUTION-PINS.json NEW-OUTPUT-DIRECTORY')
    run = Run(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    def interrupted(signum, frame):
        run.interrupted = signum
        if run.active is not None:
            kill_owned(run.active.pid)
        if signum == signal.SIGALRM:
            # No extra reconciliation allowance can extend the approved 600 s.
            # Raw events already live in the output tree. A hard stop is never eligible.
            try:
                run.invalidate('600-second whole-screen deadline exhausted', deadlineExceeded=True,
                               cleanupVerified=False, hardStop=True)
            finally:
                os._exit(124)
        if getattr(run, 'finalizing', False):
            # Interrupt control flow so a signal cannot leave a stale valid local.
            run.invalidate('signal during finalization: ' + str(signum))
            raise InterruptedError('signal during finalization: ' + str(signum))
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
        signal.signal(signum, interrupted)
    try:
        run.prepare()
        run.study()
    except BaseException as exc:
        run.result.update(complete=False, error=repr(exc), eligibleForSeparatelyReviewedFollowOn=False)
    finally:
        run.finish()
        signal.setitimer(signal.ITIMER_REAL, 0)
    return 0 if run.result['complete'] and run.result.get('finalIntegrityVerified') else 1


if __name__ == '__main__':
    raise SystemExit(main())
