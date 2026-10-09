"""Narrow Linux x64/ARM64 startup and portability CI adapter. No work runs merely by importing this file.

The copied controller and statistical functions are unchanged.
The public numeric subject and source/build guards are scoped to the reviewed plan.
This file replaces only local historical admission with fresh exact-source gates.
"""
import argparse, hashlib, json, os, pathlib, platform, shutil, signal, subprocess, sys, time, threading
import controller
from artifact_checks import verify_build_pair, scalar_fixture

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
BRANCH = 'refs/heads/proof/numeric-portability-20261009'
ARM_NAMES = ('baseline', 'candidate')
ORIGIN = json.loads((HERE/'origin.json').read_text())
ADAPTER_DEADLINE_AT = None
STANDARD_GATES = [
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

NUMERIC_GATES = [
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.numeric.json'],
    *[[runtime, str(HERE/'correctness-v2.mjs'), '{source}', selection]
      for runtime in ('node', 'bun') for selection in ('auto', 'scalar')],
    *[[runtime, 'proofs/'+name+'-worker.mjs']
      for runtime in ('node', 'bun') for name in ('numeric', 'spatial')],
]
GATES = STANDARD_GATES + NUMERIC_GATES
assert len(STANDARD_GATES) == 23 and len(NUMERIC_GATES) == 9 and len(GATES) == 32

def gate_commands(arm):
    return [[str(source(arm)) if value == '{source}' else value for value in command] for command in GATES]

def sha(path):
    digest=hashlib.sha256()
    with pathlib.Path(path).open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()
controller.sha=sha
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
    return pathlib.Path(os.environ['RUNNER_TEMP']) / ('numeric-portability-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']+'-'+lane())
def verify_packet():
    packet = read(HERE/'packet.json')
    for entry in packet['files']:
        assert sha(REPO/entry['path']) == entry['sha256'], 'Changed packet: '+entry['path']
    return packet
def require_activation():
    packet = verify_packet(); activation = read(HERE/'activation.json')
    assert activation['enabled'] is True, 'Numeric unroll screen is off by default'
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy'
    assert os.environ.get('GITHUB_REF') == BRANCH
    assert os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'Original attempt only; no selective rerun'
    assert activation['reviewedPacketSha256'] == sha(HERE/'packet.json')
    assert git('rev-parse', 'HEAD^') == activation['reviewedPacketCommit']
    assert git('diff', '--name-only', 'HEAD^', 'HEAD') == 'proofs/numeric-portability/activation.json'
    assert not git('status', '--porcelain', '--untracked-files=no')
    assert git('rev-parse', 'HEAD') == os.environ['GITHUB_SHA']
    assert packet['origin'] == ORIGIN
    return packet
def lane():
    value = os.environ.get('PROOF_LANE')
    assert value in ('x64','arm64')
    return value
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
    packages = ('assemblyscript', 'binaryen', 'long', 'typescript', 'playwright', 'playwright-core')
    per_arm = {}
    for arm in ARM_NAMES:
        base = source(arm)/'node_modules'
        per_arm[arm] = [item(p, base) for name in packages for p in sorted((base/name).rglob('*')) if p.is_file()]
        assert all(any(x['path'].startswith(name+'/') for x in per_arm[arm]) for name in packages)
    assert per_arm['baseline'] == per_arm['candidate'], 'Build tools differ between arms'
    # Freeze both paths: equality now does not protect an unlisted candidate path later.
    records += [{**x, 'path': str(source(arm)/'node_modules'/x['path'])} for arm in ARM_NAMES for x in per_arm[arm]]
    pins = read(run_root()/'browser-pins.json')
    assert pins['version'] == '1.63.0'
    for engine in pins['engines']:
        executable = pathlib.Path(engine['executable']).resolve()
        base = next((p for p in executable.parents if p.name.startswith(('chromium-', 'chromium_headless_shell-', 'firefox-', 'webkit-'))), None)
        assert base is not None and executable.is_file(), 'Installed browser distribution missing'
        records += [item(p) for p in sorted(base.rglob('*')) if p.is_file()]
    records += [item(run_root()/'browser-pins.json')]
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
            'GITHUB_REPOSITORY', 'GITHUB_REF', 'GITHUB_WORKSPACE', 'RUNNER_TEMP', 'PROOF_LANE', 'ImageOS', 'ImageVersion', 'RUNNER_ARCH')}
        run['workDeadlineMonotonicSeconds'] = time.monotonic()+82*60
        write(run_root()/'run.json', run)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('enabled='+str(enabled).lower()+'\n')
            if enabled: output.write('results='+str(run_root())+'\n')
    print(json.dumps({'enabled': enabled, 'timingRun': False}))
