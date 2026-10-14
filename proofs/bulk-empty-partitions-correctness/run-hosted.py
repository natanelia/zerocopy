"""One ordinary hosted correctness gate, adapted from the existing ordinary correctness controller."""
import base64, difflib, hashlib, json, os, re
from pathlib import Path
import shutil, signal, subprocess, sys, tarfile, time

BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
PATCH = '03fd0b9536faf3d0e75a60c95d2aca98f593701a9a739dfb81ef6e9b051a2301'
NODE_HASH = '8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d'
BUN_HASH = 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c'
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
ROOT = Path(sys.argv[1]).resolve()
START = time.monotonic()
LIMIT = 1500
ENV = {**os.environ, 'NODE_OPTIONS': '', 'BUN_OPTIONS': '', 'BULK_INPUT_ARM': 'candidate'}
for marker in ['BULK_INPUT_RUNTIME', 'BULK_INPUT_REPORT']:
    ENV.pop(marker, None)
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


def command(label, argv, cwd, cap, extra_env=None):
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
        child = subprocess.Popen([str(x) for x in argv], cwd=cwd, env={**ENV, **(extra_env or {})}, stdout=output,
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
               'logSha256': sha(log), 'logBytes': log.stat().st_size,
               'environmentOverrides': extra_env or {}, 'legacyBulkArm': ENV['BULK_INPUT_ARM'],
               'legacyBulkRuntimeMarker': None}
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


def wat_tree(path):
    stack, roots = [], []
    for token in re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+', Path(path).read_text()):
        if token == '(':
            node = []
            (stack[-1] if stack else roots).append(node)
            stack.append(node)
        elif token == ')':
            assert stack, 'Unbalanced WAT'
            stack.pop()
        else:
            assert stack, 'WAT token outside expression'
            stack[-1].append(token)
    assert not stack and len(roots) == 1 and roots[0][0] == 'module'
    return roots[0]


def nodes(tree, op=None):
    if isinstance(tree, list):
        if tree and (op is None or tree[0] == op):
            yield tree
        for child in tree:
            if isinstance(child, list):
                yield from nodes(child, op)


