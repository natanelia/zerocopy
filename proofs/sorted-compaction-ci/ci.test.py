"""Deterministic admission/ownership tests. No builds, candidate runs or timing."""
import json, pathlib, tempfile, unittest
from unittest.mock import Mock, patch
import ci

class AdmissionTests(unittest.TestCase):
    def test_final_manifest_guards_both_compiler_trees(self):
        # Tiny-file version of the independent R2 probe; no compiler executes.
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); executables=root/'executables';executables.mkdir()
            for name in ('node','bun','python3'):(executables/name).write_text('synthetic '+name)
            packages=('assemblyscript','binaryen','long','typescript')
            for arm in ci.ARM_NAMES:
                for name in packages:
                    p=root/arm/'node_modules'/name/'index.js';p.parent.mkdir(parents=True);p.write_text('original '+name)
            with patch('ci.source',side_effect=lambda arm:root/arm),patch('ci.shutil.which',side_effect=lambda name:str(executables/name)):
                expected=[ci.item(q,root/'baseline/node_modules') for name in packages for q in sorted((root/'baseline/node_modules'/name).rglob('*')) if q.is_file()]
                with patch('ci.read',return_value={'files':expected}): records=ci.tools_identity()
                self.assertEqual(len(records),11)
                for arm in ci.ARM_NAMES:self.assertEqual(sum(str(root/arm/'node_modules')+'/' in row['path'] for row in records),4)
                manifest={'tools':records,'harness':[],'sources':{},'sourceReview':{'files':[]}}
                self.assertTrue(ci.controller.verify(manifest)['ok'])
                for arm in ci.ARM_NAMES:
                    for name in packages:
                        with self.subTest(arm=arm,package=name):
                            p=root/arm/'node_modules'/name/'index.js';p.write_text('changed after freeze')
                            with self.assertRaises(AssertionError):ci.controller.verify(manifest)
                            with self.assertRaises(AssertionError):ci.tools_identity()
                            p.write_text('original '+name)
                            self.assertTrue(ci.controller.verify(manifest)['ok'])

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
    def test_exact_source_chain_is_fixed(self):
        origin=ci.ORIGIN
        values={('diff','--name-only',origin['baselineCommit'],origin['candidateCommit']):'\n'.join(origin['changedFiles']),
            ('rev-parse',origin['candidateCommit']+'^'):origin['runtimeCommit'],
            ('rev-parse',origin['runtimeCommit']+'^'):origin['baselineCommit'],
            ('rev-parse',origin['runtimeCommit']+'^{tree}'):origin['runtimeTree'],
            ('diff','--name-only',origin['baselineCommit'],origin['runtimeCommit']):'compaction.ts\npersistent-core.as.ts',
            ('diff','--name-only',origin['runtimeCommit'],origin['candidateCommit']):'sorted-compaction.test.ts',
            ('rev-parse',origin['baselineCommit']+'^{tree}'):origin['baselineTree'],
            ('rev-parse',origin['candidateCommit']+'^{tree}'):origin['candidateTree']}
        with patch('ci.git',side_effect=lambda *args:values[args]):ci.verify_source_chain()
        values[('rev-parse',origin['candidateCommit']+'^')]='different-parent'
        with patch('ci.git',side_effect=lambda *args:values[args]):
            with self.assertRaises(AssertionError):ci.verify_source_chain()
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
                self.assertEqual(len(ci.validate_gates(root)),2*(2*len(ci.GATES)+3))
    def test_gate_command_count_matches_current_ci(self):
        self.assertEqual(len(ci.GATES),24)
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
    def test_untimed_failure_rewrites_admission_as_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); (root/'harness').mkdir()
            ci.write(root/'run.json',{'workDeadlineMonotonicSeconds':ci.time.monotonic()+5000})
            def failed_controller():
                ci.write(root/'untimed-semantic-admission.json',{'status':'passed'})
                raise TimeoutError('late finalization')
            with patch('ci.run_root',return_value=root),patch('ci.require_activation'),patch('ci.bounded'),patch('ci.threading.Timer'),patch('ci.controller.main',side_effect=failed_controller),patch('ci.controller.HERE'),patch('ci.controller.admission'),patch.object(ci.sys,'argv',[]):
                with self.assertRaises(TimeoutError):ci.launch('untimed')
            self.assertEqual(ci.read(root/'untimed-semantic-admission.json')['status'],'failed')

    def test_untimed_semantic_admission_is_sealed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); harness=root/'harness';harness.mkdir();(harness/'manifest.json').write_text('{}\n')
            (root/'untimed').mkdir(); slots=[]
            for runtime in ('node','bun'):
                for arm in ci.ARM_NAMES:
                    identity=runtime+'-'+arm
                    (root/'untimed'/(identity+'.stdout.jsonl')).write_text('synthetic\n')
                    slots.append({'id':identity,'status':'complete','cleanup':{'ownedGroupGone':True}})
            ci.write(root/'untimed/ledger.json',{'mode':'untimed','status':'complete','manifestSha256':ci.sha(harness/'manifest.json'),'slots':slots})
            ci.write(root/'untimed/semantic-comparison.json',{'passed':True,'chunks':80,'manifestSha256':ci.sha(harness/'manifest.json'),'ledgerSha256':ci.sha(root/'untimed/ledger.json'),'inputs':[ci.item(root/'untimed'/(slot['id']+'.stdout.jsonl')) for slot in slots]})
            receipt=root/'logs/untimed-comparison/00.json';receipt.parent.mkdir(parents=True);receipt.with_suffix('.log').write_text('passed\n')
            ci.write(receipt,{'status':'passed','returncode':0,'cleanup':{'ownedGroupGone':True},'cwd':str(ci.REPO),'command':['node',str(ci.HERE/'verify-untimed.mjs'),str(root/'untimed'),str(harness/'manifest.json')],'logSha256':ci.sha(receipt.with_suffix('.log'))})
            ci.write(root/'untimed-semantic-admission.json',{'status':'passed','elapsedWallSeconds':1,'inputs':[ci.item(root/'untimed/ledger.json'),ci.item(root/'untimed/semantic-comparison.json'),ci.item(receipt)]})
            ci.validate_untimed(root,harness)
            originals={p:p.read_bytes() for p in root.rglob('*') if p.is_file()}
            for filename,field,value in [
                ('untimed/ledger.json','status','incomplete'),
                ('untimed/semantic-comparison.json','inputs',[]),
                ('untimed/semantic-comparison.json','ledgerSha256','wrong'),
                ('logs/untimed-comparison/00.json','cleanup',{'ownedGroupGone':False}),
                ('logs/untimed-comparison/00.json','command',['wrong']),
                ('logs/untimed-comparison/00.json','cwd','/wrong'),
                ('untimed-semantic-admission.json','elapsedWallSeconds',363),
                ('untimed-semantic-admission.json','inputs',[]),
            ]:
                with self.subTest(filename=filename,field=field):
                    for p,data in originals.items():p.write_bytes(data)
                    record=ci.read(root/filename);record[field]=value;ci.write(root/filename,record)
                    with self.assertRaises(AssertionError):ci.validate_untimed(root,harness)
            for p,data in originals.items():p.write_bytes(data)
            (root/'untimed/node-baseline.stdout.jsonl').write_text('changed\n')
            with self.assertRaises(AssertionError):ci.validate_untimed(root,harness)

    def test_preserve_honors_fatal_controller_without_process_record(self):
        for name,record in (('ledger.json',{'fatalOwnedProcess':'identity not persisted'}),('controller-timeout.json',{'cleanup':{'ownedGroupGone':False}})):
            with tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory);(root/'screen').mkdir();ci.write(root/'screen'/name,record)
                with patch('ci.run_root',return_value=root),patch('ci.sha') as digest:ci.preserve()
                digest.assert_not_called();self.assertFalse(ci.read(root/'preservation.json')['archivesVerified'])

if __name__ == '__main__': unittest.main()
