"""One finite preparation; no subject imports, tests, calibration or timing."""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tarfile
import time

from provision_common import Commands, signal_group
from supervisor import (BASE, EXECUTABLE_SHA, METHOD_PINS, SOURCE_MANIFEST_SHA,
    authenticate_ordinary, authenticate_portable, inventory, read, require, sha,
    source_closure, write)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BRANCH = 'proof/empty-prefix-read-screen-20261015'
WORKFLOW = '.github/workflows/empty-prefix-read-screen.yml'
TOTAL_SECONDS, RESERVE_SECONDS = 900, 60
MIN_AVAILABLE = 5368709120
NPM_SHA = '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7'
BUILD_PLAN = [('baseline', 'native', 90), ('baseline', 'portable', 60),
              ('candidate', 'native', 90), ('candidate', 'portable', 60),
              ('candidate', 'declarations', 60)]


def substitute(value, bindings):
    """Only complete, reviewed placeholder tokens can acquire runtime values."""
    if isinstance(value, dict):
        return {key: substitute(item, bindings) for key, item in value.items()}
    if isinstance(value, list):
        return [substitute(item, bindings) for item in value]
    if not isinstance(value, str):
        return value
    for token in re.findall(r'\$\{[A-Z_]+\}', value):
        require(token in bindings, 'unknown release placeholder: ' + token)
        value = value.replace(token, bindings[token])
    require('${' not in value, 'malformed release placeholder')
    return value