def native_evidence():
    trees = {arm: wat_tree(ROOT / 'native-inspection' / (arm + '.wat')) for arm in originals}
    abis, bodies = {}, {}
    for arm, tree in trees.items():
        funcs = {f[1]: f for f in tree if isinstance(f, list) and f and f[0] == 'func'}
        imports = [entry for entry in tree if isinstance(entry, list) and entry and entry[0] == 'import']
        assert len(imports) == 1 and imports[0][1:3] == ['"env"', '"memory"']
        assert imports[0][3][0] == 'memory'
        exports = {}
        for entry in tree:
            if not isinstance(entry, list) or not entry or entry[0] != 'export':
                continue
            kind, name = entry[2]
            if kind == 'func':
                f = funcs[name]
                exports[entry[1]] = {'kind': kind,
                    'params': [x[-1] for x in f if isinstance(x, list) and x and x[0] == 'param'],
                    'results': [x[1:] for x in f if isinstance(x, list) and x and x[0] == 'result']}
            else:
                assert kind == 'memory'
                exports[entry[1]] = {'kind': kind}
        abis[arm] = {'imports': [imports[0][1:3] + [imports[0][3][0]] + imports[0][3][2:]], 'exports': exports}
        matches = [f for f in funcs.values() if sum(1 for x in f if isinstance(x, list) and x and x[0] == 'param') == 5
                   and any(x in [['i32.const', '8192'], ['i32.const', '-8192']] for x in nodes(f))
                   and any(x[1] == f[1] for x in nodes(f, 'call'))]
        assert len(matches) == 1, (arm, 'Cannot uniquely identify batchAt')
        bodies[arm] = matches[0]
    assert abis['baseline'] == abis['candidate'], 'Native ABI changed'
    write(ROOT / 'native-inspection' / 'abi.json', abis)
    old, new = bodies['baseline'], bodies['candidate']
    old_calls = [x for x in nodes(old, 'call') if x[1] == old[1]]
    new_calls = [x for x in nodes(new, 'call') if x[1] == new[1]]
    assert len(old_calls) == len(new_calls) == 1
    old_call, new_call = old_calls[0], new_calls[0]
    assert old_call[2][0] == 'block' and new_call[2][0] == 'local.get'
    guards = [x for x in nodes(new, 'if') if x[1] == new_call[4] and new_call in list(nodes(x, 'call'))]
    assert len(guards) == 1 and guards[0][1][0] == 'local.get'
    guard = guards[0]
    scalar_reads = list(nodes(guard, 'global.get'))
    assert len(scalar_reads) == 1
    assert sum(x == scalar_reads[0] for x in nodes(new, 'global.get')) == 1
    sequences = [x for x in nodes(new) if guard in x]
    assert len(sequences) == 1
    sequence = sequences[0]
    index = sequence.index(guard)
    assert index >= 2
    count_read, child_read = sequence[index - 2:index]
    assert count_read[0:2] == ['local.set', guard[1][1]] and count_read[2][0] == 'i32.load'
    assert child_read[0:2] == ['local.set', new_call[2][1]] and child_read[2][0] == 'block'
    # Local allocation can renumber registers. Preserve the exact expressions
    # as evidence; this structural check deliberately does not prove aliasing.
    def local_normalized(expr):
        if not isinstance(expr, list):
            return expr
        return [expr[0], '$local', *[local_normalized(x) for x in expr[2:]]] if expr and expr[0] in ['local.get', 'local.set', 'local.tee'] else [local_normalized(x) for x in expr]
    assert local_normalized(old_call[2]) == local_normalized(child_read[2]), 'Child read expression changed'
    old_sequences = [x for x in nodes(old) if any(isinstance(y, list) and y[:1] == ['local.set'] and old_call in list(nodes(y, 'call')) for y in x)]
    assert len(old_sequences) == 1
    old_sequence = old_sequences[0]
    old_index = next(i for i, x in enumerate(old_sequence) if isinstance(x, list) and x[:1] == ['local.set'] and old_call in list(nodes(x, 'call')))
    assert local_normalized(old_sequence[old_index - 1]) == local_normalized(count_read)
    assert len(list(nodes(old_sequence[old_index + 1], 'global.get'))) == 1
    assert local_normalized(old_sequence[old_index + 2:]) == local_normalized(sequence[index + 1:]), 'Child emission or start update changed'
    old_zero = next(x for x in old if isinstance(x, list) and x[:1] == ['if'])
    new_zero = next(x for x in new if isinstance(x, list) and x[:1] == ['if'])
    assert local_normalized(old_zero) == local_normalized(new_zero), 'Top-level zero path changed'
    write(ROOT / 'native-inspection' / 'batchAt-expressions.json', {'baseline': old, 'candidate': new,
          'guardedRecursionAndScalarRead': True, 'childReadAndEmissionStructurePreserved': True,
          'topLevelZeroPathPreserved': True, 'independentEmittedCodeReviewRequired': True})
    baseline_text = (ROOT / 'native-inspection/baseline.wat').read_text().splitlines(True)
    candidate_text = (ROOT / 'native-inspection/candidate.wat').read_text().splitlines(True)
    (ROOT / 'native-inspection/core.diff').write_text(''.join(difflib.unified_diff(baseline_text, candidate_text, fromfile='baseline.wat', tofile='candidate.wat')))


def portable_evidence(arm):
    folder = ROOT / arm
    expected = (folder / 'persistent-core.wasm').read_bytes()
    found = []
    graph = {}
    for path in (folder / 'dist').glob('*.js'):
        text = path.read_text()
        graph[path.name] = re.findall(r'(?:from\s*|import\s*)[\'"](\./[^\'"]+\.js)[\'"]', text)
        for match in re.finditer(r'function loadWasm\(\)\s*\{\s*const text = atob\("([A-Za-z0-9+/=]+)"\)', text):
            embedded = base64.b64decode(match.group(1), validate=True)
            assert embedded == expected, 'Stale portable core: ' + arm
            found.append(path.name)
    assert len(found) == 1, (arm, 'Missing or duplicated embedded persistent core')
    seen, pending = set(), ['shared.js']
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        assert name in graph, 'Missing portable dependency: ' + name
        seen.add(name)
        pending.extend(Path(dependency).name for dependency in graph[name])
    assert found[0] in seen, 'Worker entry does not reach the verified embedded core'
    return {'coreSha256': sha(folder / 'persistent-core.wasm'), 'coreBytes': len(expected),
            'embeddedFile': found[0], 'embeddedFileSha256': sha(folder / 'dist' / found[0]),
            'sharedEntryReachableFiles': sorted(seen), 'embeddedBytesEqualNative': True}


