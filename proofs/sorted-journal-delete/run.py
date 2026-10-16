"""Exact-source correctness admission and one fixed hosted latency/allocation screen on Linux."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import statistics
import subprocess
import sys
import time

BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
CASES = ['P', 'S16', 'R1', 'N4', 'G1', 'B0', 'C0', 'M0', 'L4', 'X4', 'I4']
METHOD_SHA256 = '55126790039ff81803285a73841adb59a458d3edac28fe6bbaa088f46741caf4'
PRODUCTION_PINS = {
    'persistent-core.as.ts': {'baseline': 'baa5d5a7682af2738a216566d3a8b61ee8f298e3abb61e34eb597d3ae277f976',
                              'candidate': '1012b2736937497abc7f69ecf5cc6483c5b58de9f4a497a4f20a179022d06669'},
}
FOCUSED_TEST = 'sorted-journal-delete.test.ts'
FOCUSED_SHA256 = 'b2bb9c9a3e54457fc09024a087ca52bc1e1da400950536fbebd234ba276866bb'
WORKER_PROOF = 'proofs/sorted-journal-delete-worker.mjs'
WORKER_SHA256 = 'c77b32c4508ed9bf180d91b07083ce511110885fa08a8203fb494c946e13be37'
ENTRIES = {'node': ['dist/shared.js'], 'bun': ['shared.ts']}
STUDY_PAYLOAD_BYTES = 128 * 1024 ** 3
CHILD_PAYLOAD_BYTES = 8 * 1024 ** 3
INITIAL_RESERVATION_BYTES = 112 * 1024 ** 2
ORDERS = ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB']
SCIENCE_SECONDS = 2400
CHILD_SECONDS = 90
SCIENCE_RSS = 2 * 1024 ** 3
ADMISSION_SECONDS = 1620
ADMISSION_RSS = 4 * 1024 ** 3
POLL_SECONDS = .05

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()

def read(path): return json.loads(Path(path).read_text())
def write(path, value): Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
def command(argv, cwd, deadline, supervisor):
    remaining = deadline - time.monotonic()
    assert remaining > 2, 'Admission deadline before metadata command and cleanup'
    label = 'metadata-' + str(len(supervisor.receipts) + 1)
    supervisor.run(label, argv, cwd, deadline, min(10, remaining), ADMISSION_RSS)
    return (supervisor.output / (label + '.stdout')).read_text().strip()

def tree(root, excluded=()):
    result = {}
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(name for name in folders if name not in excluded)
        for name in sorted(files + [name for name in folders if (Path(directory) / name).is_symlink()]):
            path = Path(directory) / name
            relative = str(path.relative_to(root))
            result[relative] = {'link': os.readlink(path)} if path.is_symlink() else {'sha256': sha(path)}
    return result

def group_members(group):
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group: continue
            match = re.search(r'^VmRSS:\s+(\d+) kB$', (path / 'status').read_text(), re.M)
            rows.append({'pid': int(path.name), 'rss': int(match[1]) * 1024 if match else 0, 'state': fields[0]})
        except (FileNotFoundError, ProcessLookupError): pass
    return rows

class Supervisor:
    def __init__(self, output, labels=()):
        self.output = output
        self.labels = sorted(labels, key=lambda pair: -len(pair[0]))
        self.receipts = []
        self.interrupted = None
        self.active = None
        for number in [signal.SIGINT, signal.SIGTERM]: signal.signal(number, self.on_signal)

    def on_signal(self, number, _frame): self.interrupted = number

    def display(self, text):
        for path, label in self.labels: text = text.replace(path, label)
        return text

    def run(self, label, argv, cwd, deadline, wall, rss_limit, ready=False, environment=None):
        assert not self.interrupted and time.monotonic() < deadline, 'deadline or interruption before launch'
        receipt = {'label': label, 'argv': [self.display(x) for x in argv], 'cwd': self.display(str(cwd)), 'startedUnix': time.time(),
                   'wallSeconds': wall, 'sampledGroupRssLimitBytes': rss_limit, 'sampleIntervalSeconds': POLL_SECONDS,
                   'peakObservedGroupRssBytes': 0, 'cleanupSignals': [], 'spawnToReadyNs': None, 'environmentOverrides': environment or {}}
        self.receipts.append(receipt)
        write(self.output / 'commands.json', self.receipts)
        out_path = self.output / (label + '.stdout')
        err_path = self.output / (label + '.stderr')
        start = time.monotonic()
        # Reserve two seconds for cleanup inside both the child and whole-study caps.
        stop = min(start + wall, deadline) - 2
        child = None
        failure = None
        try:
            with out_path.open('xb') as out, err_path.open('xb') as err:
                child = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=err, start_new_session=True, env={**os.environ, **(environment or {})})
                self.active = child
                receipt['ownedProcessGroup'] = child.pid
                while True:
                    if ready and receipt['spawnToReadyNs'] is None:
                        lines = out_path.read_text().splitlines()
                        if lines:
                            try: event = json.loads(lines[0])
                            except json.JSONDecodeError: event = {}
                            if event.get('event') == 'ready': receipt['spawnToReadyNs'] = (time.monotonic() - start) * 1e9
                    rows = group_members(child.pid)
                    sampled = sum(row['rss'] for row in rows)
                    receipt['peakObservedGroupRssBytes'] = max(receipt['peakObservedGroupRssBytes'], sampled)
                    if sampled > rss_limit: failure = 'sampled group RSS ceiling'
                    if self.interrupted: failure = 'interrupted'
                    if time.monotonic() >= stop: failure = failure or 'wall cap'
                    if failure: break
                    if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT): break
                    time.sleep(POLL_SECONDS)
        except BaseException as error:
            failure = self.display(repr(error))
        finally:
            if child is not None:
                # Never reap the leader before checking descendants: retain ownership.
                leftover = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                receipt['descendantsBeforeCleanup'] = leftover
                exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if failure or leftover or not exited:
                    failure = failure or 'unexpected surviving descendants'
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    receipt['cleanupSignals'].append('SIGKILL original group')
                cleanup_stop = min(deadline, start + wall, time.monotonic() + 2)
                while time.monotonic() < cleanup_stop:
                    exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    descendants = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                    if exited and not descendants: break
                    time.sleep(.01)
                receipt['descendantsAfterCleanup'] = [row for row in group_members(child.pid) if row['pid'] != child.pid]
                pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                if pid:
                    child.returncode = os.waitstatus_to_exitcode(status)
                    receipt['exitCode'] = child.returncode
                else: failure = failure or 'leader not reaped by cleanup deadline'
                receipt['leaderReaped'] = bool(pid)
                if receipt['descendantsAfterCleanup']: failure = failure or 'descendants remain'
                self.active = None
            receipt.update({'endedUnix': time.time(), 'elapsedSecondsForSafety': time.monotonic() - start, 'failure': failure})
            for path in [out_path, err_path]:
                if path.exists(): receipt[path.suffix[1:]] = {'file': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size}
            write(self.output / 'commands.json', self.receipts)
        assert not failure and receipt.get('exitCode') == 0 and not self.interrupted, f'No retry after failure: {label}: {failure}'
        return receipt

def events(output, label, remaining):
    rows = [json.loads(line) for line in (output / (label + '.stdout')).read_text().splitlines()]
    assert rows[0]['event'] == 'ready'
    assert all(row.get('event') == 'ledger' for row in rows[1:-1])
    result = rows[-1]
    assert result['event'] == 'result' and result['status'] == 'complete'
    assert list(result['cases']) == CASES
    assert result['ledger'] == rows[1:-1]
    total = 0
    for row in result['ledger']:
        added = row['addedPayloadBytes']
        assert isinstance(added, int) and added >= 0
        total += added
        assert row['cumulativePayloadBytes'] == total
        assert total <= CHILD_PAYLOAD_BYTES and total <= remaining
    assert total == result['cumulativePayloadBytes']
    return result


def built_artifacts(root):
    expected = {'persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm', 'linked-list.wasm', 'singly-linked-list.wasm',
                'doubly-linked-list.wasm', 'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm',
                'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'}
    wasm = {path.name: sha(path) for path in root.glob('*.wasm')}
    assert set(wasm) == expected and (root / 'geometry-kernels.wat').is_file()
    for name in wasm:
        assert (root / name).read_bytes()[:8] == b'\x00asm\x01\x00\x00\x00'
        if name not in {'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'}:
            assert wasm[name] == wasm['persistent-core.wasm']
    chunks = {str(path.relative_to(root)): sha(path) for path in (root / 'dist').rglob('*') if path.is_file()}
    assert all('dist/' + name in chunks for name in ['shared.js', 'worker.js', 'state.js', 'redux.js', 'tanstack-db-collection.js', 'numeric.js', 'geometry.js'])
    js = {name: (root / name).read_text() for name in chunks if name.endswith('.js')}
    assert 7 <= len(js) <= 32
    embedded = {}
    for name in ['persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm']:
        token = base64.b64encode((root / name).read_bytes()).decode('ascii')
        found = [chunk for chunk, text in js.items() if token in text]
        assert found, 'Fresh native bytes missing from portable output: ' + name
        embedded[name] = {'sha256': wasm[name], 'chunks': sorted(found)}
    return {**wasm, 'geometry-kernels.wat': sha(root / 'geometry-kernels.wat'), **chunks}, embedded

def interval(ratios):
    assert len(ratios) == 6 and all(type(x) in (int, float) and math.isfinite(x) and x > 0 for x in ratios)
    logs = list(map(math.log, ratios))
    center = statistics.mean(logs)
    half = 2.570582 * statistics.stdev(logs) / math.sqrt(6)
    return {'ratios': ratios, 'ratio': math.exp(center), 'lower': math.exp(center - half), 'upper': math.exp(center + half)}


def analyze(records, calibrations):
    # Admission, process completion, allocation ledgers and source identity are
    # controller gates. This pure analysis independently checks the fixed cells.
    caps = dict(zip(CASES, [16384, 32768, 32768, 16384, 1048576, 16384, 65536, 1048576, 16384, 16384, 256]))
    envelopes = dict(zip(CASES, [4096, 2048, 2048, 4096, 64, 4096, 1024, 0, 4096, 4096, 4096]))
    assert len(records) == 36 and set(calibrations) == {'node', 'bun'}
    expected = {(engine, block, arm) for engine in ['node', 'bun'] for block in range(1, 7) for arm in 'ABC'}
    assert {(r['engine'], r['block'], r['arm']) for r in records} == expected
    assert len({(r['engine'], r['block'], r['arm']) for r in records}) == len(records)

    def finite(value):
        return type(value) in (int, float) and math.isfinite(value)

    def timer_status(timer):
        readings = timer['readingsMs']
        assert len(readings) == 4096 and type(timer['precheckPassed']) is bool
        assert isinstance(timer['positiveDeltasMs'], list)
        valid = all(finite(value) for value in readings)
        ordered = valid and all(b >= a for a, b in zip(readings, readings[1:]))
        deltas = [b - a for a, b in zip(readings, readings[1:]) if finite(a) and finite(b) and b > a]
        quantum = min(deltas) if deltas else None
        consistent = (timer['positiveDeltasMs'] == deltas and timer['quantumMs'] == quantum)
        eligible = bool(ordered and quantum is not None and finite(quantum) and quantum > 0 and consistent and timer['precheckPassed'])
        return {'eligible': eligible, 'quantumMs': quantum, 'reportedQuantumMs': timer['quantumMs'],
                'reasons': ([] if eligible else ['timer precheck, positive quantum, or retained readings unresolved'])}

    def batch_status(batch, case, phase, ordinal, count, timer):
        assert batch['phase'] == phase and type(batch['ordinal']) is int and batch['ordinal'] == ordinal
        assert type(batch['count']) is int and batch['count'] == count and 1 <= count <= caps[case]
        assert batch['validation'] == 'passed' and type(batch['timerEligible']) is bool
        assert type(batch['arenaId']) in (str, int) and batch['arenaId'] != ''
        for key in ['startUsed', 'endUsed', 'startCapacity', 'endCapacity']:
            assert type(batch[key]) is int and batch[key] >= 65536
        assert batch['startUsed'] <= batch['endUsed'] <= batch['endCapacity']
        assert batch['startUsed'] <= batch['startCapacity'] <= batch['endCapacity']
        growth = batch['endUsed'] - batch['startUsed']
        assert type(batch['allocationBytes']) is int and batch['allocationBytes'] == growth
        assert batch['startUsed'] <= 8 * 1024 ** 2
        assert batch['endCapacity'] <= 128 * 1024 ** 2
        assert growth <= envelopes[case] * count, 'native allocation envelope exceeded'
        assert isinstance(batch['sinks'], dict)
        duration = batch['elapsedNs']
        elapsed_ms = batch['elapsedMs']
        if finite(duration) and finite(elapsed_ms):
            assert duration == elapsed_ms * 1e6
        valid_duration = finite(duration) and duration > 0 and finite(elapsed_ms) and elapsed_ms > 0
        observed_eligible = bool(valid_duration and timer['eligible'] and timer['quantumMs'] <= .005 * elapsed_ms)
        eligible = observed_eligible and batch['timerEligible']
        return {'nsPerOp': duration / count if valid_duration else None,
                'nativeBytesPerUnit': growth / count, 'growthBytes': growth, 'timerEligible': eligible,
                'timerReasons': [] if eligible else ['batch timer eligibility unresolved'], 'raw': batch}

    calibration_summary = {}
    for engine in ['node', 'bun']:
        child = calibrations[engine]
        assert child['status'] == 'complete' and child['mode'] == 'calibrate' and child['engine'] == engine
        assert set(child['cases']) == set(CASES)
        timer = timer_status(child['timer'])
        cases, arena_ids = {}, set()
        for case in CASES:
            cell = child['cases'][case]
            assert cell['id'] == case and type(cell['accepted']) is bool
            trials = cell['trials']
            assert 1 <= len(trials) <= 4
            count, summaries = (4 if case == 'I4' else 256), []
            for index, trial in enumerate(trials):
                assert type(trial['trial']) is int and trial['trial'] == index + 1
                assert type(trial['count']) is int and trial['count'] == count
                assert type(trial['accepted']) is bool
                assert len(trial['warmup']) == 5 and len(trial['pilots']) == 3
                pilots = []
                for phase, batches in [('warmup', trial['warmup']), ('pilot', trial['pilots'])]:
                    for ordinal, batch in enumerate(batches, 1):
                        status = batch_status(batch, case, phase, ordinal, count, timer)
                        assert batch['arenaId'] not in arena_ids, 'batch arena reused'
                        arena_ids.add(batch['arenaId'])
                        if phase == 'pilot':
                            assert status['nsPerOp'] is not None, 'invalid pilot duration blocks the study'
                            pilots.append(status)
                median_ms = statistics.median(batch['elapsedMs'] for batch in trial['pilots'])
                assert trial['medianMs'] == median_ms
                accepted = 20 <= median_ms <= 50
                assert trial['accepted'] == accepted
                summaries.append({'trial': index + 1, 'count': count, 'medianMs': median_ms, 'accepted': accepted,
                                  'pilotTimerEligible': [pilot['timerEligible'] for pilot in pilots]})
                next_count = max(1, min(caps[case], math.floor(count * 30 / median_ms + .5)))
                stopped = accepted or next_count == count or index == 3
                assert (index == len(trials) - 1) == stopped, 'calibration stopped or continued outside fixed rule'
                if index < len(trials) - 1: count = next_count
            assert type(cell['count']) is int and cell['count'] == count
            assert cell['accepted'] == summaries[-1]['accepted']
            cases[case] = {'count': count, 'accepted': cell['accepted'], 'trials': summaries,
                           'timerEligible': all(summaries[-1]['pilotTimerEligible'])}
        calibration_summary[engine] = {'timer': timer, 'cases': cases}

    cells = {}
    for record in records:
        engine, block, arm = record['engine'], record['block'], record['arm']
        child = record['result']
        assert child['status'] == 'complete' and child['mode'] == 'measure' and child['engine'] == engine
        assert set(child['cases']) == set(CASES)
        timer, arena_ids = timer_status(child['timer']), set()
        for case in CASES:
            cell = child['cases'][case]
            count = calibration_summary[engine]['cases'][case]['count']
            assert cell['id'] == case and type(cell['count']) is int and cell['count'] == count
            assert len(cell['warmup']) == 5 and len(cell['measured']) == 9
            batches = {}
            for phase, expected_length in [('warmup', 5), ('measured', 9)]:
                assert len(cell[phase]) == expected_length
                batches[phase] = []
                for ordinal, batch in enumerate(cell[phase], 1):
                    status = batch_status(batch, case, phase, ordinal, count, timer)
                    assert batch['arenaId'] not in arena_ids, 'batch arena reused'
                    arena_ids.add(batch['arenaId'])
                    batches[phase].append(status)
            xs = [batch['nsPerOp'] for batch in batches['measured']]
            valid = all(x is not None for x in xs)
            mean = statistics.mean(xs) if valid else None
            cv = statistics.stdev(xs) / mean if valid else None
            drift = statistics.mean(xs[-3:]) / statistics.mean(xs[:3]) if valid else None
            reasons = []
            if not valid: reasons.append('invalid duration')
            if any(finite(batch['elapsedNs']) and batch['elapsedNs'] < 10e6 for batch in cell['measured']): reasons.append('batch below 10 ms')
            if cv is not None and cv > .25: reasons.append('batch CV above 25%')
            if drift is not None and (drift < .85 or drift > 1.15): reasons.append('batch drift outside 0.85–1.15')
            cells[engine, block, arm, case] = {'nsPerOp': mean, 'cv': cv, 'drift': drift, 'reasons': reasons,
                                             'timerEligible': all(batch['timerEligible'] for batch in batches['measured']),
                                             'timer': timer, 'batches': batches}

    engines, unresolved_controls, unresolved_timing, regressions, timing_slowdowns = {}, [], [], [], []
    latency_blockers, allocation_unresolved, allocation_increases, allocation_primary_failures = [], [], [], []
    for engine in ['node', 'bun']:
        rows = {}
        for case in CASES:
            blocks, allocation_batches, row_allocation_unresolved, row_allocation_increases = [], [], [], []
            primary_met = True
            for index, order in enumerate(ORDERS):
                block = index + 1
                group = {arm: cells[engine, block, arm, case] for arm in 'ABC'}
                values = {arm: {key: group[arm][key] for key in ['nsPerOp', 'cv', 'drift', 'reasons', 'timerEligible', 'timer']} for arm in 'ABC'}
                later, earlier = ('A', 'B') if order.index('A') > order.index('B') else ('B', 'A')
                def ratio(a, b):
                    return values[a]['nsPerOp'] / values[b]['nsPerOp'] if values[a]['nsPerOp'] is not None and values[b]['nsPerOp'] is not None else None
                blocks.append({'block': block, 'order': order, 'values': values,
                               'paired': ratio('C', 'B'), 'aa': ratio('A', 'B'), 'chronologicalBaseline': ratio(later, earlier)})
                for phase, length in [('warmup', 5), ('measured', 9)]:
                    for offset in range(length):
                        matched = {arm: group[arm]['batches'][phase][offset] for arm in 'ABC'}
                        b, a, c = (matched[arm] for arm in 'BAC')
                        assert len({value['raw']['count'] for value in matched.values()}) == 1
                        label = f'{engine}:{case}:block{block}:{phase}{offset + 1}'
                        equal_baselines = (b['raw']['startUsed'] == a['raw']['startUsed'] and
                                           b['raw']['endUsed'] == a['raw']['endUsed'] and b['growthBytes'] == a['growthBytes'])
                        reasons = []
                        if not equal_baselines: reasons.append('B/A fresh-fixture frontiers or growth disagree')
                        if case == 'P' and (b['growthBytes'] <= 0 or a['growthBytes'] <= 0): reasons.append('primary baseline growth is not positive')
                        if reasons: row_allocation_unresolved.append({'receipt': label, 'reasons': reasons})
                        # Equal integer counts allow an exact cross-multiplied
                        # 10% boundary, without a floating per-unit comparison.
                        meets_primary = (b['growthBytes'] > 0 and a['growthBytes'] > 0 and
                                         10 * c['growthBytes'] <= 9 * b['growthBytes'] and 10 * c['growthBytes'] <= 9 * a['growthBytes'])
                        if case == 'P' and not meets_primary: primary_met = False
                        increase = case != 'P' and (c['growthBytes'] > b['growthBytes'] or c['growthBytes'] > a['growthBytes'])
                        if increase: row_allocation_increases.append(label)
                        if case == 'M0': assert all(value['growthBytes'] == 0 for value in matched.values()), 'M0 must allocate zero bytes'
                        allocation_batches.append({'block': block, 'phase': phase, 'ordinal': offset + 1,
                                                  'arms': matched, 'baselinesMatch': equal_baselines,
                                                  'primaryTenPercentMet': meets_primary if case == 'P' else None,
                                                  'controlIncrease': increase, 'unresolvedReasons': reasons})
            row = {}
            for name, key in [('candidate', 'paired'), ('aa', 'aa'), ('chronologicalBaseline', 'chronologicalBaseline')]:
                ratios = [block[key] for block in blocks]
                row[name] = interval(ratios) if all(x is not None for x in ratios) else {'ratios': ratios, 'ratio': None, 'lower': None, 'upper': None, 'unresolved': 'invalid duration'}
            calibration = calibration_summary[engine]['cases'][case]
            row.update({'blocks': blocks, 'calibration': calibration, 'calibrationResolved': calibration['accepted'],
                        'qualityResolved': all(not value['reasons'] for block in blocks for value in block['values'].values()),
                        'clockResolved': calibration['timerEligible'] and all(value['timerEligible'] for block in blocks for value in block['values'].values()),
                        'absoluteNsPerOp': {arm: [block['values'][arm]['nsPerOp'] for block in blocks] for arm in 'ABC'},
                        'unit': 'complete transaction' if case in ['X4', 'I4'] else 'public delete'})
            row['bias'] = any(row[name]['lower'] is not None and (row[name]['lower'] > 1.05 or row[name]['upper'] < .95) for name in ['aa', 'chronologicalBaseline'])
            row['aaResolved'] = not row['bias'] and all(row[name]['lower'] is not None for name in ['aa', 'chronologicalBaseline'])
            reasons = []
            if not row['calibrationResolved']: reasons.append('uncalibrated frozen count')
            if not row['qualityResolved']: reasons.append('measurement quality unresolved')
            if not row['clockResolved']: reasons.append('calibration or measurement timer eligibility unresolved')
            if not row['aaResolved']: reasons.append('major A/A bias' if row['bias'] else 'A/A interval unresolved')
            if row['candidate']['upper'] is None: reasons.append('candidate interval unresolved')
            elif row['candidate']['upper'] > 1.02: reasons.append('candidate upper bound above 1.02')
            row['unresolvedReasons'] = reasons
            label = engine + ':' + case
            if reasons:
                unresolved_timing.append(label)
                if case != 'P': unresolved_controls.append(label)
            # Calibration, clock and quality flags never suppress an adverse
            # estimate that remains calculable from the original durations.
            if row['candidate']['lower'] is not None and row['candidate']['lower'] > 1.02:
                timing_slowdowns.append(label)
                if case != 'P': regressions.append(label)
            allocation_unresolved.extend(row_allocation_unresolved)
            allocation_increases.extend(row_allocation_increases)
            if case == 'P' and not primary_met: allocation_primary_failures.append(label)
            row['allocation'] = {'matchedBatches': allocation_batches, 'unresolved': row_allocation_unresolved,
                                 'controlIncreases': row_allocation_increases,
                                 'primaryTenPercentMet': primary_met if case == 'P' else None}
            rows[case] = row
        primary = rows['P']
        if not (primary['candidate']['ratio'] is not None and primary['candidate']['ratio'] <= .95 and primary['candidate']['upper'] <= .95): latency_blockers.append(engine + ': P does not meet 5% criterion')
        if not primary['calibrationResolved']: latency_blockers.append(engine + ': P calibration unresolved')
        if not primary['qualityResolved']: latency_blockers.append(engine + ': P quality unresolved')
        if not primary['clockResolved']: latency_blockers.append(engine + ': P clock eligibility unresolved')
        if primary['bias'] or rows['M0']['bias']: latency_blockers.append(engine + ': P/M0 major A/A bias')
        engines[engine] = rows
    latency_lead = not latency_blockers and not regressions
    allocation_criteria = not allocation_unresolved and not allocation_increases and not allocation_primary_failures
    allocation_lead = allocation_criteria and not timing_slowdowns
    latency_verdict = ('parked: control timing regression' if regressions else 'no qualified hosted latency lead' if latency_blockers else
                       'promising hosted sorted pending-delete latency lead')
    allocation_verdict = ('failed: control native-allocation increase' if allocation_increases else
                          'unresolved: unmatched native-allocation evidence' if allocation_unresolved else
                          'no qualified hosted native-allocation lead' if allocation_primary_failures else
                          'parked: confident timing slowdown' if timing_slowdowns else
                          'promising hosted sorted pending-delete native-allocation lead')
    return {'engines': engines, 'calibrations': calibration_summary,
            'latency': {'lead': latency_lead, 'verdict': latency_verdict, 'blockers': latency_blockers,
                        'regressions': regressions, 'unresolvedControls': unresolved_controls},
            'nativeAllocation': {'lead': allocation_lead, 'verdict': allocation_verdict, 'deterministicCriteriaMet': allocation_criteria,
                                 'unresolved': allocation_unresolved, 'controlIncreases': allocation_increases,
                                 'primaryCriterionFailures': allocation_primary_failures, 'timingSlowdowns': timing_slowdowns,
                                 'unresolvedTimingRows': unresolved_timing, 'confidenceInterval': None},
            'verdict': latency_verdict + '; ' + allocation_verdict,
            'promotionReady': False,
            'limitations': ['six process blocks per engine; batches are not independent replicates',
                           'paired Student-t intervals assume approximately normal independent process log-ratios; small n and shared host limit inference',
                           'unadjusted warning controls do not establish simultaneous absence of regressions',
                           'prepared hot-key operation latency excludes fixture preparation, validation and explicit GC',
                           'native append-only payload differences do not establish retained heap, backing capacity, RSS or application-wide savings',
                           'named unresolved evidence and browser/platform/contributor checks remain before promotion']}

def runtime_pins(node, bun, deadline, supervisor):
    versions = {'node': command([node, '--version'], Path.cwd(), deadline, supervisor), 'bun': command([bun, '--version'], Path.cwd(), deadline, supervisor), 'python': sys.version}
    assert versions['node'] == 'v22.16.0' and versions['bun'] == '1.4.2'
    return {name: {'path': path, 'sha256': sha(path), 'version': versions[name]} for name, path in [('node', node), ('bun', bun), ('python', str(Path(sys.executable).resolve()))]}

def main():
    candidate, baseline, output = map(lambda p: Path(p).resolve(), sys.argv[1:])
    proof = candidate / 'proofs/sorted-journal-delete'
    output.mkdir(parents=True, exist_ok=False)
    node, bun = (str(Path(shutil.which(name)).resolve()) for name in ['node', 'bun'])
    supervisor = Supervisor(output, [(str(candidate), '$CANDIDATE'), (str(baseline), '$BASELINE'), (str(output), '$EVIDENCE'), (node, '$NODE'), (bun, '$BUN')])
    status = {'status': 'preparing', 'performanceClaim': False, 'studyChildrenStarted': 0, 'cumulativePayloadBytes': 0}
    write(output / 'status.json', status)
    started = time.monotonic()
    admission_deadline = started + ADMISSION_SECONDS
    science_start = None
    phase = 'admission'
    def whole_alarm(number, _frame):
        if supervisor.active is not None: supervisor.interrupted = number
        else: raise TimeoutError(phase + ' whole wall cap; cleanup reserve')
    signal.signal(signal.SIGALRM, whole_alarm)
    signal.setitimer(signal.ITIMER_REAL, ADMISSION_SECONDS - 2)
    try:
        assert os.environ['GITHUB_REPOSITORY'] == 'natanelia/zerocopy'
        assert candidate == Path(os.environ['GITHUB_WORKSPACE']).resolve()
        assert baseline == (Path(os.environ['RUNNER_TEMP']) / 'sorted-journal-delete-baseline').resolve()
        assert output == (Path(os.environ['RUNNER_TEMP']) / 'sorted-journal-delete-evidence').resolve()
        assert os.environ['GITHUB_RUN_ATTEMPT'] == '1'
        assert os.environ['GITHUB_REF'] == 'refs/heads/proof/sorted-journal-delete-budget-screen-20261016'
        assert not os.environ.get('NODE_OPTIONS') and not os.environ.get('BUN_OPTIONS'), 'Unexpected runtime flags'
        assert command(['git', 'rev-parse', 'HEAD'], baseline, admission_deadline, supervisor) == BASE
        commit = command(['git', 'rev-parse', 'HEAD'], candidate, admission_deadline, supervisor)
        assert commit == os.environ['GITHUB_SHA']
        assert command(['git', 'rev-parse', 'HEAD^'], candidate, admission_deadline, supervisor) == BASE
        base_files = read(proof / 'baseline-sources.json')
        overlay = read(proof / 'source-pins.json')
        assert len(base_files) == 502
        changed = set(command(['git', 'diff', '--name-only', BASE, 'HEAD'], candidate, admission_deadline, supervisor).splitlines())
        assert changed == set(overlay) | {'proofs/sorted-journal-delete/source-pins.json'}
        for relative, digest in base_files.items():
            assert sha(baseline / relative) == digest, relative
            assert sha(candidate / relative) == overlay.get(relative, digest), relative
        for relative, digest in overlay.items(): assert sha(candidate / relative) == digest, relative
        assert sha(proof / 'METHOD.md') == METHOD_SHA256
        assert {relative for relative, digest in base_files.items() if overlay.get(relative, digest) != digest} == set(PRODUCTION_PINS)
        for relative, pins in PRODUCTION_PINS.items():
            assert base_files[relative] == sha(baseline / relative) == pins['baseline'], relative
            assert overlay[relative] == sha(candidate / relative) == pins['candidate'], relative
        assert sha(candidate / FOCUSED_TEST) == FOCUSED_SHA256
        assert sha(candidate / WORKER_PROOF) == WORKER_SHA256
        # Identical added tests accompany the ordinary complete admissions.
        for name in [FOCUSED_TEST, WORKER_PROOF]: shutil.copyfile(candidate / name, baseline / name)
        dependencies = proof / 'dependencies/node_modules'
        assert dependencies.is_dir(), 'Missing pre-provisioned locked dependencies'
        for root in [baseline, candidate]:
            assert (root / 'node_modules').is_symlink() and (root / 'node_modules').resolve() == dependencies
            assert not list(root.glob('*.wasm')) and not list(root.glob('*.wat')) and not (root / 'dist').exists(), 'Native and portable outputs must be fresh'
        tracked = [relative for relative in command(['git', 'ls-files', '-z'], candidate, admission_deadline, supervisor).split('\0') if relative]
        source_pins = {arm: {relative: sha(root / relative) for relative in (list(base_files) + [FOCUSED_TEST, WORKER_PROOF] if arm == 'baseline' else tracked)} for arm, root in [('baseline', baseline), ('candidate', candidate)]}
        dep_pins = tree(dependencies, excluded=('.vite', '.vite-temp', '.cache'))
        executables = runtime_pins(node, bun, admission_deadline, supervisor)
        write(output / 'admission-inputs.json', {'sourceFiles': source_pins, 'dependencies': dep_pins,
              'executables': {name: {'command': name, 'sha256': record['sha256'], 'version': record['version']} for name, record in executables.items()},
              'dependencyLockSha256': sha(proof / 'dependencies/package-lock.json')})
        commands = []
        for arm, root in [('baseline', baseline), ('candidate', candidate)]:
            commands.extend([(arm + '-prepublishOnly', [bun, 'run', 'prepublishOnly'], root, 600, {'ZEROCOPY_SORTED_DELETE_ARM': arm}),
                             (arm + '-node-worker', [node, 'proofs/node-worker.mjs'], root, 90, {}),
                             (arm + '-typed-json-worker', [node, 'proofs/typed-json-worker.mjs'], root, 90, {})])
        write(output / 'admission-plan.json', [{'label': label, 'argv': [supervisor.display(x) for x in argv], 'cwd': supervisor.display(str(cwd)), 'wallSeconds': wall, 'environmentOverrides': env} for label, argv, cwd, wall, env in commands])
        for label, argv, cwd, wall, env in commands:
            supervisor.run(label, argv, cwd, admission_deadline, wall, ADMISSION_RSS, environment=env)
            if label.endswith('prepublishOnly'):
                log = (output / (label + '.stdout')).read_text() + (output / (label + '.stderr')).read_text()
                for name, count in [(FOCUSED_TEST, 20), ('shared-sorted.test.ts', 8), ('performance-revision.test.ts', 21), ('allocation-failure.test.ts', 32)]:
                    assert re.search(re.escape(name) + r'[^\n]*\(' + str(count) + r' tests?\)', log), f'Focused suite not observed: {name}'
                allocation = re.findall(r'SORTED_DELETE_ALLOCATION (\{[^\r\n]*\})', log)
                assert len(allocation) == 1
                observed = json.loads(allocation[0])
                assert observed == {'arm': env['ZEROCOPY_SORTED_DELETE_ARM'], 'allocatedBytes': 0 if env['ZEROCOPY_SORTED_DELETE_ARM'] == 'candidate' else 24}
        artifacts, portable_bindings = {}, {}
        for arm, root in [('baseline', baseline), ('candidate', candidate)]: artifacts[arm], portable_bindings[arm] = built_artifacts(root)
        for name in ['numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm', 'geometry-kernels.wat']:
            assert artifacts['baseline'][name] == artifacts['candidate'][name]
        manifest = {'baselineCommit': BASE, 'candidateCommit': commit, 'candidateTree': command(['git', 'rev-parse', 'HEAD^{tree}'], candidate, admission_deadline, supervisor),
                    'diagnosticsProvenance': 'Original public hosted diagnostics; verified ephemeral public checkout, dependency and toolchain paths may appear in raw logs.',
                    'sourceFiles': source_pins, 'artifacts': artifacts, 'portableNativeBindings': portable_bindings,
                    'executables': {name: {'command': name, 'sha256': record['sha256'], 'version': record['version']} for name, record in executables.items()}, 'dependencies': dep_pins,
                    'lockSha256': sha(proof / 'dependencies/package-lock.json'), 'methodSha256': sha(proof / 'METHOD.md'),
                    'buildFlagsSourceSha256': sha(candidate / 'scripts/build-wasm.mjs'), 'portableBuildSourceSha256': sha(candidate / 'scripts/build-browser.ts'),
                    'entries': ENTRIES,
                    'host': {'os': os.uname().sysname, 'release': os.uname().release, 'architecture': os.uname().machine,
                             'cpuCount': os.cpu_count(), 'cpuModel': next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), 'unavailable')},
                    'run': {name: os.environ[name] for name in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA']},
                    'flags': {'node': ['--expose-gc'], 'bun': []}, 'admissionSeconds': time.monotonic() - started,
                    'limits': {'wholeStudySeconds': SCIENCE_SECONDS, 'perChildSeconds': CHILD_SECONDS, 'sampledGroupRssBytes': SCIENCE_RSS, 'rssSampleSeconds': POLL_SECONDS, 'maximumChildren': 38,
                               'cumulativePayloadBytesPerChild': CHILD_PAYLOAD_BYTES, 'cumulativePayloadBytesWholeStudy': STUDY_PAYLOAD_BYTES, 'initialReservationBytes': INITIAL_RESERVATION_BYTES},
                    'cacheAllowance': 'node_modules/.vite, .vite-temp and .cache may change; excluded from dependency pins'}
        def verify():
            for arm, root in [('baseline', baseline), ('candidate', candidate)]:
                for relative, digest in {**source_pins[arm], **artifacts[arm]}.items(): assert sha(root / relative) == digest, (arm, relative)
            for record in executables.values(): assert sha(record['path']) == record['sha256']
            assert tree(dependencies, excluded=('.vite', '.vite-temp', '.cache')) == dep_pins
        verify()
        write(output / 'manifest.json', manifest)
        frozen_manifest_sha = sha(output / 'manifest.json')
        write(output / 'manifest-seal.json', {'sha256': frozen_manifest_sha})
        assert time.monotonic() < admission_deadline and not supervisor.interrupted
        science_start = time.monotonic()
        deadline = science_start + SCIENCE_SECONDS
        phase = 'science'
        signal.setitimer(signal.ITIMER_REAL, SCIENCE_SECONDS - 2)
        status.update({'status': 'calibrating', 'admission': 'passed', 'manifestSha256': frozen_manifest_sha})
        write(output / 'status.json', status)
        calibrations, counts_files, records, ledger = {}, {}, [], []
        driver = str(proof / 'subject.mjs')
        def run_subject(engine, label, root, mode, counts):
            remaining = STUDY_PAYLOAD_BYTES - status['cumulativePayloadBytes']
            assert remaining >= INITIAL_RESERVATION_BYTES, 'Study payload allowance cannot admit the next child'
            assert status['studyChildrenStarted'] < 38
            status['studyChildrenStarted'] += 1
            write(output / 'status.json', status)
            argv = ([node, '--expose-gc'] if engine == 'node' else [bun]) + [driver, 'child', str(root / ENTRIES[engine][0]), mode, str(counts), str(remaining)]
            try:
                receipt = supervisor.run(label, argv, root, deadline, CHILD_SECONDS, SCIENCE_RSS, True)
                result = events(output, label, remaining)
                assert result['engine'] == engine and result['mode'] == mode
            except BaseException:
                # A stopped child may have allocated after its last emitted boundary.
                # Preserve reported completed work without claiming a final total.
                reported, boundaries, accounting_error = 0, 0, None
                try:
                    path = output / (label + '.stdout')
                    for line in path.read_text().splitlines() if path.exists() else []:
                        try: row = json.loads(line)
                        except json.JSONDecodeError: break
                        if row.get('event') != 'ledger': continue
                        added = row['addedPayloadBytes']
                        assert isinstance(added, int) and added >= 0
                        assert row['cumulativePayloadBytes'] == reported + added
                        assert reported + added <= min(CHILD_PAYLOAD_BYTES, remaining)
                        reported += added; boundaries += 1
                except BaseException as error: accounting_error = supervisor.display(repr(error))
                status['cumulativePayloadBytes'] += reported
                status['cumulativeAccountingComplete'] = False
                status['cumulativePayloadBytesMeaning'] = 'lower bound from completed reported boundaries; stopped child may have unreported work'
                ledger.append({'child': label, 'status': 'incomplete', 'reservedInitializationBytes': INITIAL_RESERVATION_BYTES,
                               'availableBeforeChildBytes': remaining, 'reportedPayloadBytes': reported,
                               'reportedBoundaries': boundaries, 'studyReportedPayloadBytes': status['cumulativePayloadBytes'],
                               'accountingComplete': False, 'accountingError': accounting_error})
                write(output / 'allocation-ledger.json', ledger)
                write(output / 'status.json', status)
                raise
            status['cumulativePayloadBytes'] += result['cumulativePayloadBytes']
            assert status['cumulativePayloadBytes'] <= STUDY_PAYLOAD_BYTES
            ledger.append({'child': label, 'reservedInitializationBytes': INITIAL_RESERVATION_BYTES, 'availableBeforeChildBytes': remaining,
                           'actualPayloadBytes': result['cumulativePayloadBytes'], 'studyCumulativePayloadBytes': status['cumulativePayloadBytes']})
            write(output / 'allocation-ledger.json', ledger)
            write(output / 'status.json', status)
            return receipt, result
        for engine in ['node', 'bun']:
            _, calibrations[engine] = run_subject(engine, engine + '-calibration', baseline, 'calibrate', '-')
            counts_files[engine] = output / (engine + '-counts.json')
            write(counts_files[engine], {id: calibrations[engine]['cases'][id]['count'] for id in CASES})
            write(output / 'calibrations.json', calibrations)
        count_pins = {engine: sha(path) for engine, path in counts_files.items()}
        write(output / 'counts-seal.json', count_pins)
        status['status'] = 'measuring'
        for index, order in enumerate(ORDERS):
            for engine in (['node', 'bun'] if index % 2 == 0 else ['bun', 'node']):
                for arm in order:
                    assert sha(counts_files[engine]) == count_pins[engine]
                    root = candidate if arm == 'C' else baseline
                    label = f'{engine}-block{index + 1}-{arm}'
                    receipt, result = run_subject(engine, label, root, 'measure', counts_files[engine])
                    records.append({'engine': engine, 'block': index + 1, 'arm': arm, 'result': result,
                                    'spawnToReadyNs': receipt['spawnToReadyNs'], 'startedUnix': receipt['startedUnix'], 'endedUnix': receipt['endedUnix']})
                    write(output / 'analysis-input.json', {'records': records, 'calibrations': calibrations})
        assert status['studyChildrenStarted'] == 38 and len(records) == 36
        analysis = analyze(records, calibrations)
        write(output / 'analysis.json', analysis)
        verify()
        assert all(sha(path) == count_pins[engine] for engine, path in counts_files.items())
        assert sha(output / 'manifest.json') == frozen_manifest_sha
        assert time.monotonic() < deadline and not supervisor.interrupted
        status.update({'status': 'finalizing', 'verdict': analysis['verdict'], 'performanceClaim': False, 'requiresPromotionChecks': True,
                       'cumulativeAccountingComplete': True, 'requiresSuccessfulControllerExit': True})
    except BaseException as error:
        status.update({'status': 'incomplete', 'error': supervisor.display(repr(error))})
        raise
    finally:
        try:
            status['admissionAndStudySecondsForSafety'] = time.monotonic() - started
            if science_start is not None: status['studySecondsForSafety'] = time.monotonic() - science_start
            if status['status'] == 'finalizing':
                assert time.monotonic() < deadline and not supervisor.interrupted
                status['status'] = 'complete'
            write(output / 'status.json', status)
            write(output / 'evidence-sha256.json', {path.name: sha(path) for path in sorted(output.iterdir()) if path.is_file() and path.name != 'evidence-sha256.json'})
            if status['status'] == 'complete': assert time.monotonic() < deadline and not supervisor.interrupted
            signal.setitimer(signal.ITIMER_REAL, 0)
        except BaseException as error:
            signal.setitimer(signal.ITIMER_REAL, 0)
            status.update({'status': 'incomplete', 'finalizationError': supervisor.display(repr(error)), 'requiresSuccessfulControllerExit': True})
            write(output / 'status.json', status)
            raise

if __name__ == '__main__': main()

