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
from analyze import analyze

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
assert sha((root / 'INPUT-PINS.json').read_bytes()) == seal['inputPinsSHA256']
assert len(schedule) == 256 and config['blocks'] == 4 and config['wholeSeconds'] == 600
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
    assert terminal['state'] == 'passed' and len(terminal['commands']) == 11
    assert terminal['sealSHA256'] == config['correctnessPreparedSealSHA256']
    assert all(c['receipt']['state'] == 'passed' and c['receipt']['cleanup']['confirmedEmpty'] for c in terminal['commands'])
    audit = json.loads((correctness_root / 'execution/emitted-audit.json').read_text())
    assert audit['passed'] and audit['sourceCommit'] == config['sourceCommit']
    assert audit['moduleCountPerArm'] == 12 and audit['declarationsPerArm'] == 41 and len(audit['outputs']) == 106
    assert audit['allFourWasmBytesUnchanged'] and audit['declarationsIdentical']
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
record = {'schema': 1, 'kind': 'lazy-bulk-timing-controller', 'state': 'running',
          'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'commands': [],
          'observations': [dict(x, status='not-run', reason='not-yet-reached') for x in schedule],
          'sealSHA256': args.seal_sha256, 'bindingSHA256': args.binding_sha256,
          'methodSHA256': config['methodSHA256'], 'signal': None, 'error': None,
          'finalInputsAuthenticated': False}
current = None
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


def command(identifier, request=None, pure=False):
    global current
    assert len(record['commands']) < 293
    remaining = config['wholeSeconds'] - (time.monotonic() - started) - config['cleanupSeconds']
    if remaining <= 0 or record['signal'] is not None:
        raise WindowCap('Whole window exhausted or controller interrupted')
    output = identifier + '.json'
    if pure:
        executable = config['executables']['node-portable']
        argv = [executable, str(root / 'bulk-timing.mjs'), '--pure', '-', str(execution / output)]
    else:
        write_json(identifier + '.request.json', request)
        executable = config['executables'][request['engine']]
        argv = [executable, str(root / 'bulk-timing.mjs'), '--request', str(execution / (identifier + '.request.json')), str(execution / output)]
    log = execution / (identifier + '.log')
    cap = min(config['childSeconds'], remaining)
    supervisor_argv = [sys.executable, str(root / 'supervise.py'), '--cwd', str(root), '--seconds', str(cap),
                       '--rss-mib', str(config['rssMiB']), '--output', str(log), '--', *argv]
    print('START ' + identifier, flush=True)
    with (execution / (identifier + '.supervisor.log')).open('xb') as stream:
        current = subprocess.Popen(supervisor_argv, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT)
        code = current.wait()
    current = None
    receipt = json.loads(Path(str(log) + '.receipt.json').read_text())
    item = {'id': identifier, 'supervisorReturncode': code, 'receipt': receipt}
    record['commands'].append(item)
    assert receipt['command'] == argv and receipt['cwd'] == str(root)
    assert receipt['secondsCap'] == cap and receipt['rssMiBCap'] == config['rssMiB']
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
    if receipt['limit'] is not None:
        assert receipt['limit'] in ['seconds', 'rss']
        return {'status': 'capped', 'reason': receipt['limit'], 'output': None, **retained}
    if code != 0 and request and request['mode'] == 'measure':
        observation = next(x for x in record['observations'] if x['id'] == identifier)
        observation.update(status='failed', reason='unexpected-subject-failure',
                           **{k: v for k, v in retained.items() if k != 'data'})
    assert code == 0 and receipt['state'] == 'passed'
    assert not cleanup['remainingBeforeCleanup'] and not cleanup['signals']
    allowed = re.compile(r'^\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time\.$')
    lines, warning = [], False
    for line in log.read_text().splitlines():
        if allowed.fullmatch(line):
            warning = True
        elif warning and line == '(Use `node --trace-warnings ...` to show where the warning was created)':
            pass
        elif line:
            lines.append(line)
    assert len(lines) == 1, (identifier, lines)
    message = json.loads(lines[0]); data = (execution / output).read_bytes(); result = json.loads(data)
    assert sha(data) == message['outputSHA256'] and result['status'] == message['status']
    assert result['schema'] == 1 and result['status'] in ['passed', 'short', 'budget-invalid']
    if not pure:
        for key in ['mode', 'engine', 'arm']:
            assert result[key] == request[key]
        assert result['endpoint'] == request.get('endpoint')
        assert result['admissions'] == len(result['ledger']) <= config['admissionsPerChild']
        assert result['sumConfiguredLinearMemoryMaxima'] == result['admissions'] * config['arenaMaximumBytes']
    outputs[str(execution / output)] = sha(data)
    item['output'] = output; item['outputSHA256'] = sha(data); item['knownUNDICIEHPAWarning'] = warning
    return {'status': result['status'], 'reason': result.get('error'), 'output': output,
            'outputSHA256': sha(data), 'outputBytes': len(data), 'data': result}