def preserve():
    artifact = ROOT / 'artifact'
    artifact.mkdir()
    for p in HERE.rglob('*'):
        if p.is_file():
            target = artifact / 'inputs' / p.relative_to(HERE)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, target)
    shutil.copyfile(REPO / '.github/workflows/bulk-empty-partitions-correctness.yml', artifact / 'workflow.yml')
    for name in ['logs', 'baseline-build-v1', 'candidate-build-v1', 'correctness-v1', 'native-inspection']:
        if (ROOT / name).exists():
            shutil.copytree(ROOT / name, artifact / name)
    for name in ['command-receipts.json', 'hosted-result.json', 'SOURCE-SHA256SUMS', 'progress.jsonl', 'executables.json', 'main.tar', 'command-plan.json', 'portable-authentication.json']:
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
    disassembler = toolchain / 'node_modules/binaryen/bin/wasm-dis'
    assert sha(disassembler) == 'd1ea59ca56e9587b5f68d4e6c10db61ee42a55826008bea6b8e5fdeed932bfe8'
    write(ROOT / 'executables.json', {name: {'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size,
          'version': version} for name, path, version in [('node', node, '22.16.0'), ('bun', bun, '1.4.2'),
          ('wasm-dis', disassembler, '131.0.0-nightly.20260721')]})
    archive = ROOT / 'main.tar'
    command('archive-exact-main', ['git', 'archive', '--format=tar', BASE, '-o', archive], REPO, 30)
    baseline, candidate = ROOT / 'baseline', ROOT / 'candidate'
    baseline.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(baseline, filter='data')
    shutil.copytree(baseline, candidate)
    main_sources = source_files(baseline)
    expected = load(HERE / 'candidate-files.json')
    for name, digest in expected['main'].items():
        assert main_sources[name] == digest, name
    command('apply-fixed-candidate', ['git', 'apply', '-p1', HERE / 'candidate.patch'], candidate, 30)
    command('apply-identical-baseline-test', ['git', 'apply', '-p1', HERE / 'test.patch'], baseline, 30)
    originals = {'baseline': source_files(baseline), 'candidate': source_files(candidate)}
    changed = {name for name in set(originals['baseline']) | set(originals['candidate'])
               if originals['baseline'].get(name) != originals['candidate'].get(name)}
    assert changed == {'persistent-core.as.ts'}
    assert len(originals['baseline']) == len(originals['candidate']) == 502
    assert {name for name in main_sources if main_sources[name] != originals['candidate'][name]} == set(expected['candidate'])
    assert {name for name in main_sources if main_sources[name] != originals['baseline'][name]} == {'bulk-input-storage.test.ts'}
    for arm in ['baseline', 'candidate']:
        for name, digest in expected[arm].items():
            assert originals[arm][name] == digest, name
        (ROOT / arm / 'node_modules').symlink_to(toolchain / 'node_modules', target_is_directory=True)
    (ROOT / 'SOURCE-SHA256SUMS').write_text(''.join(f'{digest}  {arm}/{name}\n'
          for arm in originals for name, digest in sorted(originals[arm].items())))
    tsc = toolchain / 'node_modules/typescript/bin/tsc'
    inventory = load(HERE / 'test-inventory.json')
    for arm in originals:
        for name, digest in inventory['testSourceSha256'].items():
            assert originals[arm][name] == digest, (arm, name)
        for path in [*(ROOT / arm).glob('*.wasm'), *(ROOT / arm).glob('*.wat')]:
            path.unlink()
    folder = ROOT / 'correctness-v1'
    folder.mkdir()
    (ROOT / 'native-inspection').mkdir()
    full_report = folder / 'full-bun.json'
    declarations = [node, tsc, '--emitDeclarationOnly', '--noEmit', 'false', '--declarationMap', 'false', '--outDir', 'dist/types']
    builds = [(arm + '-native-build', 90, [node, 'scripts/build-wasm.mjs'], arm) for arm in originals]
    builds += [(arm + '-native-disassembly', 30, [node, disassembler, ROOT / arm / 'persistent-core.wasm', '-o', ROOT / 'native-inspection' / (arm + '.wat')], arm) for arm in originals]
    portable_builds = [(arm + '-' + name, cap, argv, arm) for arm in originals for name, cap, argv in
                       [('portable-build', 60, [bun, 'scripts/build-browser.ts']), ('declarations', 60, declarations)]]
    focused = []
    for arm in originals:
        for runtime, executable in [('bun', bun), ('node', node)]:
            report = folder / (arm + '-' + runtime + '.json')
            argv = [executable, *(['--bun'] if runtime == 'bun' else []), 'node_modules/vitest/vitest.mjs', 'run',
                    'bulk-input-storage.test.ts', '--maxWorkers=1', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(report)]
            focused.append((arm + '-focused-' + runtime, 90, argv, arm))
    bulk_workers = [(arm + '-bulk-workers-bun', 90, [bun, 'proofs/bulk-input-workers.mjs', ROOT, arm,
                    folder / (arm + '-bulk-workers-bun.json'), 'bun'], arm) for arm in originals]
    gates = [('types-main', 60, [node, tsc, '--noEmit'])]
    for kind in ['redux', 'typed-values', 'geometry', 'worker']:
        gates.append(('types-' + kind, 60, [node, tsc, '--noEmit', '-p', 'tsconfig.' + kind + '.json']))
    gates += [('types-values-inexact', 60, [node, tsc, '--noEmit', '-p', 'tsconfig.typed-values.json', '--exactOptionalPropertyTypes', 'false']),
              ('full-bun-vitest', 300, [bun, '--bun', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(full_report)]),
              ('real-node-worker', 45, [node, 'proofs/node-worker.mjs']),
              ('redux-node', 30, [node, 'proofs/redux-node.mjs']),
              ('typed-json-worker', 30, [node, 'proofs/typed-json-worker.mjs']),
              ('real-worker-tasks', 60, [node, '--test', '--test-concurrency=1', '--test-timeout=15000', 'proofs/worker-tasks.mjs', 'proofs/worker-task-lifecycle.node.mjs']),
              ('packed-package-consumer', 180, [node, 'scripts/check-package.mjs'])]
    commands = builds + portable_builds + focused + bulk_workers + [('candidate-' + name, cap, argv, 'candidate') for name, cap, argv in gates]
    write(ROOT / 'command-plan.json', {'baselineCommit': BASE, 'proofCommit': proof_commit,
          'runnerSha256': sha(__file__), 'sourcePatchSha256': PATCH,
          'commands': [[name, cap, [str(x) for x in argv], arm] for name, cap, argv, arm in commands],
          'fixedPreparationCommands': [r['label'] for r in receipts], 'totalCommands': len(commands) + len(receipts)})
    for arm in originals:
        build_folder = ROOT / (arm + '-build-v1')
        build_folder.mkdir()
        write(build_folder / 'plan.json', {'sourceFiles': originals[arm], 'sourcePatchSha256': PATCH,
              'baselineCommit': BASE, 'commands': [[name, cap, [str(x) for x in argv]] for name, cap, argv, target in builds + portable_builds if target == arm]})
    for label, cap, argv, arm in builds:
        command(label, argv, ROOT / arm, cap)
    aliases = ['persistent-core', 'shared-map', 'shared-list', 'linked-list', 'singly-linked-list',
               'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue']
    for arm in originals:
        core = sha(ROOT / arm / 'persistent-core.wasm')
        assert all(sha(ROOT / arm / (name + '.wasm')) == core for name in aliases)
    assert sha(baseline / 'persistent-core.wasm') == '08b1e91c9ee6d3602c0a100f449f51555ee35e5641e1839b7f719d016c209d90'
    assert sha(candidate / 'persistent-core.wasm') != sha(baseline / 'persistent-core.wasm')
    unchanged = ['numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm', 'geometry-kernels.wat']
    assert all(sha(candidate / name) == sha(baseline / name) for name in unchanged)
    write(ROOT / 'native-inspection/output-parity.json', {'baselineCoreSha256': sha(baseline / 'persistent-core.wasm'),
          'candidateCoreSha256': sha(candidate / 'persistent-core.wasm'), 'coreAliases': aliases,
          'unchangedOutputs': {name: sha(candidate / name) for name in unchanged}})
    native_evidence()
    for label, cap, argv, arm in portable_builds:
        command(label, argv, ROOT / arm, cap)
        if label.endswith('-declarations'):
            frozen_outputs[arm] = generated(ROOT / arm)
            write(ROOT / (arm + '-build-v1') / 'generated.json', frozen_outputs[arm])
    portable = {arm: portable_evidence(arm) for arm in originals}
    write(ROOT / 'portable-authentication.json', portable)
    reports, bulk_rows = {}, {}
    for label, cap, argv, arm in focused:
        runtime = label.rsplit('-', 1)[1]
        rows_path = folder / (arm + '-' + runtime + '-bulk-rows.json')
        command(label, argv, ROOT / arm, cap, {'BULK_INPUT_REPORT': str(rows_path)})
        report_path = folder / (arm + '-' + runtime + '.json')
        reports[label] = check_report(report_path, inventory['focused'], ROOT / arm)
        raw_report = load(report_path)
        assert sorted(case['fullName'] for suite in raw_report['testResults'] for case in suite['assertionResults']) == sorted(inventory['focusedNames'])
        rows = load(rows_path)
        assert rows['arm'] == 'candidate'
        nested_rows = [row for row in rows['rows'] if row['name'] == 'nested']
        assert len(nested_rows) == 1 and set(nested_rows[0]) == {'name', 'sameLeaf', 'sameCachedValue'}
        if runtime == 'bun':
            assert rows['runtime']['bun'] == '1.4.2'
        else:
            assert rows['runtime']['node'] == '22.16.0' and 'bun' not in rows['runtime']
        bulk_rows[(arm, runtime)] = rows['rows']
        write(folder / 'test-reports.json', reports)
    for runtime in ['bun', 'node']:
        assert bulk_rows[('baseline', runtime)] == bulk_rows[('candidate', runtime)], 'Paired bulk rows differ: ' + runtime
    write(folder / 'paired-bulk-rows.json', {'engines': ['bun', 'node'], 'rowsEqualWithinEachEngine': True,
          'includes': ['logical results', 'root pointers', 'used bytes', 'heap payload hashes', 'failure/recovery observations'],
          'rawRecordsRetainedVerbatim': True, 'nestedRecordContainsOnlySemanticFlags': True,
          'excludes': ['cross-process nested descriptor bytes', 'full scratch-memory byte comparison',
                       'recursive post-trap recovery beyond the existing fixtures']})
    for label, cap, argv, arm in bulk_workers:
        command(label, argv, ROOT / arm, cap)
        report = load(folder / (arm + '-bulk-workers-bun.json'))
        assert report['runtime']['bun'] == '1.4.2' and len(report['rows']) == 4
        assert {(x['reader'], x['copy']) for x in report['rows']} == {(reader, copy) for reader in originals for copy in [False, True]}
        assert all(x['producer'] == arm and x['phase'] == 'done' and x['exit'] == 0 and x['runtime']['bun'] == '1.4.2' for x in report['rows'])
    for label, cap, argv in gates:
        command('candidate-' + label, argv, candidate, cap)
        if label == 'full-bun-vitest':
            reports['fullBun'] = check_report(full_report, inventory['fullBun'], candidate)
            write(folder / 'test-reports.json', reports)
    check_inputs()
    for arm in originals:
        build_folder = ROOT / (arm + '-build-v1')
        write(build_folder / 'receipts.json', [r for r in receipts if r['label'].startswith(arm + '-') and any(r['label'].endswith(suffix) for suffix in ['native-build', 'native-disassembly', 'portable-build', 'declarations'])])
        write(build_folder / 'result.json', {'status': 'passed', 'sourceFiles': len(originals[arm]), 'portable': portable[arm]})
    write(folder / 'receipts.json', [r for r in receipts if r['label'] not in {name for name, _, _, _ in builds + portable_builds}])
    write(folder / 'final-generated.json', {arm: generated(ROOT / arm) for arm in originals})
    write(folder / 'result.json', {'status': 'passed', 'testReports': reports, 'commands': len(receipts),
          'independentEmittedCodeReviewRequired': True})
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
