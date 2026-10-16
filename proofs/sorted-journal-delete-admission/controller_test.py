"""Pure diagnostic controller checks using synthetic process and reporter records."""
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('diagnostic', HERE / 'run.py')
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class SyntheticFile:
    def __init__(self, text=''):
        self.text = text
    def stat(self):
        return SimpleNamespace(st_size=len(self.text.encode()))
    def read_text(self):
        return self.text
    def is_file(self):
        return True


def proc(pid, group=7, resident=12):
    fields = ['0'] * 30
    for index, value in {0: 'S', 1: '3', 2: str(group), 11: '19', 12: '23', 17: '5', 19: '101'}.items():
        fields[index] = value
    values = {'stat': f'{pid} (synthetic ) name) ' + ' '.join(fields), 'status': f'Name:\tsynthetic\nVmRSS:\t{resident} kB\n'}
    class Entry:
        name = str(pid)
        def __truediv__(self, name):
            return SyntheticFile(values[name])
    return Entry()


class ControllerChecks(unittest.TestCase):
    def test_process_fields_and_group_filter(self):
        with patch.object(diagnostic, 'Path', return_value=SimpleNamespace(iterdir=lambda: [proc(11), proc(12, group=8)])):
            self.assertEqual(diagnostic.group_members(7, details=True), [{'pid': 11, 'rss': 12288, 'state': 'S', 'ppid': 3,
                'processStartTicks': 101, 'userCpuTicks': 19, 'systemCpuTicks': 23, 'threads': 5}])
            self.assertEqual(diagnostic.group_members(7), [{'pid': 11, 'rss': 12288, 'state': 'S'}])

    def test_process_record_is_bounded_scalar_json(self):
        stream, counter = io.BytesIO(), {'records': 0, 'bytes': 0}
        with patch.object(diagnostic.time, 'time', return_value=100):
            diagnostic.process_record(stream, counter, [{'pid': 9, 'rss': 12, 'state': 'S'}], 1.5, SyntheticFile('ab'), SyntheticFile('c'), terminal=True)
        row = json.loads(stream.getvalue())
        self.assertEqual(row, {'v': 1, 'seq': 1, 'observedElapsedSeconds': 1.5, 'observedUnix': 100, 'terminal': True,
                              'processes': [{'pid': 9, 'rss': 12, 'state': 'S'}], 'stdoutBytes': 2, 'stderrBytes': 1})
        self.assertEqual(counter, {'records': 1, 'bytes': len(stream.getvalue())})

    def test_process_caps_fail_before_write(self):
        for rows, counter in [([{'pid': 1}] * 65, {'records': 0, 'bytes': 0}),
                              ([], {'records': 2000, 'bytes': 0}), ([], {'records': 0, 'bytes': diagnostic.PROCESS_MAX_BYTES})]:
            with self.subTest(rows=len(rows), counter=counter):
                stream = io.BytesIO()
                with self.assertRaises(AssertionError):
                    diagnostic.process_record(stream, counter, rows, 0, SyntheticFile(), SyntheticFile())
                self.assertEqual(stream.getvalue(), b'')

    def test_process_io_failure_propagates(self):
        class Broken(io.BytesIO):
            def write(self, _value): raise OSError('synthetic')
        with self.assertRaises(OSError):
            diagnostic.process_record(Broken(), {'records': 0, 'bytes': 0}, [], 0, SyntheticFile(), SyntheticFile())

    def test_reporter_clean_end_required(self):
        rows = [{'seq': 1, 'event': 'run-start'}, {'seq': 2, 'event': 'run-end', 'reason': 'passed'}]
        def file(items): return SyntheticFile(''.join(json.dumps(row) + '\n' for row in items))
        with patch.object(diagnostic, 'sha', return_value='synthetic-sha'):
            self.assertEqual(diagnostic.validate_reporter(file(rows))['records'], 2)
            for invalid in [rows[:1], [rows[0], {'seq': 2, 'event': 'limit'}],
                            [rows[0], {'seq': 2, 'event': 'run-end', 'reason': 'failed'}],
                            [rows[0], {'seq': 3, 'event': 'run-end', 'reason': 'passed'}]]:
                with self.assertRaises(AssertionError): diagnostic.validate_reporter(file(invalid))

    def test_fixed_limits_and_no_study(self):
        self.assertEqual((diagnostic.ADMISSION_SECONDS, diagnostic.ADMISSION_RSS, diagnostic.POLL_SECONDS), (1620, 4 * 1024 ** 3, .05))
        self.assertEqual((diagnostic.PROCESS_SECONDS, diagnostic.PROCESS_MAX_ROWS, diagnostic.PROCESS_MAX_RECORDS, diagnostic.PROCESS_MAX_BYTES), (1, 64, 2000, 8 * 1024 ** 2))
        source = (HERE / 'run.py').read_text()
        self.assertNotIn('def run_subject', source)
        self.assertNotIn('def analyze', source)
        self.assertNotIn('subject.mjs', source)
        self.assertIn("'studyChildrenStarted': 0", source)
        self.assertIn("'non-reproduction; original failure remains unresolved'", source)
        self.assertEqual(source.count("[bun, 'run', 'prepublishOnly']"), 1)
        self.assertIn("root, 600,", source)
        self.assertIn("'proofs/node-worker.mjs'], root, 90", source)
        self.assertIn("'proofs/typed-json-worker.mjs'], root, 90", source)

    def test_config_only_adds_reporter_and_heap(self):
        root = HERE.parent.parent
        config = (root / 'vitest.config.ts').read_text()
        original = config.replace("    reporters: ['default', './proofs/sorted-journal-delete-admission/reporter.mjs'],\n    logHeapUsage: true,\n", '')
        import hashlib
        self.assertEqual(hashlib.sha256(original.encode()).hexdigest(), '6bae9f4e513173dec6c089c4fcaf3957c5cb9aa3195173f1d5ace6a60140a489')
        self.assertEqual(diagnostic.sha(root / 'persistent-core.as.ts'), diagnostic.PRODUCTION_PINS['persistent-core.as.ts']['candidate'])
        self.assertEqual(diagnostic.sha(HERE / 'METHOD.md'), diagnostic.METHOD_SHA256)

    def test_workflow_caps_and_scope(self):
        workflow = (HERE.parent.parent / '.github/workflows/sorted-journal-delete-admission.yml').read_text()
        self.assertIn('timeout-minutes: 35', workflow)
        self.assertIn('branches: [proof/sorted-journal-delete-admission-diagnostic-20261016]', workflow)
        self.assertNotIn('\n    env:', workflow)
        self.assertNotIn('subject.mjs', workflow)
        self.assertIn('if: always()', workflow)
        self.assertIn('persist-credentials: false', workflow)
        self.assertIn('test "$GITHUB_RUN_ATTEMPT" = 1', workflow)


if __name__ == '__main__': unittest.main()
