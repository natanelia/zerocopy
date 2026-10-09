"""Small Linux/x64 CI adapter. No work runs merely by importing this file.

The copied controller and statistical functions are unchanged.
The public deletion subject and source/build guards are scoped to the reviewed plan.
This file replaces only local historical admission with fresh exact-source gates.
"""
import argparse, hashlib, json, os, pathlib, platform, shutil, signal, subprocess, sys, time, threading
import controller

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
BRANCH = 'refs/heads/proof/sorted-delete-fusion-screen-20261009'
ARM_NAMES = ('baseline', 'candidate')
ORIGIN = json.loads((HERE/'origin.json').read_text())
ADAPTER_DEADLINE_AT = None
GATES = [
    ['bun', 'run', 'build:wasm'], ['bun', 'run', 'build:browser'], ['bun', 'run', 'build:types'],
    ['bun', 'run', 'typecheck'], ['bun', 'run', 'typecheck:redux'],
    ['bun', 'run', 'typecheck:values'], ['bun', 'run', 'typecheck:geometry'],
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json'],
    ['bun', 'run', 'test'], ['node', '--test', 'proofs/worker-tasks.mjs'],
    ['node', '--test', 'proofs/list-query.mjs'], ['node', '--test', 'proofs/list-query-regression.mjs'],
    ['node', '--test', 'proofs/memory-startup.mjs'], ['node', '--test', 'scripts/check-docs.node.mjs'],
    ['node', 'scripts/check-docs.mjs', '--base', ORIGIN['baselineCommit'], '--preserve'],
    ['node', 'scripts/check-doc-examples.mjs'], ['node', 'scripts/check-doc-browser.mjs'],
    ['node', 'scripts/check-worker-docs.mjs'], ['node', 'proofs/node-worker.mjs'],
    ['node', 'proofs/redux-node.mjs'], ['node', 'proofs/typed-json-worker.mjs'],
    ['bun', 'run', 'check:package'], ['node', 'proofs/restore-local-evidence.mjs'],
]

def sha(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def read(path): return json.loads(pathlib.Path(path).read_text())
def git(*args, tree=REPO): return subprocess.check_output(['git', '-C', str(tree), *args], text=True).strip()
def write(path, value):
    path = pathlib.Path(path)
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value, indent=2)+'\n'); temporary.replace(path)
def item(path, base=None):
    return {'path': str(path.relative_to(base) if base else path), 'sha256': sha(path), 'bytes': path.stat().st_size}
def run_root():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Execution is CI-only; local timing is disabled'
    return pathlib.Path(os.environ['RUNNER_TEMP']) / ('sorted-delete-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT'])
def verify_packet():
    packet = read(HERE/'packet.json')
    for entry in packet['files']:
        assert sha(REPO/entry['path']) == entry['sha256'], 'Changed packet: '+entry['path']
    return packet
def require_activation():
    packet = verify_packet(); activation = read(HERE/'activation.json')
    assert activation['enabled'] is True, 'Sorted delete screen is off by default'
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy'
    assert os.environ.get('GITHUB_REF') == BRANCH
    assert os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'Original attempt only; no selective rerun'
    assert activation['reviewedPacketSha256'] == sha(HERE/'packet.json')
    assert git('rev-parse', 'HEAD^') == activation['reviewedPacketCommit']
    assert git('diff', '--name-only', 'HEAD^', 'HEAD') == 'proofs/sorted-delete-ci/activation.json'
    assert not git('status', '--porcelain', '--untracked-files=no')
    assert git('rev-parse', 'HEAD') == os.environ['GITHUB_SHA']
    assert packet['origin'] == ORIGIN
    return packet
def source(arm): return run_root()/'sources'/arm
def verify_source(arm):
    tree = source(arm); commit = ORIGIN[arm+'Commit']
    assert git('rev-parse', 'HEAD', tree=tree) == commit
    assert not git('status', '--porcelain', '--untracked-files=no', tree=tree)
    assert sha(tree/'bun.lock') == sha(HERE/'dependencies.bun.lock')
    assert git('rev-parse', 'HEAD^{tree}', tree=tree) == ORIGIN[arm+'Tree']
    for name, expected in ORIGIN['sourceHashes'][arm].items():
        assert sha(tree/name) == expected, 'Changed exact source: '+name
    return {'commit': commit, 'tree': git('rev-parse', 'HEAD^{tree}', tree=tree)}