def setup():
    require_activation(); assert platform.system() == 'Linux' and platform.machine() == {'x64':'x86_64','arm64':'aarch64'}[lane()]
    assert subprocess.check_output(['node','--version'], text=True).strip() == 'v22.23.3'
    assert subprocess.check_output(['bun','--version'], text=True).strip() == '1.4.2'
    (run_root()/'sources').mkdir()
    for arm in ARM_NAMES:
        git('worktree', 'add', '--detach', str(source(arm)), ORIGIN[arm+'Commit'])
        shutil.copyfile(HERE/'dependencies.bun.lock', source(arm)/'bun.lock')
        verify_source(arm)
    verify_source_chain()
    commands = [(['bun','install','--frozen-lockfile'], source(arm)) for arm in ARM_NAMES]
    commands += [(['node','node_modules/playwright/cli.js','install','--with-deps',*(['chromium','firefox','webkit'] if lane() == 'x64' else ['chromium'])], source('baseline'))]
    commands += [(['node',str(HERE/'inventory-browsers.mjs'),str(source('baseline')),str(run_root()/'browser-pins.json'),lane()], source('baseline'))]
    stage('setup', 600, commands)
    for arm in ARM_NAMES: verify_source(arm)
    write(run_root()/'toolchain-before.json', tools_identity())
def verify_source_chain():
    assert git('rev-parse', ORIGIN['mainCommit']+'^{tree}') == ORIGIN['mainTree']
    assert git('rev-parse', ORIGIN['sourceCandidateCommit']+'^') == ORIGIN['mainCommit']
    assert git('rev-parse', ORIGIN['sourceCandidateCommit']+'^{tree}') == ORIGIN['sourceCandidateTree']
    assert git('rev-parse', ORIGIN['baselineCommit']+'^') == ORIGIN['mainCommit']
    assert git('rev-parse', ORIGIN['candidateCommit']+'^') == ORIGIN['sourceCandidateCommit']
    assert git('diff','--name-only',ORIGIN['baselineCommit'],ORIGIN['candidateCommit']) == 'numeric-kernels.as.ts'
    assert git('diff','--numstat',ORIGIN['baselineCommit'],ORIGIN['candidateCommit']) == '8\t0\tnumeric-kernels.as.ts'
    patch = subprocess.check_output(['git','-C',str(REPO),'diff',ORIGIN['baselineCommit'],ORIGIN['candidateCommit'],'--','numeric-kernels.as.ts'])
    assert hashlib.sha256(patch).hexdigest() == ORIGIN['runtimePatchSha256']
    for parent, child in ((ORIGIN['mainCommit'],ORIGIN['baselineCommit']),(ORIGIN['sourceCandidateCommit'],ORIGIN['candidateCommit'])):
        assert git('diff','--name-only',parent,child) == 'numeric.test.ts'
        test_patch = subprocess.check_output(['git','-C',str(REPO),'diff',parent,child,'--','numeric.test.ts'])
        assert hashlib.sha256(test_patch).hexdigest() == ORIGIN['commonTestPatchSha256']
    git('merge-base','--is-ancestor',ORIGIN['historicalBaselineCommit'],ORIGIN['mainCommit'])
    assert git('diff','--name-only',ORIGIN['historicalBaselineCommit'],ORIGIN['mainCommit']).splitlines() == ORIGIN['mainDocumentationChanges']
    for arm in ARM_NAMES:
        assert git('rev-parse', ORIGIN[arm+'Commit']+'^{tree}') == ORIGIN[arm+'Tree']


def verify_wasm(arm, tree):
    expected = ORIGIN['expectedWasm'][arm]
    assert sorted(p.name for p in tree.glob('*.wasm')) == sorted(expected)
    for name, digest in expected.items():
        assert sha(tree/name) == digest, 'Fresh WASM differs from reviewed exact build: '+arm+'/'+name
    return {name: sha(tree/name) for name in sorted(expected)}

