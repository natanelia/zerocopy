"""Pure resource models: no real spawn, prctl, signals, /proc or clocks."""
import copy
import io
import itertools
import json
import unittest
from contextlib import ExitStack
from unittest.mock import patch
import resource_ownership as r

CONTROLLER = {'pid': 900, 'state': 'S', 'ppid': 1, 'group': 900, 'session': 900, 'startTicks': 1}
ROOT = {'pid': 111, 'state': 'S', 'ppid': 900, 'group': 111, 'session': 111, 'startTicks': 10}
ENGINE = {'pid': 222, 'state': 'S', 'ppid': 111, 'group': 222, 'session': 222, 'startTicks': 20}
BINDING = {'slotId': 'chromium-untimed-baseline', 'manifestSha256': 'a' * 64, 'runtime': 'chromium', 'lane': 'x64', 'arm': 'baseline', 'mode': 'untimed'}


def journal_rows(count=4):
    rows = [{'kind': 'ownership-ready', 'adapter': ROOT}, {'kind': 'engine-spawn-intent', 'attempt': 1},
            {'kind': 'engine-spawned', 'attempt': 1, 'identity': ENGINE}, {'kind': 'ownership-sealed', 'attempts': 1, 'engineExited': True}]
    return [dict(schema=1, sequence=index, binding=BINDING, **row) for index, row in enumerate(rows[:count])]


def journal_bytes(count=4):
    return ''.join(json.dumps(row) + '\n' for row in journal_rows(count)).encode()


class Model:
    def __init__(self, *children, journal=None, invisible_children=False):
        self.table = {value['pid']: copy.deepcopy(value) for value in (CONTROLLER, *children)}
        self.signals = []
        self.waits = []
        self.journal = journal
        self.invisible_children = invisible_children
        self.clock = itertools.count(0, .05)

    def signal(self, target, number, group=False):
        self.signals.append((target, number, group))
        for value in self.table.values():
            if value['pid'] != CONTROLLER['pid'] and (value['group'] == target if group else value['pid'] == target):
                value['state'] = 'Z'

    def wait(self, pid, flags):
        self.waits.append(pid)
        value = self.table.get(pid)
        if value is None or value['ppid'] != CONTROLLER['pid']:
            raise ChildProcessError()
        if value['state'] == 'Z':
            del self.table[pid]
            return pid, 0
        return 0, 0

    def child(self):
        model = self
        class Child:
            pid = ROOT['pid']
            def poll(self):
                return None if self.pid in model.table and model.table[self.pid]['state'] != 'Z' else 0
            def wait(self, timeout):
                model.table.pop(self.pid, None)
                return 0
        return Child()

    def mocks(self):
        stack = ExitStack()
        stack.enter_context(patch.object(r, 'proc', side_effect=lambda pid: copy.deepcopy(self.table.get(pid))))
        stack.enter_context(patch.object(r, 'process_table', side_effect=lambda: copy.deepcopy(self.table)))
        stack.enter_context(patch.object(r, '_subreaper', return_value=True))
        stack.enter_context(patch.object(r, '_kernel_has_children', side_effect=lambda: self.invisible_children or any(v['ppid'] == CONTROLLER['pid'] for v in self.table.values())))
        stack.enter_context(patch.object(r.os, 'killpg', side_effect=lambda target, number: self.signal(target, number, True)))
        stack.enter_context(patch.object(r.os, 'kill', side_effect=self.signal))
        stack.enter_context(patch.object(r, '_signal_identity', side_effect=lambda owner, number: self.signal(owner['pid'], number)))
        stack.enter_context(patch.object(r.os, 'waitpid', side_effect=self.wait))
        stack.enter_context(patch.object(r.time, 'monotonic', side_effect=lambda: next(self.clock)))
        stack.enter_context(patch.object(r.time, 'sleep'))
        if self.journal is not None:
            stack.enter_context(patch.object(r.pathlib.Path, 'open', side_effect=lambda *a, **kw: io.BytesIO(self.journal)))
        else:
            stack.enter_context(patch.object(r.pathlib.Path, 'open', side_effect=FileNotFoundError()))
        return stack


