"""One hosted screen; all subjects use the unchanged bounded supervisor."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import sys
import time
import copy

root = Path(__file__).resolve().parent
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda name: json.loads((root / name).read_text())
parser = argparse.ArgumentParser()
parser.add_argument('--seal-sha256', required=True)
parser.add_argument('--binding-sha256', required=True)
args = parser.parse_args()
started = time.monotonic()
assert sha((root / 'PREPARED-SEAL.json').read_bytes()) == args.seal_sha256
seal = read('PREPARED-SEAL.json')
assert seal['status'] == 'prepared-not-executed'
assert sha((root / 'BINDING.json').read_bytes()) == args.binding_sha256
release = read('BINDING.json')
assert release['kind'] == 'hosted-timing-binding' and release['preparedSealSHA256'] == args.seal_sha256
pins, config, schedule = read('INPUT-PINS.json'), read('CONFIG.json'), read('SCHEDULE.json')
warm_endpoints = [e for e in config['endpoints'] if e['mode'] != 'cold']
assert sha((root / 'INPUT-PINS.json').read_bytes()) == seal['inputPinsSHA256']
assert len(schedule) == 192 and config['blocks'] == 4 and config['wholeSeconds'] == 900
assert config['operationCap'] == 2**27 and config['primitiveMeasurementOperationCap'] == 2**29
execution = root / 'execution'
if execution.exists():
    raise FileExistsError('One run only; existing execution may not be replaced.')

correctness_root = Path(config['correctnessPacket'])
correctness_binding = release['currentSourceCorrectness']
assert correctness_binding['sourceCommit'] == config['sourceCommit']
assert correctness_binding['preparedSealSHA256'] == config['correctnessPreparedSealSHA256']
assert Path(correctness_binding['outputSealPath']) == correctness_root / 'RESULTS-SEAL.json'


def verify_correctness_outputs():
    assert sha((correctness_root / 'PREPARED-SEAL.json').read_bytes()) == config['correctnessPreparedSealSHA256']
    data = (correctness_root / 'RESULTS-SEAL.json').read_bytes()
    assert sha(data) == correctness_binding['outputSealSHA256']
    output_seal = json.loads(data)
    assert output_seal['state'] == 'passed' and output_seal['sourceCommit'] == config['sourceCommit']
    assert output_seal['preparedSealSHA256'] == config['correctnessPreparedSealSHA256']
    sealed = {item['path']: item for item in output_seal['files']}
    assert len(sealed) == len(output_seal['files']) == output_seal['fileCount']
    for item in output_seal['files']:
        path = Path(item['path'])
        assert not path.is_absolute() and '..' not in path.parts
        contents = (correctness_root / path).read_bytes()
        assert len(contents) == item['bytes'] and sha(contents) == item['sha256']
    terminal = json.loads((correctness_root / 'execution/RESULT.json').read_text())
    assert terminal['state'] == 'passed' and len(terminal['commands']) == 14
    assert terminal['sealSHA256'] == config['correctnessPreparedSealSHA256']
    assert all(c['receipt']['state'] == 'passed' and c['receipt']['cleanup']['confirmedEmpty'] for c in terminal['commands'])
    audit = json.loads((correctness_root / 'execution/emitted-audit.json').read_text())
    assert audit['passed'] and audit['sourceCommit'] == config['sourceCommit']
    assert audit['moduleCountPerArm'] == 12 and audit['declarationsPerArm'] == 41 and len(audit['outputs']) == 106
    assert audit['allFourWasmBytesUnchanged'] and audit['declarationsIdentical']
    assert audit['moduleNamesImportsAndInitializationOrderIdentical'] and audit['internalRegistryUnchanged'] and audit['codecDeclarationAndLookupOnly']
    for item in audit['outputs']:
        relative = str(Path(item['path']).relative_to(correctness_root))
        assert sealed[relative]['sha256'] == item['sha256'] and sealed[relative]['bytes'] == item['bytes']
    for arm in config['arms']:
        assert (correctness_root / arm / 'dist/shared.js').is_file()


def verify_inputs():
    assert sha((root / 'PREPARED-SEAL.json').read_bytes()) == args.seal_sha256
    assert sha((root / 'BINDING.json').read_bytes()) == args.binding_sha256
    for name in pins['directories']:
        p = Path(name); assert p.is_dir() and not p.is_symlink(), name
    for item in pins['symlinks']:
        p = Path(item['path']); assert p.is_symlink() and os.readlink(p) == item['target'], item['path']
        if item.get('targetExists'):
            assert p.exists(), item['path']
    for item in pins['files']:
        p = Path(item['path']); data = p.read_bytes()
        assert len(data) == item['bytes'] and sha(data) == item['sha256'], item['path']
        if item.get('regularFile'):
            assert p.is_file() and not p.is_symlink(), item['path']
    verify_correctness_outputs()


verify_inputs()
execution.mkdir()
record = {'schema': 1, 'kind': 'redux-classifier-timing-controller', 'state': 'running',
          'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'commands': [],
          'observations': [dict(x, status='not-run', reason='not-yet-reached') for x in schedule],
          'sealSHA256': args.seal_sha256, 'bindingSHA256': args.binding_sha256,
          'methodSHA256': config['methodSHA256'], 'signal': None, 'error': None,
          'finalInputsAuthenticated': False}
current = None
active_observation = None
outputs = {}
terminal_committed = False


def stop(number, _frame):
    if terminal_committed:
        return
    record['signal'] = number
    if current is not None and current.poll() is None:
        current.send_signal(number)


for number in [signal.SIGTERM, signal.SIGINT]:
    signal.signal(number, stop)


class WindowCap(Exception):
    pass


def write_json(name, value):
    p = execution / name
    with p.open('x') as stream:
        json.dump(value, stream, indent=2); stream.write('\n')
    outputs[str(p)] = sha(p.read_bytes())


def measurement_cap(endpoint):
    return config['primitiveMeasurementOperationCap'] if endpoint['mode'] == 'primitive' else config['operationCap']


def command(identifier, request, analysis=False):
    global current, active_observation
    assert len(record['commands']) < config['maximumChildren']
    verify_inputs()
    remaining = config['wholeSeconds'] - (time.monotonic() - started) - config['cleanupSeconds']
    if remaining <= 0 or record['signal'] is not None:
        raise WindowCap('Whole window exhausted or controller interrupted')
    if not analysis and request['mode'] == 'measure':
        endpoint = next(e for e in config['endpoints'] if e['id'] == request['endpoint'])
        assert request['measurementOperationCap'] == measurement_cap(endpoint)
        assert type(request['measurementCalls']) is int and 0 < request['measurementCalls'] <= measurement_cap(endpoint)
        assert request['measurementCalls'] % config['countQuantum'] == 0
    output = 'ANALYSIS-RAW.json' if analysis else identifier + '.json'
    write_json(identifier + '.request.json', request)
    if analysis:
        argv = [sys.executable, str(root / 'analyze.py'), '--request', str(execution / (identifier + '.request.json')), '--output', str(execution / output)]
    else:
        executable = config['executables'][request['engine']]
        argv = [executable, str(root / 'redux-timing.mjs'), '--request', str(execution / (identifier + '.request.json')), str(execution / output)]
    log = execution / (identifier + '.log')
    cap = min(config['analysisSeconds'] if analysis else config['calibrationSeconds'] if request['mode'] == 'calibrate' else config['childSeconds'], remaining)
    rss = 512 if analysis else config['rssMiB']
    supervisor_argv = [sys.executable, str(root / 'supervise.py'), '--cwd', str(root), '--seconds', str(cap),
                       '--rss-mib', str(rss), '--output', str(log), '--', *argv]
    print('START ' + identifier, flush=True)
    with (execution / (identifier + '.supervisor.log')).open('xb') as stream:
        current = subprocess.Popen(supervisor_argv, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT)
        if not analysis and request['mode'] in ['measure', 'cold']:
            active_observation = next(x for x in record['observations'] if x['id'] == identifier)
            active_observation.update(status='running', reason='launched', output=output)
        if record['signal'] is not None:
            current.send_signal(record['signal'])
        code = current.wait()
    current = None
    receipt = json.loads(Path(str(log) + '.receipt.json').read_text())
    item = {'id': identifier, 'supervisorReturncode': code, 'receipt': receipt}
    record['commands'].append(item)
    assert receipt['command'] == argv and receipt['cwd'] == str(root)
    assert receipt['secondsCap'] == cap and receipt['rssMiBCap'] == rss
    cleanup = receipt['cleanup']
    assert cleanup and cleanup['confirmedEmpty'] and not cleanup['remainingAfterCleanup'] and not cleanup['errors'], 'uncertain cleanup'
    assert receipt['error'] is None and receipt['signal'] is None and record['signal'] is None
    retained = {}
    if (execution / output).exists():
        raw_bytes = (execution / output).read_bytes()
        outputs[str(execution / output)] = sha(raw_bytes)
        retained = {'output': output, 'outputSHA256': sha(raw_bytes), 'outputBytes': len(raw_bytes)}
        item.update(retained)
        try:
            retained['data'] = json.loads(raw_bytes)
        except (ValueError, UnicodeDecodeError):
            item['rawOutputParseFailed'] = True
    allowed = re.compile(r'^\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time\.$')
    lines, warning = [], False
    for line in log.read_text().splitlines():
        if allowed.fullmatch(line):
            warning = True
        elif warning and line == '(Use `node --trace-warnings ...` to show where the warning was created)':
            pass
        elif line:
            lines.append(line)
    item['knownUNDICIEHPAWarning'] = warning
    if receipt['limit'] is not None:
        assert receipt['limit'] in ['seconds', 'rss']
        assert receipt['returncode'] is not None and receipt['returncode'] <= 0, 'failure alongside cap'
        assert len(lines) <= 1, (identifier, lines)
        if lines:
            message = json.loads(lines[0])
            assert message['status'] in ['passed', 'short', 'budget-invalid', 'failed']
            assert 'data' in retained, 'terminal message without readable output'
            assert message['outputSHA256'] == retained['outputSHA256'] and message['status'] == retained['data']['status']
        if 'data' in retained:
            validate_result(retained['data'], request, analysis, partial=True)
        return {'status': 'capped', 'reason': receipt['limit'], 'output': None, **retained}
    assert code == 0 and receipt['state'] == 'passed'
    assert not cleanup['remainingBeforeCleanup'] and not cleanup['signals']
    assert len(lines) == 1, (identifier, lines)
    message = json.loads(lines[0]); data = (execution / output).read_bytes(); result = json.loads(data)
    assert sha(data) == message['outputSHA256'] and result['status'] == message['status']
    validate_result(result, request, analysis)
    outputs[str(execution / output)] = sha(data)
    item['output'] = output; item['outputSHA256'] = sha(data)
    return {'status': result['status'], 'reason': result.get('error'), 'output': output,
            'outputSHA256': sha(data), 'outputBytes': len(data), 'data': result}


def validate_result(result, request, analysis, partial=False):
    assert result['schema'] == 1 and result['status'] in (['running'] if partial else []) + ['passed', 'short', 'budget-invalid']
    if analysis:
        assert result['kind'] == 'redux-classifier-timing-analysis' and result['status'] == 'passed'
    else:
        assert result['kind'] == 'redux-classifier-timing-observation'
        for key in ['mode', 'engine', 'arm']:
            assert result[key] == request[key]
        assert result['endpoint'] == request.get('endpoint')
        endpoint = next((e for e in config['endpoints'] if e['id'] == request.get('endpoint')), None)
        phase_cap = measurement_cap(endpoint) if request['mode'] == 'measure' else config['operationCap']
        assert result['cumulativeCallsScope'] == 'phase-loop operations only'
        assert result['measurementOperationCap'] == request.get('measurementOperationCap')
        if request['mode'] == 'measure':
            assert request['measurementOperationCap'] == phase_cap
        else:
            assert 'measurementOperationCap' not in request
        limit = config['smokeAdmissions'] if request['mode'] == 'smoke' else endpoint['admissions']
        assert result['admissions'] == len(result['ledger']) <= limit
        assert result['sumConfiguredLinearMemoryMaxima'] == result['admissions'] * config['arenaMaximumBytes']
        if result['status'] in ['passed', 'short']:
            assert result['admissions'] == limit and all(x['completed'] for x in result['ledger'])
            assert len(result['fixtures']) == (5 if request['mode'] == 'smoke' else 0 if request['mode'] == 'cold' else 1)
        for phase in result['phases']:
            assert type(phase['calls']) is int and 0 < phase['calls'] <= phase_cap
            if request['mode'] == 'measure':
                assert phase['kind'] in ['measurement-warmup', 'measurement']
                expected_calls = request['measurementCalls'] // config['measurementWarmupDivisor'] if phase['kind'] == 'measurement-warmup' else request['measurementCalls']
                assert phase['calls'] == expected_calls
            if result['status'] in ['passed', 'short']:
                assert phase['completed'] and phase['validated']
            if phase.get('completed'):
                assert phase['completedCalls'] == phase['calls']
                if request['mode'] != 'cold':
                    fixture = next(x for x in result['fixtures'] if x['endpoint'] == phase['endpoint'])
                    assert phase['checksum'] == (phase['calls'] * fixture['unit']) % (2**32)
                else:
                    assert phase['kind'] == 'cold-import' and phase['calls'] == 1
            if request['mode'] != 'smoke' and result['status'] == 'passed':
                assert math.isfinite(phase['elapsedNs']) and phase['elapsedNs'] > 0
        if request['mode'] != 'cold':
            assert result['cumulativeCalls'] == sum(p['calls'] for p in result['phases'] if p.get('completed'))
        if request['mode'] == 'calibrate':
            assert result['cumulativeCalls'] <= config['calibrationCumulativeCap']


def request_for(engine, arm, mode, endpoint=None):
    subject_root = Path(config['correctnessPacket']) / arm
    subject = subject_root / ('redux-public-entry.mjs' if mode == 'cold' else 'classifier-public-consumer.mjs')
    request = {'mode': mode, 'engine': engine, 'arm': arm, 'endpoint': endpoint, 'subject': str(subject)}
    if mode == 'measure':
        request['measurementOperationCap'] = measurement_cap(next(e for e in config['endpoints'] if e['id'] == endpoint))
    return request


def fixture_fingerprint(fixture):
    return fixture['semanticSHA256']


def invalidate(analysis, reason):
    result = copy.deepcopy(analysis)
    result['qualifyingInferenceSuppressed'] = reason
    result['samePrimaryQualifiesInBothEngines'] = []
    result['regressionsBlockingPromotion'] = []
    result['coldDiagnosticsBlockingAdvancement'] = []
    for cell in result.get('cells', []):
        cell['inference'] = None; cell['status'] = 'unresolved'; cell['reason'] = reason
    result['unresolvedCells'] = [{'engine': x['engine'], 'endpoint': x['endpoint']} for x in result.get('cells', [])]
    result['outcome'] = 'controller-not-complete-and-authenticated'
    result['automaticPublicationAuthorized'] = False
    return result


try:
    smokes, fixture_pins = {}, {}
    for engine in config['engines']:
        for arm in config['arms']:
            observation = command(f'smoke-{engine}-{arm}', request_for(engine, arm, 'smoke'))
            assert observation['status'] == 'passed', 'untimed smoke failed; timing remains unopened'
            smokes[engine, arm] = observation['data']
            assert [x['endpoint'] for x in observation['data']['fixtures']] == [e['id'] for e in warm_endpoints]
        for endpoint in warm_endpoints:
            rows = [next(f for f in smokes[engine, arm]['fixtures'] if f['endpoint'] == endpoint['id']) for arm in config['arms']]
            assert fixture_fingerprint(rows[0]) == fixture_fingerprint(rows[1])
            fixture_pins[engine, endpoint['id']] = fixture_fingerprint(rows[0])
    pilots = {}
    for index, endpoint in enumerate(warm_endpoints):
        for engine in config['engines'][::1 if index % 2 == 0 else -1]:
            for arm in config['arms'][::1 if index % 2 == 0 else -1]:
                req = request_for(engine, arm, 'calibrate', endpoint['id'])
                observation = command(f'calibrate-{engine}-{endpoint["id"]}-{arm}', req)
                if 'data' in observation and observation['data'].get('fixtures') and observation['data']['fixtures'][0].get('completed'):
                    assert fixture_fingerprint(observation['data']['fixtures'][0]) == fixture_pins[engine, endpoint['id']]
                pilots[engine, endpoint['id'], arm] = observation
    counts = {}
    for engine in config['engines']:
        for endpoint in warm_endpoints:
            pair = [pilots[engine, endpoint['id'], arm] for arm in config['arms']]
            plan = {'engine': engine, 'endpoint': endpoint['id'], 'status': 'calibration-unresolved',
                    'armStatuses': [x['status'] for x in pair], 'measurementOperationCap': measurement_cap(endpoint)}
            if all(x['status'] == 'passed' for x in pair):
                rates = []
                for x in pair:
                    raw = x['data']; warm = raw['calibrationWarmup']; rows = raw['pilots']
                    assert warm['batches'] >= config['warmCalibrationMinimumBatches'] and warm['elapsedNs'] >= config['warmCalibrationMinimumNs']
                    assert len(rows) == config['pilotBatches'] and rows == raw['phases'][-3:]
                    assert all(row['elapsedNs'] >= config['pilotMinimumNs'] and row['validated'] for row in rows)
                    assert raw['cumulativeCalls'] <= config['calibrationCumulativeCap']
                    rates.extend(row['elapsedNs'] / row['calls'] for row in rows)
                measured = math.ceil(config['measurementTargetNs'] / min(rates) / config['countQuantum']) * config['countQuantum']
                plan.update(measurementCalls=measured, pilotNsPerCall=rates)
                plan['status'] = 'eligible' if measured <= plan['measurementOperationCap'] else 'calibration-count-cap'
            counts[engine, endpoint['id']] = plan
    write_json('COUNTS.json', list(counts.values()))
    record['countsSHA256'] = outputs[str(execution / 'COUNTS.json')]
    blocked = {}
    for item in record['observations']:
        key = item['engine'], item['endpoint']
        cold = item['endpoint'] == 'public-entry-import'
        plan = {'status': 'eligible'} if cold else counts[key]
        if plan['status'] != 'eligible' or key in blocked:
            item['reason'] = blocked.get(key, plan['status']); continue
        req = request_for(item['engine'], item['arm'], 'cold' if cold else 'measure', item['endpoint'])
        if not cold:
            req['measurementCalls'] = plan['measurementCalls']
        response = command(item['id'], req)
        item.update(status=response['status'], reason=response['reason'], output=response['output'])
        if response['output']:
            item.update(outputSHA256=response['outputSHA256'], outputBytes=response['outputBytes'])
        if not cold and 'data' in response and response['data'].get('fixtures') and response['data']['fixtures'][0].get('completed'):
            assert fixture_fingerprint(response['data']['fixtures'][0]) == fixture_pins[key]
        if response['status'] in ['short', 'budget-invalid', 'capped']:
            blocked[key] = 'previous-cell-short-or-cap'
        active_observation = None
    verify_inputs()
    for path, digest in outputs.items():
        assert sha(Path(path).read_bytes()) == digest, path
    record['finalInputsAuthenticated'] = True
    record['state'] = 'completed'
except WindowCap as error:
    record['state'] = 'capped'; record['error'] = str(error)
except BaseException as error:
    record['state'] = 'failed'; record['error'] = repr(error)
finally:
    if current is not None and current.poll() is None:
        current.send_signal(signal.SIGTERM)
        try:
            current.wait(timeout=8)
        except subprocess.TimeoutExpired:
            record['state'] = 'failed'; record['error'] = (record['error'] or '') + '; supervisor did not terminate'
    if active_observation is not None:
        active_observation.update(status='failed', reason='diagnostic-invalid', error=record['error'])
        path = execution / active_observation['output']
        if path.exists():
            raw_bytes = path.read_bytes()
            outputs[str(path)] = sha(raw_bytes)
            active_observation.update(outputSHA256=sha(raw_bytes), outputBytes=len(raw_bytes))
    for observation in record['observations']:
        if observation['reason'] == 'not-yet-reached':
            observation['reason'] = 'controller-' + record['state']
    analysis = None
    try:
        if not record['finalInputsAuthenticated']:
            verify_inputs()
            for path, digest in outputs.items():
                assert sha(Path(path).read_bytes()) == digest, path
            record['finalInputsAuthenticated'] = True
        response = command('analyze-retained', {'config': config, 'observations': record['observations'],
            'directory': str(execution), 'gateUsable': record['finalInputsAuthenticated'] and record['state'] == 'completed'}, analysis=True)
        assert response['status'] == 'passed'
        analysis = response['data']
        verify_inputs()
        for path, digest in outputs.items():
            assert sha(Path(path).read_bytes()) == digest, path
        analysis['controllerStateBeforeFinalization'] = record['state']
        analysis['finalInputsAuthenticated'] = record['finalInputsAuthenticated']
    except BaseException as error:
        record['state'] = 'failed'; record['analysisError'] = repr(error)
        analysis = {'schema': 1, 'kind': 'redux-classifier-timing-analysis', 'cells': [],
            'retainedObservationSlots': record['observations'], 'rawAnalysisUnavailable': True,
            'automaticPublicationAuthorized': False}
        analysis = invalidate(analysis, 'bounded-analysis-or-final-authentication-failed')
    record['endedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    record['elapsedSeconds'] = time.monotonic() - started
    if record['elapsedSeconds'] >= config['wholeSeconds'] or record['signal'] is not None:
        record['state'] = 'capped' if record['signal'] is None else 'failed'
    if record['state'] != 'completed':
        analysis = invalidate(analysis, 'controller-not-complete-and-authenticated')
    analysis['controllerStateBeforePublication'] = record['state']
    analysis['finalInputsAuthenticated'] = record['finalInputsAuthenticated']
    # No subjects remain. Block terminal signals only across publication, then
    # inspect pending signals/deadline after both files have reached the filesystem.
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, [signal.SIGTERM, signal.SIGINT])
    try:
        write_json('ANALYSIS.json', analysis)
        record['analysisSHA256'] = outputs[str(execution / 'ANALYSIS.json')]
        write_json('RESULT.json', record)
        pending = sorted(set(signal.sigpending()) & {signal.SIGTERM, signal.SIGINT})
        expired = time.monotonic() - started >= config['wholeSeconds']
        if record['state'] == 'completed' and (pending or record['signal'] is not None or expired):
            for name in ['ANALYSIS.json', 'RESULT.json']:
                original = execution / name; provisional = execution / ('PROVISIONAL-' + name)
                assert not provisional.exists()
                original.rename(provisional)
                outputs[str(provisional)] = outputs.pop(str(original))
            record['state'] = 'failed' if pending or record['signal'] is not None else 'capped'
            record['signal'] = int(pending[0]) if pending else record['signal']
            record['analysisInvalidatedByFinalStatus'] = True
            record['endedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            record['elapsedSeconds'] = time.monotonic() - started
            analysis = invalidate(analysis, 'controller-not-complete-and-authenticated')
            analysis['controllerStateBeforePublication'] = record['state']
            analysis['finalInputsAuthenticated'] = record['finalInputsAuthenticated']
            write_json('ANALYSIS.json', analysis)
            record['analysisSHA256'] = outputs[str(execution / 'ANALYSIS.json')]
            write_json('RESULT.json', record)
        terminal_committed = True
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
print(json.dumps({'state': record['state'], 'commands': len(record['commands']), 'resultSHA256': outputs[str(execution / 'RESULT.json')]}))
raise SystemExit(0 if record['state'] == 'completed' else 1)