def interrupted(signum, frame): raise KeyboardInterrupt('CI adapter interrupted; owned group cleanup follows')
def bounded(name, seconds, operation):
    """Bound source checks, commands and hashing together; reserve two seconds for cleanup."""
    global ADAPTER_DEADLINE_AT
    root = run_root(); path = root/(name+'-envelope.json')
    assert not path.exists(), 'An envelope is never overwritten or resumed'
    started = time.monotonic()
    ADAPTER_DEADLINE_AT = min(started+seconds, read(root/'run.json')['workDeadlineMonotonicSeconds'])
    receipt = {'stage':name, 'status':'started', 'budgetSeconds':seconds, 'cleanupGraceSeconds':2}
    write(path, receipt)
    def expired(signum, frame): raise TimeoutError('Whole stage including finalization exceeded its budget and cleanup grace')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, ADAPTER_DEADLINE_AT+2-time.monotonic()))
    try:
        assert time.monotonic() < ADAPTER_DEADLINE_AT, 'Work deadline already expired'
        operation()
        assert time.monotonic() <= ADAPTER_DEADLINE_AT+2, 'Finalization exceeded stage budget and cleanup grace'
        receipt['status'] = 'passed'
        receipt['elapsedWallSeconds'] = time.monotonic()-started
        write(path, receipt)
        assert time.monotonic() <= ADAPTER_DEADLINE_AT+2, 'Final receipt exceeded stage budget and cleanup grace'
    except BaseException as error:
        receipt.update(status='failed', error=repr(error), elapsedWallSeconds=time.monotonic()-started)
        write(path, receipt); raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous)
        ADAPTER_DEADLINE_AT = None
def execute(command, cwd, path, deadline):
    """One owned process group; retain start/failure receipts and always reap it."""
    path = pathlib.Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    receipt = {'command': command, 'cwd': str(cwd), 'status': 'started'}
    write(path.with_suffix('.json'), receipt)
    child = None; started = time.monotonic()
    try:
        assert started < deadline, 'Stage wall budget expired before command'
        with path.with_suffix('.log').open('xb') as log:
            child = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                env=os.environ.copy(), start_new_session=True)
            receipt.update(pid=child.pid, group=child.pid); write(path.with_suffix('.json'), receipt)
            while child.poll() is None:
                if time.monotonic() >= deadline: raise TimeoutError('Stage wall budget')
                if path.with_suffix('.log').stat().st_size > 128*1024*1024: raise RuntimeError('Log budget')
                time.sleep(0.1)
            assert time.monotonic() <= deadline, 'Stage wall budget (exit between polls)'
            assert child.returncode == 0, f'Command exited {child.returncode}'
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=repr(error)); raise
    finally:
        quiescent = child is None
        try:
            if child is not None:
                receipt['returncode'] = child.poll()
                receipt['cleanup'] = controller.cleanup_child(child, 2)
                quiescent = receipt['cleanup']['ownedGroupGone'] is True
        except BaseException as error:
            receipt.update(status='failed', cleanupError=repr(error), quiescence='unknown', logVerification='unverified: writer may remain'); raise
        finally:
            try:
                if quiescent:
                    assert time.monotonic() <= deadline+2, 'Finalization exceeded command budget and cleanup grace'
                    if path.with_suffix('.log').exists():
                        assert path.with_suffix('.log').stat().st_size <= 128*1024*1024, 'Log budget (exit between polls)'
                        receipt['logSha256'] = sha(path.with_suffix('.log'))
                    assert time.monotonic() <= deadline+2, 'Log hashing exceeded command budget and cleanup grace'
            except BaseException as error:
                receipt.update(status='failed', finalizationError=repr(error)); raise
            finally:
                receipt['elapsedWallSeconds'] = time.monotonic()-started
                write(path.with_suffix('.json'), receipt)
                if quiescent and receipt['status'] == 'passed' and time.monotonic() > deadline+2:
                    receipt.update(status='failed', finalizationError='Final receipt exceeded command budget and cleanup grace')
                    write(path.with_suffix('.json'), receipt)
                    raise TimeoutError(receipt['finalizationError'])
    return receipt
