"""Bounded synthetic transplant cases; no target imports or child processes."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bounded_process import sha
from test_transplant import transplanted_test, MAX_TEST_BYTES


class TestTransplant(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='transplant-test-')
        self.root = Path(self.fixture.name)
        self.baseline, self.candidate = self.root / 'baseline', self.root / 'candidate'
        self.original, self.replacement = b'baseline test text\n', b'candidate test text\n'
        self.baseline.write_bytes(self.original)
        self.candidate.write_bytes(self.replacement)
        self.old_sha, self.new_sha = sha(self.baseline), sha(self.candidate)
        self.receipt = {}

    def tearDown(self):
        self.fixture.cleanup()

    def enter(self):
        return transplanted_test(self.baseline, self.candidate, self.old_sha, self.new_sha, self.receipt)

    def test_success_restores_exact_bytes(self):
        with self.enter():
            self.assertEqual(self.baseline.read_bytes(), self.replacement)
        self.assertEqual(self.baseline.read_bytes(), self.original)
        self.assertTrue(self.receipt['installed'] and self.receipt['restored'])
        self.assertEqual(self.candidate.read_bytes(), self.replacement)

    def test_primary_failure_restores_and_propagates(self):
        with self.assertRaisesRegex(RuntimeError, '^primary$'):
            with self.enter():
                raise RuntimeError('primary')
        self.assertTrue(self.receipt['restored'])
        self.assertEqual(self.baseline.read_bytes(), self.original)

    def test_base_exception_restores(self):
        with self.assertRaises(KeyboardInterrupt):
            with self.enter():
                raise KeyboardInterrupt()
        self.assertTrue(self.receipt['restored'])

    def test_baseline_hash_mismatch_does_not_write(self):
        self.baseline.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Baseline test source mismatch'):
            with self.enter():
                self.fail('body must not run')
        self.assertEqual(self.baseline.read_bytes(), b'changed')

    def test_candidate_hash_mismatch_does_not_write(self):
        self.candidate.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Candidate test source mismatch'):
            with self.enter():
                self.fail('body must not run')
        self.assertEqual(self.baseline.read_bytes(), self.original)

    def test_mutation_is_terminal_then_original_is_restored(self):
        with self.assertRaisesRegex(ValueError, 'changed during validation'):
            with self.enter():
                self.baseline.write_bytes(b'modified during validation')
        self.assertTrue(self.receipt['restored'])
        self.assertEqual(self.baseline.read_bytes(), self.original)

    def test_partial_install_write_failure_restores(self):
        real_write = Path.write_bytes
        def fail_once(path, data):
            if path == self.baseline and data == self.replacement:
                real_write(path, b'partial')
                raise OSError('install failed')
            return real_write(path, data)
        with patch.object(Path, 'write_bytes', fail_once):
            with self.assertRaisesRegex(OSError, 'install failed'):
                with self.enter():
                    self.fail('body must not run')
        self.assertTrue(self.receipt['restored'])
        self.assertEqual(self.baseline.read_bytes(), self.original)

    def test_restore_failure_is_terminal(self):
        real_write = Path.write_bytes
        def fail_restore(path, data):
            if path == self.baseline and data == self.original:
                raise OSError('restore failed')
            return real_write(path, data)
        with patch.object(Path, 'write_bytes', fail_restore):
            with self.assertRaisesRegex(OSError, 'restore failed'):
                with self.enter():
                    pass
        self.assertFalse(self.receipt['restored'])
        self.assertFalse(self.receipt['restorationError']['primaryFailurePreserved'])

    def test_restore_failure_does_not_replace_primary_failure(self):
        real_write = Path.write_bytes
        def fail_restore(path, data):
            if path == self.baseline and data == self.original:
                raise OSError('restore failed')
            return real_write(path, data)
        with patch.object(Path, 'write_bytes', fail_restore):
            with self.assertRaisesRegex(RuntimeError, '^primary$'):
                with self.enter():
                    raise RuntimeError('primary')
        self.assertFalse(self.receipt['restored'])
        self.assertTrue(self.receipt['restorationError']['primaryFailurePreserved'])

    def test_symlink_rejected_without_following(self):
        self.baseline.unlink()
        self.baseline.symlink_to(self.candidate)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            with self.enter():
                self.fail('body must not run')
        self.assertEqual(self.candidate.read_bytes(), self.replacement)

    def test_identity_change_does_not_overwrite_replacement(self):
        alternate = self.root / 'alternate'
        alternate.write_bytes(b'new inode')
        with self.assertRaisesRegex(ValueError, 'changed during validation'):
            with self.enter():
                alternate.replace(self.baseline)
        self.assertEqual(self.baseline.read_bytes(), b'new inode')
        self.assertFalse(self.receipt['restored'])
        self.assertTrue(self.receipt['restorationError']['primaryFailurePreserved'])

    def test_oversized_source_rejected(self):
        self.candidate.write_bytes(b'x' * (MAX_TEST_BYTES + 1))
        with self.assertRaisesRegex(ValueError, 'finite size bound'):
            with self.enter():
                self.fail('body must not run')
        self.assertEqual(self.baseline.read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()
