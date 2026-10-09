"""Fixed 80-subject controller. 'verify' never starts a library or subject."""
from pathlib import Path
import datetime, hashlib, importlib.util, json, os, platform, signal, subprocess, sys, time
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
SUPERVISOR = ROOT / 'supervise.py'
spec = importlib.util.spec_from_file_location('reviewed_supervisor', SUPERVISOR)
supervisor = importlib.util.module_from_spec(spec); spec.loader.exec_module(supervisor)


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def read(path): return json.loads(Path(path).read_text())
def save(path, value):
    with Path(path).open('x') as stream:
        stream.write(json.dumps(value, indent=2) + '\n'); stream.flush(); os.fsync(stream.fileno())


def require_budget(deadline, now=None):
    assert deadline - (time.monotonic() if now is None else now) >= 68, 'Insufficient full 60-second command plus eight-second cleanup budget'


def verify(frozen_sha, guard=lambda: None):
    guard(); assert sha(ROOT / 'FROZEN.json') == frozen_sha, 'Frozen manifest changed'
    for row in read(ROOT / 'FROZEN.json')['files']:
        guard(); p = Path(row['path']); p = p if p.is_absolute() else ROOT / p
        assert p.is_file() and not p.is_symlink() and p.stat().st_size == row['bytes'] and sha(p) == row['sha256'], str(p)
    for row in read(ROOT / 'INPUTS.json'):
        guard(); p = ROOT / row['path']; source = Path(row['source'])
        assert p.stat().st_nlink == 1 and not p.samefile(source) and sha(source) == row['sha256'], 'Changed/aliased hosted build'
    for arm in ('baseline', 'candidate'):
        actual = {p.name for p in (ROOT / 'fixtures' / arm / 'dist').iterdir()}
        wanted = {Path(row['path']).name for row in read(ROOT / 'INPUTS.json') if row['path'].startswith(f'fixtures/{arm}/dist/')}
        assert len(wanted) == 12 and actual == wanted
    assert sha(SUPERVISOR) == '14ca60deec3dab98ffea94fb6006ea9b03167813d79a65b844e91e55a0478de0'
    guard()


def check_receipt(slot, path):
    value = read(path)
    assert value['command'] == slot['childArgv'] and value['cwd'] == str(ROOT)
    assert value['state'] == 'passed' and value['returncode'] == 0 and value['spawned']
    assert value['supervisorLimit'] is None and value['primaryError'] is None and value['interruptionSignal'] is None
    clean = value['cleanup']
    assert clean['confirmedEmpty'] and clean['remainingGroupPids'] == [] and clean['remainingBeforeCleanup'] == []
    assert clean['errors'] == [] and clean['signalsAttempted'] == []
    return value