def stage(name, seconds, commands):
    root = run_root(); path = root/(name+'.json')
    assert not path.exists(), 'A stage is never overwritten or resumed'
    receipt = {'name': name, 'status': 'started', 'budgetSeconds': seconds, 'commands': []}
    write(path, receipt); deadline = min(time.monotonic()+seconds, read(root/'run.json')['workDeadlineMonotonicSeconds'], ADAPTER_DEADLINE_AT or float('inf'))
    try:
        for index, (command, cwd) in enumerate(commands):
            record = root/'logs'/name/f'{index:02d}'
            receipt['commands'].append({'receipt': str(record.with_suffix('.json')), 'status': 'started'})
            write(path, receipt)
            execute(command, cwd, record, deadline)
            receipt['commands'][-1]['status'] = 'passed'; write(path, receipt)
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=repr(error)); raise
    finally: write(path, receipt)
    return receipt
def tools_identity():
    records = [item(pathlib.Path(shutil.which(name)).resolve()) for name in ('node', 'bun', 'python3')]
    packages = ('assemblyscript', 'binaryen', 'long', 'typescript')
    per_arm = {}
    for arm in ARM_NAMES:
        base = source(arm)/'node_modules'
        per_arm[arm] = [item(p, base) for name in packages for p in sorted((base/name).rglob('*')) if p.is_file()]
        assert all(any(x['path'].startswith(name+'/') for x in per_arm[arm]) for name in packages)
    assert per_arm['baseline'] == per_arm['candidate'], 'Build tools differ between arms'
    records += [{**x, 'path': str(source('baseline')/'node_modules'/x['path'])} for x in per_arm['baseline']]
    return records
def preflight():
    verify_packet(); activation = read(HERE/'activation.json')
    assert type(activation['enabled']) is bool
    enabled = activation['enabled']
    if enabled:
        require_activation(); run_root().mkdir(parents=True, exist_ok=False)
        write(run_root()/'activation.json', activation)
        shutil.copyfile(HERE/'packet.json', run_root()/'packet.json')
        run = {k: os.environ.get(k) for k in (
            'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA',
            'GITHUB_REPOSITORY', 'GITHUB_REF', 'ImageOS', 'ImageVersion', 'RUNNER_ARCH')}
        run['workDeadlineMonotonicSeconds'] = time.monotonic()+82*60
        write(run_root()/'run.json', run)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('enabled='+str(enabled).lower()+'\n')
            if enabled: output.write('results='+str(run_root())+'\n')
    print(json.dumps({'enabled': enabled, 'timingRun': False}))
def setup():
    require_activation(); assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
    assert subprocess.check_output(['node','--version'], text=True).strip() == 'v22.23.3'
    assert subprocess.check_output(['bun','--version'], text=True).strip() == '1.4.2'
    (run_root()/'sources').mkdir()
    for arm in ARM_NAMES:
        git('worktree', 'add', '--detach', str(source(arm)), ORIGIN[arm+'Commit'])
        shutil.copyfile(HERE/'dependencies.bun.lock', source(arm)/'bun.lock')
        verify_source(arm)
    verify_source_chain()
    commands = [(['bun','install','--frozen-lockfile'], source(arm)) for arm in ARM_NAMES]
    commands += [(['node','node_modules/playwright/cli.js','install','--with-deps','chromium'], source('baseline'))]
    stage('setup', 360, commands)
    for arm in ARM_NAMES: verify_source(arm)
    write(run_root()/'toolchain-before.json', tools_identity())
