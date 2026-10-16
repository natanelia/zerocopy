"""Synthetic fixed-plan analysis checks; no subject fixtures or timer sampling."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import re
import statistics
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('screen', Path(__file__).with_name('run.py'))
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)


def timer(quantum=1 / 1024):
    readings = [index * quantum for index in range(4096)]
    deltas = [b - a for a, b in zip(readings, readings[1:]) if b > a]
    return {'readingsMs': readings, 'positiveDeltasMs': deltas, 'quantumMs': min(deltas), 'precheckPassed': True}


def set_duration(batch, milliseconds, clock):
    batch['elapsedMs'] = milliseconds
    batch['elapsedNs'] = milliseconds * 1e6
    batch['timerEligible'] = bool(clock['precheckPassed'] and clock['quantumMs'] is not None and
                                  clock['quantumMs'] > 0 and clock['quantumMs'] <= .005 * milliseconds)


def set_growth(batch, growth):
    batch['endUsed'] = batch['startUsed'] + growth
    batch['allocationBytes'] = growth


def batch(case, phase, ordinal, count, clock, identifier, milliseconds=30, per_unit=100):
    result = {'count': count, 'startUsed': 65536 + 4096, 'endUsed': 65536 + 4096 + count * per_unit,
              'startCapacity': 8 * 1024 ** 2, 'endCapacity': 8 * 1024 ** 2,
              'arenaId': identifier + ':' + case + ':' + phase + ':' + str(ordinal),
              'phase': phase, 'ordinal': ordinal, 'validation': 'passed', 'sinks': {'sizeSum': count, 'rootSum': count * 8},
              'setupMs': .5, 'validationMs': .5, 'preGcMs': .1, 'setupGcMs': .1,
              'allocationBytes': count * per_unit, 'prospectivePayloadBytes': 8 * 1024 ** 2,
              'cumulativePayloadBytes': 4096 + count * per_unit}
    set_duration(result, milliseconds, clock)
    return result


def native_unit(case, arm='B', candidate_bytes=90):
    return 0 if case == 'M0' else 56 if case == 'G1' else candidate_bytes if case == 'P' and arm == 'C' else 100 if case == 'P' else 128


def synthetic(candidate=.9, aa=1.0, candidate_bytes=90):
    records, calibrations = [], {}
    for engine in ['node', 'bun']:
        clock = timer()
        cases = {}
        for case in screen.CASES:
            count = 4 if case == 'I4' else 256
            trial = {'trial': 1, 'count': count, 'medianMs': 30, 'accepted': True}
            for phase, length in [('warmup', 5), ('pilot', 3)]:
                trial['pilots' if phase == 'pilot' else phase] = [batch(case, phase, ordinal, count, clock,
                    engine + ':calibration:1', per_unit=native_unit(case)) for ordinal in range(1, length + 1)]
            cases[case] = {'id': case, 'count': count, 'accepted': True, 'trials': [trial]}
        calibrations[engine] = {'event': 'result', 'schemaVersion': 1, 'status': 'complete', 'mode': 'calibrate',
                                'engine': engine, 'timer': clock, 'cases': cases}
        for block in range(1, 7):
            for arm in screen.ORDERS[block - 1]:
                clock, cases = timer(), {}
                for case in screen.CASES:
                    count = 4 if case == 'I4' else 256
                    multiplier = candidate if arm == 'C' and case == 'P' else aa if arm == 'A' else 1
                    cell = {'id': case, 'count': count}
                    for phase, length in [('warmup', 5), ('measured', 9)]:
                        cell[phase] = [batch(case, phase, ordinal, count, clock,
                            f'{engine}:block{block}:{arm}', 30 * multiplier,
                            native_unit(case, arm, candidate_bytes)) for ordinal in range(1, length + 1)]
                    cases[case] = cell
                records.append({'engine': engine, 'block': block, 'arm': arm,
                                'result': {'event': 'result', 'schemaVersion': 1, 'status': 'complete', 'mode': 'measure',
                                           'engine': engine, 'cases': cases, 'timer': clock}})
    return records, calibrations


def selected(records, engine, arm, case, phase='measured'):
    return [(record, item) for record in records if record['engine'] == engine and record['arm'] == arm
            for item in record['result']['cases'][case][phase]]


def uncalibrate(records, calibrations, engine, case):
    child = calibrations[engine]
    count, trials = (4 if case == 'I4' else 256), []
    for index in range(1, 5):
        trial = {'trial': index, 'count': count, 'medianMs': 10, 'accepted': False}
        for phase, length in [('warmup', 5), ('pilot', 3)]:
            trial['pilots' if phase == 'pilot' else phase] = [batch(case, phase, ordinal, count, child['timer'],
                engine + ':uncalibrated:' + str(index), 10, native_unit(case)) for ordinal in range(1, length + 1)]
        trials.append(trial)
        if index < 4: count *= 3
    child['cases'][case] = {'id': case, 'count': count, 'accepted': False, 'trials': trials}
    for record in records:
        if record['engine'] != engine: continue
        cell = record['result']['cases'][case]
        cell['count'] = count
        for phase in ['warmup', 'measured']:
            for item in cell[phase]:
                per_unit = (item['endUsed'] - item['startUsed']) // item['count']
                item['count'] = count
                set_growth(item, count * per_unit)


class Analysis(unittest.TestCase):
    def test_fixed_plan(self):
        self.assertEqual(screen.CASES, ['P', 'S16', 'R1', 'N4', 'G1', 'B0', 'C0', 'M0', 'L4', 'X4', 'I4'])
        self.assertEqual(screen.ORDERS, ['BCA', 'ABC', 'CAB', 'BAC', 'CBA', 'ACB'])
        self.assertEqual(sum(len(order) * 2 for order in screen.ORDERS), 36)
        self.assertEqual(screen.SCIENCE_SECONDS, 2400)
        self.assertEqual(screen.CHILD_SECONDS, 90)
        self.assertEqual(screen.SCIENCE_RSS, 2 * 1024 ** 3)
        self.assertEqual(screen.POLL_SECONDS, .05)
        self.assertEqual(screen.ADMISSION_SECONDS, 1620)
        self.assertEqual(screen.ADMISSION_RSS, 4 * 1024 ** 3)
        self.assertEqual(screen.ENTRIES, {'node': ['dist/shared.js'], 'bun': ['shared.ts']})

    def test_metadata_uses_remaining_admission_budget(self):
        supervisor = Mock(output=Path('synthetic'), receipts=[])
        with patch.object(screen.time, 'monotonic', return_value=100), patch.object(Path, 'read_text', return_value='ok\n'):
            self.assertEqual(screen.command(['git', 'rev-parse', 'HEAD'], Path('.'), 107, supervisor), 'ok')
            self.assertEqual(supervisor.run.call_args.args[3:5], (107, 7))
            screen.command(['node', '--version'], Path('.'), 130, supervisor)
            self.assertEqual(supervisor.run.call_args.args[3:5], (130, 10))
            with self.assertRaises(AssertionError): screen.command(['git'], Path('.'), 101, supervisor)
            self.assertEqual(supervisor.run.call_count, 2)

    def test_workflow_runtime_permission_and_runner_context_guards(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/sorted-journal-delete.yml').read_text()
        self.assertIsNone(re.search(r'^    env\s*:', workflow, re.M), 'job-level env is forbidden')
        self.assertNotIn('pull_request_target', workflow)
        self.assertRegex(workflow, r'(?m)^    timeout-minutes: 75\s*$')
        self.assertRegex(workflow, r'(?m)^\s+node-version:\s*[\'\"]?22\.16\.0[\'\"]?\s*$')
        self.assertRegex(workflow, r'(?m)^\s+bun-version:\s*[\'\"]?1\.4\.2[\'\"]?\s*$')
        self.assertRegex(workflow, r'(?m)^\s+contents:\s*read\s*$')
        self.assertIsNone(re.search(r'(?m)^\s+[A-Za-z_-]+:\s*write\s*$', workflow))
        self.assertIn('runner.temp', workflow)
        lines = workflow.splitlines()
        for index, line in enumerate(lines):
            if 'runner.temp' in line:
                indent = len(line) - len(line.lstrip())
                self.assertGreaterEqual(indent, 10)
                parent_index = next((previous_index for previous_index in range(index - 1, -1, -1)
                                     if lines[previous_index].strip() and not lines[previous_index].lstrip().startswith('#') and
                                     len(lines[previous_index]) - len(lines[previous_index].lstrip()) < indent), None)
                self.assertIsNotNone(parent_index)
                parent = lines[parent_index].strip()
                self.assertIn(parent, ['env:', 'with:', 'path: |'])
                if parent == 'path: |':
                    parent_indent = len(lines[parent_index]) - len(lines[parent_index].lstrip())
                    self.assertEqual(parent_indent, 10)
                    owner = next((previous.strip() for previous in reversed(lines[:parent_index])
                                  if previous.strip() and not previous.lstrip().startswith('#') and
                                  len(previous) - len(previous.lstrip()) < parent_indent), None)
                    self.assertEqual(owner, 'with:')

    def test_interval_uses_six_process_ratios_and_fixed_student_t(self):
        self.assertEqual(screen.interval([1] * 6)['ratio'], 1)
        self.assertAlmostEqual(screen.interval([.9] * 6)['upper'], .9)
        ratios = [.8, .85, .9, .95, 1, 1.05]
        result = screen.interval(ratios)
        logs = [math.log(value) for value in ratios]
        center = statistics.mean(logs)
        half = 2.570582 * statistics.stdev(logs) / math.sqrt(6)
        self.assertAlmostEqual(result['lower'], math.exp(center - half))
        self.assertAlmostEqual(result['upper'], math.exp(center + half))
        with self.assertRaises(AssertionError): screen.interval(ratios * 9)
        with self.assertRaises(AssertionError): screen.interval([True] * 6)

    def test_two_separate_endpoints_and_all_receipts(self):
        records, calibration = synthetic()
        result = screen.analyze(records, calibration)
        self.assertTrue(result['latency']['lead'])
        self.assertTrue(result['nativeAllocation']['lead'])
        self.assertIsNone(result['nativeAllocation']['confidenceInterval'])
        self.assertFalse(result['promotionReady'])
        for engine in ['node', 'bun']:
            for case in screen.CASES:
                row = result['engines'][engine][case]
                self.assertEqual(len(row['candidate']['ratios']), 6)
                self.assertEqual(len(row['allocation']['matchedBatches']), 84)
                self.assertEqual(len(row['absoluteNsPerOp']['C']), 6)
                self.assertEqual(row['unit'], 'complete transaction' if case in ['X4', 'I4'] else 'public delete')

    def test_latency_primary_requires_both_engines(self):
        records, calibration = synthetic()
        for record, item in selected(records, 'bun', 'C', 'P'): set_duration(item, 29, record['result']['timer'])
        result = screen.analyze(records, calibration)
        self.assertFalse(result['latency']['lead'])
        self.assertTrue(result['nativeAllocation']['lead'])

    def test_latency_five_percent_boundary(self):
        records, calibration = synthetic(candidate=.95)
        self.assertTrue(screen.analyze(records, calibration)['latency']['lead'])
        records, calibration = synthetic(candidate=.950001)
        self.assertFalse(screen.analyze(records, calibration)['latency']['lead'])

    def test_native_ten_percent_exact_integer_boundary(self):
        records, calibration = synthetic(candidate_bytes=90)
        self.assertTrue(screen.analyze(records, calibration)['nativeAllocation']['lead'])
        item = selected(records, 'bun', 'C', 'P', 'warmup')[-1][1]
        set_growth(item, 90 * item['count'] + 1)
        result = screen.analyze(records, calibration)
        self.assertFalse(result['nativeAllocation']['lead'])
        self.assertEqual(result['nativeAllocation']['primaryCriterionFailures'], ['bun:P'])
        self.assertTrue(result['latency']['lead'])

    def test_one_bad_receipt_cannot_be_averaged_away(self):
        records, calibration = synthetic(candidate_bytes=80)
        item = selected(records, 'node', 'C', 'P')[0][1]
        set_growth(item, 91 * item['count'])
        self.assertFalse(screen.analyze(records, calibration)['nativeAllocation']['lead'])

    def test_calibration_native_deltas_are_excluded_from_effect_endpoint(self):
        records, calibration = synthetic()
        for engine in ['node', 'bun']:
            trial = calibration[engine]['cases']['P']['trials'][0]
            for phase in ['warmup', 'pilots']:
                for item in trial[phase]: set_growth(item, 1000 * item['count'])
        result = screen.analyze(records, calibration)
        self.assertTrue(result['nativeAllocation']['lead'])
        self.assertEqual(len(result['engines']['node']['P']['allocation']['matchedBatches']), 84)

    def test_native_positive_baseline_required(self):
        records, calibration = synthetic()
        for arm in 'ABC':
            for phase in ['warmup', 'measured']:
                for _, item in selected(records, 'node', arm, 'P', phase): set_growth(item, 0)
        result = screen.analyze(records, calibration)
        self.assertFalse(result['nativeAllocation']['lead'])
        self.assertTrue(result['nativeAllocation']['unresolved'])

    def test_baseline_frontier_mismatch_is_unresolved_even_with_equal_deltas(self):
        records, calibration = synthetic()
        item = selected(records, 'node', 'A', 'P')[0][1]
        item['startUsed'] += 8
        item['endUsed'] += 8
        result = screen.analyze(records, calibration)
        self.assertFalse(result['nativeAllocation']['lead'])
        self.assertTrue(result['nativeAllocation']['unresolved'])
        self.assertFalse(result['nativeAllocation']['primaryCriterionFailures'])

    def test_baseline_delta_mismatch_is_unresolved(self):
        records, calibration = synthetic()
        item = selected(records, 'bun', 'A', 'S16', 'warmup')[0][1]
        set_growth(item, item['endUsed'] - item['startUsed'] + 8)
        result = screen.analyze(records, calibration)
        self.assertFalse(result['nativeAllocation']['lead'])
        self.assertTrue(result['nativeAllocation']['unresolved'])

    def test_control_native_increase_survives_unmatched_baselines(self):
        records, calibration = synthetic()
        a = selected(records, 'node', 'A', 'C0')[0][1]
        c = selected(records, 'node', 'C', 'C0')[0][1]
        set_growth(a, 130 * a['count'])
        set_growth(c, 129 * c['count'])
        result = screen.analyze(records, calibration)
        self.assertTrue(result['nativeAllocation']['unresolved'])
        self.assertTrue(result['nativeAllocation']['controlIncreases'])
        self.assertEqual(result['nativeAllocation']['verdict'], 'failed: control native-allocation increase')

    def test_every_nonzero_control_can_fail_allocation_in_either_engine(self):
        for engine in ['node', 'bun']:
            for case in [value for value in screen.CASES[1:] if value != 'M0']:
                with self.subTest(engine=engine, case=case):
                    records, calibration = synthetic()
                    item = selected(records, engine, 'C', case, 'warmup')[0][1]
                    set_growth(item, item['endUsed'] - item['startUsed'] + 1)
                    result = screen.analyze(records, calibration)
                    self.assertFalse(result['nativeAllocation']['lead'])
                    self.assertEqual(len(result['nativeAllocation']['controlIncreases']), 1)

    def test_missing_key_requires_zero_growth_in_all_arms(self):
        for arm in 'ABC':
            records, calibration = synthetic()
            item = selected(records, 'node', arm, 'M0')[0][1]
            set_growth(item, 1)
            with self.assertRaises(AssertionError): screen.analyze(records, calibration)

    def test_all_controls_can_block_timing_in_either_engine(self):
        for engine in ['node', 'bun']:
            for case in screen.CASES[1:]:
                with self.subTest(engine=engine, case=case):
                    records, calibration = synthetic()
                    for record, item in selected(records, engine, 'C', case): set_duration(item, 30.9, record['result']['timer'])
                    result = screen.analyze(records, calibration)
                    self.assertFalse(result['latency']['lead'])
                    self.assertFalse(result['nativeAllocation']['lead'])
                    self.assertEqual(result['latency']['regressions'], [engine + ':' + case])

    def test_two_percent_lower_boundary_and_unresolved_upper_boundary(self):
        records, calibration = synthetic()
        for record, item in selected(records, 'node', 'C', 'B0'): set_duration(item, 30.6, record['result']['timer'])
        self.assertFalse(screen.analyze(records, calibration)['latency']['regressions'])
        ratios = [1, 1.01, 1, 1.01, 1, 1.10]
        for record, item in selected(records, 'node', 'C', 'B0'): set_duration(item, 30 * ratios[record['block'] - 1], record['result']['timer'])
        result = screen.analyze(records, calibration)
        self.assertFalse(result['latency']['regressions'])
        self.assertIn('node:B0', result['latency']['unresolvedControls'])

    def test_quality_and_calibration_never_hide_control_slowdown(self):
        records, calibration = synthetic()
        uncalibrate(records, calibration, 'node', 'S16')
        for arm in 'ABC':
            for record, item in selected(records, 'node', arm, 'S16'): set_duration(item, 8 * (1.03 if arm == 'C' else 1), record['result']['timer'])
        result = screen.analyze(records, calibration)
        self.assertEqual(result['latency']['regressions'], ['node:S16'])
        self.assertFalse(result['engines']['node']['S16']['qualityResolved'])
        self.assertFalse(result['engines']['node']['S16']['calibrationResolved'])
        self.assertFalse(result['nativeAllocation']['lead'])

    def test_primary_timing_slowdown_blocks_allocation_promotion(self):
        records, calibration = synthetic(candidate=1.03)
        result = screen.analyze(records, calibration)
        self.assertTrue(result['nativeAllocation']['deterministicCriteriaMet'])
        self.assertFalse(result['nativeAllocation']['lead'])
        self.assertEqual(result['nativeAllocation']['timingSlowdowns'], ['node:P', 'bun:P'])

    def test_unresolved_primary_latency_can_coexist_with_allocation(self):
        records, calibration = synthetic()
        uncalibrate(records, calibration, 'bun', 'P')
        result = screen.analyze(records, calibration)
        self.assertFalse(result['latency']['lead'])
        self.assertTrue(result['nativeAllocation']['lead'])
        self.assertIn('bun:P', result['nativeAllocation']['unresolvedTimingRows'])

    def test_primary_and_missing_key_aa_bias_block_latency(self):
        for case in ['P', 'M0']:
            for multiplier in [1.06, .94]:
                records, calibration = synthetic()
                for record, item in selected(records, 'bun', 'A', case): set_duration(item, 30 * multiplier, record['result']['timer'])
                result = screen.analyze(records, calibration)
                self.assertTrue(result['engines']['bun'][case]['bias'])
                self.assertFalse(result['latency']['lead'])

    def test_other_control_aa_bias_remains_named(self):
        records, calibration = synthetic()
        for record, item in selected(records, 'node', 'A', 'R1'): set_duration(item, 31.8, record['result']['timer'])
        result = screen.analyze(records, calibration)
        self.assertTrue(result['latency']['lead'])
        self.assertIn('node:R1', result['latency']['unresolvedControls'])

    def test_chronological_baseline_interval_is_not_omitted(self):
        records, calibration = synthetic()
        for record in records:
            if record['engine'] != 'node' or record['arm'] == 'C': continue
            order = screen.ORDERS[record['block'] - 1]
            later = 'A' if order.index('A') > order.index('B') else 'B'
            milliseconds = 31.8 if record['arm'] == later else 30
            for item in record['result']['cases']['M0']['measured']: set_duration(item, milliseconds, record['result']['timer'])
        result = screen.analyze(records, calibration)
        self.assertGreater(result['engines']['node']['M0']['chronologicalBaseline']['lower'], 1.05)
        self.assertFalse(result['latency']['lead'])

    def test_primary_quality_failure_blocks_only_latency(self):
        records, calibration = synthetic()
        record, item = selected(records, 'node', 'B', 'P')[0]
        set_duration(item, 9, record['result']['timer'])
        result = screen.analyze(records, calibration)
        self.assertFalse(result['latency']['lead'])
        self.assertTrue(result['nativeAllocation']['lead'])

    def test_invalid_control_duration_is_retained(self):
        records, calibration = synthetic()
        record, item = selected(records, 'node', 'B', 'N4')[0]
        set_duration(item, 0, record['result']['timer'])
        result = screen.analyze(records, calibration)
        self.assertTrue(result['latency']['lead'])
        self.assertIn('node:N4', result['latency']['unresolvedControls'])
        self.assertEqual(len(result['engines']['node']['N4']['blocks']), 6)
        self.assertIsNone(result['engines']['node']['N4']['candidate']['ratio'])

    def test_nonfinite_measured_duration_remains_unresolved(self):
        records, calibration = synthetic()
        _, item = selected(records, 'node', 'B', 'P')[0]
        item.update({'elapsedNs': 'NaN', 'elapsedMs': 'NaN', 'timerEligible': False})
        result = screen.analyze(records, calibration)
        self.assertFalse(result['latency']['lead'])
        self.assertTrue(result['nativeAllocation']['lead'])

    def test_clock_failure_keeps_allocation_and_adverse_timing(self):
        records, calibration = synthetic()
        for record in records:
            if record['engine'] != 'node': continue
            clock = timer(.25)
            record['result']['timer'] = clock
            for case in screen.CASES:
                for phase in ['warmup', 'measured']:
                    for item in record['result']['cases'][case][phase]:
                        milliseconds = 30.9 if case == 'S16' and record['arm'] == 'C' else item['elapsedMs']
                        set_duration(item, milliseconds, clock)
        result = screen.analyze(records, calibration)
        self.assertFalse(result['engines']['node']['P']['clockResolved'])
        self.assertEqual(result['latency']['regressions'], ['node:S16'])
        self.assertTrue(result['nativeAllocation']['deterministicCriteriaMet'])
        self.assertFalse(result['nativeAllocation']['lead'])

    def test_accepted_calibration_clock_failure_does_not_adjust_counts(self):
        records, calibration = synthetic()
        child = calibration['node']
        child['timer'] = timer(.25)
        for case in screen.CASES:
            trial = child['cases'][case]['trials'][0]
            for phase in ['warmup', 'pilots']:
                for item in trial[phase]: set_duration(item, 30, child['timer'])
        result = screen.analyze(records, calibration)
        self.assertTrue(result['engines']['node']['P']['calibrationResolved'])
        self.assertFalse(result['engines']['node']['P']['clockResolved'])
        self.assertFalse(result['latency']['lead'])
        self.assertTrue(result['nativeAllocation']['lead'])

    def test_exact_clock_duration_boundary(self):
        records, calibration = synthetic()
        for child in [record['result'] for record in records] + list(calibration.values()):
            child['timer'] = timer(.125)
            for case in screen.CASES:
                cell = child['cases'][case]
                sets = [cell['trials'][0]['warmup'], cell['trials'][0]['pilots']] if child['mode'] == 'calibrate' else [cell['warmup'], cell['measured']]
                for items in sets:
                    for item in items: set_duration(item, 25, child['timer'])
                if child['mode'] == 'calibrate': cell['trials'][0]['medianMs'] = 25
        result = screen.analyze(records, calibration)
        self.assertTrue(result['engines']['node']['P']['clockResolved'])
        record, item = selected(records, 'node', 'C', 'P')[0]
        set_duration(item, 24.999, record['result']['timer'])
        self.assertFalse(screen.analyze(records, calibration)['engines']['node']['P']['clockResolved'])

    def test_invalid_or_inadequate_timer_readings_are_not_trusted(self):
        for change in ['constant', 'backward', 'nonfinite', 'false-flag', 'wrong-quantum']:
            records, calibration = synthetic()
            clock = records[0]['result']['timer']
            if change == 'constant': clock.update({'readingsMs': [1] * 4096, 'positiveDeltasMs': [], 'quantumMs': None, 'precheckPassed': False})
            if change == 'backward': clock['readingsMs'][100] = 0
            if change == 'nonfinite': clock['readingsMs'][100] = 'NaN'
            if change == 'false-flag': clock['precheckPassed'] = False
            if change == 'wrong-quantum': clock['quantumMs'] *= 2
            result = screen.analyze(records, calibration)
            self.assertFalse(result['latency']['lead'])
            self.assertTrue(result['nativeAllocation']['lead'])

    def test_cv_and_drift_diagnostics_use_nine_measurements(self):
        records, calibration = synthetic()
        factors = [.75, 1, 1.25, 1.25, 1.25, .75, .75, 1.25, .75]
        record = next(value for value in records if value['engine'] == 'node' and value['arm'] == 'C')
        for item, factor in zip(record['result']['cases']['P']['measured'], factors): set_duration(item, 30 * factor, record['result']['timer'])
        values = screen.analyze(records, calibration)['engines']['node']['P']['blocks'][0]['values']['C']
        self.assertAlmostEqual(values['cv'], .25)
        self.assertNotIn('batch CV above 25%', values['reasons'])
        for item in record['result']['cases']['P']['measured'][:3]: set_duration(item, 30, record['result']['timer'])
        for item in record['result']['cases']['P']['measured'][-3:]: set_duration(item, 34.500001, record['result']['timer'])
        values = screen.analyze(records, calibration)['engines']['node']['P']['blocks'][0]['values']['C']
        self.assertIn('batch drift outside 0.85–1.15', values['reasons'])

    def test_invalid_calibration_pilot_blocks_study(self):
        records, calibration = synthetic()
        item = calibration['node']['cases']['P']['trials'][0]['pilots'][0]
        set_duration(item, 0, calibration['node']['timer'])
        with self.assertRaises(AssertionError): screen.analyze(records, calibration)

    def test_clipped_unchanged_count_stops_without_extra_trial(self):
        records, calibration = synthetic()
        child = calibration['node']
        trials = []
        for index, count in enumerate([256, 16384], 1):
            trial = {'trial': index, 'count': count, 'medianMs': .1, 'accepted': False}
            for phase, length in [('warmup', 5), ('pilot', 3)]:
                trial['pilots' if phase == 'pilot' else phase] = [batch('P', phase, ordinal, count, child['timer'],
                    'node:clipped:' + str(index), .1, 100) for ordinal in range(1, length + 1)]
            trials.append(trial)
        child['cases']['P'] = {'id': 'P', 'count': 16384, 'accepted': False, 'trials': trials}
        for record in records:
            if record['engine'] != 'node': continue
            cell = record['result']['cases']['P']
            cell['count'] = 16384
            for phase in ['warmup', 'measured']:
                for item in cell[phase]:
                    per_unit = (item['endUsed'] - item['startUsed']) // item['count']
                    item['count'] = 16384
                    set_growth(item, 16384 * per_unit)
        result = screen.analyze(records, calibration)
        self.assertFalse(result['latency']['lead'])
        self.assertTrue(result['nativeAllocation']['lead'])
        self.assertEqual(len(result['calibrations']['node']['cases']['P']['trials']), 2)

    def test_incomplete_child_cannot_supply_either_endpoint(self):
        records, calibration = synthetic()
        records[0]['result']['status'] = 'incomplete'
        with self.assertRaises(AssertionError): screen.analyze(records, calibration)
        records, calibration = synthetic()
        calibration['bun']['status'] = 'incomplete'
        with self.assertRaises(AssertionError): screen.analyze(records, calibration)

    def test_missing_cells_batches_and_duplicate_records_fail_closed(self):
        for kind in ['record', 'duplicate', 'case', 'warmup', 'measured', 'trial', 'timer-read']:
            records, calibration = synthetic()
            if kind == 'record': records.pop()
            if kind == 'duplicate': records[-1] = copy.deepcopy(records[0])
            if kind == 'case': del records[0]['result']['cases']['S16']
            if kind == 'warmup': records[0]['result']['cases']['P']['warmup'].pop()
            if kind == 'measured': records[0]['result']['cases']['P']['measured'].pop()
            if kind == 'trial': calibration['node']['cases']['P']['trials'] = []
            if kind == 'timer-read': records[0]['result']['timer']['readingsMs'].pop()
            with self.assertRaises(AssertionError): screen.analyze(records, calibration)

    def test_count_phase_ordinal_validation_and_arena_contract(self):
        for key, value in [('count', 255), ('phase', 'pilot'), ('ordinal', 0), ('validation', 'failed')]:
            records, calibration = synthetic()
            records[0]['result']['cases']['P']['measured'][0][key] = value
            with self.assertRaises(AssertionError): screen.analyze(records, calibration)
        records, calibration = synthetic()
        cell = records[0]['result']['cases']['P']
        cell['measured'][0]['arenaId'] = cell['warmup'][0]['arenaId']
        with self.assertRaises(AssertionError): screen.analyze(records, calibration)

    def test_calibration_count_selection_cannot_be_changed_after_observation(self):
        records, calibration = synthetic()
        calibration['node']['cases']['P']['count'] += 1
        with self.assertRaises(AssertionError): screen.analyze(records, calibration)
        records, calibration = synthetic()
        trial = copy.deepcopy(calibration['node']['cases']['P']['trials'][0])
        trial['trial'] = 2
        calibration['node']['cases']['P']['trials'].append(trial)
        with self.assertRaises(AssertionError): screen.analyze(records, calibration)

    def test_inputs_and_extra_technical_receipts_remain_unchanged(self):
        records, calibration = synthetic()
        item = records[0]['result']['cases']['P']['warmup'][0]
        item['technicalDiagnostic'] = {'nativeUsedOnly': True}
        original = json.dumps({'records': records, 'calibrations': calibration}, sort_keys=True)
        result = screen.analyze(records, calibration)
        self.assertEqual(json.dumps({'records': records, 'calibrations': calibration}, sort_keys=True), original)
        retained = result['engines']['node']['P']['allocation']['matchedBatches'][0]['arms']['B']['raw']
        self.assertEqual(retained, item)
        self.assertEqual(retained['technicalDiagnostic'], {'nativeUsedOnly': True})


if __name__ == '__main__': unittest.main()
