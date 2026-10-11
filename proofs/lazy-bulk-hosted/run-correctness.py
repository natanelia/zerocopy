"""Hosted eleven-command gate; scientific corpus and receipt checks are unchanged."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time

root = Path(__file__).resolve().parent
sha = lambda data: hashlib.sha256(data).hexdigest()
parser = argparse.ArgumentParser()
parser.add_argument('--seal-sha256', required=True)
parser.add_argument('--binding-sha256', required=True)
args = parser.parse_args()
seal_bytes = (root / 'PREPARED-SEAL.json').read_bytes()
assert sha(seal_bytes) == args.seal_sha256
seal = json.loads(seal_bytes)
assert seal['status'] == 'prepared-not-executed' and seal['commandCount'] == 11
assert sha((root / 'INPUT-PINS.json').read_bytes()) == seal['inputPinsSHA256']
release_bytes = (root / 'BINDING.json').read_bytes()
assert sha(release_bytes) == args.binding_sha256
release = json.loads(release_bytes)
assert release['kind'] == 'hosted-correctness-binding' and release['commandCount'] == 11
assert release['preparedSealSHA256'] == args.seal_sha256
execution = root / 'execution'
if execution.exists():
    raise FileExistsError('Execution already exists; no overwrite or retry.')
pins = json.loads((root / 'INPUT-PINS.json').read_text())
config = json.loads((root / 'COMMANDS.json').read_text())
expected = json.loads((root / 'EXPECTED.json').read_text())
assert config['status'] == 'prepared-not-executed' and len(config['commands']) == 11
assert config['wholeSecondsCap'] == 360 and config['cleanupAllowanceSeconds'] == 8
started = time.monotonic()

def verify_inputs():
    assert sha((root / 'PREPARED-SEAL.json').read_bytes()) == args.seal_sha256
    assert sha((root / 'BINDING.json').read_bytes()) == args.binding_sha256
    assert sha((root / 'INPUT-PINS.json').read_bytes()) == seal['inputPinsSHA256']
    for name in pins['directories']:
        path = Path(name)
        assert path.is_dir() and not path.is_symlink(), name
    for item in pins['symlinks']:
        path = Path(item['path'])
        assert path.is_symlink() and os.readlink(path) == item['target'], item['path']
        if item.get('targetExists'):
            assert path.exists(), item['path']
    for item in pins['files']:
        path = Path(item['path'])
        if item.get('regularFile'):
            assert path.is_file() and not path.is_symlink(), item['path']
        data = path.read_bytes()
        assert len(data) == item['bytes'] and sha(data) == item['sha256'], item['path']

verify_inputs()
execution.mkdir()
record = {'state': 'running', 'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'commands': [], 'signal': None, 'error': None, 'sealSHA256': args.seal_sha256,
          'bindingSHA256': args.binding_sha256, 'scope': 'Correctness only; clocks/RSS are safety limits.'}
current = None
reports = {}
output_audit_sha = None

def stop(number, _frame):
    if record['signal'] is None:
        record['signal'] = number
    record['state'] = 'failed'
    if current is not None and current.poll() is None:
        current.send_signal(number)
for number in [signal.SIGTERM, signal.SIGINT]:
    signal.signal(number, stop)

def verify_outputs():
    for path, digest in reports.items():
        assert sha(Path(path).read_bytes()) == digest, path
    path = execution / 'emitted-audit.json'
    if not path.exists():
        assert output_audit_sha is None
        return
    assert output_audit_sha is not None and sha(path.read_bytes()) == output_audit_sha
    audit = json.loads(path.read_text())
    assert audit['passed'] and audit['allFourWasmBytesUnchanged'] and len(audit['outputs']) == 106
    for item in audit['outputs']:
        data = Path(item['path']).read_bytes()
        assert len(data) == item['bytes'] and sha(data) == item['sha256'], item['path']

def check_log(command, path):
    lines, warning = [], False
    allowed = re.compile(r'^(?:# )?\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time\.$')
    for line in path.read_text().splitlines():
        if allowed.fullmatch(line):
            warning = True
        elif warning and line in ['(Use `node --trace-warnings ...` to show where the warning was created)', '# (Use `node --trace-warnings ...` to show where the warning was created)']:
            pass
        elif line:
            lines.append(line)
    kind = command['kind']
    if kind == 'build':
        assert len(lines) == 1 and re.fullmatch(r'Built 12 portable modules: \d+ bytes', lines[0])
    elif kind == 'declarations':
        assert lines == [], lines
    else:
        assert len(lines) == 1, (command['id'], lines)
        result = json.loads(lines[0]); assert result['passed'] is True
        if kind == 'smoke':
            assert result == {'schema': 1, 'kind': 'bulk-fixture-smoke', 'passed': True, 'groups': expected['groups'], 'metadataMutationRejections': 2}
        elif kind == 'corpus':
            assert set(result) == {'schema', 'kind', 'engine', 'passed', 'groups', 'workerCases', 'outputSHA256'}
            assert result['schema'] == 1 and result['kind'] == 'primitive-bulk-correctness'
            assert result['engine'] == command['engine'] and result['groups'] == expected['groups']
            assert result['workerCases'] == (2 if command['engine'] == 'node-portable' else 0)
            output = Path(command['output'])
            assert sha(output.read_bytes()) == result['outputSHA256']
            reports[str(output)] = result['outputSHA256']
        elif kind == 'audit':
            assert result['moduleCountPerArm'] == 12 and result['declarationsPerArm'] == 41
            assert result['allFourWasmBytesUnchanged'] and len(result['outputs']) == 106
        elif kind == 'reconcile':
            assert result['kind'] == 'primitive-bulk-reconciliation' and result['groups'] == expected['groups']
            assert result['withinEnginePersistentBytesAndAllocationEqual'] and result['crossEngineSemanticGroupsEqual']
            assert result['realNodeWorkerCasesPerArm'] == 2 and result['snapshotsPerWorker'] == 7
            output = execution / 'reconciliation.json'; reports[str(output)] = sha(output.read_bytes())
        else:
            raise ValueError(kind)
    return {'knownUNDICIEHPAWarning': warning}

try:
    for command in config['commands']:
        verify_inputs(); verify_outputs()
        remaining = config['wholeSecondsCap'] - (time.monotonic() - started) - config['cleanupAllowanceSeconds']
        if remaining <= 0 or record['signal'] is not None:
            raise RuntimeError('Window cap/signal before next command')
        log = execution / (command['id'] + '.log'); cap = min(remaining, command['secondsCap'])
        argv = [sys.executable, str(root / 'supervise.py'), '--cwd', command['cwd'], '--seconds', str(cap),
                '--rss-mib', str(command['rssMiBCap']), '--output', str(log), '--', *command['argv']]
        environment = os.environ.copy(); environment.update(command['environment'])
        print('START ' + command['id'], flush=True)
        with (execution / (command['id'] + '.supervisor.log')).open('xb') as stream:
            current = subprocess.Popen(argv, env=environment, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT)
            code = current.wait()
        current = None
        receipt = json.loads(Path(str(log) + '.receipt.json').read_text())
        item = {'id': command['id'], 'supervisorReturncode': code, 'receipt': receipt}; record['commands'].append(item)
        assert receipt['command'] == command['argv'] and receipt['cwd'] == command['cwd']
        assert receipt['secondsCap'] == cap and receipt['rssMiBCap'] == command['rssMiBCap']
        assert code == 0 and receipt['state'] == 'passed', command['id']
        assert receipt['limit'] is None and receipt['signal'] is None and receipt['error'] is None
        assert receipt['cleanup']['confirmedEmpty'] and not receipt['cleanup']['remainingBeforeCleanup']
        assert not receipt['cleanup']['remainingAfterCleanup'] and not receipt['cleanup']['errors']
        item['diagnostics'] = check_log(command, log)
        if command['kind'] == 'audit':
            output_audit_sha = sha((execution / 'emitted-audit.json').read_bytes())
            record['emittedAuditSHA256'] = output_audit_sha
    assert len(record['commands']) == 11
    verify_inputs(); verify_outputs()
    if time.monotonic() - started >= config['wholeSecondsCap'] or record['signal'] is not None:
        raise RuntimeError('Whole-window cap or signal during final reconciliation')
    record['state'] = 'passed'
    record['coverage'] = {'commonGroupsPerEngineArm': 5, 'engines': ['bun-source', 'node-portable'], 'realNodeWorkersPerArm': 2,
                          'snapshotsPerWorker': 7, 'declarationsIdentical': True, 'portableGraphAuthenticated': True}
except BaseException as error:
    record['state'] = 'failed'; record['error'] = repr(error)
finally:
    if current is not None and current.poll() is None:
        current.send_signal(signal.SIGTERM)
        try:
            current.wait(timeout=8)
        except subprocess.TimeoutExpired:
            record['state'] = 'failed'; record['error'] = (record['error'] or '') + '; supervisor did not stop after SIGTERM'
    record['endedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    record['elapsedSeconds'] = time.monotonic() - started
    if record['elapsedSeconds'] >= config['wholeSecondsCap'] or record['signal'] is not None:
        record['state'] = 'failed'; record['error'] = record['error'] or 'Whole-window cap/signal before finalization'
    with (execution / 'RESULT.json').open('x') as stream:
        json.dump(record, stream, indent=2); stream.write('\n')
print(json.dumps(record))
raise SystemExit(0 if record['state'] == 'passed' else 1)