def verify_source_chain():
    assert git('diff', '--name-only', ORIGIN['baselineCommit'], ORIGIN['candidateCommit']).splitlines() == ORIGIN['changedFiles']
    assert git('rev-parse', ORIGIN['candidateCommit']+'^') == ORIGIN['runtimeCommit']
    assert git('rev-parse', ORIGIN['runtimeCommit']+'^') == ORIGIN['runtimeParent']
    assert git('rev-parse', ORIGIN['runtimeParent']+'^') == ORIGIN['originalRuntime']
    assert git('rev-parse', ORIGIN['originalRuntime']+'^') == ORIGIN['baselineCommit']
    assert git('rev-parse', ORIGIN['runtimeCommit']+'^{tree}') == ORIGIN['runtimeTree']

def verify_wasm(arm, tree):
    expected = ORIGIN['expectedWasm'][arm]
    assert sorted(p.name for p in tree.glob('*.wasm')) == sorted(expected)
    for name, digest in expected.items():
        assert sha(tree/name) == digest, 'Fresh WASM differs from reviewed exact build: '+arm+'/'+name
    return {name: sha(tree/name) for name in sorted(expected)}

def gate(arm):
    require_activation(); identity = verify_source(arm)
    stage('gate-'+arm, 900, [(command, source(arm)) for command in GATES])
    verify_source(arm)
    write(run_root()/('gate-'+arm+'-source.json'), identity)
def validate_gates(root):
    receipts = []
    for arm in ARM_NAMES:
        gate = read(root/('gate-'+arm+'.json'))
        envelope = read(root/('gate-'+arm+'-envelope.json'))
        assert envelope['stage'] == 'gate-'+arm and envelope['status'] == 'passed'
        assert envelope['budgetSeconds'] == 900 and envelope['cleanupGraceSeconds'] == 2
        assert 0 <= envelope['elapsedWallSeconds'] <= 902
        assert gate['name'] == 'gate-'+arm and gate['budgetSeconds'] == 900
        assert gate['status'] == 'passed' and len(gate['commands']) == len(GATES)
        assert read(root/('gate-'+arm+'-source.json')) == verify_source(arm)
        for index, (expected, record) in enumerate(zip(GATES, gate['commands'])):
            expected_path = root/'logs'/('gate-'+arm)/f'{index:02d}.json'
            assert pathlib.Path(record['receipt']) == expected_path
            assert expected_path.resolve() == expected_path and not expected_path.is_symlink()
            log_path = expected_path.with_suffix('.log')
            assert log_path.resolve() == log_path and not log_path.is_symlink()
            result = read(expected_path)
            assert record['status'] == result['status'] == 'passed'
            assert result['command'] == expected and result['returncode'] == 0
            assert result['cwd'] == str(source(arm))
            assert 0 <= result['elapsedWallSeconds'] <= 902
            assert result['cleanup']['ownedGroupGone'] is True
            assert sha(log_path) == result['logSha256']
            receipts += [item(expected_path), item(log_path)]
        receipts += [item(root/('gate-'+arm+'.json')), item(root/('gate-'+arm+'-source.json')), item(root/('gate-'+arm+'-envelope.json'))]
    return receipts