def launch(command, trace, guard, final_deadline):
    """Reuse the reviewed owner lifecycle: TERM the supervisor; it cleans its child group."""
    proc = None
    try:
        with trace.open('xb') as stream:
            guard()
            proc = subprocess.Popen(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            save(Path(str(trace) + '.owner.json'), {'supervisorPid': proc.pid, 'supervisorGroup': proc.pid, 'argv': command})
            while proc.poll() is None:
                guard(); time.sleep(.1)
            guard(); assert proc.returncode == 0, 'Original supervised command failed'
    finally:
        if proc is not None and proc.poll() is None:
            cleanup = {'supervisorPid': proc.pid, 'requestedTERM': True, 'supervisorExited': False, 'error': None}
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                remaining = max(0, min(8, final_deadline - time.monotonic()))
                cleanup['waitBudgetSeconds'] = remaining; proc.wait(timeout=remaining); cleanup['supervisorExited'] = True
            except BaseException as error: cleanup['error'] = repr(error)
            save(Path(str(trace) + '.interruption.json'), cleanup)


def check_raw(slot):
    output = Path(slot['childArgv'][-6]); assert output == ROOT / 'execution' / f"{slot['id']}.json"
    for path in (output, Path(str(output) + '.rows.jsonl'), Path(str(output) + '.started.json')):
        assert path.is_file() and path.stat().st_size <= 262144, 'Missing/oversized child record'
    value = read(output); rows = [json.loads(line) for line in Path(str(output) + '.rows.jsonl').read_text().splitlines()]
    assert value['complete'] and value['failure'] is None and len(rows) == 30 and rows == value['rows']
    for field, expected in [('cell', slot['case']), ('label', slot['label']), ('pair', slot['pairIndex']), ('kind', slot['pairKind']), ('runtime', slot['runtime'])]:
        assert value[field] == expected
    assert value['entry'] == slot['childArgv'][-7]
    assert value['buildSha256'] == read(ROOT / 'BUILD-HASHES.json')[slot['sourceArm']]
    started = read(str(output) + '.started.json')
    assert started == {key: value[key] for key in started}, 'Metadata changed after recording'
    return value


def run(frozen_sha):
    matrix = read(ROOT / 'MATRIX.json'); schedule = read(ROOT / 'SCHEDULE.json')
    assert len(schedule) == 80 and [s['index'] for s in schedule] == list(range(80))
    started = time.monotonic(); deadline = started + 2700; work_until = deadline - 8
    out = ROOT / 'execution'; complete = []; observations = []; current = None
    with supervisor.Signals() as signals:
        def guard():
            if signals.first is not None: raise InterruptedError(f'Controller signal {signals.first}')
            if time.monotonic() >= work_until: raise TimeoutError('2692-second active cutoff; eight seconds reserved for owner cleanup')
        out.mkdir()
        try:
            verify(frozen_sha, guard)
            injection = {key: bool(os.environ.get(key)) for key in ('NODE_OPTIONS', 'BUN_OPTIONS', 'LD_PRELOAD')}
            assert not any(injection.values()), 'Unexpected runtime injection environment'
            save(out / 'admission.json', {'frozenSHA256': frozen_sha, 'scheduleSHA256': sha(ROOT / 'SCHEDULE.json'),
                'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'platform': platform.platform(),
                'machine': platform.machine(), 'cpuInfo': Path('/proc/cpuinfo').read_text(), 'affinity': sorted(os.sched_getaffinity(0)),
                'loadAverage': os.getloadavg(), 'injectionEnvironmentPresent': injection,
                'scope': '80 original subjects, one read-only analysis; supervisor clocks/RSS are safety metadata only'})
            for slot in schedule:
                current = slot; verify(frozen_sha, guard)
                require_budget(deadline)
                save(out / f"{slot['index']:02d}-started.json", slot)
                print(json.dumps({'id': slot['id'], 'state': 'started'}), flush=True)
                launch(slot['supervisorArgv'], out / f"{slot['id']}.supervisor.log", guard, deadline)
                check_receipt(slot, out / f"{slot['id']}.log.json")
                assert (out / f"{slot['id']}.log").stat().st_size <= 1048576
                observations.append(check_raw(slot)); verify(frozen_sha, guard); complete.append(slot['id'])
                print(json.dumps({'id': slot['id'], 'state': 'completed'}), flush=True)
            assert len(complete) == 80
            for slot, value in zip(schedule, observations):
                guard(); check_receipt(slot, out / f"{slot['id']}.log.json"); assert check_raw(slot) == value
            save(out / 'canonical.json', {'observations': observations, 'schedule': schedule, 'matrix': matrix})
            analysis = read(ROOT / 'ANALYSIS-COMMAND.json'); current = analysis
            require_budget(deadline)
            launch(analysis['supervisorArgv'], out / 'analysis.supervisor.log', guard, deadline)
            check_receipt(analysis, out / 'analysis.log.json'); verify(frozen_sha, guard)
            save(out / 'completion.json', {'state': 'complete', 'completed': complete, 'frozenSHA256': frozen_sha,
                'analysisSha256': sha(out / 'analysis.json'), 'statisticalClassification': read(out / 'analysis.json')['classification']})
        except BaseException as error:
            save(out / 'failure.json', {'classification': 'invalid-or-incomplete', 'completed': complete,
                'current': current['id'] if current else None, 'errorName': type(error).__name__, 'error': str(error),
                'originalEvidencePreserved': True, 'laterInvocations': 'unstarted; no replacements'})
            raise


if __name__ == '__main__':
    assert len(sys.argv) == 3 and sys.argv[1] in ('verify', 'run'), 'Require mode and reviewed FROZEN hash'
    if sys.argv[1] == 'verify': verify(sys.argv[2]); print('Input/source verification passed; no subjects started')
    else: run(sys.argv[2])
