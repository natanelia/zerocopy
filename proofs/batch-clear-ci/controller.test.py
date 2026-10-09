"""Deterministic protocol/launcher contract checks; no candidate clocks."""
import json, pathlib, unittest, signal, subprocess, tempfile
import controller
from unittest.mock import Mock, patch
from controller import HERE, plan, admission, cleanup_child, ControllerDeadline, controller_timeout, finish_timeout

class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.p = json.loads((HERE/'protocol.json').read_text())
    def test_exact_finite_process_count(self):
        slots = plan(self.p)
        self.assertEqual(len(slots), 32)
        self.assertEqual(len({s['id'] for s in slots}), 32)
        for block in range(4):
            for runtime in ['node', 'bun']:
                self.assertEqual([s['arm'] for s in slots if s['block'] == block and s['runtime'] == runtime], self.p['orders'][block])
    def test_source_position_balance(self):
        slots = plan(self.p)
        for runtime in ['node', 'bun']:
            for position in range(4):
                self.assertEqual(sum(s['arm'] == 'baseline' for s in slots if s['runtime'] == runtime and s['position'] == position), 2)
    def test_blocks_are_replicates(self):
        self.assertEqual(self.p['blocks'], 4)
        self.assertEqual(self.p['statistics']['pairedLogRatioDf'], 3)
        self.assertEqual(self.p['measurement']['samples'], 7)
    def test_fixed_memory_and_whole_process_budgets(self):
        self.assertEqual(self.p['memory']['maximumArenaBytes'], 64*1024*1024)
        self.assertEqual(self.p['memory']['maximumSubjectRssBytes'], 512*1024*1024)
        self.assertEqual(self.p['budgets']['measurementProcessWallSeconds'], 90)
        self.assertEqual(self.p['budgets']['calibrationProcessWallSeconds'], 180)
        self.assertEqual(self.p['budgets']['controllerWallSeconds'], 2100)
    def test_batch_clear_candidate_gate_is_never_borrowed(self):
        import ci
        with patch('ci.run_root', return_value=pathlib.Path('/not-a-run')), patch('ci.require_activation'), patch('ci.validate_gates', side_effect=AssertionError('missing fresh gate')):
            with self.assertRaises(AssertionError): ci.fresh_admission()
        self.assertEqual(len(self.p['cases']), 7)
        self.assertEqual([c['operation'] for c in self.p['cases']].count('setMany'), 5)
    def test_calibration_is_shared_and_bounded(self):
        self.assertEqual(self.p['calibration']['samplesPerLevel'], 3)
        for cell in self.p['cases']:
            self.assertEqual(len(cell['ladder']), 5)
            self.assertEqual(sorted(set(cell['ladder'])), cell['ladder'])
    def test_ci_gate_commands_include_full_standard_suite(self):
        import ci
        self.assertIn(['bun','run','test'], ci.GATES)
        self.assertIn(['bun','run','check:package'], ci.GATES)
        self.assertIn(['node','scripts/check-doc-browser.mjs'], ci.GATES)
    def test_already_exited_child_is_reaped_and_verified(self):
        child = Mock(pid=42, returncode=0)
        with patch('controller.group_alive', return_value=False), patch('controller.os.killpg') as kill:
            receipt = cleanup_child(child, 2)
        self.assertTrue(receipt['ownedGroupGone']); self.assertFalse(receipt['terminated'])
        child.wait.assert_called_once(); kill.assert_not_called()
    def test_owned_child_timeout_escalates_within_cleanup(self):
        child = Mock(pid=42, returncode=-9)
        child.wait.side_effect = [subprocess.TimeoutExpired('dummy', 1.5), -9]
        with patch('controller.group_alive', side_effect=[True, True, False]), patch('controller.os.killpg') as kill:
            receipt = cleanup_child(child, 2)
        self.assertTrue(receipt['ownedGroupGone'])
        self.assertEqual([x.args for x in kill.call_args_list], [(42, signal.SIGTERM), (42, signal.SIGKILL)])

