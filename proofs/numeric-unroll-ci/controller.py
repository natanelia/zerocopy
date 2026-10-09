"""Bounded local launcher. Default verification does not run performance clocks."""
import argparse, hashlib, json, os, pathlib, platform, re, signal, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
ACTIVE_CHILD = None
DEADLINE_AT = None
class OwnedProcessRemains(RuntimeError): pass
class ControllerDeadline(BaseException): pass

def controller_timeout(_signal, _frame):
    global DEADLINE_AT
    DEADLINE_AT = time.monotonic()
    # Stop the one-shot alarm before unwinding; final cleanup gets its own bounded grace.
    signal.setitimer(signal.ITIMER_REAL, 0)
    raise ControllerDeadline('whole-controller wall budget')

def finish_timeout(out, grace):
    global ACTIVE_CHILD
    receipt = {'status': 'incomplete', 'reason': 'whole-controller wall budget',
        'sourceAfterVerified': False, 'originalPendingOrStartedSlotsAreNotReplaced': True,
        'lateSamplesAdmitted': False, 'cleanupGraceSeconds': grace}
    if ACTIVE_CHILD is not None:
        try:
            receipt['cleanup'] = cleanup_child(ACTIVE_CHILD, grace)
            ACTIVE_CHILD = None
        except Exception as error:
            receipt['cleanup'] = {'pid': ACTIVE_CHILD.pid, 'ownedGroupGone': False, 'error': repr(error)}
    else:
        receipt['cleanup'] = {'activeChild': None, 'ownedGroupGone': True}
    if out is not None:
        write_new(out/'controller-timeout.json', receipt)
        ledger_path = out/'ledger.json'
        if ledger_path.exists():
            ledger = read(ledger_path)
            ledger.update(status='incomplete', deadline=receipt)
            update(ledger_path, ledger)
    print(json.dumps(receipt), flush=True)
    return receipt
def group_alive(pid):
    try: os.killpg(pid, 0); return True
    except ProcessLookupError: return False
def cleanup_child(child, grace):
    deadline = time.monotonic()+grace
    if DEADLINE_AT is not None: deadline = min(deadline, DEADLINE_AT+grace)
    terminated = group_alive(child.pid)
    if terminated: os.killpg(child.pid, signal.SIGTERM)
    try: child.wait(timeout=max(0, min(grace*0.75, deadline-time.monotonic())))
    except subprocess.TimeoutExpired:
        if group_alive(child.pid): os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=max(0, deadline-time.monotonic()))
    if group_alive(child.pid):
        os.killpg(child.pid, signal.SIGKILL)
        raise OwnedProcessRemains(f'Owned process group {child.pid} is still visible; stop all further slots')
    return {'pid': child.pid, 'group': child.pid, 'returncode': child.returncode, 'terminated': terminated, 'ownedGroupGone': True}