def request_for(engine, arm, mode, endpoint=None):
    subject_root = Path(config['correctnessPacket']) / arm
    subject = subject_root / ('shared.ts' if engine == 'bun-source' else 'dist/shared.js')
    return {'mode': mode, 'engine': engine, 'arm': arm, 'endpoint': endpoint, 'subject': str(subject)}


def allocation_fingerprint(raw):
    # Timing changes are allowed; native allocation/content/operation identity is not.
    ledger = [{k: v for k, v in e.items() if k != 'elapsedNs'} for e in raw['ledger']]
    return sha(json.dumps(ledger, sort_keys=True).encode())


def probe_fingerprint(raw, probe):
    admissions = set(probe['epochAdmissions'])
    ledger = [{k: v for k, v in e.items() if k not in ['elapsedNs', 'admission']}
              for e in raw['ledger'] if e['admission'] in admissions]
    assert len(ledger) == len(admissions) and all(e['completed'] for e in ledger)
    return sha(json.dumps({'calls': probe['calls'], 'checksum': probe['checksum'], 'ledger': ledger}, sort_keys=True).encode())


try:
    assert command('pure-fixture-smoke', pure=True)['status'] == 'passed'
    smokes = {}
    for engine in config['engines']:
        for arm in config['arms']:
            observation = command(f'smoke-{engine}-{arm}', request_for(engine, arm, 'smoke'))
            assert observation['status'] == 'passed', 'untimed smoke failed; timing remains unopened'
            smokes[engine, arm] = observation['data']
        assert allocation_fingerprint(smokes[engine, 'baseline']) == allocation_fingerprint(smokes[engine, 'candidate'])
    layouts = {}
    for engine in config['engines']:
        for endpoint in config['endpoints']:
            rows = [next(f for f in smokes[engine, arm]['fixtures'] if f['id'] == endpoint['id']) for arm in config['arms']]
            assert rows[0]['fixtureSHA256'] == rows[1]['fixtureSHA256']
            seed = max(x['seedBytes'] for x in rows); delta = max(x['maximumObservedWriteBytes'] for x in rows)
            limit = config['emptyCallCap'] if endpoint['mode'] == 'empty' else ((config['epochBudgetBytes'] - seed) // max(1, delta) // 256) * 256
            layouts[engine, endpoint['id']] = {'engine': engine, 'endpoint': endpoint['id'], 'epochWriteLimit': limit,
                                               'maximumObservedSeedBytes': seed, 'maximumObservedWriteBytes': delta,
                                               'status': 'eligible' if limit >= 256 else 'sizing-budget-invalid'}
    write_json('SIZING-LAYOUTS.json', list(layouts.values()))
    pilots = {}
    for index, endpoint in enumerate(config['endpoints']):
        for engine in config['engines'][::1 if index % 2 == 0 else -1]:
            layout = layouts[engine, endpoint['id']]
            for arm in config['arms'][::1 if index % 2 == 0 else -1]:
                if layout['status'] != 'eligible':
                    pilots[engine, endpoint['id'], arm] = {'status': 'not-run', 'reason': layout['status']}
                    continue
                req = request_for(engine, arm, 'calibrate', endpoint['id']); req['epochWriteLimit'] = layout['epochWriteLimit']
                pilots[engine, endpoint['id'], arm] = command(f'calibrate-{engine}-{endpoint["id"]}-{arm}', req)
    counts = {}
    for engine in config['engines']:
        for endpoint in config['endpoints']:
            pair = [pilots[engine, endpoint['id'], arm] for arm in config['arms']]
            plan = dict(layouts[engine, endpoint['id']]); plan['status'] = 'calibration-unresolved'
            plan['armStatuses'] = [x['status'] for x in pair]
            if all('data' in x for x in pair):
                by_count = [{probe['calls']: probe for probe in x['data'].get('probes', [])} for x in pair]
                for calls in sorted(by_count[0].keys() & by_count[1].keys()):
                    assert probe_fingerprint(pair[0]['data'], by_count[0][calls]) == probe_fingerprint(pair[1]['data'], by_count[1][calls]), 'matching-count calibration allocation/content disagreement'
            if all(x['status'] == 'passed' for x in pair):
                rates = []
                for x in pair:
                    raw = x['data']; probe = raw['probes'][raw['selectedProbe']]
                    assert probe['elapsedNs'] >= config['probeTargetNs']
                    rates.append(probe['elapsedNs'] / probe['calls'])
                fastest = min(rates)
                warmup = math.ceil(config['warmupTargetNs'] / fastest / 256) * 256
                measured = math.ceil(config['measurementTargetNs'] / fastest / 256) * 256
                limit = plan['epochWriteLimit']
                warm_epochs, measured_epochs = math.ceil(warmup / limit), math.ceil(measured / limit)
                plan.update(warmupCalls=warmup, measurementCalls=measured, warmupEpochs=warm_epochs,
                            measurementEpochs=measured_epochs, pilotNsPerCall=rates)
                if warm_epochs <= 2 and measured_epochs <= 8 and warm_epochs + measured_epochs <= 10 and (endpoint['mode'] != 'empty' or max(warmup, measured) <= config['emptyCallCap']):
                    plan['status'] = 'eligible'
                else:
                    plan['status'] = 'calibration-count-cap'
            counts[engine, endpoint['id']] = plan
    write_json('COUNTS.json', list(counts.values()))
    record['countsSHA256'] = outputs[str(execution / 'COUNTS.json')]
    blocked, fingerprints = {}, {}
    for item in record['observations']:
        key = item['engine'], item['endpoint']; plan = counts[key]
        if plan['status'] != 'eligible' or key in blocked:
            item['reason'] = blocked.get(key, plan['status']); continue
        req = request_for(item['engine'], item['arm'], 'measure', item['endpoint'])
        req.update({name: plan[name] for name in ['epochWriteLimit', 'warmupCalls', 'measurementCalls']})
        response = command(item['id'], req)
        item.update(status=response['status'], reason=response['reason'], output=response['output'])
        if response['output']:
            item.update(outputSHA256=response['outputSHA256'], outputBytes=response['outputBytes'])
        if response['status'] in ['budget-invalid', 'capped']:
            blocked[key] = 'previous-cell-budget-or-runtime-cap'
        else:
            fp = allocation_fingerprint(response['data'])
            if key in fingerprints:
                assert fingerprints[key] == fp, 'native allocation or content differs across repeated arms'
            fingerprints[key] = fp
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
        analysis = analyze(config, record['observations'], execution,
                           gate_usable=record['finalInputsAuthenticated'] and record['state'] == 'completed')
        analysis['controllerStateBeforeFinalization'] = record['state']
        analysis['finalInputsAuthenticated'] = record['finalInputsAuthenticated']
    except BaseException as error:
        record['state'] = 'failed'; record['analysisError'] = repr(error)
        analysis = analyze(config, record['observations'], execution, gate_usable=False)
    record['endedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    record['elapsedSeconds'] = time.monotonic() - started
    if record['elapsedSeconds'] >= config['wholeSeconds'] or record['signal'] is not None:
        record['state'] = 'capped' if record['signal'] is None else 'failed'
    if record['state'] != 'completed':
        analysis = analyze(config, record['observations'], execution, gate_usable=False)
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
            analysis = analyze(config, record['observations'], execution, gate_usable=False)
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