def gate(arm):
    require_activation(); identity = verify_source(arm)
    stage('gate-'+arm, 900, [(command, source(arm)) for command in gate_commands(arm)])
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
        for index, (expected, record) in enumerate(zip(gate_commands(arm), gate['commands'])):
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
    from artifact_admission import FROZEN
    for name in FROZEN:
        shutil.copyfile(HERE/name, harness/name)
    sources = {}
    for arm in ARM_NAMES:
        tree = source(arm); names = git('ls-tree','-r','--name-only','HEAD',tree=tree).splitlines()
        files = [item(tree/name, tree) for name in names]
        builds = sorted([*tree.glob('*.wasm'), *tree.glob('dist/*.js'), *tree.glob('dist/types/**/*.d.ts')])
        assert len(list(tree.glob('*.wasm'))) == 12 and len(list(tree.glob('dist/*.js'))) == 12
        sources[arm] = {**verify_source(arm), 'path': str(tree), 'files': files, 'builds': [item(p,tree) for p in builds]}
    verify_source_chain()
    for arm in ARM_NAMES:
        verify_wasm(arm, source(arm))
        assert sources[arm]['builds'] == ORIGIN['expectedOutputs'][arm], 'Fresh official outputs differ from retained matching arm'
    write(root/'build-comparison.json', verify_build_pair(source('baseline'), source('candidate'), ORIGIN))
    # Generate only after official outputs pass; never count this as official output 13.
    fixtures = {arm:scalar_fixture(source(arm), create=True) for arm in ARM_NAMES}
    for arm in ARM_NAMES: sources[arm]['generatedFixtures'] = [fixtures[arm]]
    write(root/'generated-fixtures.json', fixtures)
    policy = {'mode':'ci-screen', 'promotionAllowed':False,
        'fullStandardGateStatus':{'baseline':'passed-fresh-exact-source', 'candidate':'passed-fresh-exact-source'},
        'gateReceiptFiles': reviews, 'historicalEvidenceTransferred':False,
        'interpretation':'Exploratory pointwise spatial-first startup and ARM/browser warm portability; range-first, earlier inconclusive controls and other environments unresolved; no promotion.',
        'firstUseStatus':'prospective-spatial-first-only', 'standardCommandsPerArm':23, 'numericCommandsPerArm':9}
    write(harness/'admission.json', policy)
    manifest = {'schema':3, 'purpose':'Fresh exact-source main52 numeric portability lane', 'lane':lane(), 'sources':sources,
        'runtimes':{name:{'path':str(pathlib.Path(shutil.which(name)).resolve()), 'args':['--expose-gc'] if name == 'node' else []} for name in ('node','bun')},
        'tools':tools, 'harness':[item(p) for p in sorted(harness.iterdir()) if p.is_file()] +
            [item(source(arm)/fixtures[arm]['path']) for arm in ARM_NAMES],
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
    assert read(root/'generated-fixtures.json') == {arm:scalar_fixture(source(arm)) for arm in ARM_NAMES}
    return policy
def launch(mode):
    require_activation(); bounded('admission-'+mode,120,fresh_admission)
    root=run_root(); harness=root/'harness'
    if mode in ('semantics','untimed'):
        run = read(root/'run.json')
        if 'supplementalAdmissionDeadlineMonotonicSeconds' not in run:
            run['supplementalAdmissionDeadlineMonotonicSeconds'] = time.monotonic()+600
            write(root/'run.json',run)
    if mode == 'semantics' and lane() != 'x64':
        return
    budget = {'x64':1680,'arm64':1500}[lane()] if mode == 'run' else 360
    assert time.monotonic()+budget+2 <= read(root/'run.json')['workDeadlineMonotonicSeconds'], 'Insufficient full prospective controller budget'
    if mode == 'untimed' and lane() == 'x64':
        assert read(root/'semantics/ledger.json')['status'] == 'complete'
    if mode == 'run':
        assert read(root/'untimed/ledger.json')['status'] == 'complete'
    stage('launch-'+mode,budget+2,[(['python3',str(harness/'run.py'),mode,'--root',str(root),'--lane',lane()],REPO)])
    if mode == 'run':
        stage('report',120,[(['node',str(harness/'report.mjs'),str(root),lane()],REPO)])

def preserve():
    """Copy artifacts only; never delete worktrees, logs, partial slots or failures."""
    from resource_ownership import validate_cleanup_receipts, parse_ownership_rows
    root = run_root()
    if not root.exists(): return
    unresolved = []
    for path in sorted((root/'logs').glob('*/*.json')):
        try: record = read(path)
        except (ValueError, OSError) as error:
            unresolved.append({'receipt':str(path), 'error':repr(error)}); continue
        if record.get('status') == 'started' or record.get('cleanupError') or record.get('quiescence') == 'unknown' or (record.get('pid') and record.get('cleanup', {}).get('ownedGroupGone') is not True):
            unresolved.append({'receipt':str(path), 'pid':record.get('pid'), 'status':record.get('status')})
    for directory in (root/'semantics',root/'untimed',root/'run'):
        def verified_slot_cleanup(identifier):
            """Incomplete birth/receipt windows remain unknown, even without PID."""
            if not isinstance(identifier,str) or not identifier or pathlib.Path(identifier).name!=identifier or identifier in ('.','..'):return False
            process_path=directory/(identifier+'.process.json')
            cleanup_path=directory/(identifier+'.cleanup.json')
            config_path=directory/(identifier+'.config.json')
            try:
                process=read(process_path);cleanup=read(cleanup_path);config=read(config_path)
                if config.get('id')!=identifier or identifier.split('-',1)[0]!=config.get('runtime') or process.get('command',[])[-1:]!=[str(config_path)]:return False
                slot_receipt_path=directory/(identifier+'.receipt.json')
                if slot_receipt_path.exists():
                    slot_receipt=read(slot_receipt_path)
                    if slot_receipt.get('cleanup')!=cleanup or slot_receipt.get('command')!=process.get('command'):return False
                    if slot_receipt.get('configSha256')!=sha(config_path):return False
                journal=None
                if config.get('runtime') in ('chromium','firefox','webkit'):
                    journal_path=directory/(identifier+'.ownership.jsonl')
                    if config.get('ownershipJournal')!=str(journal_path):return False
                    with journal_path.open('rb') as source:journal_data=source.read(65537)
                    journal=parse_ownership_rows(journal_data)
                    if hashlib.sha256(journal_data).hexdigest()!=cleanup.get('ownership',{}).get('sha256'):return False
                validate_cleanup_receipts({'id':identifier,'runtime':config.get('runtime')},config,process,cleanup,journal)
                return True
            except (ValueError,OSError,TypeError,AttributeError,KeyError):return False
        try: timeout = read(directory/'controller-timeout.json') if (directory/'controller-timeout.json').exists() else {}
        except (ValueError, OSError) as error:
            timeout = {}; unresolved.append({'receipt':str(directory/'controller-timeout.json'),'error':repr(error)})
        if timeout.get('cleanup',{}).get('ownedGroupGone') is False:
            unresolved.append({'receipt':str(directory/'controller-timeout.json'), 'cleanup':timeout['cleanup']})
        if (directory/'ledger.json').exists():
            try:
                ledger = read(directory/'ledger.json')
                if ledger.get('fatalOwnedProcess'): unresolved.append({'receipt':str(directory/'ledger.json'),'error':ledger['fatalOwnedProcess']})
                for slot in ledger.get('slots',[]):
                    if slot.get('status') in ('pending','not-run'):continue
                    identifier=slot.get('id')
                    if not isinstance(identifier,str) or not identifier or not verified_slot_cleanup(identifier):
                        unresolved.append({'receipt':str(directory/'ledger.json'),'slot':identifier,'status':slot.get('status'),'error':'Attempted slot has no verified birth-bound cleanup'})
            except (ValueError, OSError, TypeError, AttributeError) as error:
                unresolved.append({'receipt':str(directory/'ledger.json'), 'error':repr(error)})
        for path in directory.glob('*.receipt.json'):
            try:
                record=read(path);identifier=path.name[:-len('.receipt.json')]
                if record.get('fatalOwnedProcess') or record.get('cleanupReceiptError') or not verified_slot_cleanup(identifier):
                    unresolved.append({'receipt':str(path),'pid':record.get('cleanup',{}).get('pid'),'status':record.get('status'),'error':'Slot ownership/preservation remains unknown'})
            except (ValueError,OSError,TypeError,AttributeError) as error:
                unresolved.append({'receipt':str(path),'error':repr(error)})
        for path in directory.glob('*.process.json'):
            try:
                record = read(path)
                if not verified_slot_cleanup(path.name[:-len('.process.json')]):
                    unresolved.append({'receipt':str(path), 'pid':record.get('pid')})
            except (ValueError, OSError, TypeError, AttributeError) as error:
                unresolved.append({'receipt':str(path), 'error':repr(error)}); continue
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
    parser = argparse.ArgumentParser(); parser.add_argument('mode',choices=['preflight','setup','gate','freeze','semantics','untimed','screen','preserve']); parser.add_argument('--arm', choices=ARM_NAMES)
    args = parser.parse_args(); signal.signal(signal.SIGTERM, interrupted)
    if args.mode == 'preflight': preflight()
    elif args.mode == 'setup': bounded('setup',600,setup)
    elif args.mode == 'gate':
        assert args.arm
        bounded('gate-'+args.arm,900,lambda:gate(args.arm))
    elif args.mode == 'freeze': bounded('freeze',120,freeze)
    elif args.mode in ('semantics','untimed','screen'): launch('run' if args.mode == 'screen' else args.mode)
    else: preserve()
if __name__ == '__main__': main()
