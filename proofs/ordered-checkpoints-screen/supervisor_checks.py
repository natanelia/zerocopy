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
    spec = importlib.util.spec_from_file_location('ordered_supervisor', Path(__file__).with_name('run-hosted.py'))
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
            'probe': [('probe', 15)],
            'calibration': [('setup', 20), ('calibration', 60), ('final', 10)],
            'comparison': [('setup', 20), ('memory', 8), ('latency', 22), ('final', 5), ('exit', 5)]})
        jobs = self.module.planned_jobs()
        self.assertEqual([job['mode'] for job in jobs[:4]], ['probe', 'probe', 'calibration', 'calibration'])
        self.assertEqual(len(jobs), 36)
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
        analysis = {'complete': True, 'disposition': 'promising_temporary_heap_lead',
                    'all_28_iteration_controls_cleared': True, 'both_engine_memory_conditions_satisfied': True,
                    'unchanged_candidate_advancement_veto': True,
                    'valid_adverse_latency_controls': [{'engine': 'node', 'endpoint': 'P:first'}],
                    'latency': [{'status': 'adverse', 'statistic': 1.2}, {'status': 'cleared', 'statistic': .9}],
                    'memory': [{'status': 'conditions_satisfied', 'saving_bytes': 600000}]}
        self.module.invalidate_positive_summary(analysis, 'final source hash failed')
        self.assertFalse(analysis['complete'])
        self.assertFalse(analysis['all_28_iteration_controls_cleared'])
        self.assertFalse(analysis['both_engine_memory_conditions_satisfied'])
        self.assertEqual(analysis['disposition'], 'inconclusive_or_incomplete')
        self.assertTrue(analysis['unchanged_candidate_advancement_veto'])
        self.assertEqual(analysis['latency'][0], {'status': 'adverse', 'statistic': 1.2})
        self.assertEqual(analysis['memory'][0]['saving_bytes'], 600000)
        analysis['disposition'] = 'memory_conditions_met_accounting_review_required'
        self.module.invalidate_positive_summary(analysis, 'final preservation failed')
        self.assertEqual(analysis['disposition'], 'inconclusive_or_incomplete')
        self.assertEqual(analysis['latency'][0], {'status': 'adverse', 'statistic': 1.2})
        self.assertEqual(analysis['memory'][0]['saving_bytes'], 600000)


if __name__ == '__main__':
    unittest.main()