class Run(Commands):
    def __init__(self, root):
        self.root = root
        require(not root.exists() and not root.is_relative_to(REPO), 'fresh external preparation root required')
        self.start = time.monotonic()
        self.end = self.start + TOTAL_SECONDS
        self.deadline = self.end - RESERVE_SECONDS
        self.phase, self.active, self.interrupted = 'preparation', None, None
        root.mkdir()
        self.artifact = root / 'artifact'
        self.artifact.mkdir()
        self.input_pins = read(HERE / 'INPUT-SHA256.json')
        self.input_manifest_sha = sha(HERE / 'INPUT-SHA256.json')
        self.sources, self.generated, self.executables, self.receipts = {}, {}, {}, []
        self.arms = {arm: root / 'arms' / arm for arm in ('baseline', 'candidate')}
        self.env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ') if key in os.environ}
        self.env.update(CI='1', NODE_OPTIONS='', BUN_OPTIONS='', npm_config_audit='false', npm_config_fund='false')
        self.result = {'kind': 'empty-prefix-screen-preparation', 'complete': False,
            'baseCommit': BASE, 'buildsPassed': [], 'unrunCommands': [],
            'subjectChildren': 0, 'screenSeconds': 600, 'screenPlannedChildren': 400,
            'runId': os.environ.get('GITHUB_RUN_ID'), 'attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
            'caps': {'preparationSeconds': 900, 'preservationReserveSeconds': 60,
                     'sampledGroupRssBytes': 4294967296, 'minimumAvailableMemoryBytes': MIN_AVAILABLE}}
        write(self.artifact / 'preparation-result.json', self.result)

    def check_budget(self):
        require(not self.interrupted, 'preparation interrupted')
        require(time.monotonic() < self.deadline, self.phase + ' deadline exhausted')

    def check_inputs(self):
        self.check_budget()
        require(sha(HERE / 'INPUT-SHA256.json') == self.input_manifest_sha, 'input manifest changed')
        for name, digest in self.input_pins.items():
            self.check_budget()
            path = (REPO / name).resolve(strict=True)
            require(path.is_relative_to(REPO) and not (REPO / name).is_symlink() and sha(path) == digest,
                    'publication input changed: ' + name)
        for arm, expected in self.sources.items():
            require(inventory(self.arms[arm]) == expected, 'source tree changed: ' + arm)
            self.check_budget()
        for arm, expected in self.generated.items():
            require(inventory(self.arms[arm], True) == expected, 'generated tree changed: ' + arm)
            self.check_budget()
        for engine, pin in self.executables.items():
            require(sha(Path(pin['path'])) == pin['sha256'], 'executable changed: ' + engine)
            self.check_budget()
        if (self.root / 'toolchain').exists():
            for name in ('package.json', 'package-lock.json'):
                require(sha(self.root / 'toolchain' / name) == sha(HERE / 'toolchain' / name), 'toolchain input changed')

    def prepare(self):
        self.check_inputs()
        require(os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy', 'repository mismatch')
        require(os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_REF') == 'refs/heads/' + BRANCH,
                'only the released branch push may prepare')
        require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'no retry attempt')
        require(os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64', 'host mismatch')
        memory = {k: int(v) * 1024 for k, v in re.findall(r'^(MemTotal|MemAvailable):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M)}
        write(self.artifact / 'host.json', {'memory': memory, 'uname': list(os.uname()),
            'run': {k: os.environ.get(k) for k in ('GITHUB_SHA', 'GITHUB_REF', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'ImageOS', 'ImageVersion')}})
        require(memory['MemAvailable'] >= MIN_AVAILABLE, 'insufficient preparation memory headroom')
        self.command('proof-head', ['git', 'rev-parse', 'HEAD'], REPO, 10)
        self.head = self.output('proof-head')
        require(re.fullmatch('[0-9a-f]{40}', self.head) and self.head == os.environ.get('GITHUB_SHA'), 'event/head mismatch')
        self.command('proof-parent', ['git', 'rev-list', '--parents', '-n', '1', 'HEAD'], REPO, 10)
        require(self.output('proof-parent').split() == [self.head, BASE], 'proof sole parent mismatch')
        self.command('proof-tree', ['git', 'rev-parse', 'HEAD^{tree}'], REPO, 10)
        self.command('proof-delta', ['git', 'diff', '--name-status', '-z', BASE, 'HEAD'], REPO, 10)
        entries = (self.artifact / 'logs/proof-delta.stdout').read_bytes().split(b'\0')[:-1]
        require(len(entries) % 2 == 0, 'unexpected Git delta encoding')
        changes = {entries[i+1].decode(): entries[i].decode() for i in range(0, len(entries), 2)}
        expected_paths = set(self.input_pins) | {'proofs/empty-prefix-screen/INPUT-SHA256.json'}
        require(changes == {name: 'A' for name in expected_paths}, 'proof delta contains missing, changed or unrelated files')
        self.result.update(proofCommit=self.head, proofTree=self.output('proof-tree'), inputManifestSha256=self.input_manifest_sha)
        write(self.artifact / 'proof-delta.json', changes)
        self.node = Path(shutil.which('node')).resolve(strict=True)
        require(sha(self.node) == EXECUTABLE_SHA['node'], 'Node binary pin')
        self.npm = self.node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
        require(sha(self.npm) == NPM_SHA, 'npm CLI pin')
        toolchain = self.root / 'toolchain'
        shutil.copytree(HERE / 'toolchain', toolchain)
        self.env['PATH'] = str(self.node.parent) + os.pathsep + self.env['PATH']
        self.command('locked-dependencies', [self.node, self.npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], toolchain, 180,
                     {'npm_config_offline': 'false', 'npm_config_registry': 'https://registry.npmjs.org/'})
        self.bun = (toolchain / 'node_modules/@oven/bun-linux-x64/bin/bun').resolve(strict=True)
        require(sha(self.bun) == EXECUTABLE_SHA['bun'], 'Bun binary pin')
        self.env['PATH'] = str(self.bun.parent) + os.pathsep + str(toolchain / 'node_modules/.bin') + os.pathsep + self.env['PATH']
        self.env['npm_config_offline'] = 'true'
        for engine, path, version in [('node', self.node, '22.16.0'), ('bun', self.bun, '1.4.2')]:
            self.command(engine + '-version', [path, '--version'], toolchain, 5)
            require(self.output(engine + '-version').lstrip('v') == version, 'runtime version mismatch')
            self.command(engine + '-identity', [path, '-p', 'JSON.stringify({execPath:process.execPath,version:process.version,versions:process.versions})'], toolchain, 5)
            identity = json.loads(self.output(engine + '-identity'))
            require(Path(identity['execPath']).resolve() == path, 'runtime executable identity')
            self.executables[engine] = {'path': str(path), 'sha256': EXECUTABLE_SHA[engine]}
        write(self.artifact / 'executables.json', self.executables)
        archive = self.root / 'main.tar'
        self.command('archive-exact-main', ['git', 'archive', '--format=tar', BASE, '-o', archive], REPO, 30)
        baseline = read(HERE / 'baseline-sources.json')
        require(len(baseline) == 502 and sha(HERE / 'baseline-sources.json') == SOURCE_MANIFEST_SHA['baseline'], 'baseline source pin')
        for arm, folder in self.arms.items():
            folder.mkdir(parents=True)
            with tarfile.open(archive) as source:
                for member in source:
                    self.check_budget()
                    source.extract(member, folder, filter='data')
            require(inventory(folder) == baseline, 'extracted main source differs')
        self.command('check-fixed-patch', ['git', 'apply', '--check', '-p1', HERE / 'candidate.patch'], self.arms['candidate'], 10)
        self.command('apply-fixed-patch', ['git', 'apply', '-p1', HERE / 'candidate.patch'], self.arms['candidate'], 10)
        for arm, folder in self.arms.items():
            self.sources[arm] = read(HERE / (arm + '-sources.json'))
            require(sha(HERE / (arm + '-sources.json')) == SOURCE_MANIFEST_SHA[arm], 'arm source manifest pin')
            require(inventory(folder) == self.sources[arm], 'prepared source mismatch')
            (folder / 'node_modules').symlink_to(toolchain / 'node_modules', target_is_directory=True)
        native_inputs = {name: digest for name, digest in baseline.items() if name.endswith('.as.ts') or name in ('scripts/build-wasm.mjs', 'package.json')}
        require(all(self.sources['candidate'][name] == digest for name, digest in native_inputs.items()), 'native production inputs differ')
        write(self.artifact / 'native-inputs.json', native_inputs)
        self.check_inputs()

    def build(self):
        commands = {'native': [self.node, 'scripts/build-wasm.mjs'], 'portable': [self.bun, 'scripts/build-browser.ts'],
            'declarations': [self.node, 'node_modules/typescript/bin/tsc', '--emitDeclarationOnly', '--noEmit', 'false',
                             '--declarationMap', 'false', '--outDir', 'dist/types']}
        for arm, kind, cap in BUILD_PLAN:
            self.command(arm + '-' + kind, commands[kind], self.arms[arm], cap)
            actual = inventory(self.arms[arm], True)
            if kind == 'native':
                require({n:v for n,v in actual.items() if '/' not in n} == read(HERE / 'baseline-native.json'), 'native output mismatch')
            if kind == 'portable':
                authenticate_portable(self.arms[arm], read(HERE / (arm + '-portable-authentication.json')))
            if (arm, kind) in [('baseline', 'portable'), ('candidate', 'declarations')]:
                self.generated[arm] = read(HERE / (arm + '-generated.json'))
                require(actual == self.generated[arm], 'complete generated manifest mismatch: ' + arm)
            self.result['buildsPassed'].append(arm + '-' + kind)
            write(self.artifact / 'preparation-result.json', self.result)
            self.check_inputs()

    def bind(self):
        self.check_inputs()
        for arm, folder in self.arms.items():
            authenticate_portable(folder, read(HERE / (arm + '-portable-authentication.json')))
            require(source_closure(folder) == read(HERE / (arm + '-bun-source-closure.json')), 'Bun static source closure mismatch')
            self.check_budget()
        bindings = {'${PROVISION_ROOT}': str(self.root), '${BUNDLE_ROOT}': str(HERE),
                    '${NODE}': str(self.node), '${BUN}': str(self.bun), '${PROOF_HEAD}': self.head}
        pins = substitute(read(HERE / 'EXECUTION-TEMPLATE.json'), bindings)
        require(pins['executionReleased'] is True and pins['expectedHostedHead'] == self.head, 'prospective released template mismatch')
        for key, digest in METHOD_PINS.items():
            require(pins['evidence'][key]['sha256'] == digest, 'method binding mismatch')
        authenticate_ordinary(pins['evidence'], self.sources['candidate'], self.generated['candidate'])
        release = substitute(read(HERE / 'RELEASE-TEMPLATE.json'), bindings)
        require(release.get('approved') is True and release.get('subjectChildren') == 400, 'reviewed release scope missing')
        require(release['arms'] == pins['arms'] and release['executables'] == pins['executables']
                and release['implementationFiles'] == pins['implementationFiles'] and release['evidence'] == pins['evidence'],
                'release and execution templates disagree')
        self.check_inputs()
        write(self.root / 'EXECUTION-RELEASE.json', release)
        pins['evidence']['executionRelease'] = {'path': str(self.root / 'EXECUTION-RELEASE.json'), 'sha256': sha(self.root / 'EXECUTION-RELEASE.json')}
        write(self.root / 'EXECUTION-PINS.json', pins)
        self.check_budget()
        self.result['executionPinsSha256'] = sha(self.root / 'EXECUTION-PINS.json')
        self.result['readyForScreen'] = True

    def preserve(self):
        # Finite copies preserve actual measured inputs without rerunning any subject.
        self.check_budget()
        for name in self.input_pins:
            target = self.artifact / 'publication' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / name, target)
            self.check_budget()
        shutil.copyfile(HERE / 'INPUT-SHA256.json', self.artifact / 'INPUT-SHA256.json')
        for arm, folder in self.arms.items():
            if not folder.exists(): continue
            sources, outputs = inventory(folder), inventory(folder, True)
            write(self.artifact / (arm + '-final-sources.json'), sources)
            write(self.artifact / (arm + '-final-generated.json'), outputs)
            with tarfile.open(self.artifact / (arm + '-source.tar'), 'w') as archive:
                for name in sources:
                    self.check_budget(); archive.add(folder / name, arcname=name, recursive=False)
            for name, pin in outputs.items():
                self.check_budget()
                target = self.artifact / 'generated' / arm / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(folder / name, target)
                require(sha(target) == pin['sha256'], 'preserved output mismatch')
        for name in ('EXECUTION-PINS.json', 'EXECUTION-RELEASE.json'):
            if (self.root / name).exists(): shutil.copyfile(self.root / name, self.artifact / name)


def main():
    require(len(sys.argv) == 2, 'usage: provision.py NEW-ROOT')
    run = Run(Path(sys.argv[1]).resolve())
    def alarm(_number=None, _frame=None):
        if run.active is not None: signal_group(run.active.pid, signal.SIGKILL)
        if run.phase != 'preservation': raise TimeoutError('840-second preparation work deadline')
        run.result.update(complete=False, readyForScreen=False, hardStop=True, cleanupVerified=False, artifactManifestStale=True)
        try: write(run.artifact / 'preparation-result.json', run.result)
        finally: os._exit(124)
    def interrupted(number, _frame):
        run.interrupted = number
        if run.phase == 'preservation':
            run.result.update(complete=False, readyForScreen=False, finalIntegrityVerified=False,
                              artifactManifestStale=True, finalizationError='interrupted during preservation')
            write(run.artifact / 'preparation-result.json', run.result)
            raise InterruptedError('preparation interrupted during preservation')
    signal.signal(signal.SIGALRM, alarm)
    for number in (signal.SIGTERM, signal.SIGINT): signal.signal(number, interrupted)
    failed = False
    try:
        signal.setitimer(signal.ITIMER_REAL, max(.001, run.deadline - time.monotonic()))
        run.prepare(); run.build(); run.bind()
    except BaseException as error:
        failed = True
        run.result.update(error=repr(error), failedCommand=run.result.get('activeCommand'))
    finally:
        run.phase = 'preservation'
        run.deadline = min(run.end, time.monotonic() + RESERVE_SECONDS)
        signal.setitimer(signal.ITIMER_REAL, max(.001, run.deadline - time.monotonic()))
        try:
            run.cleanup()
            run.result['cleanupVerified'] = all(row.get('leaderReapedAfterCleanup') and not row.get('descendantsAfterCleanup')
                for row in run.receipts if 'ownedProcessGroup' in row)
            require(run.result['cleanupVerified'], 'preparation cleanup incomplete')
            run.check_inputs(); run.result['finalIntegrityVerified'] = True
        except BaseException as error:
            failed = True; run.result['cleanupOrIntegrityError'] = repr(error)
        try: run.preserve()
        except BaseException as error:
            failed = True; run.result['preservationError'] = repr(error)
        try:
            run.check_budget()
            write(run.artifact / 'command-receipts.json', run.receipts)
            manifest = {}
            for path in sorted(run.artifact.rglob('*')):
                if path.is_file() and path.name not in ('ARTIFACT-SHA256.json', 'preparation-result.json'):
                    run.check_budget(); manifest[path.relative_to(run.artifact).as_posix()] = sha(path)
            write(run.artifact / 'ARTIFACT-SHA256.json', manifest)
            run.result['artifactManifestSha256'] = sha(run.artifact / 'ARTIFACT-SHA256.json')
            run.check_budget()
            run.result['complete'] = bool(not failed and run.result.get('readyForScreen'))
            run.result['readyForScreen'] = run.result['complete']
            write(run.artifact / 'preparation-result.json', run.result)
            run.check_budget()
        except BaseException as error:
            failed = True; run.result.update(complete=False, readyForScreen=False, artifactManifestStale=True, finalizationError=repr(error))
            write(run.artifact / 'preparation-result.json', run.result)
        signal.setitimer(signal.ITIMER_REAL, 0)
    return 0 if run.result['complete'] and not run.interrupted else 1


if __name__ == '__main__':
    raise SystemExit(main())