class Resources(unittest.TestCase):
    def test_strict_rss_missing_live_is_failure(self):
        for status in (None, '', 'VmRSS: unknown kB\n', 'VmRSS: 5 MB\n', 'VmRSS: 1 kB\nVmRSS: 2 kB\n'):
            with self.subTest(status=status), patch.object(r, 'proc', return_value=ROOT), patch.object(r, '_read_status', side_effect=PermissionError('unreadable') if status is None else None, return_value=status):
                with self.assertRaises(r.ResourceAccountingError) as error:
                    r.strict_rss(ROOT)
                self.assertEqual(error.exception.evidence['identityAfter']['startTicks'], 10)

    def test_rss_confirmed_exit_and_reuse_are_not_live_read_failures(self):
        for after in (None, dict(ROOT, state='Z'), dict(ROOT, startTicks=99)):
            with self.subTest(after=after), patch.object(r, 'proc', side_effect=[ROOT, after]), patch.object(r, '_read_status', side_effect=PermissionError()):
                self.assertEqual(r.strict_rss(ROOT), 0)

    def test_rss_valid_bytes_and_controller_failure(self):
        with patch.object(r, 'proc', return_value=ROOT), patch.object(r, '_read_status', return_value='Name: fake\nVmRSS: 123 kB\n'):
            self.assertEqual(r.strict_rss(ROOT), 123 * 1024)
        with patch.object(r, 'proc', return_value=CONTROLLER), patch.object(r, '_read_status', side_effect=PermissionError()):
            with self.assertRaises(r.ResourceAccountingError):
                r.rss_for_pid(900)

    def test_proc_access_or_malformed_is_not_exit(self):
        for effect, text in ((PermissionError(), None), (None, 'malformed')):
            with patch.object(r.pathlib.Path, 'read_text', side_effect=effect, return_value=text):
                with self.assertRaises(r.ResourceAccountingError):
                    r.proc(111)
        with patch.object(r.pathlib.Path, 'read_text', side_effect=FileNotFoundError(2, 'missing')):
            self.assertIsNone(r.proc(111))

    def test_capture_root_requires_owned_birth(self):
        with patch.object(r, 'proc', return_value=ROOT), patch.object(r.os, 'getpid', return_value=900):
            known = {}
            self.assertEqual(r.capture_root(111, known), ROOT)
            self.assertEqual(known, {111: ROOT})
        with patch.object(r, 'proc', return_value=None):
            with self.assertRaises(r.ResourceAccountingError):
                r.capture_root(111, {})

    def test_subreaper_setup_is_verified_before_scope(self):
        with patch.object(r, '_subreaper', return_value=False):
            with self.assertRaises(r.ResourceAccountingError):
                r.enable_subreaper()
        with patch.object(r, '_subreaper', return_value=True), patch.object(r, '_kernel_has_children', return_value=True), patch.object(r, 'proc', return_value=CONTROLLER):
            with self.assertRaises(r.ResourceAccountingError):
                r.begin_scope()
        with patch.object(r, '_subreaper', return_value=True), patch.object(r, '_kernel_has_children', return_value=False), patch.object(r, 'proc', return_value=CONTROLLER):
            self.assertEqual(r.begin_scope().controller, CONTROLLER)
        with patch.object(r, '_subreaper', return_value=True), patch.object(r.signal, 'getsignal', return_value=r.signal.SIG_IGN):
            with self.assertRaises(r.ResourceAccountingError):
                r.begin_scope()

    def test_kernel_no_children_requires_echild(self):
        with patch.object(r.os, 'waitid', return_value=None):
            self.assertTrue(r._kernel_has_children())
        with patch.object(r.os, 'waitid', side_effect=ChildProcessError()):
            self.assertFalse(r._kernel_has_children())

    def test_pidfd_signal_is_bound_to_retained_birth(self):
        for current, expected in ((ROOT, 1), (dict(ROOT, startTicks=999), 0), (None, 0)):
            with self.subTest(current=current), patch.object(r.os, 'pidfd_open', return_value=41), patch.object(r.os, 'close') as close, patch.object(r, 'proc', return_value=current), patch.object(r.signal, 'pidfd_send_signal') as send:
                r._signal_identity(ROOT, r.signal.SIGTERM)
                self.assertEqual(send.call_count, expected)
                close.assert_called_once_with(41)

    def test_detached_engine_between_polls_adapter_death(self):
        model = Model(dict(ENGINE, ppid=900), journal=journal_bytes(3))
        ownership = r.Ownership('/synthetic/slot.ownership.jsonl', BINDING)
        with model.mocks():
            receipt = r.cleanup(model.child(), {111: ROOT}, 2, ownership=ownership, scope=r.SubreaperScope(CONTROLLER))
        self.assertNotIn(222, model.table)
        self.assertIn(222, receipt['ownedGroups'])
        self.assertIn(222, model.waits)
        self.assertFalse(receipt['ownedGroupGone'])
        self.assertEqual(receipt['quiescence'], 'unknown')
        self.assertEqual(receipt['ownership']['registeredEngine']['startTicks'], 20)

    def test_spawn_to_registration_gap_remains_unknown(self):
        for count in (0, 1, 2):
            model = Model(dict(ENGINE, ppid=900), journal=journal_bytes(count))
            with self.subTest(count=count), model.mocks():
                receipt = r.cleanup(model.child(), {111: ROOT}, 2, ownership=r.Ownership('/synthetic/slot', BINDING), scope=r.SubreaperScope(CONTROLLER))
            self.assertFalse(receipt['ownedGroupGone'])
            self.assertEqual(receipt['quiescence'], 'unknown')
            self.assertNotIn(222, model.table)

    def test_unseen_detached_descendant_is_adopted_and_reaped(self):
        orphan = dict(ENGINE, pid=333, group=333, session=333, startTicks=30, ppid=900)
        model = Model(orphan)
        with model.mocks():
            receipt = r.cleanup(model.child(), {111: ROOT}, 2, scope=r.SubreaperScope(CONTROLLER))
        self.assertTrue(receipt['ownedGroupGone'])
        self.assertEqual(receipt['quiescence'], 'verified')
        self.assertEqual(receipt['descendantScope']['adoptedChildrenReaped'][0]['identity']['pid'], 333)
        self.assertTrue(receipt['descendantScope']['finalKernelChildrenAbsent'])

    def test_successful_closed_browser_journal(self):
        model = Model(journal=journal_bytes())
        with model.mocks():
            receipt = r.cleanup(model.child(), {111: ROOT}, 2, ownership=r.Ownership('/synthetic/slot', BINDING), scope=r.SubreaperScope(CONTROLLER))
        self.assertTrue(receipt['ownedGroupGone'])
        self.assertTrue(receipt['ownership']['complete'])

    def test_empty_proc_snapshot_is_not_quiescence(self):
        model = Model(invisible_children=True)
        with model.mocks():
            receipt = r.cleanup(model.child(), {111: ROOT}, 2, scope=r.SubreaperScope(CONTROLLER))
        self.assertFalse(receipt['ownedGroupGone'])
        self.assertFalse(receipt['descendantScope']['finalKernelChildrenAbsent'])

    def test_adoption_after_first_empty_scan_is_reconciled(self):
        model = Model(dict(ENGINE, pid=333, group=333, session=333, startTicks=30, ppid=900))
        scans = itertools.count()
        with model.mocks(), patch.object(r, 'process_table', side_effect=lambda: {900: CONTROLLER} if next(scans) == 0 else copy.deepcopy(model.table)):
            receipt = r.cleanup(model.child(), {111: ROOT}, 2, scope=r.SubreaperScope(CONTROLLER))
        self.assertTrue(receipt['ownedGroupGone'])
        self.assertIn(333, model.waits)

    def test_reused_registered_pid_is_never_signaled(self):
        model = Model(dict(ENGINE, startTicks=999, ppid=900))
        with model.mocks():
            receipt = r.cleanup(model.child(), {111: ROOT, 222: ENGINE}, 2, scope=r.SubreaperScope(CONTROLLER))
        self.assertFalse(receipt['ownedGroupGone'])
        self.assertEqual(model.signals, [])

    def test_unreadable_proc_during_cleanup_is_unknown(self):
        model = Model()
        with model.mocks(), patch.object(r, 'process_table', side_effect=r.ResourceAccountingError('unreadable')):
            receipt = r.cleanup(model.child(), {111: ROOT}, 2, scope=r.SubreaperScope(CONTROLLER))
        self.assertFalse(receipt['ownedGroupGone'])
        self.assertEqual(receipt['quiescence'], 'unknown')

    def test_census_accounts_for_adopted_detached_child(self):
        model = Model(dict(ENGINE, ppid=900))
        with model.mocks(), patch.object(r, '_read_status', return_value='VmRSS: 128 kB\n'):
            alive, rss = r.census(111, {111: ROOT}, scope=r.SubreaperScope(CONTROLLER))
        self.assertEqual([owner['pid'] for owner in alive], [222])
        self.assertEqual(rss, 128 * 1024)

    def test_journal_binding_partial_and_boolean_attempt_rejected(self):
        variants = []
        rows = journal_rows();rows[2]['binding'] = dict(BINDING, slotId='wrong');variants.append(''.join(json.dumps(x) + '\n' for x in rows).encode())
        rows = journal_rows();rows[1]['attempt'] = True;variants.append(''.join(json.dumps(x) + '\n' for x in rows).encode())
        variants.append(journal_bytes()[:-1])
        variants.append(journal_bytes().replace(b'"attempt": 1', b'"attempt": 2, "attempt": 1', 1))
        for data in variants:
            model = Model(journal=data)
            with self.subTest(data=data), model.mocks():
                receipt = r.cleanup(model.child(), {111: ROOT}, 2, ownership=r.Ownership('/synthetic/slot', BINDING), scope=r.SubreaperScope(CONTROLLER))
            self.assertFalse(receipt['ownedGroupGone'])

    def test_no_subreaper_never_claims_full_quiescence(self):
        model = Model()
        with model.mocks():
            receipt = r.cleanup(model.child(), {111: ROOT}, 2)
        self.assertFalse(receipt['ownedGroupGone'])
        self.assertEqual(receipt['quiescence'], 'unknown')

    def test_pure_resource_admission_and_negative_receipts(self):
        slot = {'id': BINDING['slotId'], 'runtime': 'chromium'}
        config = {key: BINDING[key] for key in ('runtime', 'lane', 'arm', 'mode', 'manifestSha256')}
        config.update(ownershipJournal='/synthetic/' + slot['id'] + '.ownership.jsonl', ownershipBinding=BINDING)
        model = Model(journal=journal_bytes())
        with model.mocks():
            cleanup = r.cleanup(model.child(), {111: ROOT}, 2, ownership=r.Ownership(config['ownershipJournal'], BINDING), scope=r.SubreaperScope(CONTROLLER))
        process = {'pid': 111, 'group': 111, 'status': 'spawned', 'identity': ROOT, 'command': ['synthetic']}
        record = {'status': 'complete', 'command': ['synthetic'], 'cleanup': cleanup, 'maximumTreeRssBytes': 100, 'controllerMaximumRssBytes': 10,
                  'resourceAccounting': {'status': 'complete', 'strictRss': True, 'sampledNotPeak': True, 'rssSampleCount': 1}}
        self.assertTrue(r.validate_resource_receipts(slot, config, process, cleanup, record, journal_rows()))
        for key, value in (('quiescence', 'unknown'), ('ownedGroupGone', False), ('descendantScope', None), ('ownedProcessIdentities', []), ('problems', ['RSS failed'])):
            bad = copy.deepcopy(cleanup);bad[key] = value
            with self.subTest(key=key), self.assertRaises((ValueError, TypeError)):
                r.validate_resource_receipts(slot, config, process, bad, dict(record, cleanup=bad), journal_rows())
        with self.assertRaises(ValueError):
            r.validate_resource_receipts(slot, config, process, cleanup, dict(record, resourceAccounting={}), journal_rows())
        for key in ('maximumTreeRssBytes', 'controllerMaximumRssBytes'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                r.validate_resource_receipts(slot, config, process, cleanup, dict(record, **{key: 0}), journal_rows())


if __name__ == '__main__':
    unittest.main()
