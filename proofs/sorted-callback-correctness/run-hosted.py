"""One ordinary hosted correctness gate, adapted from the existing Set controller."""
import hashlib, json, os
from pathlib import Path
import shutil, signal, subprocess, sys, tarfile, time

BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
PATCH = '2f11252bd6ea9eeee68265f07bf6be2e63b055e52965b85520477ad574856aa9'
NODE_HASH = '8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d'
BUN_HASH = 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c'
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
ROOT = Path(sys.argv[1]).resolve()
START = time.monotonic()
LIMIT = 1500
ENV = {**os.environ, 'NODE_OPTIONS': '', 'BUN_OPTIONS': ''}
receipts, originals, frozen_outputs = [], {}, {}
created, active, interrupted = False, None, None
result = {'kind': 'ordinary-correctness-only', 'host': 'github-ubuntu-24.04', 'sourceBase': BASE,
          'candidatePatchSha256': PATCH, 'complete': False, 'benchmarksRun': False}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def load(path):
    return json.loads(Path(path).read_text())


def source_files(folder):
    files = {}
    for directory, dirs, names in os.walk(folder, followlinks=False):
        dirs[:] = [name for name in dirs if name not in ['node_modules', 'dist']]
        for name in names:
            p = Path(directory) / name
            rel = p.relative_to(folder)
            assert not p.is_symlink(), str(rel)
            if not (len(rel.parts) == 1 and p.suffix in ['.wasm', '.wat']):
                files[rel.as_posix()] = sha(p)
    return files


def generated(folder):
    paths = [*folder.glob('*.wasm'), *folder.glob('*.wat'), *(folder / 'dist').rglob('*')]
    return {p.relative_to(folder).as_posix(): {'sha256': sha(p), 'bytes': p.stat().st_size}
            for p in sorted(paths) if p.is_file()}


def check_inputs():
    for arm, expected in originals.items():
        assert source_files(ROOT / arm) == expected, 'Source changed: ' + arm
    for arm, expected in frozen_outputs.items():
        assert generated(ROOT / arm) == expected, 'Generated output changed: ' + arm


