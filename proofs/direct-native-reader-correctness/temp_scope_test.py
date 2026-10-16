"""Bounded synthetic filesystem cases; no target imports or child processes."""
import ast
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
        self.scopes = {name: scopes.create_scope(self.root / name) for name in ['shared', 'package']}
        self.output = self.root / 'evidence'
        self.deadline = time.monotonic() + 30

    def tearDown(self):
        self.fixture.cleanup()

    def add(self, scope, name, text='keep'):
        path = self.scopes[scope]['path'] / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def clean(self, closed=True):
        return scopes.cleanup_scopes(self.scopes, self.output, self.deadline, closed)

    def receipt(self):
        return json.loads((self.output / 'receipt.json').read_text())

    def seed_both(self):
        return [self.add(name, 'retained') for name in self.scopes]

    def test_large_first_subtree_does_not_hide_package_prefix(self):
        for index in range(600): self.add('shared', 'many/' + str(index))
        prefix = self.add('shared', 'zerocopy-package-synthetic/retained')
        observation = scopes.snapshot(self.scopes['shared'], self.deadline)
        self.assertTrue(observation['complete'])
        self.assertTrue(observation['rootCoverageComplete'])
        self.assertFalse(observation['descendantSampleComplete'])
        self.assertEqual(len(observation['entries']), 512)
        self.assertLessEqual(observation['metadataBytes'], 128 * 1024)
        with self.assertRaisesRegex(ValueError, 'entry remains before cleanup'):
            scopes.package_workspaces_absent(observation)
        with self.assertRaisesRegex(ValueError, 'entry remains before cleanup'): self.clean()
        self.assertTrue(prefix.exists())
        self.assertEqual(len(list((self.scopes['shared']['path'] / 'many').iterdir())), 600)

    def test_complete_plan_above_old_cap_and_linear_receipts(self):
        for index in range(600): self.add('shared', 'many/' + str(index))
        self.add('package', 'ordinary')
        real_fsync = os.fsync
        with patch.object(scopes.os, 'fsync', wraps=real_fsync) as fsync:
            result = self.clean()
        self.assertTrue(result['complete'])
        self.assertEqual(result['deletedEntries'], 602)
        self.assertLessEqual(fsync.call_count, 40)
        self.assertEqual(result, self.receipt())
        self.assertTrue(all(not list(scope['path'].iterdir()) for scope in self.scopes.values()))
        pair = json.loads((self.output / 'plans-complete.json').read_text())
        self.assertEqual(pair['aggregateEntries'], 602)
        self.assertLessEqual(pair['aggregateBytes'], 2 * 1024 * 1024)
        journal = [json.loads(line) for line in (self.output / 'deleted.jsonl').read_text().splitlines()]
        self.assertEqual(sum(row['kind'] == 'deleted' for row in journal), 602)

    def test_containment_and_symlink_destinations(self):
        outside = self.root / 'outside'; outside.mkdir()
        sentinel = outside / 'sentinel'; sentinel.write_text('untouched')
        nested = self.add('shared', 'nested/file')
        (nested.parent / 'link').symlink_to(sentinel)
        (self.scopes['package']['path'] / 'outside-link').symlink_to(outside, target_is_directory=True)
        self.assertTrue(self.clean()['complete'])
        self.assertEqual(sentinel.read_text(), 'untouched')

    def test_closed_groups_required(self):
        files = self.seed_both()
        with self.assertRaisesRegex(ValueError, 'Closed groups'): self.clean(False)
        self.assertTrue(all(path.exists() for path in files))

    def test_second_plan_failure_blocks_removal_in_both_scopes(self):
        first = self.add('shared', 'retained')
        second = [self.add('package', 'many/' + str(i)) for i in range(8)]
        with patch.object(scopes, 'PLAN_ENTRIES', 4):
            with self.assertRaisesRegex(ValueError, 'plan entry cap'): self.clean()
        self.assertTrue(first.exists() and all(path.exists() for path in second))
        self.assertFalse((self.output / 'deleted.jsonl').exists())
        self.assertTrue((self.output / 'shared-plan.jsonl').exists())
        self.assertFalse(self.receipt()['complete'])

    def test_plan_byte_cap_and_depth_cap_are_terminal(self):
        files = self.seed_both()
        with patch.object(scopes, 'PLAN_BYTES', 6200):
            with self.assertRaisesRegex(ValueError, 'plan byte cap'): self.clean()
        self.assertTrue(all(path.exists() for path in files))
        self.output = self.root / 'second-evidence'
        deep = self.add('package', '/'.join(['d'] * 8) + '/leaf')
        with self.assertRaisesRegex(ValueError, 'plan depth cap'): self.clean()
        self.assertTrue(deep.exists() and all(path.exists() for path in files))

    def test_root_entry_and_byte_caps_remain_fail_closed(self):
        for index in range(513): self.add('shared', str(index))
        result = scopes.snapshot(self.scopes['shared'], self.deadline)
        self.assertFalse(result['complete'])
        self.assertFalse(result['rootCoverageComplete'])
        self.add('package', 'entry')
        with patch.object(scopes, 'MAX_METADATA_BYTES', 1):
            self.assertFalse(scopes.snapshot(self.scopes['package'], self.deadline)['complete'])

    def test_both_scope_prefix_additions_after_planning_block_first_removal(self):
        for target in ['shared', 'package']:
            with self.subTest(target=target):
                files = self.seed_both()
                original = scopes.make_plan
                def make(*args):
                    plan = original(*args)
                    if args[0] == 'package': self.add(target, 'zerocopy-package-late/retained')
                    return plan
                with patch.object(scopes, 'make_plan', side_effect=make):
                    with self.assertRaisesRegex(ValueError, 'entry remains before cleanup'): self.clean()
                self.assertTrue(all(path.exists() for path in files))
                self.assertFalse((self.output / 'deleted.jsonl').exists())
                self.output = self.root / ('evidence-' + target)
                for scope in self.scopes.values():
                    prefix = scope['path'] / 'zerocopy-package-late'
                    if prefix.exists(): (prefix / 'retained').unlink(); prefix.rmdir()

    def test_root_replacement_after_planning_is_terminal(self):
        files = self.seed_both(); original = scopes.make_plan
        def make(*args):
            plan = original(*args)
            if args[0] == 'package':
                self.scopes['shared']['path'].rename(self.root / 'original-shared')
                self.scopes['shared']['path'].mkdir()
                self.add('shared', 'new')
            return plan
        with patch.object(scopes, 'make_plan', side_effect=make):
            with self.assertRaisesRegex(ValueError, 'root identity changed'): self.clean()
        self.assertTrue((self.root / 'original-shared/retained').exists() and files[1].exists())
        self.assertTrue((self.scopes['shared']['path'] / 'new').exists())

    def test_ancestor_symlink_substitution_never_escapes(self):
        self.add('shared', 'nested/sentinel')
        outside = self.root / 'outside'; outside.mkdir()
        sentinel = outside / 'sentinel'; sentinel.write_text('untouched')
        original = scopes.remove_record; changed = False
        def remove(scope, row):
            nonlocal changed
            if not changed:
                changed = True
                (scope['path'] / 'nested').rename(self.root / 'original-nested')
                (scope['path'] / 'nested').symlink_to(outside, target_is_directory=True)
            return original(scope, row)
        with patch.object(scopes, 'remove_record', side_effect=remove):
            with self.assertRaises(OSError): self.clean()
        self.assertEqual(sentinel.read_text(), 'untouched')
        self.assertTrue((self.root / 'original-nested/sentinel').exists())

    def test_leaf_replacement_retains_both_identities(self):
        self.add('shared', 'leaf'); original = scopes.remove_record
        def remove(scope, row):
            path = scope['path'] / row['name']
            path.rename(self.root / 'original-leaf')
            path.write_text('replacement')
            return original(scope, row)
        with patch.object(scopes, 'remove_record', side_effect=remove):
            with self.assertRaisesRegex(ValueError, 'entry identity changed'): self.clean()
        self.assertEqual((self.root / 'original-leaf').read_text(), 'keep')
        self.assertEqual((self.scopes['shared']['path'] / 'leaf').read_text(), 'replacement')

    def test_changed_plan_after_authentication_cannot_change_next_record(self):
        for name in ['a', 'b', 'c']: self.add('shared', name)
        plans = {}; make = scopes.make_plan; remove = scopes.remove_record; changed = False
        def capture(*args):
            plan = make(*args); plans[args[0]] = plan; return plan
        def mutate(scope, row):
            nonlocal changed
            remove(scope, row)
            if not changed:
                changed = True
                plan = plans['shared']; position = plan['stream'].tell()
                data = plan['path'].read_bytes()
                following = data[position:]
                self.assertIn(b'"sizeBytes":4', following)
                data = data[:position] + following.replace(b'"sizeBytes":4', b'"sizeBytes":5', 1)
                plan['path'].write_bytes(data)
                plan['stream'].seek(position)
        with patch.object(scopes, 'make_plan', side_effect=capture), patch.object(scopes, 'remove_record', side_effect=mutate):
            with self.assertRaisesRegex(ValueError, 'plan record changed'): self.clean()
        self.assertEqual(len(list(self.scopes['shared']['path'].iterdir())), 2)

    def test_journal_cap_precedes_unacknowledged_removal(self):
        for index in range(12): self.add('shared', 'entry-' + str(index))
        removed = []; original = scopes.remove_record
        def remove(scope, row):
            original(scope, row); removed.append(row['name'])
        with patch.object(scopes, 'JOURNAL_BYTES', 2000), patch.object(scopes, 'remove_record', side_effect=remove):
            with self.assertRaisesRegex(ValueError, 'journal byte cap'): self.clean()
        rows = [json.loads(line) for line in (self.output / 'deleted.jsonl').read_text().splitlines()]
        self.assertEqual(removed, [row['name'] for row in rows if row['kind'] == 'deleted'])
        self.assertLess(len(removed), 12)

    def test_journal_io_failure_has_explicit_uncertain_tail(self):
        path = self.add('shared', 'leaf'); original = Path.open
        class FailingJournal:
            def __init__(self, stream): self.stream = stream
            def __getattr__(self, name): return getattr(self.stream, name)
            def write(self, data):
                if b'"kind":"deleted"' in data: raise OSError('synthetic append failure')
                return self.stream.write(data)
        def opened(path, *args, **kwargs):
            stream = original(path, *args, **kwargs)
            return FailingJournal(stream) if path.name == 'deleted.jsonl' and args and args[0] == 'x+b' else stream
        with patch.object(Path, 'open', opened):
            with self.assertRaises(OSError): self.clean()
        self.assertFalse(path.exists())
        self.assertFalse(self.receipt()['complete'])
        self.assertTrue(self.receipt()['uncertainTailPossible'])
        self.assertEqual(self.receipt()['confirmedAcknowledgments'], 0)

    def test_changed_journal_cannot_claim_durable_completion(self):
        self.add('shared', 'leaf'); original = scopes.top_entries; changed = False
        def scan(scope, stop):
            nonlocal changed
            rows = original(scope, stop)
            journal = self.output / 'deleted.jsonl'
            if journal.exists() and not changed:
                changed = True
                journal.rename(self.output / 'original-journal.jsonl')
                journal.write_bytes(b'changed')
            return rows
        with patch.object(scopes, 'top_entries', side_effect=scan):
            with self.assertRaisesRegex(ValueError, 'journal identity/size changed'): self.clean()
        self.assertFalse(self.receipt()['complete'])
        self.assertTrue((self.output / 'original-journal.jsonl').exists())

    def test_short_journal_write_is_incomplete(self):
        leaf = self.add('shared', 'leaf'); original = Path.open
        class ShortJournal:
            def __init__(self, stream): self.stream = stream
            def __getattr__(self, name): return getattr(self.stream, name)
            def write(self, data):
                if b'"kind":"deleted"' in data:
                    self.stream.write(data[:-1]); return len(data) - 1
                return self.stream.write(data)
        def opened(path, *args, **kwargs):
            stream = original(path, *args, **kwargs)
            return ShortJournal(stream) if path.name == 'deleted.jsonl' and args and args[0] == 'x+b' else stream
        with patch.object(Path, 'open', opened):
            with self.assertRaisesRegex(ValueError, 'journal short write'): self.clean()
        self.assertFalse(leaf.exists())
        self.assertFalse(self.receipt()['complete'])
        self.assertTrue(self.receipt()['uncertainTailPossible'])

    def test_new_unplanned_entry_fails_independent_empty_after(self):
        self.add('shared', 'leaf'); original = scopes.remove_record
        def remove(scope, row):
            original(scope, row); self.add('package', 'unplanned')
        with patch.object(scopes, 'remove_record', side_effect=remove):
            with self.assertRaisesRegex(ValueError, 'not empty after cleanup'): self.clean()
        self.assertTrue((self.scopes['package']['path'] / 'unplanned').exists())
        self.assertFalse(self.receipt()['complete'])

    def test_late_plan_fsync_prevents_all_removal(self):
        files = self.seed_both(); clock = [0.0]; calls = 0; original = os.fsync
        def fsync(fd):
            nonlocal calls
            original(fd); calls += 1
            if calls == 2: clock[0] = 6.0
        with patch.object(scopes.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(scopes.os, 'fsync', side_effect=fsync):
            with self.assertRaisesRegex(ValueError, 'deadline'): self.clean()
        self.assertTrue(all(path.exists() for path in files))

    def test_root_scan_keeps_five_second_limit_inside_transaction(self):
        leaf = self.add('shared', 'retained'); clock = [0.0]; original = scopes.metadata
        def metadata(entry, prefix=''):
            result = original(entry, prefix)
            clock[0] = 6.0
            return result
        with patch.object(scopes.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(scopes, 'metadata', side_effect=metadata):
            with self.assertRaisesRegex(ValueError, 'deadline'):
                scopes.top_entries(self.scopes['shared'], 9.0)
        self.assertTrue(leaf.exists())

    def test_late_final_receipt_cannot_claim_complete(self):
        self.add('shared', 'leaf'); clock = [0.0]; original = scopes.write
        def write(path, value):
            original(path, value)
            if Path(path).name == 'receipt.json' and value['complete']: clock[0] = 11.0
        with patch.object(scopes.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(scopes, 'write', side_effect=write):
            with self.assertRaisesRegex(ValueError, 'final receipt exceeded'): self.clean()
        self.assertFalse(self.receipt()['complete'])

    def test_special_entry_and_expired_deadline_preserve_files(self):
        files = self.seed_both(); fifo = self.scopes['package']['path'] / 'fifo'; os.mkfifo(fifo)
        with self.assertRaisesRegex(ValueError, 'special entry'): self.clean()
        self.assertTrue(all(path.exists() for path in files) and fifo.exists())
        self.output = self.root / 'expired-evidence'; self.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(ValueError, 'deadline'): self.clean()
        self.assertTrue(all(path.exists() for path in files))

    def test_each_controller_checkpoint_rejects_shared_package_prefix(self):
        self.add('shared', 'zerocopy-package-residual/keep')
        self.output.mkdir()
        tree = ast.parse(Path(__file__).with_name('run.py').read_text())
        main = next(row for row in tree.body if isinstance(row, ast.FunctionDef) and row.name == 'main')
        function = next(row for row in main.body if isinstance(row, ast.FunctionDef) and row.name == 'record_temporary_scopes')
        namespace = {'time': time, 'deadline': self.deadline, 'SCAN_SECONDS': scopes.SCAN_SECONDS,
                     'processes_closed': lambda: True, 'temporary_scopes': self.scopes, 'snapshot': scopes.snapshot,
                     'write': scopes.write, 'require': scopes.require, 'package_workspaces_absent': scopes.package_workspaces_absent,
                     'output': self.output, 'bounded': bounded, 'work': self.root}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<synthetic-checkpoint-helper>', 'exec'), namespace)
        for checkpoint in ['before-package', 'after-package', 'after-archive', 'before-cleanup']:
            with self.subTest(checkpoint=checkpoint):
                with self.assertRaisesRegex(ValueError, 'entry remains before cleanup'):
                    namespace['record_temporary_scopes'](checkpoint)
                retained = json.loads((self.output / ('temporary-' + checkpoint + '.json')).read_text())
                self.assertTrue(retained['scopes']['shared']['rootCoverageComplete'])

    def test_pair_completion_replacement_or_growth_blocks_removal(self):
        files = self.seed_both(); original = scopes.verify_pair; changed = False
        def verify(path, expected_identity, data, stop):
            nonlocal changed
            if not changed:
                changed = True
                with path.open('ab') as stream: stream.write(b'x' * 4096)
            return original(path, expected_identity, data, stop)
        with patch.object(scopes, 'verify_pair', side_effect=verify):
            with self.assertRaisesRegex(ValueError, 'identity/size changed'): self.clean()
        self.assertTrue(all(path.exists() for path in files))

    def test_primary_child_error_survives_secondary_inventory_error(self):
        original = ValueError('synthetic child failure'); status = {}
        def operation(): raise original
        def after(): raise ValueError('synthetic inventory failure')
        with patch.dict(bounded.CHILD_ENVIRONMENT, {'TMPDIR': 'shared'}):
            with self.assertRaises(ValueError) as caught:
                run_package_consumer(operation, after, self.scopes['package']['path'], status)
            self.assertIs(caught.exception, original)
            self.assertEqual(bounded.CHILD_ENVIRONMENT['TMPDIR'], 'shared')
        self.assertTrue(status['secondaryTemporaryInventoryError']['primaryFailurePreserved'])

    def test_inventory_failure_after_success_remains_terminal(self):
        status = {}
        def after(): raise ValueError('synthetic inventory failure')
        with patch.dict(bounded.CHILD_ENVIRONMENT, {'TMPDIR': 'shared'}):
            with self.assertRaisesRegex(ValueError, 'inventory failure'):
                run_package_consumer(lambda: None, after, self.scopes['package']['path'], status)
            self.assertEqual(bounded.CHILD_ENVIRONMENT['TMPDIR'], 'shared')
        self.assertEqual(status, {})


if __name__ == '__main__':
    unittest.main()
