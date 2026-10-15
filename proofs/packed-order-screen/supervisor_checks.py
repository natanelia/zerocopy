"""Inert proposed checks. Source only; execution requires a separate release.

No library imports, Node/Bun invocation, subject fixture, measurement or real
subprocess is used. Filesystem writes, signals, process ownership and clocks are
mocked for cleanup checks. Only loading this supervisor's Python definitions is
needed when these checks are separately authorized.
"""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def load_supervisor():
    spec = importlib.util.spec_from_file_location('packed_order_supervisor', Path(__file__).with_name('run-hosted.py'))
    module = importlib.util.module_from_spec(spec)
    with patch('subprocess.Popen', side_effect=AssertionError('a real process must never start')):
        spec.loader.exec_module(module)
    return module


class ProposedSupervisorChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_supervisor()

    def test_fixed_scientific_schedule(self):
        self.assertEqual(self.module.PHASES, {
            'probe': [('probe', 20)],
            'calibration': [('setup', 20), ('calibration', 90), ('final', 10)],
            'comparison': [('startup', 5), ('setup', 20), ('memory', 30), ('latency', 25), ('final', 5), ('exit', 5)]})
        jobs = self.module.planned_jobs()
        self.assertEqual([job['mode'] for job in jobs[:4]], ['probe', 'probe', 'calibration', 'calibration'])
        self.assertEqual(len(jobs), 36)
        self.assertEqual(sum(sum(cap for _, cap in self.module.PHASES[job['mode']]) for job in jobs), 3160)
        self.assertEqual(120 + 3160 + 90 + 60, 3430)
        self.assertEqual(len({job['jobId'] for job in jobs}), 36)
        self.assertTrue(all(job['arm'] == 'baseline' for job in jobs[2:4]))
        for pair in range(8):
            block = jobs[4 + pair * 4:8 + pair * 4]
            engines = ['node', 'bun'] if pair % 2 == 0 else ['bun', 'node']
            arms = ['baseline', 'candidate'] if pair % 2 == 0 else ['candidate', 'baseline']
            self.assertEqual([(job['engine'], job['arm']) for job in block],
                             [(engine, arm) for engine in engines for arm in arms])
            rotation = pair % 7
            expected_cases = list(self.module.CASES[rotation:] + self.module.CASES[:rotation])
            self.assertTrue(all(job['pairIndex'] == pair and job['caseOrder'] == expected_cases for job in block))
            for job in block:
                order = self.module.iteration_order(job)
                self.assertEqual(len(order), 18)
                closes = self.module.CLOSE_CASES[::-1] if pair % 2 else self.module.CLOSE_CASES
                self.assertEqual(order[-4:], [(case, 'close') for case in closes])

    def test_fixed_correctness_commands_are_separate(self):
        self.assertEqual(self.module.CORRECTNESS_PLAN, [
            ('baseline', 'bun-full-suite', 240), ('candidate', 'bun-full-suite', 240),
            ('baseline', 'typecheck', 60), ('candidate', 'typecheck', 60),
            ('baseline', 'node-worker', 60), ('candidate', 'node-worker', 60)])
        self.assertEqual(sum(cap for _, _, cap in self.module.CORRECTNESS_PLAN), 720)
        self.assertEqual(len(self.module.PREP_COMMANDS), 22)
        self.assertFalse(any('subject' in label for label in self.module.PREP_COMMANDS))

    def test_interrupted_prepare_still_cleans_original_group(self):
        module = self.module
        run = module.Run.__new__(module.Run)
        run.mode, run.stage, run.interrupted = 'prepare', 'prepare', 15
        run.end, run.deadline = 100, 40
        run.active = SimpleNamespace(pid=123, returncode=None)
        run.receipts = [{'ownedProcessGroup': 123, 'label': 'mock', 'cleanupSignals': []}]
        run.result = {'firstFailure': 'received signal 15', 'complete': False, 'readyForScreen': False}
        run.artifact = Mock()
        run.artifact.__truediv__ = Mock(return_value=run.artifact)
        run.artifact.exists = Mock(return_value=False)
        run.artifact.rglob.return_value = []
        run.outputs = {}
        run.authenticate_inputs = Mock()
        run.preserve = Mock()
        events = []
        def wait4(pid, flags):
            self.assertEqual(pid, 123)
            self.assertIsNone(run.active, 'signal authority must be cleared before reap')
            events.append('reap')
            return 123, 9, SimpleNamespace(ru_maxrss=1024)
        with patch.object(module.time, 'monotonic', return_value=1), \
             patch.object(module.signal, 'setitimer'), \
             patch.object(module, 'signal_group', side_effect=lambda pid: events.append(('kill', pid))), \
             patch.object(module, 'group_memory', return_value=[]), \
             patch.object(module.os, 'waitid', return_value=object()), \
             patch.object(module.os, 'wait4', side_effect=wait4), \
             patch.object(module, 'sha', return_value='a' * 64), \
             patch.object(module, 'write'), \
             patch.object(module.subprocess, 'Popen', side_effect=AssertionError('no process may start')):
            run.finish()
        self.assertEqual(events, [('kill', 123), 'reap'])
        self.assertNotIn('finalizationError', run.result, run.result.get('finalizationError'))
        self.assertTrue(run.result['cleanupVerified'])
        self.assertFalse(run.result['complete'])
        self.assertFalse(run.result['readyForScreen'])
        self.assertEqual(run.result['firstFailure'], 'received signal 15')
        run.preserve.assert_called_once()

    def test_terminal_failure_revokes_positive_summary_keeps_harm(self):
        analysis = {'complete': True, 'disposition': 'scoped_node_retained_memory_lead',
                    'scoped_node_lead_eligible': True, 'strong_scoped_screen_clearance': True,
                    'bun_material_benefit_corroborated': True, 'all_38_latency_controls_cleared': True,
                    'all_22_memory_contrasts_cleared': True,
                    'unchanged_candidate_advancement_veto': True,
                    'valid_adverse_latency_controls': [{'engine': 'node', 'endpoint': 'P:first'}],
                    'latency': [{'status': 'adverse', 'statistic': 1.2}],
                    'memory': [{'status': 'conditions_satisfied', 'saving_bytes': 600000}]}
        self.module.invalidate_positive_summary(analysis, 'final source hash failed')
        self.assertFalse(analysis['complete'])
        self.assertFalse(analysis['scoped_node_lead_eligible'])
        self.assertFalse(analysis['strong_scoped_screen_clearance'])
        self.assertFalse(analysis['bun_material_benefit_corroborated'])
        self.assertFalse(analysis['all_38_latency_controls_cleared'])
        self.assertFalse(analysis['all_22_memory_contrasts_cleared'])
        self.assertEqual(analysis['disposition'], 'material_adverse_control_veto')
        self.assertTrue(analysis['unchanged_candidate_advancement_veto'])
        self.assertEqual(analysis['latency'][0], {'status': 'adverse', 'statistic': 1.2})
        self.assertEqual(analysis['memory'][0]['saving_bytes'], 600000)
        self.assertEqual(analysis['valid_adverse_latency_controls'], [{'engine': 'node', 'endpoint': 'P:first'}])
        clean = {'complete': True, 'disposition': 'strong_scoped_screen_clearance',
                 'unchanged_candidate_advancement_veto': False}
        self.module.invalidate_positive_summary(clean, 'final preservation failed')
        self.assertEqual(clean['disposition'], 'inconclusive_or_incomplete')
        self.assertFalse(clean['strong_scoped_screen_clearance'])

    def synthetic_comparison(self):
        """Synthetic custody records only: no target, subject, clock or fixture call."""
        module = self.module
        job = dict(module.planned_jobs()[4])
        job['calibration'] = {case: {endpoint: {'k': 1, 'resolved': True} for endpoint in endpoints}
                              for case, endpoints in module.calibration_endpoint_set().items()}
        endpoints, chunks = {}, []
        for case, endpoint in module.iteration_order(job):
            endpoints[case + ':' + endpoint] = {'k': 1, 'warmup_ms': [20.] * 4,
                                                'measured_ms': [20.] * 6, 'eligible': True}
            for kind, count in [('warmup', 4), ('measured', 6)]:
                for index in range(count):
                    chunks.append({'event': 'sample', 'case': case, 'endpoint': endpoint,
                                   'kind': kind, 'index': index, 'k': 1, 'milliseconds': 20.})
        startup = {'before': {}, 'after': {}, 'eligible': True, 'invalid_reasons': []}
        import_endpoint = {'k': 1, 'warmup_ms': [], 'measured_ms': [1.], 'eligible': True}
        endpoints['startup:import'] = import_endpoint
        cases = {}
        for case in module.MEMORY_CASES:
            raw = {} if case in ('N4096', 'N4097', 'N8192', 'N8193', 'P') else None
            cases[case] = {'cycles': [{'before': {}, 'rawPaused': raw, 'paused': {}, 'released': {},
                                      'resumed_ok': True} for _ in range(2 if case == 'P' else 1)]}
        memory = {'cases': cases}
        result = {'endpoints': endpoints, 'startup': startup, 'memory': memory}
        phase = lambda name: {'event': 'phase', 'phase': name}
        records = [phase('startup'), {'event': 'startup', 'startup': startup, 'endpoint': import_endpoint},
                   phase('setup'), phase('memory'), {'event': 'memory', 'memory': memory}, phase('latency')]
        records += chunks + [phase('final'), {'event': 'result', 'result': result}, phase('exit')]
        return job, records

    def test_synthetic_complete_custody_and_missing_chunk(self):
        job, records = self.synthetic_comparison()
        self.module.validate_comparison_records(job, records)
        del records[6]
        with self.assertRaises(ValueError):
            self.module.validate_comparison_records(job, records)

    def test_synthetic_startup_and_unresolved_calibration(self):
        job, records = self.synthetic_comparison()
        records[1]['endpoint'] = {'k': 1, 'warmup_ms': [], 'measured_ms': [2.], 'eligible': True}
        with self.assertRaises(ValueError):
            self.module.validate_comparison_records(job, records)
        job, records = self.synthetic_comparison()
        job['calibration']['N4097']['close']['resolved'] = False
        with self.assertRaises(ValueError):
            self.module.validate_comparison_records(job, records)
        records[-2]['result']['endpoints']['N4097:close']['eligible'] = False
        self.module.validate_comparison_records(job, records)

    def test_hosted_dependency_custody_keeps_reviewed_hidden_lock_exception(self):
        module = self.module
        manifest = {'mutable_cache_exclusions': ['.vite', '.vite-temp'],
                    'files': {'.package-lock.json': 'a' * 64, 'package/file': 'b' * 64},
                    'symlinks': {'.bin/bun': '../bun/bin/bun.exe'}}
        observed = {'files': {'.package-lock.json': 'c' * 64, 'package/file': 'b' * 64},
                    'symlinks': dict(manifest['symlinks']), 'other': {}}
        module.validate_dependency_inventory(observed, manifest, 'c' * 64)
        observed['files']['package/file'] = 'd' * 64
        with self.assertRaises(AssertionError):
            module.validate_dependency_inventory(observed, manifest, 'c' * 64)


if __name__ == '__main__':
    unittest.main()
