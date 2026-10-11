"""Portable setup and evidence bindings for a single hosted cohort.

The timing engine, corpus, analysis, ordering and supervisor live in the adjacent
files. This adapter never changes their scientific configuration.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import time

PUBLIC = Path(__file__).resolve().parent
SOURCE = json.loads((PUBLIC / 'SOURCE.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda path: json.loads(path.read_text())
setup_signal = None
active_supervisor = None


def stop_setup(number, _frame):
    global setup_signal
    if setup_signal is None:
        setup_signal = number
    if active_supervisor is not None and active_supervisor.poll() is None:
        try:
            active_supervisor.send_signal(number)
        except ProcessLookupError:
            pass


def check_setup_interruption():
    if setup_signal is not None:
        raise InterruptedError(f'Setup interrupted by signal {setup_signal}; no later stage may run')


def put(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def file_record(path):
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': sha(data), 'regularFile': not path.is_symlink()}


def inventory(roots):
    files, links, directories = {}, {}, set()

    def add(path):
        if path.is_symlink():
            links[str(path)] = {'path': str(path), 'target': os.readlink(path), 'targetExists': path.exists()}
            assert path.exists(), path
            target = path.resolve(strict=True)
            if target.is_file():
                files[str(target)] = file_record(target)
        elif path.is_dir():
            directories.add(str(path))
        elif path.is_file():
            files[str(path)] = file_record(path)
        else:
            raise ValueError(f'Unsupported or absent input: {path}')

    for root in roots:
        root = Path(root).absolute()
        add(root)
        if root.is_dir() and not root.is_symlink():
            for directory, subdirs, names in os.walk(root, followlinks=False):
                for name in subdirs + names:
                    add(Path(directory) / name)
    return {'directories': sorted(directories), 'files': [files[k] for k in sorted(files)],
            'symlinks': [links[k] for k in sorted(links)]}


def verify_inventory(pins):
    for name in pins['directories']:
        path = Path(name)
        assert path.is_dir() and not path.is_symlink(), name
    for item in pins['symlinks']:
        path = Path(item['path'])
        assert path.is_symlink() and os.readlink(path) == item['target'] and path.exists(), path
    for item in pins['files']:
        path = Path(item['path'])
        data = path.read_bytes()
        assert len(data) == item['bytes'] and sha(data) == item['sha256'], path
        if item['regularFile']:
            assert path.is_file() and not path.is_symlink(), path


def output(argv, cwd=None):
    return subprocess.check_output([str(x) for x in argv], cwd=cwd, timeout=15, text=True).strip()


def verify_public(repo):
    payload = read(PUBLIC / 'PAYLOAD.json')
    assert payload['sourceCommit'] == SOURCE['commit']
    expected = {item['path'] for item in payload['files']} | {'proofs/lazy-bulk-hosted/PAYLOAD.json'}
    for item in payload['files']:
        path = repo / item['path']
        data = path.read_bytes()
        assert not path.is_symlink() and len(data) == item['bytes'] and sha(data) == item['sha256'], path
    # A single new proof commit is the only permitted published cohort. A push
    # after it, a workflow rerun, or a PR merge checkout cannot launch another.
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('GITHUB_EVENT_NAME') == 'push'
    assert os.environ.get('GITHUB_RUN_ATTEMPT') == '1'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/agent/lazy-bulk-tables-hosted-screen-20261011'
    head = output(['git', 'rev-parse', 'HEAD'], repo)
    assert head == os.environ['GITHUB_SHA']
    assert output(['git', 'rev-list', '--parents', '-n', '1', head], repo).split() == [head, SOURCE['commit']]
    assert output(['git', 'rev-parse', SOURCE['commit'] + '^{tree}'], repo) == SOURCE['tree']
    changes = output(['git', 'diff', '--name-only', SOURCE['commit'], head], repo).splitlines()
    assert set(changes) == expected and len(changes) == len(expected)
    assert not output(['git', 'status', '--porcelain', '--untracked-files=all'], repo)
    return head


def supervised(work, identifier, argv, cwd, seconds, rss=2048):
    global active_supervisor
    check_setup_interruption()
    log = work / 'setup' / (identifier + '.log')
    command = [sys.executable, str(PUBLIC / 'supervise.py'), '--cwd', str(cwd),
               '--seconds', str(seconds), '--rss-mib', str(rss), '--output', str(log), '--', *map(str, argv)]
    with (work / 'setup' / (identifier + '.supervisor.log')).open('xb') as stream:
        active_supervisor = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT)
        # Close the signal-before-Popen race without killing the supervisor:
        # it must retain ownership of the subject group's bounded cleanup.
        if setup_signal is not None:
            stop_setup(setup_signal, None)
        code = active_supervisor.wait()
        active_supervisor = None
    receipt = read(Path(str(log) + '.receipt.json'))
    assert receipt['command'] == list(map(str, argv)) and receipt['cwd'] == str(cwd)
    assert receipt['secondsCap'] == seconds and receipt['rssMiBCap'] == rss
    cleanup = receipt['cleanup']
    assert code == 0 and receipt['state'] == 'passed'
    assert receipt['limit'] is None and receipt['signal'] is None and receipt['error'] is None
    assert cleanup['confirmedEmpty'] and not cleanup['remainingBeforeCleanup']
    assert not cleanup['remainingAfterCleanup'] and not cleanup['errors'] and not cleanup['signals']
    check_setup_interruption()
    return receipt


def verify_source(directory, arm):
    for name, digest in SOURCE['baselineSourceHashes'].items():
        path = directory / name
        expected = SOURCE['candidateArenaSHA256'] if name == 'arena.ts' and arm == 'candidate' else digest
        assert path.is_file() and not path.is_symlink() and sha(path.read_bytes()) == expected, path


def prepare_inputs(work, repo):
    started = time.monotonic()
    head = verify_public(repo)
    assert not work.exists(), 'A cohort directory cannot be reused'
    work.mkdir()
    (work / 'setup').mkdir()
    correct = work / 'correctness'
    correct.mkdir()
    archive = work / 'source.tar'
    with archive.open('xb') as stream:
        subprocess.run(['git', 'archive', '--format=tar', SOURCE['commit']], cwd=repo, stdout=stream, check=True, timeout=30)
    for arm in ['baseline', 'candidate']:
        target = correct / arm
        target.mkdir()
        with tarfile.open(archive) as source:
            members = source.getmembers()
            for member in members:
                name = Path(member.name)
                assert not name.is_absolute() and '..' not in name.parts
                assert member.isfile() or member.isdir(), member.name
            assert {m.name for m in members if m.isfile()} == set(SOURCE['baselineSourceHashes'])
            source.extractall(target)
        verify_source(target, 'baseline')
    patch = PUBLIC / 'candidate.patch'
    assert sha(patch.read_bytes()) == SOURCE['candidatePatchSHA256']
    subprocess.run(['git', 'apply', '--check', str(patch)], cwd=correct / 'candidate', check=True, timeout=15)
    subprocess.run(['git', 'apply', str(patch)], cwd=correct / 'candidate', check=True, timeout=15)
    for arm in ['baseline', 'candidate']:
        verify_source(correct / arm, arm)
        for name, digest in SOURCE['nativeBuildInputs'].items():
            assert sha((correct / arm / name).read_bytes()) == digest

    node, bun = [Path(shutil.which(name)).resolve(strict=True) for name in ['node', 'bun']]
    assert output([node, '--version']) == 'v22.23.3'
    assert output([bun, '--version']) == '1.4.2'
    toolchain = work / 'toolchain'
    toolchain.mkdir()
    shutil.copyfile(correct / 'baseline/package.json', toolchain / 'package.json')
    # No repository lockfile exists at this base. Resolve once, retain the lock
    # and hash every installed file; the exact resolved cohort is never reused.
    supervised(work, 'install-dependencies', [bun, 'install', '--ignore-scripts'], toolchain, 180)
    versions = {}
    for name, expected in [('typescript', '5.9.3'), ('vitest', '4.1.11'), ('assemblyscript', '0.28.20')]:
        path = toolchain / 'node_modules' / name / 'package.json'
        versions[name] = read(path)['version']
        assert versions[name] == expected
    for arm in ['baseline', 'candidate']:
        (correct / arm / 'node_modules').symlink_to(toolchain / 'node_modules', target_is_directory=True)
    native_inputs = inventory([correct / 'baseline' / name for name in SOURCE['nativeBuildInputs']] + [toolchain / 'node_modules', node])
    put(work / 'NATIVE-INPUTS.json', native_inputs)
    native = supervised(work, 'build-native-once', [node, 'scripts/build-wasm.mjs'], correct / 'baseline', 120)
    verify_inventory(native_inputs)
    wasm_names = ['persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm']
    native_records = []
    for path in sorted((correct / 'baseline').glob('*.wasm')):
        assert path.read_bytes().startswith(b'\0asm')
        shutil.copyfile(path, correct / 'candidate' / path.name)
        native_records.append({'name': path.name, **{k: v for k, v in file_record(path).items() if k != 'path'}})
    assert set(wasm_names) <= {item['name'] for item in native_records}
    put(correct / 'REUSE-WASM.json', {'kind': 'fresh-host-native-build-shared-by-identical-inputs',
        'sourceCommit': SOURCE['commit'], 'compilerVersion': versions['assemblyscript'],
        'records': [item for item in native_records if item['name'] in wasm_names]})
    put(work / 'NATIVE-BUILD.json', {'sourceCommit': SOURCE['commit'], 'nativeInputManifestSHA256': sha((work / 'NATIVE-INPUTS.json').read_bytes()),
        'receipt': native, 'outputs': native_records, 'crossHostByteEquivalenceClaimed': False})
    host = {'schema': 1, 'kind': 'prospective-hosted-cohort', 'proofCommit': head, 'sourceCommit': SOURCE['commit'],
        'sourceTree': SOURCE['tree'], 'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'platform': platform.platform(), 'machine': platform.machine(), 'python': sys.version,
        'cpuinfo': Path('/proc/cpuinfo').read_text(), 'osRelease': Path('/etc/os-release').read_text(),
        'availableCPUs': sorted(os.sched_getaffinity(0)), 'logicalCPUCount': os.cpu_count(),
        'nodeVersion': output([node, '--version']), 'bunVersion': output([bun, '--version']),
        'nodeComponents': json.loads(output([node, '-p', 'JSON.stringify(process.versions)'])),
        'packages': versions, 'binaries': [file_record(p) for p in [node, bun, Path(sys.executable).resolve()]],
        'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
        'runnerOS': os.environ.get('RUNNER_OS'), 'runnerArch': os.environ.get('RUNNER_ARCH'),
        'runnerImageOS': os.environ.get('ImageOS'), 'runnerImageVersion': os.environ.get('ImageVersion'),
        'localTimingExists': False, 'crossHostEquivalenceClaimed': False}
    put(work / 'HOST.json', host)
    for name in ['bulk-correctness.mjs', 'audit-emitted.py', 'reconcile.py', 'EXPECTED.json', 'supervise.py']:
        shutil.copyfile(PUBLIC / name, correct / name)
    shutil.copyfile(PUBLIC / 'run-correctness.py', correct / 'run-once.py')
    put(correct / 'PROVENANCE.json', SOURCE)
    commands = []

    def command(name, kind, argv, cwd=correct, seconds=60, rss=2048, **extra):
        commands.append({'id': f'{len(commands)+1:02d}-{name}', 'kind': kind, 'argv': list(map(str, argv)),
            'cwd': str(cwd), 'secondsCap': seconds, 'rssMiBCap': rss, 'environment': {}, **extra})

    command('fixture-metadata-smoke', 'smoke', [node, correct / 'bulk-correctness.mjs', '--smoke'], seconds=30, rss=512)
    for arm in ['baseline', 'candidate']:
        command(f'{arm}-portable-build', 'build', [bun, 'scripts/build-browser.ts'], correct / arm)
    for arm in ['baseline', 'candidate']:
        command(f'{arm}-declarations', 'declarations', [node, 'node_modules/typescript/bin/tsc', '--emitDeclarationOnly', '--noEmit', 'false', '--declarationMap', 'false', '--outDir', 'dist/types'], correct / arm)
    command('emitted-source-and-declaration-audit', 'audit', [sys.executable, correct / 'audit-emitted.py'], seconds=30, rss=512)
    for engine, runtime, entry in [('bun-source', bun, 'shared.ts'), ('node-portable', node, 'dist/shared.js')]:
        for arm in ['baseline', 'candidate']:
            destination = str(correct / 'execution' / f'{engine}-{arm}.json')
            command(f'{engine}-{arm}', 'corpus', [runtime, correct / 'bulk-correctness.mjs', correct / arm / entry, engine, destination], engine=engine, output=destination)
    command('retained-json-reconciliation', 'reconcile', [sys.executable, correct / 'reconcile.py'], seconds=30, rss=512)
    assert len(commands) == 11
    put(correct / 'COMMANDS.json', {'status': 'prepared-not-executed', 'wholeSecondsCap': 360, 'cleanupAllowanceSeconds': 8, 'commands': commands})
    put(work / 'RUNTIMES.json', {'bun-source': str(bun), 'node-portable': str(node)})
    for arm in ['baseline', 'candidate']:
        verify_source(correct / arm, arm)
    assert time.monotonic() - started < 360, 'Setup window exceeded'
    pins = inventory([correct, toolchain, PUBLIC, repo / '.github/workflows/lazy-bulk-hosted.yml',
                      work / 'HOST.json', work / 'RUNTIMES.json', work / 'NATIVE-INPUTS.json', work / 'NATIVE-BUILD.json',
                      node, bun, Path(sys.executable).resolve()])
    put(correct / 'INPUT-PINS.json', pins)
    put(correct / 'PREPARED-SEAL.json', {'status': 'prepared-not-executed', 'commandCount': 11,
        'inputPinsSHA256': sha((correct / 'INPUT-PINS.json').read_bytes()),
        'commandsSHA256': sha((correct / 'COMMANDS.json').read_bytes()),
        'candidateArenaSHA256': SOURCE['candidateArenaSHA256'], 'sourceCommit': SOURCE['commit']})
    put(correct / 'BINDING.json', {'kind': 'hosted-correctness-binding', 'commandCount': 11,
        'preparedSealSHA256': sha((correct / 'PREPARED-SEAL.json').read_bytes()),
        'hostSHA256': sha((work / 'HOST.json').read_bytes()), 'proofCommit': head})
    assert time.monotonic() - started < 360, 'Setup authentication/sealing window exceeded'


def prepare(work, repo):
    passed = False
    previous = {number: signal.signal(number, stop_setup) for number in [signal.SIGINT, signal.SIGTERM]}
    try:
        prepare_inputs(work, repo)
        check_setup_interruption()
        passed = True
    finally:
        # Custom signal handlers avoid subprocess.call's KeyboardInterrupt path,
        # which could kill the supervisor before it drains its new-session child.
        # Exceptional non-signal exits also allow that supervisor to clean up.
        try:
            if active_supervisor is not None and active_supervisor.poll() is None:
                active_supervisor.send_signal(signal.SIGTERM)
                active_supervisor.wait(timeout=8)
        finally:
            if setup_signal is not None and (work / 'setup').is_dir():
                put(work / 'setup/INTERRUPTION.json', {'signal': setup_signal,
                    'observedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'laterSetupStagesProhibited': True,
                    'supervisorStillRunning': active_supervisor is not None and active_supervisor.poll() is None})
            if (work / 'setup').is_dir():
                put(work / 'setup/SETUP-RESULT.json', {'state': 'passed' if passed and setup_signal is None else 'failed',
                    'signal': setup_signal, 'sourceCommit': SOURCE['commit'],
                    'cleanupUncertain': active_supervisor is not None and active_supervisor.poll() is None})
            for number, handler in previous.items():
                signal.signal(number, handler)


def verify_setup_passed(work):
    assert not (work / 'setup/INTERRUPTION.json').exists(), 'Interrupted setup cannot run a later stage'
    terminal = read(work / 'setup/SETUP-RESULT.json')
    assert terminal['state'] == 'passed' and terminal['signal'] is None and not terminal['cleanupUncertain']
    assert terminal['sourceCommit'] == SOURCE['commit']


def prepare_timing(work, repo):
    head = verify_public(repo)
    verify_setup_passed(work)
    correct = work / 'correctness'
    assert not (work / 'timing').exists()
    verify_inventory(read(correct / 'INPUT-PINS.json'))
    result = read(correct / 'execution/RESULT.json')
    assert result['state'] == 'passed' and len(result['commands']) == 11
    assert result['signal'] is None and result['error'] is None and result['elapsedSeconds'] < 360
    assert result['sealSHA256'] == sha((correct / 'PREPARED-SEAL.json').read_bytes())
    assert result['bindingSHA256'] == sha((correct / 'BINDING.json').read_bytes())
    assert all(c['receipt']['state'] == 'passed' and c['receipt']['cleanup']['confirmedEmpty'] for c in result['commands'])
    emitted = read(correct / 'execution/emitted-audit.json')
    assert result['emittedAuditSHA256'] == sha((correct / 'execution/emitted-audit.json').read_bytes())
    assert emitted['passed'] and emitted['sourceCommit'] == SOURCE['commit']
    assert emitted['moduleCountPerArm'] == 12 and emitted['declarationsPerArm'] == 41 and len(emitted['outputs']) == 106
    assert emitted['allFourWasmBytesUnchanged'] and emitted['declarationsIdentical']
    for item in emitted['outputs']:
        contents = Path(item['path']).read_bytes()
        assert len(contents) == item['bytes'] and sha(contents) == item['sha256']
    reconciliation = read(correct / 'execution/reconciliation.json')
    assert reconciliation['passed'] and reconciliation['withinEnginePersistentBytesAndAllocationEqual']
    for item in reconciliation['rawReports']:
        data = Path(item['path']).read_bytes()
        assert len(data) == item['bytes'] and sha(data) == item['sha256']
    files = []
    for path in sorted([*(correct / 'execution').rglob('*'), *(correct / 'baseline/dist').rglob('*'), *(correct / 'candidate/dist').rglob('*')]):
        if path.is_file():
            item = file_record(path)
            item['path'] = str(path.relative_to(correct))
            files.append(item)
    put(correct / 'RESULTS-SEAL.json', {'state': 'passed', 'sourceCommit': SOURCE['commit'],
        'preparedSealSHA256': sha((correct / 'PREPARED-SEAL.json').read_bytes()), 'fileCount': len(files), 'files': files})
    timing = work / 'timing'
    timing.mkdir()
    for name in ['bulk-timing.mjs', 'analyze.py', 'SCHEDULE.json', 'supervise.py', 'METHOD.md']:
        shutil.copyfile(PUBLIC / name, timing / name)
    shutil.copyfile(PUBLIC / 'run-timing.py', timing / 'run-once.py')
    config = read(PUBLIC / 'CONFIG.json')
    config['correctnessPacket'] = str(correct)
    config['executables'] = read(work / 'RUNTIMES.json')
    config['correctnessPreparedSealSHA256'] = sha((correct / 'PREPARED-SEAL.json').read_bytes())
    put(timing / 'CONFIG.json', config)
    # Inherit the authenticated installation/source graph, then bind every
    # hosted correctness output and the generated portable configuration.
    pins = read(correct / 'INPUT-PINS.json')
    extra = inventory([timing, correct / 'INPUT-PINS.json', correct / 'PREPARED-SEAL.json', correct / 'BINDING.json', correct / 'RESULTS-SEAL.json'])
    for key in ['files', 'symlinks']:
        merged = {item['path']: item for item in pins[key] + extra[key]}
        pins[key] = [merged[p] for p in sorted(merged)]
    pins['directories'] = sorted(set(pins['directories'] + extra['directories']))
    put(timing / 'INPUT-PINS.json', pins)
    put(timing / 'PREPARED-SEAL.json', {'status': 'prepared-not-executed', 'sourceCommit': SOURCE['commit'],
        'inputPinsSHA256': sha((timing / 'INPUT-PINS.json').read_bytes()), 'methodSHA256': config['methodSHA256'],
        'candidateArenaSHA256': SOURCE['candidateArenaSHA256'], 'measurementChildren': 256, 'wholeSecondsCap': 600})
    put(timing / 'BINDING.json', {'kind': 'hosted-timing-binding',
        'preparedSealSHA256': sha((timing / 'PREPARED-SEAL.json').read_bytes()), 'proofCommit': head,
        'currentSourceCorrectness': {'sourceCommit': SOURCE['commit'],
            'preparedSealSHA256': config['correctnessPreparedSealSHA256'],
            'outputSealPath': str(correct / 'RESULTS-SEAL.json'), 'outputSealSHA256': sha((correct / 'RESULTS-SEAL.json').read_bytes())}})


def run(work, repo, stage):
    verify_public(repo)
    verify_setup_passed(work)
    directory = work / stage
    # Replace this metadata adapter; the established controller receives GitHub
    # cancellation directly and remains responsible for its original groups.
    os.execv(sys.executable, [sys.executable, str(directory / 'run-once.py'),
        '--seal-sha256', sha((directory / 'PREPARED-SEAL.json').read_bytes()),
        '--binding-sha256', sha((directory / 'BINDING.json').read_bytes())])


def export(work):
    # Deliberate allowlist: synthetic evidence and source only; no environment
    # dumps, credentials, package cache, installation payload, or private files.
    evidence = work / 'evidence'
    evidence.mkdir()
    for name in ['HOST.json', 'RUNTIMES.json', 'NATIVE-INPUTS.json', 'NATIVE-BUILD.json', 'source.tar']:
        if (work / name).exists():
            shutil.copyfile(work / name, evidence / name)
    if (work / 'toolchain').exists():
        (evidence / 'toolchain').mkdir()
        for name in ['package.json', 'bun.lock', 'bun.lockb']:
            if (work / 'toolchain' / name).exists():
                shutil.copyfile(work / 'toolchain' / name, evidence / 'toolchain' / name)
    for stage in ['setup', 'correctness', 'timing']:
        directory = work / stage
        if not directory.exists():
            continue
        target = evidence / stage
        target.mkdir()
        for path in directory.iterdir():
            if path.is_file() and path.suffix in ['.json', '.log']:
                shutil.copyfile(path, target / path.name)
        if (directory / 'execution').exists():
            shutil.copytree(directory / 'execution', target / 'execution')
        if stage == 'correctness':
            for arm in ['baseline', 'candidate']:
                if (directory / arm / 'dist').exists():
                    shutil.copytree(directory / arm / 'dist', target / arm / 'dist')
    records = []
    for path in sorted(evidence.rglob('*')):
        if path.is_file():
            item = file_record(path)
            item['path'] = str(path.relative_to(evidence))
            records.append(item)
    put(evidence / 'ARTIFACT-SEAL.json', {'kind': 'hosted-evidence', 'files': records,
        'timingTerminalPresent': (evidence / 'timing/execution/RESULT.json').exists(),
        'missingTerminalIsNotAPass': True})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['prepare', 'correctness', 'prepare-timing', 'timing', 'export'])
    parser.add_argument('--work-root', required=True)
    parser.add_argument('--repo', required=True)
    args = parser.parse_args()
    work, repo = Path(args.work_root).absolute(), Path(args.repo).resolve(strict=True)
    if args.stage == 'prepare':
        prepare(work, repo)
    elif args.stage == 'prepare-timing':
        prepare_timing(work, repo)
    elif args.stage in ['correctness', 'timing']:
        run(work, repo, args.stage)
    else:
        if work.exists():
            export(work)


if __name__ == '__main__':
    main()
