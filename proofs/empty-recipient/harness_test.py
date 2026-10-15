"""Synthetic statistics and fixed-plan checks; no subject import or elapsed-time sampling."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('screen', Path(__file__).with_name('run.py'))
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)

def synthetic(candidate=.9, aa=1.0):
    records = []
    calibrations = {engine: {'cases': {case: {'accepted': True} for case in screen.CASES}} for engine in ['node', 'bun']}
    for engine in ['node', 'bun']:
        for block in range(1, 7):
            for arm in screen.ORDERS[block - 1]:
                cases = {}
                for case in screen.CASES:
                    ratio = candidate if arm == 'C' and case == 'P' else aa if arm == 'A' else 1
                    cases[case] = {'measured': [{'count': 1000, 'elapsedNs': 30e6 * ratio} for _ in range(9)]}
                records.append({'engine': engine, 'block': block, 'arm': arm, 'result': {'cases': cases, 'firstPublishNs': 1000}, 'spawnToReadyNs': 1e6, 'startedUnix': block, 'endedUnix': block + .5})
    return records, calibrations

class Harness(unittest.TestCase):
    def test_interval(self):
        self.assertEqual(screen.interval([1] * 6)['ratio'], 1)
        self.assertAlmostEqual(screen.interval([.9] * 6)['upper'], .9)
        ci = screen.interval([.8, .85, .9, .95, 1, 1.05])
        self.assertLess(ci['lower'], ci['ratio'])
        self.assertGreater(ci['upper'], ci['ratio'])

    def test_fixed_plan(self):
        self.assertEqual(screen.CASES, ['P', 'L1', 'E0', 'E1', 'W24', 'U1', 'F'])
        self.assertEqual(sum(len(order) * 2 for order in screen.ORDERS), 36)
        self.assertEqual(len(set(screen.ORDERS)), 6)
        self.assertEqual(screen.SCIENCE_SECONDS, 870)
        self.assertEqual(screen.CHILD_SECONDS, 90)
        self.assertEqual(screen.SCIENCE_RSS, 2 * 1024 ** 3)
        self.assertEqual(screen.POLL_SECONDS, .05)
        self.assertEqual(screen.ENTRIES, {'node': ['dist/shared.js', 'dist/worker.js'], 'bun': ['shared.ts', 'worker.ts']})
        self.assertEqual(screen.ADMISSION_SECONDS, 1620)
        self.assertEqual(screen.ADMISSION_RSS, 4 * 1024 ** 3)

    def test_metadata_uses_remaining_admission_budget(self):
        supervisor = Mock(output=Path('synthetic'), receipts=[])
        with patch.object(screen.time, 'monotonic', return_value=100), patch.object(Path, 'read_text', return_value='ok\n'):
            self.assertEqual(screen.command(['git', 'rev-parse', 'HEAD'], Path('.'), 107, supervisor), 'ok')
            self.assertEqual(supervisor.run.call_args.args[3:5], (107, 7))
            screen.command(['node', '--version'], Path('.'), 130, supervisor)
            self.assertEqual(supervisor.run.call_args.args[3:5], (130, 10))
            with self.assertRaises(AssertionError): screen.command(['git'], Path('.'), 101, supervisor)
            self.assertEqual(supervisor.run.call_count, 2)

    def test_primary_conjunction(self):
        records, calibration = synthetic()
        self.assertTrue(screen.analyze(records, calibration)['verdict'].startswith('promising hosted recipient-free publication-latency lead, with unresolved controls:'))
        for row in records:
            if row['engine'] == 'bun' and row['arm'] == 'C':
                for batch in row['result']['cases']['P']['measured']: batch['elapsedNs'] = 29e6
        self.assertEqual(screen.analyze(records, calibration)['verdict'], 'no qualified hosted lead')

    def test_control_regression_and_unresolved(self):
        records, calibration = synthetic()
        for row in records:
            if row['engine'] == 'node' and row['arm'] == 'C':
                for batch in row['result']['cases']['E0']['measured']: batch['elapsedNs'] *= 1.03
        self.assertEqual(screen.analyze(records, calibration)['regressions'], ['node:E0'])

    def test_bias_quality_and_no_batch_replicates(self):
        records, calibration = synthetic(aa=1.06)
        self.assertEqual(screen.analyze(records, calibration)['verdict'], 'no qualified hosted lead')
        records, calibration = synthetic()
        records[0]['result']['cases']['P']['measured'][0]['elapsedNs'] = 9e6
        self.assertEqual(screen.analyze(records, calibration)['verdict'], 'no qualified hosted lead')
        records, calibration = synthetic()
        calibration['bun']['cases']['U1']['accepted'] = False
        self.assertIn('bun:U1', screen.analyze(records, calibration)['unresolvedControls'])
        self.assertEqual(len(screen.analyze(records, calibration)['engines']['node']['P']['candidate']['ratios']), 6)
        with self.assertRaises(AssertionError): screen.analyze(records[:-1], calibration)

    def test_invalid_control_is_retained_unresolved(self):
        records, calibration = synthetic()
        records[0]['result']['cases']['U1']['measured'][0]['elapsedNs'] = 0
        result = screen.analyze(records, calibration)
        self.assertIn('node:U1', result['unresolvedControls'])
        self.assertTrue(result['verdict'].startswith('promising hosted recipient-free publication-latency lead, with unresolved controls:'))
        self.assertEqual(len(result['engines']['node']['U1']['blocks']), 6)

    def test_every_control_can_park_either_engine(self):
        for engine in ['node', 'bun']:
            for case in screen.CASES[1:]:
                with self.subTest(engine=engine, case=case):
                    records, calibration = synthetic()
                    for row in records:
                        if row['engine'] == engine and row['arm'] == 'C':
                            for batch in row['result']['cases'][case]['measured']: batch['elapsedNs'] *= 1.03
                    result = screen.analyze(records, calibration)
                    self.assertEqual(result['verdict'], 'parked: control regression')
                    self.assertEqual(result['regressions'], [engine + ':' + case])

    def test_unresolved_control_does_not_hide_regression(self):
        records, calibration = synthetic()
        calibration['node']['cases']['E0']['accepted'] = False
        for row in records:
            if row['engine'] == 'node':
                for batch in row['result']['cases']['E0']['measured']:
                    batch['elapsedNs'] = 8e6 * (1.03 if row['arm'] == 'C' else 1)
        result = screen.analyze(records, calibration)
        self.assertEqual(result['verdict'], 'parked: control regression')
        self.assertFalse(result['engines']['node']['E0']['qualityResolved'])
        self.assertIn('node:E0', result['unresolvedControls'])

    def test_flush_sentinel_bias_blocks_gain(self):
        records, calibration = synthetic()
        for row in records:
            if row['engine'] == 'bun' and row['arm'] == 'A':
                for batch in row['result']['cases']['F']['measured']: batch['elapsedNs'] *= 1.06
        result = screen.analyze(records, calibration)
        self.assertTrue(result['engines']['bun']['F']['bias'])
        self.assertFalse(result['engines']['bun']['P']['bias'])
        self.assertEqual(result['verdict'], 'no qualified hosted lead')

    def test_other_control_bias_is_unresolved(self):
        records, calibration = synthetic()
        for row in records:
            if row['engine'] == 'node' and row['arm'] == 'A':
                for batch in row['result']['cases']['E1']['measured']: batch['elapsedNs'] *= 1.06
        result = screen.analyze(records, calibration)
        self.assertIn('node:E1', result['unresolvedControls'])
        self.assertFalse(result['blockers'])

    def test_raw_fixture_and_peer_batch_fields_survive(self):
        records, calibration = synthetic()
        child = records[0]['result']
        child['event'] = 'result'
        child['fixtures'] = {'copy': False, 'peer': {'transport': 'synthetic-only'}}
        peer_fields = {'count': 1000, 'elapsedNs': 30e6,
                       'peerDrain': {'firstVersion': 1, 'finalVersion': 1000, 'readerCallbacks': 2}}
        child['cases']['E1']['warmup'] = [peer_fields]
        child['cases']['E1']['measured'][0] = peer_fields
        original = json.dumps(records, sort_keys=True)
        stdout = json.dumps({'event': 'ready'}) + '\n' + json.dumps(child) + '\n'
        with patch.object(Path, 'read_text', return_value=stdout):
            self.assertEqual(screen.events(Path('synthetic'), 'child'), child)
        screen.analyze(records, calibration)
        self.assertEqual(json.dumps(records, sort_keys=True), original)

    def test_first_publication_diagnostics_stay_descriptive(self):
        records, calibration = synthetic()
        result = screen.analyze(records, calibration)
        self.assertEqual(len(result['firstPublicationAndStartup']), 36)
        self.assertEqual(result['firstPublicationAndStartup'][0]['firstPublishNs'], 1000)
        self.assertIn('unresolved descriptive', result['firstPublicationStatus'])
        self.assertNotIn('constructorAndStartup', result)

if __name__ == '__main__': unittest.main()