def sha(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def read(path): return json.loads(pathlib.Path(path).read_text())
def write_new(path, value):
    with pathlib.Path(path).open('x') as f: json.dump(value, f, indent=2); f.write('\n')
def update(path, value):
    temp = pathlib.Path(str(path)+'.tmp'); temp.write_text(json.dumps(value, indent=2)+'\n'); temp.replace(path)
def git(tree, *args): return subprocess.check_output(['git', '-C', str(tree), *args], text=True).strip()
def optional(path):
    try: return pathlib.Path(path).read_text().strip()
    except OSError: return None
def host():
    return {'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'platform': platform.platform(),
        'machine': platform.machine(), 'cpuCount': os.cpu_count(), 'loadAverage': os.getloadavg(),
        'cpuInfo': optional('/proc/cpuinfo'), 'memInfo': optional('/proc/meminfo'),
        'cpuPressure': optional('/proc/pressure/cpu'), 'memoryPressure': optional('/proc/pressure/memory'),
        'cpuMax': optional('/sys/fs/cgroup/cpu.max'), 'memoryMax': optional('/sys/fs/cgroup/memory.max'),
        'cpuStat': optional('/sys/fs/cgroup/cpu.stat'), 'memoryCurrent': optional('/sys/fs/cgroup/memory.current'),
        'affinity': sorted(os.sched_getaffinity(0)), 'clock': time.get_clock_info('monotonic').__dict__}
def rss(pid):
    s = optional(f'/proc/{pid}/status')
    if s:
        for line in s.splitlines():
            if line.startswith('VmRSS:'): return int(line.split()[1])*1024
    return 0
def verify(manifest):
    for item in manifest['sourceReview']['files']:
        assert sha(item['path']) == item['sha256'], f"Changed independent source review: {item['path']}"
    for group in ['harness', 'tools']:
        for item in manifest[group]:
            assert sha(item['path']) == item['sha256'], f"Changed {group}: {item['path']}"
    for arm, data in manifest['sources'].items():
        tree = pathlib.Path(data['path'])
        assert git(tree, 'rev-parse', 'HEAD') == data['commit'], f'{arm} HEAD changed'
        assert git(tree, 'rev-parse', 'HEAD^{tree}') == data['tree'], f'{arm} tree changed'
        assert not git(tree, 'status', '--porcelain', '--untracked-files=no'), f'{arm} tracked worktree changed'
        for item in data['files'] + data['builds']:
            assert sha(tree/item['path']) == item['sha256'], f"Changed {arm}: {item['path']}"
    return {'ok': True, 'sourceCommits': {a: d['commit'] for a, d in manifest['sources'].items()}}
def admission():
    prerequisites = read(HERE/'prerequisites.json'); policy = read(HERE/'admission.json')
    assert policy['mode'] == 'exploratory-only' and policy['promotionAllowed'] is False
    assert policy['fullStandardGateStatus'] == {'baseline': 'failed-timeout-only-existing-exact-ad2', 'candidate': 'not-run'}
    assert policy['knownTimeoutFailures'] == {'baseline': 16, 'candidate': None}
    assert prerequisites['nativeCandidateFullStandardSuite'] == 'not-run'
    assert prerequisites['newBuilds'] is False
    assert prerequisites['copiedOfficialBuildsVerified'] is True
    evidence = read(HERE/'baseline-gate-evidence.json')
    assert evidence['commit'] == 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad'
    assert sha(evidence['log']) == evidence['logSha256']
    log = pathlib.Path(evidence['log']).read_text()
    failures = re.findall(r'^ FAIL  (.*)$', log, re.M)
    errors = re.findall(r'^Error: (.*)$', log, re.M)
    assert errors and all(e == 'Test timed out in 5000ms.' for e in errors)
    assert len(failures) == 16 and failures == evidence['failureIdentities']['failures']
    assert evidence['isolatedBaselineTimeoutStillUnresolved'] is True
    return policy
def launch(manifest, protocol, out, slot, mode, deadline, work=None):
    global ACTIVE_CHILD
    record = {**slot, 'mode': mode, 'status': 'started', 'hostBefore': host()}
    record['verificationBefore'] = verify(manifest)
    runtime = manifest['runtimes'][slot['runtime']]
    config = {**slot, 'mode': mode, 'entrypoint': str(pathlib.Path(manifest['sources'][slot['arm']]['path'])/'dist/shared.js')}
    if work is not None: config['work'] = work
    config_path = out/f"{slot['id']}.config.json"; write_new(config_path, config)
    stdout_path, stderr_path = out/f"{slot['id']}.stdout.jsonl", out/f"{slot['id']}.stderr.log"
    command = [runtime['path'], *runtime['args'], str(HERE/'subject.mjs'), str(config_path)]
    seconds = protocol['budgets'][{'untimed': 'untimedProcessWallSeconds', 'calibrate': 'calibrationProcessWallSeconds', 'measure': 'measurementProcessWallSeconds'}[mode]]
    started = time.monotonic(); limit = min(started+seconds, deadline)
    record.update(command=command, maximumWallSeconds=seconds, maximumRss=0, controllerMaximumRss=0)
    with stdout_path.open('xb') as stdout, stderr_path.open('xb') as stderr:
        child = None; reason = None
        try:
            child = subprocess.Popen(command, cwd=manifest['sources'][slot['arm']]['path'], stdout=stdout, stderr=stderr,
                env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'NO_COLOR': '1'}, start_new_session=True)
            ACTIVE_CHILD = child
            record['pid'] = record['processGroup'] = child.pid
            write_new(out/f"{slot['id']}.process.json", {'pid': child.pid, 'group': child.pid, 'command': command, 'status': 'spawned'})
            while child.poll() is None:
                record['maximumRss'] = max(record['maximumRss'], rss(child.pid))
                record['controllerMaximumRss'] = max(record['controllerMaximumRss'], rss(os.getpid()))
                if time.monotonic() >= limit: reason = 'whole-process wall budget'
                if record['maximumRss'] > protocol['memory']['maximumSubjectRssBytes']: reason = 'subject RSS budget'
                if record['controllerMaximumRss'] > protocol['memory']['maximumControllerRssBytes']: reason = 'controller RSS budget'
                if stdout_path.stat().st_size + stderr_path.stat().st_size > protocol['memory']['maximumOutputBytes']: reason = 'output budget'
                if reason: break
                time.sleep(protocol['memory']['rssPollMs']/1000)
        finally:
            if child is not None:
                record['cleanup'] = cleanup_child(child, protocol['budgets']['terminationGraceSeconds'])
                write_new(out/f"{slot['id']}.cleanup.json", record['cleanup'])
                ACTIVE_CHILD = None
    elapsed = time.monotonic()-started
    if elapsed > seconds and reason is None: reason = 'whole-process wall budget (exit between polls)'
    if time.monotonic() > deadline: reason = 'whole-controller wall budget'
    if stdout_path.stat().st_size + stderr_path.stat().st_size > protocol['memory']['maximumOutputBytes']: reason = 'output budget'
    record.update(returncode=child.returncode, elapsedWallSeconds=elapsed,
        status='failed' if reason or child.returncode else 'complete', failure=reason,
        stdoutSha256=sha(stdout_path), stderrSha256=sha(stderr_path), hostAfter=host())
    try: record['verificationAfter'] = verify(manifest)
    except Exception as error: record.update(status='failed', failure=f'source/artifact verification: {error}')
    try:
        rows = [json.loads(x) for x in stdout_path.read_text().splitlines()]
        assert len([x for x in rows if x['kind'] == 'case']) == len(protocol['cases'])
        assert rows[-1]['kind'] == 'complete'
        record['completeReceipt'] = rows[-1]
    except Exception as error:
        rows = []; record.update(status='failed', failure=record['failure'] or f'incomplete output: {error}')
    return record, rows