def freeze():
    require_activation(); root = run_root(); reviews = validate_gates(root)
    tools = tools_identity(); assert tools == read(root/'toolchain-before.json'), 'Toolchain changed during gates'
    harness = root/'harness'; harness.mkdir()
    for name in ('protocol.json', 'subject.mjs', 'fixtures.mjs', 'math.mjs', 'controller.py', 'report.mjs', 'ci.py', 'origin.json'):
        shutil.copyfile(HERE/name, harness/name)
    sources = {}
    for arm in ARM_NAMES:
        tree = source(arm); names = git('ls-tree','-r','--name-only','HEAD',tree=tree).splitlines()
        files = [item(tree/name, tree) for name in names]
        builds = sorted([*tree.glob('*.wasm'), *tree.glob('dist/*.js'), *tree.glob('dist/types/**/*.d.ts')])
        assert len(list(tree.glob('*.wasm'))) == 12 and len(list(tree.glob('dist/*.js'))) == 12
        sources[arm] = {**verify_source(arm), 'path': str(tree), 'files': files, 'builds': [item(p,tree) for p in builds]}
    verify_source_chain()
    for arm in ARM_NAMES: verify_wasm(arm, source(arm))
    policy = {'mode':'ci-screen', 'promotionAllowed':False,
        'fullStandardGateStatus':{'baseline':'passed-fresh-exact-source', 'candidate':'passed-fresh-exact-source'},
        'gateReceiptFiles': reviews, 'historicalEvidenceTransferred':False,
        'interpretation':'Exploratory pointwise x64 screen; exact PR CI and independent review are still required for promotion.'}
    write(harness/'admission.json', policy)
    manifest = {'schema':3, 'purpose':'Fresh exact-source sorted-delete CI screen', 'sources':sources,
        'runtimes':{name:{'path':str(pathlib.Path(shutil.which(name)).resolve()), 'args':['--expose-gc'] if name == 'node' else []} for name in ('node','bun')},
        'tools':tools, 'harness':[item(p) for p in sorted(harness.iterdir()) if p.is_file()],
        'sourceReview':{'files':[item(HERE/'packet.json'), *reviews]}, 'origin':ORIGIN,
        'ciRun':read(root/'run.json'), 'preparationHost':controller.host()}
    controller.write_new(harness/'manifest.json', manifest)
    (harness/'manifest.sha256').write_text(sha(harness/'manifest.json')+'  manifest.json\n')
    controller.verify(manifest)
def fresh_admission():
    root = run_root(); require_activation(); validate_gates(root)
    envelope = read(root/'freeze-envelope.json')
    assert envelope['stage'] == 'freeze' and envelope['status'] == 'passed'
    assert envelope['budgetSeconds'] == 120 and 0 <= envelope['elapsedWallSeconds'] <= 122
    policy = read(root/'harness/admission.json')
    assert policy['mode'] == 'ci-screen' and policy['promotionAllowed'] is False
    for entry in policy['gateReceiptFiles']: assert sha(entry['path']) == entry['sha256']
    assert policy['fullStandardGateStatus'] == {arm:'passed-fresh-exact-source' for arm in ARM_NAMES}
    return policy
def launch(mode):
    require_activation(); bounded('admission-'+mode,120,fresh_admission)
    root = run_root(); harness = root/'harness'
    budget = 2100 if mode == 'run' else 360
    assert time.monotonic()+budget+2 <= read(root/'run.json')['workDeadlineMonotonicSeconds'], 'Insufficient remaining job budget; no shortened screen'
    if mode == 'run':
        untimed = read(root/'untimed/ledger.json')
        assert untimed['mode'] == 'untimed' and untimed['status'] == 'complete'
        assert untimed['manifestSha256'] == sha(harness/'manifest.json')
        assert len(untimed['slots']) == 4 and all(s['status'] == 'complete' and s['cleanup']['ownedGroupGone'] for s in untimed['slots'])
    controller.HERE = harness
    controller.admission = fresh_admission
    sys.argv = ['controller.py', mode, '--output', str(root/('screen' if mode == 'run' else 'untimed'))]
    if mode == 'run': sys.argv += ['--approved-manifest-sha256', sha(harness/'manifest.json')]
    timer = None
    if mode == 'untimed':
        # Reuse the reviewed alarm handler, cleanup and incomplete receipt at six minutes.
        timer = threading.Timer(360, lambda: os.kill(os.getpid(), signal.SIGALRM))
        timer.daemon = True; timer.start()
    try: controller.main()
    finally:
        if timer is not None: timer.cancel()
