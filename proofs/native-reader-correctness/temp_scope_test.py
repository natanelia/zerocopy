"""Synthetic filesystem tests only; no target imports or child processes."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import temp_scopes as scopes
from run import run_package_consumer
import bounded_process as bounded


class TemporaryScopes(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='scope-test-')
        self.root = Path(self.fixture.name)
        self.scope = scopes.create_scope(self.root / 'owned')
        self.receipt = self.root / 'receipt.json'
        self.deadline = time.monotonic() + 30

    def tearDown(self):
        self.fixture.cleanup()

    def test_package_residue_is_terminal_before_any_deletion(self):
        residual = self.scope['path'] / 'zerocopy-package-synthetic'
        residual.mkdir()
        sentinel = residual / 'retained.txt'
        sentinel.write_text('retain')
        with self.assertRaisesRegex(ValueError, 'entry remains before cleanup'):
            scopes.cleanup_scope(self.scope, self.receipt, self.deadline, True, package=True)
        receipt = json.loads(self.receipt.read_text())
        self.assertFalse(receipt['complete'])
        self.assertEqual(receipt['deleted'], [])
        self.assertEqual(sentinel.read_text(), 'retain')
        with self.assertRaisesRegex(ValueError, 'entry remains before cleanup'):
            scopes.cleanup_scope(self.scope, self.receipt, self.deadline, True, package=False)
        self.assertEqual(json.loads(self.receipt.read_text())['deleted'], [])
        self.assertEqual(sentinel.read_text(), 'retain')

    def test_contained_cleanup_receipt_and_symlinks(self):
        outside = self.root / 'outside.txt'
        outside.write_text('untouched')
        nested = self.scope['path'] / 'nested'
        nested.mkdir()
        (nested / 'scratch.txt').write_text('scratch')
        (nested / 'link').symlink_to(outside)
        (self.scope['path'] / 'linked-directory').symlink_to(self.root, target_is_directory=True)
        before = scopes.snapshot(self.scope, self.deadline)
        self.assertTrue(before['complete'])
        self.assertEqual({row['name'] for row in before['entries']},
                         {'nested', 'nested/scratch.txt', 'nested/link', 'linked-directory'})
        result = scopes.cleanup_scope(self.scope, self.receipt, self.deadline, True)
        self.assertTrue(result['complete'])
        self.assertEqual(result['after']['entries'], [])
        self.assertEqual(len(result['deleted']), 4)
        self.assertEqual(json.loads(self.receipt.read_text()), result)
        self.assertEqual(outside.read_text(), 'untouched')

    def test_unclosed_process_custody_blocks_deletion(self):
        (self.scope['path'] / 'scratch').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'closed owned process groups'):
            scopes.cleanup_scope(self.scope, self.receipt, self.deadline, False)
        self.assertTrue((self.scope['path'] / 'scratch').exists())
        self.assertEqual(json.loads(self.receipt.read_text())['deleted'], [])

    def test_metadata_entry_byte_and_depth_caps(self):
        (self.scope['path'] / 'a').write_text('a')
        (self.scope['path'] / 'b').write_text('b')
        with patch.object(scopes, 'MAX_ENTRIES', 1):
            entry_limited = scopes.snapshot(self.scope, self.deadline)
            self.assertFalse(entry_limited['complete'])
            self.assertEqual(len(entry_limited['entries']), 1)
            with self.assertRaisesRegex(ValueError, 'inventory incomplete'):
                scopes.cleanup_scope(self.scope, self.receipt, self.deadline, True)
            self.assertEqual(json.loads(self.receipt.read_text())['deleted'], [])
        with patch.object(scopes, 'MAX_METADATA_BYTES', 1):
            byte_limited = scopes.snapshot(self.scope, self.deadline)
            self.assertFalse(byte_limited['complete'])
            self.assertEqual(byte_limited['metadataBytes'], 0)
        (self.scope['path'] / 'directory').mkdir()
        (self.scope['path'] / 'directory' / 'child').write_text('keep')
        with patch.object(scopes, 'MAX_DEPTH', 1):
            self.assertFalse(scopes.snapshot(self.scope, self.deadline)['complete'])

    def test_replaced_root_and_root_symlink_are_rejected(self):
        original = self.root / 'original'
        self.scope['path'].rename(original)
        self.scope['path'].mkdir()
        self.assertFalse(scopes.snapshot(self.scope, self.deadline)['complete'])
        self.scope['path'].rmdir()
        self.scope['path'].symlink_to(original, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'inventory incomplete'):
            scopes.cleanup_scope(self.scope, self.receipt, self.deadline, True)
        self.assertTrue(original.is_dir())
        self.assertEqual(json.loads(self.receipt.read_text())['deleted'], [])

    def test_special_entries_are_retained(self):
        fifo = self.scope['path'] / 'fifo'
        os.mkfifo(fifo)
        self.assertFalse(scopes.snapshot(self.scope, self.deadline)['complete'])
        with self.assertRaisesRegex(ValueError, 'inventory incomplete'):
            scopes.cleanup_scope(self.scope, self.receipt, self.deadline, True)
        self.assertTrue(fifo.exists())
        self.assertEqual(json.loads(self.receipt.read_text())['deleted'], [])

    def test_package_failure_keeps_primary_and_records_secondary(self):
        original = ValueError('synthetic child failure')
        status = {}
        def operation():
            self.assertEqual(bounded.CHILD_ENVIRONMENT['TMPDIR'], str(self.scope['path']))
            raise original
        def after():
            self.assertEqual(bounded.CHILD_ENVIRONMENT['TMPDIR'], 'synthetic-shared')
            raise ValueError('synthetic inventory failure')
        with patch.dict(bounded.CHILD_ENVIRONMENT, {'TMPDIR': 'synthetic-shared'}):
            with self.assertRaises(ValueError) as caught:
                run_package_consumer(operation, after, self.scope['path'], status)
            self.assertIs(caught.exception, original)
            self.assertEqual(bounded.CHILD_ENVIRONMENT['TMPDIR'], 'synthetic-shared')
        self.assertEqual(status['secondaryTemporaryInventoryError']['error'], 'synthetic inventory failure')
        self.assertTrue(status['secondaryTemporaryInventoryError']['primaryFailurePreserved'])

    def test_inventory_failure_after_package_success_remains_terminal(self):
        status = {}
        def after():
            raise ValueError('synthetic inventory failure')
        with patch.dict(bounded.CHILD_ENVIRONMENT, {'TMPDIR': 'synthetic-shared'}):
            with self.assertRaisesRegex(ValueError, 'synthetic inventory failure'):
                run_package_consumer(lambda: None, after, self.scope['path'], status)
            self.assertEqual(bounded.CHILD_ENVIRONMENT['TMPDIR'], 'synthetic-shared')
        self.assertEqual(status, {})

    def test_expired_deadline_keeps_scratch(self):
        scratch = self.scope['path'] / 'scratch'
        scratch.write_text('keep')
        with self.assertRaisesRegex(ValueError, 'inventory incomplete'):
            scopes.cleanup_scope(self.scope, self.receipt, time.monotonic() - 1, True)
        self.assertTrue(scratch.exists())
        self.assertEqual(json.loads(self.receipt.read_text())['deleted'], [])


if __name__ == '__main__':
    unittest.main()
