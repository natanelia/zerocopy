"""Deterministic admission/ownership tests. No builds, candidate runs or timing."""
import json, pathlib, tempfile, unittest
from unittest.mock import Mock, patch
import ci

class AdmissionTests(unittest.TestCase):
    def make_gates(self, root):
        for arm in ci.ARM_NAMES:
            identity={'commit':arm, 'tree':arm}
            ci.write(root/('gate-'+arm+'-source.json'), identity)
            ci.write(root/('gate-'+arm+'-envelope.json'), {'stage':'gate-'+arm,'status':'passed','budgetSeconds':900,'cleanupGraceSeconds':2,'elapsedWallSeconds':1})
            commands=[]
            for index, command in enumerate(ci.GATES):
                path=root/'logs'/('gate-'+arm)/f'{index:02d}.json';path.parent.mkdir(parents=True,exist_ok=True)
                path.with_suffix('.log').write_text('passed\n')
                ci.write(path,{'command':command,'cwd':str(root/'sources'/arm),'status':'passed','returncode':0,'elapsedWallSeconds':1,'cleanup':{'ownedGroupGone':True},'logSha256':ci.sha(path.with_suffix('.log'))})
                commands.append({'receipt':str(path),'status':'passed'})
            ci.write(root/('gate-'+arm+'.json'),{'name':'gate-'+arm,'budgetSeconds':900,'status':'passed','commands':commands})
    def assert_bad_gate(self, mutation):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);self.make_gates(root);mutation(root)
            with patch('ci.run_root',return_value=root), patch('ci.verify_source',side_effect=lambda arm:{'commit':arm,'tree':arm}):
                with self.assertRaises(AssertionError):ci.validate_gates(root)
    def test_local_execution_is_blocked(self):
        with patch.dict(ci.os.environ, {}, clear=True):
            with self.assertRaises(AssertionError): ci.run_root()
    def test_activation_has_explicit_boolean(self):
        self.assertIs(type(ci.read(ci.HERE/'activation.json')['enabled']), bool)
    def source_pair_responses(self):
        o=ci.ORIGIN
        return {
            ('diff','--name-only',o['baselineCommit'],o['candidateCommit']):'\n'.join(sorted(o['candidateChangedFiles'])),
            ('rev-parse',o['baselineCommit']+'^{tree}'):o['baselineTree'],
            ('rev-parse',o['candidateCommit']+'^{tree}'):o['candidateTree'],
            ('rev-parse',o['runtimeCommit']+'^'):o['baselineCommit'],
            ('rev-parse',o['runtimeCommit']+'^{tree}'):o['runtimeTree'],
            ('diff','--name-only',o['baselineCommit'],o['runtimeCommit']):'shared-queue.ts',
            ('diff','--name-only',o['runtimeCommit'],o['candidateCommit']):'proofs/queue-prefix-special-numbers.mjs\nshared-queue-prefix.test.ts',
        }
    def test_queue_source_pair_exact_diff_is_accepted(self):
        responses=self.source_pair_responses()
        with patch('ci.git',side_effect=lambda *args:responses[args]),patch('ci.source',return_value=pathlib.Path('/candidate')),patch('ci.sha',side_effect=lambda p:ci.ORIGIN['candidateChangedFiles'][str(p.relative_to('/candidate'))]):
            ci.verify_source_pair()
    def test_queue_source_pair_rejects_each_wrong_identity_or_diff(self):
        for key in self.source_pair_responses():
            with self.subTest(command=key):
                responses=self.source_pair_responses();responses[key]='wrong'
                with patch('ci.git',side_effect=lambda *args:responses[args]),patch('ci.source',return_value=pathlib.Path('/candidate')),patch('ci.sha',side_effect=lambda p:ci.ORIGIN['candidateChangedFiles'][str(p.relative_to('/candidate'))]):
                    with self.assertRaises(AssertionError):ci.verify_source_pair()
    def test_queue_source_pair_rejects_changed_file_hash(self):
        for filename in ci.ORIGIN['candidateChangedFiles']:
            with self.subTest(filename=filename):
                responses=self.source_pair_responses()
                def digest(p):
                    name=str(p.relative_to('/candidate'))
                    return 'wrong' if name==filename else ci.ORIGIN['candidateChangedFiles'][name]
                with patch('ci.git',side_effect=lambda *args:responses[args]),patch('ci.source',return_value=pathlib.Path('/candidate')),patch('ci.sha',side_effect=digest):
                    with self.assertRaises(AssertionError):ci.verify_source_pair()
    def test_disabled_activation_rejects_execution(self):
        with patch('ci.verify_packet', return_value={}), patch('ci.read', return_value={'enabled':False}):
            with self.assertRaises(AssertionError): ci.require_activation()
    def test_gate_needs_every_command(self):
        def change(root):
            p=root/'gate-baseline.json';d=ci.read(p);d['commands']=[];ci.write(p,d)
        self.assert_bad_gate(change)
    def test_incomplete_gate_is_rejected(self):
        def change(root):
            p=root/'gate-baseline.json';d=ci.read(p);d['status']='started';ci.write(p,d)
        self.assert_bad_gate(change)
    def test_failed_command_rejects_gate(self):
        def change(root):
            p=root/'logs/gate-baseline/00.json';d=ci.read(p);d['status']='failed';ci.write(p,d)
        self.assert_bad_gate(change)
    def test_wrong_run_receipt_is_rejected(self):
        def change(root):
            p=root/'gate-baseline.json';d=ci.read(p);d['commands'][0]['receipt']='/other-run/logs/gate-baseline/00.json';ci.write(p,d)
        self.assert_bad_gate(change)
    def test_wrong_source_cwd_is_rejected(self):
        def change(root):
            p=root/'logs/gate-baseline/00.json';d=ci.read(p);d['cwd']='/wrong/source/arm';ci.write(p,d)
        self.assert_bad_gate(change)
    def test_late_envelope_is_rejected(self):
        def change(root):
            p=root/'gate-baseline-envelope.json';d=ci.read(p);d['elapsedWallSeconds']=903;ci.write(p,d)
        self.assert_bad_gate(change)
    def test_exact_fresh_gate_receipts_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);self.make_gates(root)
            with patch('ci.run_root',return_value=root),patch('ci.verify_source',side_effect=lambda arm:{'commit':arm,'tree':arm}):
                self.assertEqual(len(ci.validate_gates(root)),98)
    def test_gate_command_count_matches_current_ci(self):
        self.assertEqual(len(ci.GATES),23)
        self.assertIn(['node','node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.worker.json'],ci.GATES)
        self.assertIn(['node','proofs/restore-local-evidence.mjs'],ci.GATES)
    def test_stage_records_failure_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            (root/'run.json').write_text(json.dumps({'workDeadlineMonotonicSeconds':1e100}))
            with patch('ci.run_root',return_value=root), patch('ci.execute',side_effect=RuntimeError('failure')) as run:
                with self.assertRaises(RuntimeError): ci.stage('gate',10,[(['first'],root),(['second'],root)])
            self.assertEqual(run.call_count,1)
            self.assertEqual(json.loads((root/'gate.json').read_text())['status'],'failed')
    def test_existing_stage_is_never_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); (root/'gate.json').write_text('{}')
            with patch('ci.run_root',return_value=root), patch('ci.execute') as run:
                with self.assertRaises(AssertionError): ci.stage('gate',10,[])
            run.assert_not_called()
    def test_command_failure_always_cleans_owned_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); child=Mock(pid=42,returncode=1); child.poll.return_value=1
            with patch('ci.subprocess.Popen',return_value=child), patch('ci.controller.cleanup_child',return_value={'ownedGroupGone':True}) as clean:
                with self.assertRaises(AssertionError): ci.execute(['failing-command'],root,root/'command',float('inf'))
            clean.assert_called_once_with(child,2)
            receipt=json.loads((root/'command.json').read_text())
            self.assertEqual(receipt['status'],'failed')
            self.assertTrue(receipt['cleanup']['ownedGroupGone'])
    def test_unresolved_writer_is_never_hashed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);child=Mock(pid=42,returncode=0);child.poll.return_value=0
            with patch('ci.subprocess.Popen',return_value=child),patch('ci.controller.cleanup_child',side_effect=ci.controller.OwnedProcessRemains('still visible')),patch('ci.sha') as digest:
                with self.assertRaises(ci.controller.OwnedProcessRemains):ci.execute(['command'],root,root/'command',float('inf'))
            digest.assert_not_called();receipt=ci.read(root/'command.json')
            self.assertNotIn('logSha256',receipt);self.assertEqual(receipt['quiescence'],'unknown')
    def test_oversized_post_exit_log_is_not_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);child=Mock(pid=42,returncode=0);child.poll.return_value=0
            def spawn(*args,**kwargs):kwargs['stdout'].truncate(128*1024*1024+1);return child
            with patch('ci.subprocess.Popen',side_effect=spawn),patch('ci.controller.cleanup_child',return_value={'ownedGroupGone':True}),patch('ci.sha') as digest:
                with self.assertRaises(AssertionError):ci.execute(['command'],root,root/'command',float('inf'))
            digest.assert_not_called();self.assertEqual(ci.read(root/'command.json')['status'],'failed')
    def test_final_hash_overrun_fails_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);child=Mock(pid=42,returncode=0);child.poll.return_value=0;clock=[0]
            def digest(path):clock[0]=20;return 'digest'
            with patch('ci.time.monotonic',side_effect=lambda:clock[0]),patch('ci.subprocess.Popen',return_value=child),patch('ci.controller.cleanup_child',return_value={'ownedGroupGone':True}),patch('ci.sha',side_effect=digest):
                with self.assertRaises(AssertionError):ci.execute(['command'],root,root/'command',10)
            self.assertEqual(ci.read(root/'command.json')['status'],'failed')
    def test_cleanup_within_two_second_grace_is_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);child=Mock(pid=42,returncode=0);child.poll.return_value=0;clock=[0]
            def cleanup(*args):clock[0]=11;return {'ownedGroupGone':True}
            with patch('ci.time.monotonic',side_effect=lambda:clock[0]),patch('ci.subprocess.Popen',return_value=child),patch('ci.controller.cleanup_child',side_effect=cleanup):
                self.assertEqual(ci.execute(['command'],root,root/'command',10)['status'],'passed')
    def test_freeze_finalization_respects_work_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);ci.write(root/'run.json',{'workDeadlineMonotonicSeconds':10});clock=[0]
            def freeze():clock[0]=20
            with patch('ci.run_root',return_value=root),patch('ci.time.monotonic',side_effect=lambda:clock[0]),patch('ci.signal.signal'),patch('ci.signal.setitimer') as alarm:
                with self.assertRaises(AssertionError):ci.bounded('freeze',120,freeze)
            self.assertEqual(alarm.call_args_list[0].args[1],12)
            self.assertEqual(ci.read(root/'freeze-envelope.json')['status'],'failed')
    def test_envelope_final_receipt_overrun_is_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);ci.write(root/'run.json',{'workDeadlineMonotonicSeconds':10});clock=[0];original=ci.write
            def write(path,value):
                original(path,value)
                if value.get('status')=='passed':clock[0]=20
            with patch('ci.run_root',return_value=root),patch('ci.time.monotonic',side_effect=lambda:clock[0]),patch('ci.signal.signal'),patch('ci.signal.setitimer'),patch('ci.write',side_effect=write):
                with self.assertRaises(AssertionError):ci.bounded('freeze',120,lambda:None)
            self.assertEqual(ci.read(root/'freeze-envelope.json')['status'],'failed')
    def test_preserve_discloses_unresolved_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);p=root/'logs/gate-baseline/00.json';p.parent.mkdir(parents=True)
            ci.write(p,{'pid':42,'cleanupError':'still visible'});p.with_suffix('.log').write_text('partial')
            with patch('ci.run_root',return_value=root),patch('ci.sha') as digest:ci.preserve()
            digest.assert_not_called();receipt=ci.read(root/'preservation.json')
            self.assertFalse(receipt['archivesVerified']);self.assertEqual(receipt['quiescence'],'unknown')
            self.assertEqual(p.with_suffix('.log').read_text(),'partial');self.assertFalse((root/'artifact-inventory.json').exists())
    def test_preserve_treats_incomplete_receipts_as_unknown(self):
        for contents in ('{"status":"started"}', '{"status":', '{"cleanupError":"identity not persisted"}', '{"quiescence":"unknown"}'):
            with tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory);p=root/'logs/setup/00.json';p.parent.mkdir(parents=True);p.write_text(contents)
                with patch('ci.run_root',return_value=root),patch('ci.sha') as digest:ci.preserve()
                digest.assert_not_called();self.assertEqual(ci.read(root/'preservation.json')['quiescence'],'unknown')
    def test_preserve_honors_fatal_controller_without_process_record(self):
        for name,record in (('ledger.json',{'fatalOwnedProcess':'identity not persisted'}),('controller-timeout.json',{'cleanup':{'ownedGroupGone':False}})):
            with tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory);(root/'screen').mkdir();ci.write(root/'screen'/name,record)
                with patch('ci.run_root',return_value=root),patch('ci.sha') as digest:ci.preserve()
                digest.assert_not_called();self.assertFalse(ci.read(root/'preservation.json')['archivesVerified'])

if __name__ == '__main__': unittest.main()