def preserve():
    """Copy artifacts only; never delete worktrees, logs, partial slots or failures."""
    root = run_root()
    if not root.exists(): return
    unresolved = []
    for path in sorted((root/'logs').glob('*/*.json')):
        try: record = read(path)
        except (ValueError, OSError) as error:
            unresolved.append({'receipt':str(path), 'error':repr(error)}); continue
        if record.get('status') == 'started' or record.get('cleanupError') or record.get('quiescence') == 'unknown' or (record.get('pid') and record.get('cleanup', {}).get('ownedGroupGone') is not True):
            unresolved.append({'receipt':str(path), 'pid':record.get('pid'), 'status':record.get('status')})
    for directory in (root/'untimed', root/'screen'):
        try: timeout = read(directory/'controller-timeout.json') if (directory/'controller-timeout.json').exists() else {}
        except (ValueError, OSError) as error:
            timeout = {}; unresolved.append({'receipt':str(directory/'controller-timeout.json'),'error':repr(error)})
        if timeout.get('cleanup',{}).get('ownedGroupGone') is False:
            unresolved.append({'receipt':str(directory/'controller-timeout.json'), 'cleanup':timeout['cleanup']})
        if (directory/'ledger.json').exists():
            try:
                ledger = read(directory/'ledger.json')
                if ledger.get('fatalOwnedProcess'): unresolved.append({'receipt':str(directory/'ledger.json'),'error':ledger['fatalOwnedProcess']})
            except (ValueError, OSError) as error:
                unresolved.append({'receipt':str(directory/'ledger.json'), 'error':repr(error)})
        for path in directory.glob('*.process.json'):
            try:
                record = read(path); cleanup_path = path.with_name(path.name.replace('.process.json','.cleanup.json'))
                cleanup = read(cleanup_path) if cleanup_path.exists() else timeout.get('cleanup',{})
            except (ValueError, OSError) as error:
                unresolved.append({'receipt':str(path), 'error':repr(error)}); continue
            if cleanup.get('pid') != record['pid'] or cleanup.get('ownedGroupGone') is not True:
                unresolved.append({'receipt':str(path), 'pid':record['pid']})
    preservation = {'status':'started', 'quiescence':'unknown' if unresolved else 'verified-from-owned-receipts', 'unresolvedWriters':unresolved}
    write(root/'preservation.json', preservation)
    if unresolved:
        # Upload the original partial files; do not read/hash files that may still be changing.
        preservation.update(status='partial-unverified', archivesVerified=False, rawFilesRetained=True,
            limitation='Owned writers may remain. Original partial logs are retained; copying source/build archives is skipped. No stable log/build hashes or verified source archives are claimed.')
        write(root/'preservation.json', preservation)
        return
    for arm in ARM_NAMES:
        tree = source(arm)
        if not tree.exists(): continue
        archive = root/(arm+'-source.tar')
        if not archive.exists():
            with archive.open('xb') as output: subprocess.run(['git','-C',str(tree),'archive','HEAD'],stdout=output,check=True)
        target = root/'builds'/arm; target.mkdir(parents=True, exist_ok=True)
        for path in [*tree.glob('*.wasm'), *tree.glob('dist/**/*')]:
            if path.is_file():
                dest = target/path.relative_to(tree); dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(path,dest)
    files = []
    for directory, dirs, names in os.walk(root):
        if pathlib.Path(directory) == root: dirs[:] = [name for name in dirs if name != 'sources']
        files += [item(pathlib.Path(directory)/name, root) for name in sorted(names) if name not in ('artifact-inventory.json','preservation.json')]
    write(root/'artifact-inventory.json', {'files':files, 'quiescence':preservation['quiescence'], 'originalAttemptFilesIncluded':True})
    preservation.update(status='complete', archivesVerified=True)
    write(root/'preservation.json', preservation)
def main():
    parser = argparse.ArgumentParser(); parser.add_argument('mode',choices=['preflight','setup','gate','freeze','untimed','screen','preserve']); parser.add_argument('--arm', choices=ARM_NAMES)
    args = parser.parse_args(); signal.signal(signal.SIGTERM, interrupted)
    if args.mode == 'preflight': preflight()
    elif args.mode == 'setup': bounded('setup',360,setup)
    elif args.mode == 'gate':
        assert args.arm
        bounded('gate-'+args.arm,900,lambda:gate(args.arm))
    elif args.mode == 'freeze': bounded('freeze',120,freeze)
    elif args.mode in ('untimed','screen'): launch('untimed' if args.mode == 'untimed' else 'run')
    else: preserve()
if __name__ == '__main__': main()