def group_exists(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def signal_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def wait_group(pid):
    deadline = time.monotonic() + 2
    while group_exists(pid) and time.monotonic() < deadline:
        time.sleep(0.05)


def on_signal(signum, frame):
    global interrupted
    interrupted = signum
    if active is not None:
        signal_group(active.pid, signal.SIGTERM)


def progress(event):
    event = {**event, 'gateElapsedSeconds': time.monotonic() - START}
    with (ROOT / 'progress.jsonl').open('a') as output:
        output.write(json.dumps(event) + '\n')
    print(json.dumps(event), flush=True)


def command(label, argv, cwd, cap):
    global active
    check_inputs()
    assert not interrupted, 'Interrupted'
    remaining = LIMIT - (time.monotonic() - START) - 20
    assert remaining > 0, 'Hosted aggregate budget exhausted'
    effective = min(cap, remaining)
    log = ROOT / 'logs' / (label + '.log')
    log.parent.mkdir(exist_ok=True)
    started = time.monotonic()
    timed_out, cleanup = False, []
    progress({'event': 'command-start', 'label': label, 'capSeconds': cap, 'effectiveCapSeconds': effective})
    with log.open('xb') as output:
        child = subprocess.Popen([str(x) for x in argv], cwd=cwd, env=ENV, stdout=output,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        active = child
        while True:
            left = effective - (time.monotonic() - started)
            if left <= 0:
                timed_out = True
                cleanup.append('SIGTERM for timeout')
                signal_group(child.pid, signal.SIGTERM)
                try:
                    code = child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    cleanup.append('SIGKILL after timeout')
                    signal_group(child.pid, signal.SIGKILL)
                    code = child.wait(timeout=5)
                break
            try:
                code = child.wait(timeout=min(15, left))
                break
            except subprocess.TimeoutExpired:
                progress({'event': 'command-running', 'label': label, 'seconds': time.monotonic() - started,
                          'logBytes': log.stat().st_size})
    leftover = group_exists(child.pid)
    if leftover:
        cleanup.append('SIGTERM for remaining group')
        signal_group(child.pid, signal.SIGTERM)
        wait_group(child.pid)
        if group_exists(child.pid):
            cleanup.append('SIGKILL for remaining group')
            signal_group(child.pid, signal.SIGKILL)
            wait_group(child.pid)
    remains = group_exists(child.pid)
    active = None
    validation_error = None
    try:
        check_inputs()
    except Exception as error:
        validation_error = repr(error)
    receipt = {'label': label, 'command': [str(x) for x in argv], 'seconds': time.monotonic() - started,
               'capSeconds': cap, 'effectiveCapSeconds': effective, 'exitCode': code, 'timedOut': timed_out,
               'ownedProcessGroup': child.pid, 'leftoverProcessGroup': leftover, 'groupAfterCleanup': remains,
               'cleanupSignals': cleanup, 'interruptedSignal': interrupted, 'validationError': validation_error,
               'logSha256': sha(log), 'logBytes': log.stat().st_size}
    receipts.append(receipt)
    write(ROOT / 'command-receipts.json', receipts)
    progress({'event': 'command-end', **receipt})
    if code or timed_out or leftover or remains or interrupted or validation_error:
        raise RuntimeError('Command failed; no retry: ' + label)
    return receipt


def check_report(path, expected, folder):
    report = load(path)
    assert report['success'] and report['numTotalTests'] == report['numPassedTests'] == sum(expected.values())
    assert report['numFailedTests'] == report['numPendingTests'] == report.get('numTodoTests', 0) == 0
    actual = {}
    for suite in report['testResults']:
        name = str(Path(suite['name']).resolve().relative_to(folder))
        assert name not in actual and suite['status'] == 'passed'
        assert all(case['status'] == 'passed' for case in suite['assertionResults'])
        actual[name] = len(suite['assertionResults'])
    assert actual == expected, (actual, expected)
    return {'files': actual, 'total': sum(actual.values()), 'sha256': sha(path)}


def preserve():
    artifact = ROOT / 'artifact'
    artifact.mkdir()
    for p in HERE.rglob('*'):
        if p.is_file():
            target = artifact / 'inputs' / p.relative_to(HERE)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, target)
    shutil.copyfile(REPO / '.github/workflows/sorted-callback-correctness.yml', artifact / 'workflow.yml')
    for name in ['logs', 'baseline-build-v1', 'correctness-v1']:
        if (ROOT / name).exists():
            shutil.copytree(ROOT / name, artifact / name)
    for name in ['command-receipts.json', 'hosted-result.json', 'SOURCE-SHA256SUMS', 'progress.jsonl', 'executables.json', 'main.tar']:
        if (ROOT / name).exists():
            shutil.copyfile(ROOT / name, artifact / name)
    for arm in ['baseline', 'candidate']:
        folder = ROOT / arm
        if folder.exists():
            retained = artifact / 'retained' / arm
            retained.mkdir(parents=True)
            write(retained / 'generated.json', generated(folder))
            write(retained / 'source-files.json', source_files(folder))
            if (folder / 'dist').exists():
                shutil.copytree(folder / 'dist', retained / 'dist')
            if (folder / 'package.json').exists():
                shutil.copyfile(folder / 'package.json', retained / 'package.json')
            for p in [*folder.glob('*.wasm'), *folder.glob('*.wat')]:
                shutil.copyfile(p, retained / p.name)
    write(artifact / 'ARTIFACT-SHA256.json', {p.relative_to(artifact).as_posix(): sha(p)
          for p in sorted(artifact.rglob('*')) if p.is_file()})


try:
    ROOT.mkdir()
    created = True
    for sig in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(sig, on_signal)
    proof_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True, timeout=10).strip()
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD^'], cwd=REPO, text=True, timeout=10).strip() == BASE
    assert subprocess.check_output(['git', 'rev-parse', BASE + '^{commit}'], cwd=REPO, text=True, timeout=10).strip() == BASE
    result['proofCommit'] = proof_commit
    for name, expected in load(HERE / 'INPUT-SHA256.json').items():
        p = HERE / name
        assert p.resolve().is_relative_to(REPO) and not p.is_symlink() and sha(p) == expected, name
    assert sha(HERE / 'candidate.patch') == PATCH
    node = Path(shutil.which('node')).resolve()
    assert sha(node) == NODE_HASH
    toolchain = ROOT / 'toolchain'
    shutil.copytree(HERE / 'toolchain', toolchain)
    ENV['PATH'] = str(node.parent) + os.pathsep + ENV['PATH']
    npm = node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
    command('locked-dependencies', [node, npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], toolchain, 180)
    bun = (toolchain / 'node_modules/@oven/bun-linux-x64/bin/bun').resolve()
    assert sha(bun) == BUN_HASH
    ENV['PATH'] = str(bun.parent) + os.pathsep + ENV['PATH']
    assert subprocess.check_output([node, '--version'], text=True, env=ENV, timeout=5).strip() == 'v22.16.0'
    assert subprocess.check_output([bun, '--version'], text=True, env=ENV, timeout=5).strip() == '1.4.2'
    write(ROOT / 'executables.json', {name: {'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size}
          for name, path in [('node', node), ('bun', bun)]})
    archive = ROOT / 'main.tar'
    command('archive-exact-main', ['git', 'archive', '--format=tar', BASE, '-o', archive], REPO, 30)
    baseline, candidate = ROOT / 'baseline', ROOT / 'candidate'
    baseline.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(baseline, filter='data')
    shutil.copytree(baseline, candidate)
    command('apply-fixed-candidate', ['git', 'apply', '-p1', HERE / 'candidate.patch'], candidate, 30)
    originals = {'baseline': source_files(baseline), 'candidate': source_files(candidate)}
    changed = {name for name in set(originals['baseline']) | set(originals['candidate'])
               if originals['baseline'].get(name) != originals['candidate'].get(name)}
    expected = load(HERE / 'candidate-files.json')
    assert changed == set(expected['candidate']) and len(changed) == 3
    assert len(originals['baseline']) == 502 and len(originals['candidate']) == 503
    for arm in ['baseline', 'candidate']:
        for name, digest in expected[arm].items():
            assert originals[arm][name] == digest, name
        (ROOT / arm / 'node_modules').symlink_to(toolchain / 'node_modules', target_is_directory=True)
    (ROOT / 'SOURCE-SHA256SUMS').write_text(''.join(f'{digest}  {arm}/{name}\n'
          for arm in originals for name, digest in sorted(originals[arm].items())))
    tsc = toolchain / 'node_modules/typescript/bin/tsc'
    builds = [('native-build', 90, [node, 'scripts/build-wasm.mjs']),
              ('portable-build', 60, [bun, 'scripts/build-browser.ts']),
              ('declarations', 60, [node, tsc, '--emitDeclarationOnly', '--noEmit', 'false', '--declarationMap', 'false', '--outDir', 'dist/types'])]
    inventory = load(HERE / 'test-inventory.json')
    folder = ROOT / 'correctness-v1'
    full_report, node_report = folder / 'full-bun.json', folder / 'focused-node.json'
    gates = [('types-main', 60, [node, tsc, '--noEmit'])]
    for kind in ['redux', 'typed-values', 'geometry', 'worker']:
        gates.append(('types-' + kind, 60, [node, tsc, '--noEmit', '-p', 'tsconfig.' + kind + '.json']))
    gates += [('types-values-inexact', 60, [node, tsc, '--noEmit', '-p', 'tsconfig.typed-values.json', '--exactOptionalPropertyTypes', 'false']),
              ('full-bun-vitest', 300, [bun, '--bun', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(full_report)]),
              ('focused-node-vitest', 60, [node, 'node_modules/vitest/vitest.mjs', 'run', *inventory['focusedNode'], '--maxWorkers=1', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(node_report)]),
              ('real-node-worker', 45, [node, 'proofs/node-worker.mjs']),
              ('redux-node', 30, [node, 'proofs/redux-node.mjs']),
              ('typed-json-worker', 30, [node, 'proofs/typed-json-worker.mjs']),
              ('real-worker-tasks', 60, [node, '--test', '--test-concurrency=1', '--test-timeout=15000', 'proofs/worker-tasks.mjs', 'proofs/worker-task-lifecycle.node.mjs']),
              ('packed-package-consumer', 180, [node, 'scripts/check-package.mjs'])]
    for arm in ['baseline', 'candidate']:
        folder = ROOT / ('baseline-build-v1' if arm == 'baseline' else 'correctness-v1')
        folder.mkdir()
        if arm == 'candidate':
            for name in originals['baseline']:
                if name.endswith('.as.ts') or name == 'scripts/build-wasm.mjs':
                    assert originals['candidate'][name] == originals['baseline'][name]
            for p in [*baseline.glob('*.wasm'), *baseline.glob('*.wat')]:
                shutil.copyfile(p, candidate / p.name)
                assert sha(candidate / p.name) == sha(p)
        commands = builds if arm == 'baseline' else builds[1:] + gates
        write(folder / 'plan.json', {'baselineCommit': BASE, 'proofCommit': proof_commit, 'sourcePatchSha256': PATCH,
              'runnerSha256': sha(__file__), 'sourceFiles': originals[arm],
              'commands': [[name, cap, [str(x) for x in argv]] for name, cap, argv in commands]})
        arm_receipts, reports = [], {}
        for label, cap, argv in commands:
            arm_receipts.append(command(arm + '-' + label, argv, ROOT / arm, cap))
            write(folder / 'receipts.json', arm_receipts)
            if label == 'declarations':
                frozen_outputs[arm] = generated(ROOT / arm)
            if label in ['full-bun-vitest', 'focused-node-vitest']:
                mode = 'fullBun' if label == 'full-bun-vitest' else 'focusedNode'
                path = full_report if mode == 'fullBun' else node_report
                reports[mode] = check_report(path, inventory[mode], ROOT / arm)
                write(folder / 'test-reports.json', reports)
        check_inputs()
        files = generated(ROOT / arm)
        write(folder / ('generated.json' if arm == 'baseline' else 'final-generated.json'), files)
        write(folder / 'result.json', {'status': 'passed', 'commands': len(commands), 'sourceFiles': len(originals[arm]), 'testReports': reports})
    assert time.monotonic() - START <= LIMIT
    result['complete'] = True
except BaseException as error:
    result['error'] = repr(error)
finally:
    if active is not None:
        signal_group(active.pid, signal.SIGKILL)
        active.wait(timeout=5)
    if created:
        result['seconds'] = time.monotonic() - START
        write(ROOT / 'hosted-result.json', result)
        preserve()
    print(json.dumps(result), flush=True)
if not result['complete']:
    raise SystemExit(1)