class DeadlineTests(unittest.TestCase):
    def setUp(self):
        controller.DEADLINE_AT = None
        self.temp = tempfile.TemporaryDirectory()
        self.out = pathlib.Path(self.temp.name)
        (self.out/'ledger.json').write_text(json.dumps({'status':'running','slots':[{'id':'original','status':'started'},{'id':'next','status':'pending'}]}))
    def tearDown(self):
        controller.ACTIVE_CHILD = None
        controller.DEADLINE_AT = None
        self.temp.cleanup()
    def finish(self):
        with patch('controller.print'):
            result = finish_timeout(self.out, 2)
        self.assertFalse(result['lateSamplesAdmitted'])
        self.assertFalse(result['sourceAfterVerified'])
        ledger = json.loads((self.out/'ledger.json').read_text())
        self.assertEqual(ledger['status'], 'incomplete')
        self.assertEqual([s['status'] for s in ledger['slots']], ['started', 'pending'])
        self.assertTrue((self.out/'controller-timeout.json').exists())
        return result
    def test_alarm_during_active_child_reaps_and_checks_group(self):
        child = Mock(pid=42, returncode=-15)
        controller.ACTIVE_CHILD = child
        with patch('controller.signal.setitimer') as timer:
            with self.assertRaises(ControllerDeadline): controller_timeout(None, None)
            timer.assert_called_once_with(signal.ITIMER_REAL, 0)
        with patch('controller.group_alive', side_effect=[True, False]), patch('controller.os.killpg') as kill:
            result = self.finish()
        child.wait.assert_called_once()
        kill.assert_called_once_with(42, signal.SIGTERM)
        self.assertTrue(result['cleanup']['ownedGroupGone'])
        self.assertIsNone(controller.ACTIVE_CHILD)
    def test_alarm_during_cleanup_reenters_bounded_final_cleanup(self):
        child = Mock(pid=42, returncode=-9)
        controller.ACTIVE_CHILD = child
        child.wait.side_effect = [ControllerDeadline('alarm during wait'), -9]
        with patch('controller.group_alive', side_effect=[True, True, False]), patch('controller.os.killpg'):
            with self.assertRaises(ControllerDeadline): cleanup_child(child, 2)
            result = self.finish()
        self.assertEqual(child.wait.call_count, 2)
        self.assertTrue(result['cleanup']['ownedGroupGone'])
        self.assertEqual(result['cleanupGraceSeconds'], 2)
    def run_main_interruption(self, launch_effect=None, verify_effect=None):
        destination = self.out/'new-run'
        original_read = controller.read
        def read(path):
            if pathlib.Path(path).name == 'manifest.json': return {}
            return original_read(path)
        with patch('controller.sys.argv', ['controller.py','untimed','--output',str(destination)]), patch('controller.read', side_effect=read), patch('controller.verify', side_effect=verify_effect), patch('controller.launch', side_effect=launch_effect) as launch, patch('controller.host', return_value={}), patch('controller.sha', return_value='test-hash'), patch('controller.signal.signal'), patch('controller.signal.setitimer'), patch('controller.print'):
            with self.assertRaises(SystemExit) as stopped: controller.main()
        self.assertEqual(stopped.exception.code, 124)
        receipt = json.loads((destination/'controller-timeout.json').read_text())
        self.assertFalse(receipt['lateSamplesAdmitted'])
        self.assertFalse(receipt['sourceAfterVerified'])
        if (destination/'ledger.json').exists():
            ledger = json.loads((destination/'ledger.json').read_text())
            self.assertEqual(ledger['status'], 'incomplete')
            self.assertEqual([slot['status'] for slot in ledger['slots']], ['started','pending','pending','pending'])
        return launch, receipt
    def test_main_alarm_during_active_child_stops_all_later_slots(self):
        child = Mock(pid=42, returncode=-15)
        def launch(*args):
            controller.ACTIVE_CHILD = child
            controller_timeout(None, None)
        with patch('controller.group_alive', side_effect=[True, False]), patch('controller.os.killpg'):
            launched, receipt = self.run_main_interruption(launch)
        self.assertEqual(launched.call_count, 1)
        child.wait.assert_called_once()
        self.assertTrue(receipt['cleanup']['ownedGroupGone'])
    def test_main_alarm_during_cleanup_finishes_reaping(self):
        child = Mock(pid=42, returncode=-9)
        child.wait.side_effect = [ControllerDeadline('alarm during wait'), -9]
        def launch(*args):
            controller.ACTIVE_CHILD = child
            cleanup_child(child, 2)
        with patch('controller.group_alive', side_effect=[True, True, False]), patch('controller.os.killpg'):
            launched, receipt = self.run_main_interruption(launch)
        self.assertEqual(launched.call_count, 1)
        self.assertEqual(child.wait.call_count, 2)
        self.assertTrue(receipt['cleanup']['ownedGroupGone'])
    def test_main_alarm_during_source_verification_never_resumes_slots(self):
        controller.ACTIVE_CHILD = None
        def launch(*args): controller.verify({})
        launched, receipt = self.run_main_interruption(launch, [None, ControllerDeadline('alarm during source verification')])
        self.assertEqual(launched.call_count, 1)
        self.assertTrue(receipt['cleanup']['ownedGroupGone'])
    def test_main_initial_verification_timeout_gets_new_receipt(self):
        launched, receipt = self.run_main_interruption(None, ControllerDeadline('alarm during initial verification'))
        launched.assert_not_called()
        self.assertTrue(receipt['cleanup']['ownedGroupGone'])
    def test_deadline_cleanup_does_not_restart_grace(self):
        controller.DEADLINE_AT = 10
        child = Mock(pid=42, returncode=0)
        with patch('controller.time.monotonic', return_value=11.5), patch('controller.group_alive', return_value=False):
            cleanup_child(child, 2)
        child.wait.assert_called_once_with(timeout=0.5)
    def test_untimed_failure_stops_later_subjects(self):
        destination = self.out/'failed-untimed'
        original_read = controller.read
        def read(path):
            if pathlib.Path(path).name == 'manifest.json': return {}
            return original_read(path)
        def launch(manifest, protocol, out, slot, mode, deadline, work):
            return {**slot, 'status':'failed', 'failure':'fixture assertion'}, []
        with patch('controller.sys.argv', ['controller.py','untimed','--output',str(destination)]), patch('controller.read', side_effect=read), patch('controller.verify', return_value={'ok': True}), patch('controller.launch', side_effect=launch) as launched, patch('controller.host', return_value={}), patch('controller.sha', return_value='test-hash'), patch('controller.signal.signal'), patch('controller.signal.setitimer'), patch('controller.print'):
            with self.assertRaises(SystemExit) as stopped: controller.main()
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(launched.call_count, 1)
        ledger = json.loads((destination/'ledger.json').read_text())
        self.assertEqual([slot['status'] for slot in ledger['slots']], ['failed','not-run','not-run','not-run'])
    def test_unresolved_owned_group_is_disclosed(self):
        controller.ACTIVE_CHILD = Mock(pid=42)
        with patch('controller.cleanup_child', side_effect=controller.OwnedProcessRemains('group remains')):
            result = self.finish()
        self.assertFalse(result['cleanup']['ownedGroupGone'])
        self.assertIn('group remains', result['cleanup']['error'])

if __name__ == '__main__': unittest.main()
