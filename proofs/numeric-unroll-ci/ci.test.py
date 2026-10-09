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
            for index, template in enumerate(ci.GATES):
                command=[str(root/'sources'/arm) if value=='{source}' else value for value in template]
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
    def test_disabled_activation_rejects_execution(self):
        with patch('ci.verify_packet', return_value={}), patch('ci.read', return_value={'enabled':False}):
            with self.assertRaises(AssertionError): ci.require_activation()
    def test_original_attempt_only(self):
        activation={'enabled':True}
        environment={'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':'natanelia/zerocopy','GITHUB_REF':ci.BRANCH,'GITHUB_RUN_ATTEMPT':'2'}
        with patch('ci.verify_packet',return_value={}),patch('ci.read',return_value=activation),patch.dict(ci.os.environ,environment,clear=True),patch('ci.git') as git:
            with self.assertRaisesRegex(AssertionError,'Original attempt only'):ci.require_activation()
            git.assert_not_called()
    def test_disabled_preflight_cannot_create_run_or_spawn(self):
        with patch('ci.verify_packet',return_value={}),patch('ci.read',return_value={'enabled':False}),patch.dict(ci.os.environ,{},clear=True),patch('ci.run_root') as root,patch('ci.subprocess.Popen') as spawn,patch('ci.print'):
            ci.preflight();root.assert_not_called();spawn.assert_not_called()
    def source_chain_values(self):
        o=ci.ORIGIN
        return {('diff','--name-only',o['baselineCommit'],o['candidateCommit']):'numeric-kernels.as.ts',
            ('rev-parse',o['candidateCommit']+'^'):o['baselineCommit'],
            ('rev-parse',o['baselineCommit']+'^'):o['historicalBaselineCommit'],
            ('diff','--name-only',o['historicalBaselineCommit'],o['baselineCommit']):'\n'.join(o['mainDocumentationChanges']),
            ('diff','--numstat',o['baselineCommit'],o['candidateCommit']):'8\t0\tnumeric-kernels.as.ts',
            **{('rev-parse',o[arm+'Commit']+'^{tree}'):o[arm+'Tree'] for arm in ci.ARM_NAMES}}
    def test_exact_source_chain_is_fixed(self):
        values=self.source_chain_values();patch_bytes=(ci.HERE/'runtime.patch').read_bytes()
        with patch('ci.git',side_effect=lambda *args:values[args]),patch('ci.subprocess.check_output',return_value=patch_bytes):ci.verify_source_chain()
        for key in values:
            changed={**values,key:'wrong'}
            with self.subTest(command=key),patch('ci.git',side_effect=lambda *args:changed[args]),patch('ci.subprocess.check_output',return_value=patch_bytes):
                with self.assertRaises(AssertionError):ci.verify_source_chain()
        with patch('ci.git',side_effect=lambda *args:values[args]),patch('ci.subprocess.check_output',return_value=b'wrong'):
            with self.assertRaises(AssertionError):ci.verify_source_chain()
    def test_both_arm_compiler_paths_are_in_final_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            for runtime in ('node','bun','python3'):(root/runtime).write_text(runtime)
            for arm in ci.ARM_NAMES:
                for package in ('assemblyscript','binaryen','long','typescript'):
                    target=root/arm/'node_modules'/package/'index.js';target.parent.mkdir(parents=True);target.write_text(package)
            with patch('ci.source',side_effect=lambda arm:root/arm),patch('ci.shutil.which',side_effect=lambda name:str(root/name)):
                tools=ci.tools_identity()
            self.assertEqual(len(tools),11)
            target=root/'candidate/node_modules/binaryen/index.js'
            self.assertIn(str(target),[x['path'] for x in tools])
            manifest={'sourceReview':{'files':[]},'harness':[],'tools':tools,'sources':{}}
            self.assertTrue(ci.controller.verify(manifest)['ok'])
            target.write_text('synthetic candidate compiler mutation')
            with self.assertRaisesRegex(AssertionError,'Changed tools'):ci.controller.verify(manifest)
            target.write_text('binaryen')
            self.assertTrue(ci.controller.verify(manifest)['ok'])
            (root/'baseline/node_modules/binaryen/index.js').write_text('synthetic baseline compiler mutation')
            with self.assertRaisesRegex(AssertionError,'Changed tools'):ci.controller.verify(manifest)
    def test_every_wasm_alias_and_optional_module_is_guarded(self):
        with tempfile.TemporaryDirectory() as directory:
            tree=pathlib.Path(directory)
            for name in ci.ORIGIN['expectedWasm']['candidate']:(tree/name).write_bytes(b'fixture')
            expected=ci.ORIGIN['expectedWasm']['candidate']
            with patch('ci.sha',side_effect=lambda path:expected[path.name]):
                self.assertEqual(ci.verify_wasm('candidate',tree),expected)
            for changed in expected:
                with patch('ci.sha',side_effect=lambda path:'changed' if path.name==changed else expected[path.name]):
                    with self.assertRaises(AssertionError):ci.verify_wasm('candidate',tree)
            (tree/'extra.wasm').write_bytes(b'extra')
            with self.assertRaises(AssertionError):ci.verify_wasm('candidate',tree)
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
                self.assertEqual(len(ci.validate_gates(root)),134)
    def test_gate_command_count_matches_current_ci(self):
        self.assertEqual(len(ci.GATES),32)
        self.assertEqual(len(ci.STANDARD_GATES),23)
        self.assertEqual(len(ci.NUMERIC_GATES),9)
        self.assertEqual(ci.GATES.count(['bun','run','test']),1)
        self.assertFalse(any('numeric.test.ts' in command for command in ci.GATES))
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