def plan(protocol):
    slots = []
    for block in range(protocol['blocks']):
        for runtime in protocol['runtimeOrders'][block]:
            seen = {'baseline': 0, 'candidate': 0}
            for position, arm in enumerate(protocol['orders'][block]):
                slots.append({'id': f'{runtime}-b{block}-{position}-{arm}', 'runtime': runtime, 'block': block, 'position': position, 'arm': arm, 'replicate': seen[arm], 'status': 'pending'})
                seen[arm] += 1
    return slots
def median(xs):
    s = sorted(xs); n = len(s)
    return s[n//2] if n%2 else (s[n//2-1]+s[n//2])/2
def main():
    global DEADLINE_AT
    DEADLINE_AT = None
    parser = argparse.ArgumentParser(); parser.add_argument('mode', choices=['verify', 'untimed', 'run']); parser.add_argument('--output'); parser.add_argument('--approved-manifest-sha256')
    args = parser.parse_args(); started = time.monotonic()
    manifest = read(HERE/'manifest.json'); protocol = read(HERE/'protocol.json')
    deadline = started + protocol['budgets']['controllerWallSeconds']
    out = None
    if args.mode != 'verify':
        def interrupted(_signal, _frame): raise KeyboardInterrupt('Controller interrupted; owned child cleanup follows')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGALRM, controller_timeout)
        signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline-time.monotonic()))
    try:
        verify(manifest)
        if args.mode == 'verify': print(json.dumps({'verified': True, 'timingRun': False, 'manifestSha256': sha(HERE/'manifest.json')})); return
        assert args.output, '--output must name a NEW directory; failed slots are never overwritten'
        if args.mode == 'run':
            assert args.approved_manifest_sha256 == sha(HERE/'manifest.json'), 'Parent review of the exact frozen protocol is required'
            admission()
        target = pathlib.Path(args.output).resolve(); target.mkdir(parents=True, exist_ok=False)
        out = target
        ledger = {'manifestSha256': sha(HERE/'manifest.json'), 'mode': args.mode, 'hostBefore': host(), 'calibration': [], 'slots': [], 'status': 'running'}
        update(out/'ledger.json', ledger)
        def execute(slot, mode, work=None):
            if ledger.get('fatalOwnedProcess'): return {**slot, 'status': 'not-run', 'failure': 'owned process cleanup unresolved'}, []
            if time.monotonic() >= deadline: return {**slot, 'status': 'not-run', 'failure': 'controller wall budget'}, []
            slot['status'] = 'started'; update(out/'ledger.json', ledger)
            try: return launch(manifest, protocol, out, slot, mode, deadline, work)
            except Exception as error:
                if DEADLINE_AT is not None: raise ControllerDeadline('deadline during child cleanup') from error
                if isinstance(error, OwnedProcessRemains) or ACTIVE_CHILD is not None: ledger['fatalOwnedProcess'] = str(error)
                return {**slot, 'status': 'failed', 'failure': repr(error)}, []
        if args.mode == 'untimed':
            ledger['slots'] = [{'id': f'{r}-{a}-untimed', 'runtime': r, 'arm': a, 'status': 'pending'} for r in protocol['runtimes'] for a in ['baseline', 'candidate']]
            for i, slot in enumerate(ledger['slots']):
                ledger['slots'][i], _ = execute(slot, 'untimed'); update(out/'ledger.json', ledger)
                if ledger['slots'][i]['status'] != 'complete':
                    for pending in ledger['slots'][i+1:]:
                        pending.update(status='not-run', failure='original untimed subject failed; no later subjects or replacements')
                    update(out/'ledger.json', ledger)
                    break
        else:
            ledger['slots'] = plan(protocol)
            ledger['calibration'] = [{'id': f'{r}-{a}-calibration', 'runtime': r, 'arm': a, 'status': 'pending'} for r, arms in [('node', ['baseline', 'candidate']), ('bun', ['candidate', 'baseline'])] for a in arms]
            raw = {}
            for i, slot in enumerate(ledger['calibration']):
                receipt, rows = execute(slot, 'calibrate'); ledger['calibration'][i] = receipt
                raw[(slot['runtime'], slot['arm'])] = rows; update(out/'ledger.json', ledger)
            if all(s['status'] == 'complete' for s in ledger['calibration']):
                work = {}
                for runtime in protocol['runtimes']:
                    work[runtime] = {}
                    for spec in protocol['cases']:
                        values = {}
                        for arm in ['baseline', 'candidate']:
                            rows = next(x['rows'] for x in raw[(runtime, arm)] if x.get('case') == spec['id'] and x['kind'] == 'case')
                            values[arm] = {n: median([x['durationMs'] for x in rows if x['phase'] == 'calibration' and x['operations'] == n]) for n in spec['ladder']}
                        chosen = next((n for n in spec['ladder'] if all(values[a][n] >= protocol['calibration']['targetChunkMs'] for a in values)), None)
                        warmup = {arm: next(x for x in raw[(runtime, arm)] if x.get('case') == spec['id'] and x['kind'] == 'calibration-diagnostics') for arm in ['baseline', 'candidate']}
                        work[runtime][spec['id']] = {'operations': chosen or spec['ladder'][-1], 'targetMet': chosen is not None, 'calibrationMediansMs': values, 'calibrationWarmup': warmup, 'calibrationWarmupFlag': any(x['insufficientWarmup'] for x in warmup.values())}
                write_new(out/'work.json', work); ledger['workSha256'] = sha(out/'work.json'); update(out/'ledger.json', ledger)
                for i, slot in enumerate(ledger['slots']):
                    ledger['slots'][i], _ = execute(slot, 'measure', work[slot['runtime']]); update(out/'ledger.json', ledger)
            else:
                for slot in ledger['slots']: slot.update(status='not-run', failure='calibration failed; no substitute or rerun')
        final_verification = verify(manifest); elapsed = time.monotonic()-started
        complete = all(s['status'] == 'complete' for s in ledger['slots']) and elapsed <= protocol['budgets']['controllerWallSeconds']
        ledger.update(status='complete' if complete else 'incomplete', hostAfter=host(), elapsedWallSeconds=elapsed, verificationAfter=final_verification)
        update(out/'ledger.json', ledger); print(json.dumps({'status': ledger['status'], 'path': str(out/'ledger.json'), 'timingRun': args.mode == 'run'}))
        signal.setitimer(signal.ITIMER_REAL, 0)
        if ledger['status'] != 'complete': sys.exit(1)
    except ControllerDeadline:
        # If initial verification timed out, reserve only a NEW output directory.
        # A pre-existing destination must never be touched by this failure path.
        if out is None and args.output:
            target = pathlib.Path(args.output).resolve()
            try:
                target.mkdir(parents=True, exist_ok=False)
                out = target
            except FileExistsError:
                pass
        finish_timeout(out, protocol['budgets']['terminationGraceSeconds'])
        raise SystemExit(124)
    finally:
        if args.mode != 'verify': signal.setitimer(signal.ITIMER_REAL, 0)
if __name__ == '__main__': main()
