"""Synthetic failure integration only: all process/proc/clock/signal APIs mocked."""
import json
import copy
import hashlib
import pathlib
import tempfile
import types
import unittest
from contextlib import ExitStack
from unittest.mock import patch
import run
import ci

HERE=pathlib.Path(__file__).resolve().parent
PROTOCOL=json.loads((HERE/'protocol.json').read_text())
ROOT={'pid':111,'state':'S','ppid':900,'group':111,'session':111,'startTicks':10}
CONTROLLER={'pid':900,'state':'S','ppid':1,'group':900,'session':900,'startTicks':1}
SLOT={'id':'chromium-untimed-baseline','runtime':'chromium','mode':'untimed','warm':True,'arm':'baseline'}


class Child:
    pid=111
    returncode=1
    def poll(self):return self.returncode


class Failures(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name);self.out=self.root/'run';self.out.mkdir()
        self.manifest={'sources':{'baseline':{'path':'/synthetic/source'}},'runtimes':{'node':{'path':'/synthetic/node','args':[]}}}
        self.manifest_path=self.root/'manifest.json';self.manifest_path.write_text(json.dumps(self.manifest))
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(run.inherited,'verify',return_value={'ok':True}))
        self.stack.enter_context(patch.object(run.inherited,'host',return_value={'synthetic':True}))
        self.stack.enter_context(patch.object(run.time,'monotonic',return_value=1))
        self.stack.enter_context(patch.object(run.time,'sleep',side_effect=AssertionError('Unexpected clock wait')))
        self.stack.enter_context(patch.object(run.resources,'begin_scope',return_value=types.SimpleNamespace(controller=CONTROLLER)))
        self.stack.enter_context(patch.object(run.resources,'capture_root',side_effect=lambda pid,known:known.setdefault(pid,ROOT)))
        self.stack.enter_context(patch.object(run.resources,'census',side_effect=AssertionError('Unexpected real census')))
        self.stack.enter_context(patch.object(run.resources,'rss_for_pid',side_effect=AssertionError('Unexpected RSS read')))
        self.fsync=self.stack.enter_context(patch.object(run.os,'fsync'))

    def file(self,suffix):return self.out/(SLOT['id']+suffix)
    def receipt(self):return json.loads(self.file('.receipt.json').read_text())
    def launch(self):return run.launch(self.manifest,PROTOCOL,self.out,SLOT,'x64',100,self.manifest_path)
    def unknown(self):return {'pid':111,'ownedGroupGone':False,'quiescence':'unknown','problems':['synthetic unknown']}
    def verified(self):return {'pid':111,'ownedGroupGone':True,'quiescence':'verified','descendantScope':{'finalKernelChildrenAbsent':True}}

    def test_popen_interrupt_after_modeled_fork_retains_prior_intent(self):
        def interrupted(*args,**kwargs):
            marker=json.loads(self.file('.process.json').read_text())
            self.assertEqual(marker['status'],'spawn-intent');self.assertIsNone(marker['pid'])
            self.assertEqual(self.fsync.call_count,2)
            raise KeyboardInterrupt('modeled fork before Popen return')
        with patch.object(run.subprocess,'Popen',side_effect=interrupted),patch.object(run.resources,'cleanup',side_effect=AssertionError('No child handle exists')):
            with self.assertRaises(KeyboardInterrupt):self.launch()
        record=self.receipt();self.assertTrue(record['fatalOwnedProcess']);self.assertTrue(record['spawnAttempted'])
        self.assertEqual(record['cleanup']['quiescence'],'unknown');self.assertNotIn('stdoutSha256',record)

    def test_first_returned_pid_receipt_interrupt_retains_null_pid_intent(self):
        original_update=run.update
        def interrupted(path,value):
            if pathlib.Path(path)==self.file('.process.json'):raise TimeoutError('first PID receipt interrupted')
            return original_update(path,value)
        with patch.object(run.subprocess,'Popen',return_value=Child()),patch.object(run,'update',side_effect=interrupted),patch.object(run.resources,'cleanup',return_value=self.unknown()):
            with self.assertRaises(TimeoutError):self.launch()
        self.assertEqual(json.loads(self.file('.process.json').read_text())['status'],'spawn-intent')
        self.assertIn('first PID receipt interrupted',self.receipt()['error']);self.assertTrue(self.receipt()['fatalOwnedProcess'])

    def test_absent_journal_does_not_replace_original_spawn_failure(self):
        with patch.object(run.subprocess,'Popen',side_effect=FileNotFoundError('synthetic executable missing')):
            with self.assertRaises(FileNotFoundError):self.launch()
        record=self.receipt();self.assertIn('synthetic executable missing',record['error'])
        self.assertFalse(self.file('.ownership.jsonl').exists());self.assertNotIn('ownershipSha256',record)
        self.assertTrue(record['fatalOwnedProcess'])

    def test_adapter_failure_before_journal_stays_unknown(self):
        with patch.object(run.subprocess,'Popen',return_value=Child()),patch.object(run.resources,'cleanup',return_value=self.unknown()):
            with self.assertRaises(AssertionError):self.launch()
        record=self.receipt();self.assertIn('Subject exited 1',record['error']);self.assertNotIn('ownershipSha256',record)

    def test_signal_during_cleanup_retains_unknown_receipt(self):
        with patch.object(run.subprocess,'Popen',return_value=Child()),patch.object(run.resources,'cleanup',side_effect=TimeoutError('cleanup interrupted')):
            with self.assertRaises(AssertionError):self.launch()
        record=self.receipt();self.assertTrue(record['fatalOwnedProcess'])
        self.assertEqual(record['cleanup']['quiescence'],'unknown');self.assertIn('cleanup interrupted',record['cleanup']['error'])

    def test_cleanup_file_interruption_still_writes_failed_slot_receipt(self):
        original_write=run.write
        def interrupted(path,value):
            if pathlib.Path(path)==self.file('.cleanup.json'):raise TimeoutError('cleanup receipt interrupted')
            return original_write(path,value)
        with patch.object(run.subprocess,'Popen',return_value=Child()),patch.object(run.resources,'cleanup',return_value=self.verified()),patch.object(run,'write',side_effect=interrupted):
            with self.assertRaises(AssertionError):self.launch()
        record=self.receipt();self.assertTrue(record['fatalOwnedProcess']);self.assertIn('cleanup receipt interrupted',record['cleanupReceiptError'])

    def test_hash_failure_retains_original_failure_and_slot_receipt(self):
        original_sha=run.sha
        def fail_hash(path):
            if pathlib.Path(path)==self.file('.stdout.jsonl'):raise PermissionError('synthetic hash failure')
            return original_sha(path)
        with patch.object(run.subprocess,'Popen',return_value=Child()),patch.object(run.resources,'cleanup',return_value=self.verified()),patch.object(run,'sha',side_effect=fail_hash):
            with self.assertRaises(AssertionError):self.launch()
        record=self.receipt();self.assertIn('Subject exited 1',record['error']);self.assertIn('synthetic hash failure',record['finalizationError'])

    def preserve(self):
        with patch.object(ci,'run_root',return_value=self.root),patch.object(ci,'source',return_value=self.root/'absent-source'),patch.object(ci.subprocess,'run',side_effect=AssertionError('No real process allowed')):
            ci.preserve()
        return json.loads((self.root/'preservation.json').read_text())

    def write_bound_cleanup(self,runtime='chromium'):
        slot=dict(SLOT,runtime=runtime,id=runtime+'-untimed-baseline')
        file=lambda suffix:self.out/(slot['id']+suffix)
        config={**slot,'lane':'x64','manifestSha256':'a'*64}
        engine={'pid':222,'state':'S','ppid':111,'group':222,'session':222,'startTicks':20}
        process={'pid':111,'group':111,'status':'spawned','identity':ROOT,'command':['/synthetic/node',str(file('.config.json'))]}
        cleanup={'pid':111,'group':111,'ownedGroups':[111],'ownedProcessIdentities':[ROOT],'returncode':1,
                 'ownedGroupGone':True,'quiescence':'verified','survivors':[],'problems':[],'ownership':None,
                 'descendantScope':{'controller':CONTROLLER,'subreaperVerified':True,'initialKernelChildrenAbsent':True,'finalKernelChildrenAbsent':True,'adoptedChildrenReaped':[]}}
        if runtime in ('chromium','firefox','webkit'):
            binding={'slotId':slot['id'],**{key:config[key] for key in ('manifestSha256','runtime','lane','arm','mode')}}
            config.update(ownershipJournal=str(file('.ownership.jsonl')),ownershipBinding=binding)
            rows=[{'kind':'ownership-ready','adapter':ROOT},{'kind':'engine-spawn-intent','attempt':1},{'kind':'engine-spawned','attempt':1,'identity':engine},{'kind':'ownership-sealed','attempts':1,'engineExited':True}]
            rows=[dict(row,schema=1,sequence=index,binding=binding) for index,row in enumerate(rows)]
            data=''.join(json.dumps(row)+'\n' for row in rows).encode();file('.ownership.jsonl').write_bytes(data)
            cleanup.update(ownedGroups=[111,222],ownedProcessIdentities=[ROOT,engine],ownership={'path':config['ownershipJournal'],'sha256':hashlib.sha256(data).hexdigest(),'binding':binding,'registeredEngine':engine,'sealed':True,'complete':True,'problems':[]})
        file('.config.json').write_text(json.dumps(config))
        record={**slot,'status':'failed','command':process['command'],'cleanup':cleanup,'error':'synthetic RSS failure',
                'resourceAccounting':{'status':'failed'},'resourceAccountingError':{'identity':ROOT},'configSha256':hashlib.sha256(file('.config.json').read_bytes()).hexdigest()}
        file('.process.json').write_text(json.dumps(process));file('.cleanup.json').write_text(json.dumps(cleanup));file('.receipt.json').write_text(json.dumps(record))
        (self.out/'ledger.json').write_text(json.dumps({'status':'incomplete','slots':[dict(slot,status='failed')]}))
        return file,config,process,cleanup,record

    def rewrite_cleanup(self,file,cleanup,record):
        record['cleanup']=cleanup
        file('.cleanup.json').write_text(json.dumps(cleanup));file('.receipt.json').write_text(json.dumps(record))

    def test_absent_pid_and_receipt_with_attempted_ledger_blocks_preservation(self):
        for status in ('started','failed','complete'):
            with self.subTest(status=status):
                (self.out/'ledger.json').write_text(json.dumps({'status':'incomplete','slots':[dict(SLOT,status=status)]}))
                receipt=self.preserve();self.assertEqual(receipt['status'],'partial-unverified');self.assertEqual(receipt['quiescence'],'unknown')
                self.assertFalse((self.root/'artifact-inventory.json').exists())

    def test_null_pid_intent_or_fatal_slot_without_ledger_blocks_preservation(self):
        self.file('.process.json').write_text(json.dumps({'pid':None,'status':'spawn-intent'}))
        self.assertEqual(self.preserve()['quiescence'],'unknown')
        self.file('.process.json').unlink()
        self.file('.receipt.json').write_text(json.dumps({'status':'failed','fatalOwnedProcess':True}))
        self.assertEqual(self.preserve()['quiescence'],'unknown')

    def test_verified_cleanup_allows_stable_failed_subject_preservation(self):
        self.write_bound_cleanup()
        receipt=self.preserve();self.assertEqual(receipt['quiescence'],'verified-from-owned-receipts');self.assertEqual(receipt['status'],'complete')

    def test_native_verified_cleanup_preserves_failed_rss(self):
        self.write_bound_cleanup('node')
        self.assertEqual(self.preserve()['quiescence'],'verified-from-owned-receipts')

    def test_summary_cleanup_flags_are_not_preservation_proof(self):
        file,config,process,cleanup,record=self.write_bound_cleanup()
        self.rewrite_cleanup(file,self.verified(),record)
        self.assertEqual(self.preserve()['quiescence'],'unknown')

    def test_missing_or_misbound_cleanup_births_reject_preservation(self):
        mutations=[lambda c:c.update(ownedProcessIdentities=[]),lambda c:c['ownedProcessIdentities'][0].update(startTicks=999),
                   lambda c:c['descendantScope'].pop('controller'),lambda c:c['descendantScope']['controller'].update(pid=901),
                   lambda c:c.update(ownedGroups=[111]),lambda c:c.update(returncode=None),
                   lambda c:c['descendantScope'].update(adoptedChildrenReaped=[{'identity':dict(ROOT,pid=333),'waitStatus':0}])]
        for index,mutate in enumerate(mutations):
            with self.subTest(index=index):
                file,config,process,cleanup,record=self.write_bound_cleanup();cleanup=copy.deepcopy(cleanup)
                mutate(cleanup);self.rewrite_cleanup(file,cleanup,record)
                self.assertEqual(self.preserve()['quiescence'],'unknown')

    def test_missing_or_misbound_browser_journal_rejects_preservation(self):
        for mode in ('missing','digest','binding','engine','partial'):
            with self.subTest(mode=mode):
                file,config,process,cleanup,record=self.write_bound_cleanup();path=file('.ownership.jsonl')
                if mode=='missing':path.unlink()
                elif mode=='digest':cleanup['ownership']['sha256']='0'*64
                else:
                    rows=[json.loads(line) for line in path.read_bytes().splitlines()]
                    if mode=='binding':rows[2]['binding']['slotId']='wrong-slot'
                    if mode=='engine':rows[2]['identity']['startTicks']=999
                    data=''.join(json.dumps(row)+'\n' for row in rows).encode()
                    if mode=='partial':data=data[:-1]
                    path.write_bytes(data);cleanup['ownership']['sha256']=hashlib.sha256(data).hexdigest()
                self.rewrite_cleanup(file,cleanup,record)
                self.assertEqual(self.preserve()['quiescence'],'unknown')

    def test_missing_process_birth_or_misbound_config_rejects_preservation(self):
        for mode in ('identity','command','runtime','configDigest','duplicatedCleanup'):
            with self.subTest(mode=mode):
                file,config,process,cleanup,record=self.write_bound_cleanup()
                if mode=='identity':process.pop('identity')
                if mode=='command':process['command'][-1]='/other/config.json';record['command']=process['command']
                if mode=='runtime':config['runtime']='node';file('.config.json').write_text(json.dumps(config));record['configSha256']=hashlib.sha256(file('.config.json').read_bytes()).hexdigest()
                if mode=='configDigest':record['configSha256']='0'*64
                if mode=='duplicatedCleanup':record['cleanup']=dict(cleanup,quiescence='unknown')
                file('.process.json').write_text(json.dumps(process));file('.receipt.json').write_text(json.dumps(record))
                self.assertEqual(self.preserve()['quiescence'],'unknown')


if __name__=='__main__':unittest.main()
