"""Proposed inert checks: fabricated records only; no library, processes or clocks."""
import copy
import importlib.util
import json
from pathlib import Path
import analysis
from runner import invalidate_terminal
from supervisor import CASES, EXPECTED, schedule, validate_output


def rejects(function):
    try:
        function()
    except (AssertionError, KeyError, ValueError):
        return
    raise AssertionError('invalid raw record was accepted')


def main():
    spec = importlib.util.spec_from_file_location('analysis_checks', Path(__file__).with_name('analysis-checks.py'))
    checks = importlib.util.module_from_spec(spec); spec.loader.exec_module(checks)
    statistical = checks.run_checks(analysis)
    jobs = schedule()
    assert len(jobs) == 66
    assert [(j['mode'], j['engine'], j['arm']) for j in jobs[:2]] == [
        ('calibration', 'node', 'baseline'), ('calibration', 'bun', 'baseline')]
    assert {(j['engine'], j['arm'], j['round']) for j in jobs[2:]} == {
        (e, a, r) for e in ('node', 'bun') for a in ('baseline', 'candidate') for r in range(16)}
    for r in range(16):
        group = jobs[2 + r * 4:6 + r * 4]
        engines = ['node', 'node', 'bun', 'bun'] if r % 2 == 0 else ['bun', 'bun', 'node', 'node']
        arms = ['baseline', 'candidate'] * 2 if r % 2 == 0 else ['candidate', 'baseline'] * 2
        assert [j['engine'] for j in group] == engines and [j['arm'] for j in group] == arms
        assert all(j['caseOrder'] == list(CASES[r % 6:] + CASES[:r % 6]) for j in group)
    job = {**jobs[2], 'corpusSha256': 'a' * 64, 'counts': {case: 2 for case in CASES}}
    result = {key: job[key] for key in ('engine', 'arm', 'round', 'corpusSha256')}
    result['workloads'] = {}; rows = []
    for case in job['caseOrder']:
        checksum, operations = EXPECTED[case]
        rows.append({'event': 'prewarm', 'case': case, 'milliseconds': 500, 'calls': 1, 'checksum': checksum})
        for phase, count in [('warmup', 8), ('measured', 4)]:
            rows.extend({'event': 'batch', 'case': case, 'K': 2, 'phase': phase, 'index': i,
                         'milliseconds': 50, 'checksum': checksum * 2} for i in range(count))
        result['workloads'][case] = {'K': 2, 'operationsPerRepetition': operations,
            'warmupMs': [50] * 8, 'measuredMs': [50] * 4, 'checksums': [checksum * 2] * 4,
            'expectedChecksum': checksum * 2}
    rows.append({'event': 'result', 'result': result})
    assert validate_output(job, rows) == result
    rejects(lambda: validate_output(job, rows[:-2] + rows[-1:]))
    for field, value in [('K', 4), ('phase', 'measured'), ('checksum', 0), ('index', 7)]:
        changed = copy.deepcopy(rows); changed[1][field] = value
        rejects(lambda: validate_output(job, changed))
    changed = copy.deepcopy(rows); changed[-1]['result']['engine'] = 'bun'
    rejects(lambda: validate_output(job, changed))
    # Late cancellation/cap exhaustion cannot retain a favorable terminal state.
    for interrupted, elapsed in [(15, 1), (None, 900), (15, 901)]:
        terminal = {'status': 'completed', 'ready': True}
        favorable = {'terminalComplete': True, 'promisingPrimary': True, 'regressionClear': True}
        assert invalidate_terminal(terminal, interrupted, elapsed, analysis=favorable)
        assert terminal['status'] == 'stopped' and not terminal['ready']
        assert not any(favorable.values())
    terminal = {'status': 'completed', 'ready': True}
    favorable = {'terminalComplete': True, 'promisingPrimary': True, 'regressionClear': True}
    assert not invalidate_terminal(terminal, None, 899, analysis=favorable)
    assert terminal['ready'] and all(favorable.values())
    print(json.dumps({'status': 'passed', 'scope': 'pure analysis, fixed schedule and raw-record checks',
                      'statistical': statistical, 'scientificChildrenExecuted': 0}))


if __name__ == '__main__':
    main()
