#!/usr/bin/env python3
"""Deterministic adapter tests: no build, pilot, benchmark, or network call."""
import copy
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
import zipfile
from unittest.mock import patch

HERE=pathlib.Path(__file__).resolve().parent
REPO=HERE.parents[1]
adapter=types.ModuleType('ci_adapter')
exec(compile((HERE/'ci.py').read_text(),str(HERE/'ci.py'),'exec'),adapter.__dict__)

def fresh_intent(): return json.loads((HERE/'intent.json').read_text()) | {
    'measure':False,'reviewedHarnessSha256':'','reviewedAdapterSha256':'','validatedCheckCommit':'',
    'validatedCheckRun':0,'validatedArtifactId':0,'validatedArtifactZipSha256':'','validatedManifestSha256':''}
def active_intent(before, ids): return dict(schema=1,measure=True,reviewedHarnessSha256=ids['harnessDigest'],
    reviewedAdapterSha256=ids['adapterDigest'],validatedCheckCommit=before,validatedCheckRun=123,
    validatedArtifactId=456,validatedArtifactZipSha256='a'*64,validatedManifestSha256='b'*64)
def commit(root):
    subprocess.run(['git','-C',str(root),'add','.'],check=True,capture_output=True)
    subprocess.run(['git','-C',str(root),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','test'],check=True,capture_output=True)
    return adapter.git_text(root,'rev-parse','HEAD')
def write_intent(root,value):
    path=root/adapter.CI_INTENT;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
def zip_bytes(entries):
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w') as archive:
        for name,contents in entries:archive.writestr(name,contents)
    return output.getvalue()

class AdapterTests(unittest.TestCase):
    def test_original_harness_remains_byte_exact(self):
        self.assertEqual(adapter.identity(REPO)['harnessDigest'],adapter.HARNESS_DIGEST)

    def test_checks_only_schema_is_exact_and_empty(self):
        ids={'harnessDigest':'h','adapterDigest':'a'}
        self.assertFalse(adapter.validate_intent(REPO,fresh_intent(),ids,'push',''))
        invalid=fresh_intent();invalid['validatedCheckRun']=True
        with self.assertRaises(AssertionError):adapter.validate_intent(REPO,invalid,ids,'push','')
        invalid=fresh_intent();invalid['reviewedAdapterSha256']='stale'
        with self.assertRaises(AssertionError):adapter.validate_intent(REPO,invalid,ids,'push','')

    def test_one_time_direct_parent_intent_only_activation(self):
        ids={'harnessDigest':'h'*64,'adapterDigest':'a'*64}
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);subprocess.run(['git','init',str(root)],check=True,capture_output=True)
            write_intent(root,fresh_intent());before=commit(root)
            active=active_intent(before,ids);write_intent(root,active);commit(root)
            self.assertTrue(adapter.validate_intent(root,active,ids,'push',before))
            with self.assertRaises(AssertionError):adapter.validate_intent(root,active,ids,'workflow_dispatch',before)
            with self.assertRaises(AssertionError):adapter.validate_intent(root,active,ids,'push','0'*40)
            write_intent(root,fresh_intent());second_before=commit(root)
            repeated=active_intent(second_before,ids);write_intent(root,repeated);commit(root)
            with self.assertRaises(AssertionError):adapter.validate_intent(root,repeated,ids,'push',second_before)

    def test_activation_rejects_unrelated_file_change(self):
        ids={'harnessDigest':'h'*64,'adapterDigest':'a'*64}
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);subprocess.run(['git','init',str(root)],check=True,capture_output=True)
            write_intent(root,fresh_intent());before=commit(root)
            active=active_intent(before,ids);write_intent(root,active);(root/'extra.txt').write_text('unreviewed');commit(root)
            with self.assertRaises(AssertionError):adapter.validate_intent(root,active,ids,'push',before)

    def test_ours_merge_cannot_hide_old_measurement_intent(self):
        ids={'harnessDigest':'h'*64,'adapterDigest':'a'*64}
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);subprocess.run(['git','init',str(root)],check=True,capture_output=True)
            write_intent(root,fresh_intent());base=commit(root)
            subprocess.run(['git','-C',str(root),'checkout','-b','old-measurement'],check=True,capture_output=True)
            write_intent(root,active_intent(base,ids));commit(root)
            subprocess.run(['git','-C',str(root),'checkout','-b','checks',base],check=True,capture_output=True)
            (root/'marker.txt').write_text('checks branch');commit(root)
            subprocess.run(['git','-C',str(root),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
                'merge','--no-ff','-s','ours','old-measurement','-m','preserve checks-only tree'],check=True,capture_output=True)
            before=adapter.git_text(root,'rev-parse','HEAD')
            simplified=adapter.git_text(root,'log','--format=%H',before,'--',adapter.CI_INTENT).splitlines()
            self.assertTrue(all(json.loads(adapter.git(root,'show',revision+':'+adapter.CI_INTENT))['measure'] is False for revision in simplified))
            active=active_intent(before,ids);write_intent(root,active);commit(root)
            with self.assertRaisesRegex(AssertionError,'reachable history'):adapter.validate_intent(root,active,ids,'push',before)

    def test_activation_itself_must_have_exactly_one_parent(self):
        ids={'harnessDigest':'h'*64,'adapterDigest':'a'*64}
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);subprocess.run(['git','init',str(root)],check=True,capture_output=True)
            write_intent(root,fresh_intent());before=commit(root)
            subprocess.run(['git','-C',str(root),'checkout','-b','activation-side'],check=True,capture_output=True)
            active=active_intent(before,ids);write_intent(root,active);commit(root)
            subprocess.run(['git','-C',str(root),'checkout','--detach',before],check=True,capture_output=True)
            subprocess.run(['git','-C',str(root),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','merge','--no-ff','--no-commit','activation-side'],check=True,capture_output=True)
            commit(root)
            self.assertEqual(adapter.git_text(root,'rev-parse','HEAD^'),before)
            self.assertEqual(adapter.git_text(root,'diff','--name-only',before,'HEAD'),adapter.CI_INTENT)
            with self.assertRaisesRegex(AssertionError,'exactly one parent'):adapter.validate_intent(root,active,ids,'push',before)

    def test_previous_ci_start_gate_accepts_only_complete_checks_only_history(self):
        head='c'*40;previous='b'*40
        def run(run_id,sha):return dict(id=run_id,head_sha=sha,head_branch=adapter.BRANCH,path=adapter.WORKFLOW,run_attempt=1,event='push')
        def execute(runs,previous_intent=None,total=None):
            previous_intent=fresh_intent() if previous_intent is None else previous_intent
            data=json.dumps(previous_intent).encode()
            contents=dict(type='file',path=adapter.CI_INTENT,encoding='base64',size=len(data),
                content=adapter.base64.b64encode(data).decode(),sha=adapter.hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest())
            responses=[dict(total_count=len(runs) if total is None else total,workflow_runs=runs),contents]
            with tempfile.TemporaryDirectory() as directory,patch.object(adapter,'git_text',return_value=head),patch.object(adapter,'api_json',side_effect=responses) as api:
                gate=pathlib.Path(directory)
                try:adapter.verify_previous_starts(REPO,gate,124)
                finally:
                    status=adapter.read(gate/'ci-start-history/status.json')
                    self.assertEqual(status['maxRuns'],20)
                    self.assertTrue(all(call.kwargs['timeout']<=30 for call in api.call_args_list))
                    self.assertTrue((gate/'ci-start-history/runs.json').exists())
                self.assertTrue(status['passed'])
        execute([run(124,head),run(100,previous)])
        with self.assertRaisesRegex(AssertionError,'already started CI'):execute([run(124,head),run(123,head)])
        with self.assertRaisesRegex(AssertionError,'previous activation'):execute([run(124,head),run(100,previous)],fresh_intent()|{'measure':True})
        with self.assertRaises(AssertionError):execute([run(124,head)],total=21)
        with self.assertRaisesRegex(AssertionError,'absent'):execute([run(100,previous)])

    def test_ref_rewind_and_repush_of_same_activation_cannot_repeat_campaign(self):
        ids={'harnessDigest':'h'*64,'adapterDigest':'a'*64}
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);subprocess.run(['git','init',str(root)],check=True,capture_output=True)
            write_intent(root,fresh_intent());before=commit(root)
            active=active_intent(before,ids);write_intent(root,active);activation=commit(root)
            subprocess.run(['git','-C',str(root),'reset','--hard',before],check=True,capture_output=True)
            subprocess.run(['git','-C',str(root),'merge','--ff-only',activation],check=True,capture_output=True)
            self.assertTrue(adapter.validate_intent(root,active,ids,'push',before))
            runs=[dict(id=run_id,head_sha=activation,head_branch=adapter.BRANCH,path=adapter.WORKFLOW,run_attempt=1,event='push') for run_id in [124,123]]
            gate=root/'gate';gate.mkdir()
            with patch.object(adapter,'api_json',return_value={'total_count':2,'workflow_runs':runs}):
                with self.assertRaisesRegex(AssertionError,'replay prohibited'):adapter.verify_previous_starts(root,gate,124)
            self.assertFalse(adapter.read(gate/'ci-start-history/status.json')['passed'])

    def test_environment_transition_only_allows_declared_runner_metadata(self):
        old={'harnessDigest':'same','builds':{'same':True},'environment':{
            'cpus':[1],'release':'old','totalMemory':100,'execPath':'/old/node',
            'node':'v22.23.3','bun':'1.4.2','platform':'linux','arch':'x64',
            'nodeExecutableSha256':'node','bunExecutableSha256':'bun'}}
        current=copy.deepcopy(old);current['environment'].update(cpus=[2],release='new',totalMemory=200,execPath='/new/node')
        adapter.reconcile_manifests(old,current)
        for key in ['node','bun','platform','arch','nodeExecutableSha256','bunExecutableSha256']:
            broken=copy.deepcopy(current);broken['environment'][key]='changed'
            with self.assertRaises(AssertionError):adapter.reconcile_manifests(old,broken)
        broken=copy.deepcopy(current);broken['builds']={}
        with self.assertRaises(AssertionError):adapter.reconcile_manifests(old,broken)

    def test_exact_three_file_zip_and_special_file_rejection(self):
        entries=[('manifest.json','{}'),('checked.json','{}'),('receipt.json','{}')]
        with tempfile.TemporaryDirectory() as directory:
            adapter.extract_reference(zip_bytes(entries),pathlib.Path(directory))
            self.assertEqual(json.loads((pathlib.Path(directory)/'manifest.json').read_text()),{})
        for replacement in ['../manifest.json','extra.json']:
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(AssertionError):adapter.extract_reference(zip_bytes([(replacement,'{}')]+entries[1:]),pathlib.Path(directory))
        for mode in [0o120777,0o010644,0o020644]:
            info=zipfile.ZipInfo('manifest.json');info.create_system=3;info.external_attr=mode<<16
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(AssertionError):adapter.extract_reference(zip_bytes([(info,'{}')]+entries[1:]),pathlib.Path(directory))

    def test_prior_fixture_bytes_and_work_must_match_fresh_ci_checks(self):
        row=dict(runtime='bun',workload='map-object-512',role='refinement',result={
            'schema':1,'phase':'check','workload':'map-object-512','fixture':{'bytes':'same'},
            'fixtureDigest':'same','postFixtureDigest':'same','opsPerSweep':512,
            'expectedPerSweep':512,'checkSink':512,'packageDigest':'same'})
        before={'results':[copy.deepcopy(row) for _ in range(18)]};after=copy.deepcopy(before)
        adapter.reconcile_checks(before,after)
        after['results'][0]['result']['fixture']['bytes']='changed'
        with self.assertRaises(AssertionError):adapter.reconcile_checks(before,after)

    def test_exact_prior_run_job_and_artifact_are_required(self):
        ids={'harnessDigest':adapter.HARNESS_DIGEST,'adapterDigest':'a'*64};intent=active_intent('b'*40,ids)
        manifest={'harnessDigest':adapter.HARNESS_DIGEST,'pins':adapter.PINS};manifest_bytes=json.dumps(manifest).encode()
        checked={'passed':True,'timed':False,'harnessDigest':adapter.HARNESS_DIGEST,'results':[
            dict(runtime=runtime,workload=case,role=role) for runtime in ['node','bun']
            for case in ['map-object-512','map-number-512','map-string-512'] for role in adapter.PINS]}
        checked_bytes=json.dumps(checked).encode();intent['validatedManifestSha256']=adapter.sha(manifest_bytes)
        receipt=dict(sourceCommit='b'*40,runId=123,measure=False,**ids,
            manifestSha256=intent['validatedManifestSha256'],checkedSha256=adapter.sha(checked_bytes))
        archive=zip_bytes([('manifest.json',manifest_bytes),('checked.json',checked_bytes),('receipt.json',json.dumps(receipt))]);intent['validatedArtifactZipSha256']=adapter.sha(archive)
        run=dict(id=123,head_sha='b'*40,head_branch=adapter.BRANCH,status='completed',conclusion='success',run_attempt=1,
                 event='push',path=adapter.WORKFLOW,repository={'full_name':adapter.REPOSITORY})
        names=['Resolve and verify prospective CI intent','Build and validate pinned sources','Retain complete and partial evidence','Upload check reference','Upload complete or partial evidence']
        job=dict(name='focused-screen',run_id=123,head_sha='b'*40,status='completed',conclusion='success',
            steps=[{'name':name,'conclusion':'success'} for name in names]+[{'name':'Run one bounded focused campaign','conclusion':'skipped'}])
        artifact=dict(id=456,expired=False,name='object-tail-check-'+('b'*40)+'-123',workflow_run={'id':123,'head_sha':'b'*40})
        def execute(run_value=run,job_value=job,artifact_value=artifact):
            responses={'actions/runs/123':run_value,'actions/runs/123/attempts/1/jobs?per_page=100':{'total_count':1,'jobs':[job_value]},'actions/artifacts/456':artifact_value}
            with tempfile.TemporaryDirectory() as directory,patch.object(adapter,'api_json',side_effect=lambda path:responses[path]),patch.object(adapter,'artifact_bytes',return_value=archive):
                adapter.verify_prior(intent,ids,pathlib.Path(directory))
        execute()
        bad=copy.deepcopy(job);bad['steps'][1]['conclusion']='skipped'
        with self.assertRaises(AssertionError):execute(job_value=bad)
        bad=copy.deepcopy(job);bad['steps'][-1]['conclusion']='success'
        with self.assertRaises(AssertionError):execute(job_value=bad)
        with self.assertRaises(AssertionError):execute(run_value=run|{'run_attempt':2})
        with self.assertRaises(AssertionError):execute(artifact_value=artifact|{'expired':True})

    def test_failed_command_retains_started_log_and_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            gate=pathlib.Path(directory)
            with self.assertRaises(AssertionError):adapter.command(gate,'injected-failure',[sys.executable,'-c','print("retained partial output");raise SystemExit(3)'],gate,10)
            self.assertTrue((gate/'commands/injected-failure.started.json').exists())
            self.assertEqual(adapter.read(gate/'commands/injected-failure.finished.json')['returncode'],3)
            self.assertIn('retained partial output',(gate/'commands/injected-failure.log').read_text())

    def test_partial_build_archive_is_self_contained_and_excludes_worktrees(self):
        with tempfile.TemporaryDirectory() as directory:
            gate=pathlib.Path(directory)/'partial';(gate/'builds/baseline/dist').mkdir(parents=True)
            (gate/'builds/baseline/dist/shared.js').write_text('partial build')
            (gate/'builds/baseline/node_modules').symlink_to(pathlib.Path(directory)/'missing-dependencies')
            adapter.retain(REPO,gate)
            with tarfile.open(gate.with_suffix('.tar.gz')) as archive:
                names=archive.getnames();self.assertTrue(any('retained-builds/baseline/dist/shared.js' in name for name in names))
                self.assertFalse(any(name.startswith('partial/builds') for name in names))
                self.assertTrue(all(item.isfile() or item.isdir() for item in archive.getmembers()))

    def test_auditor_timeout_and_launch_error_still_archive_partial_evidence(self):
        for failure_kind in ['timeout','launch']:
            with self.subTest(failure_kind=failure_kind),tempfile.TemporaryDirectory() as directory:
                gate=pathlib.Path(directory)/'audit-failure';(gate/'validation/campaign').mkdir(parents=True)
                def fail_audit(args,stdout,stderr,timeout):
                    if failure_kind=='timeout':
                        stdout.write(b'partial audit output\n');stdout.flush()
                        stderr.write(b'audit diagnostic\n');stderr.flush()
                        raise subprocess.TimeoutExpired(args,timeout)
                    raise FileNotFoundError('injected auditor launch failure')
                with patch.object(adapter,'git_text',return_value='f'*40),patch.object(adapter.subprocess,'run',side_effect=fail_audit):
                    with self.assertRaisesRegex(AssertionError,'partial archive was retained'):adapter.retain(REPO,gate)
                status=adapter.read(gate/'raw-audit-status.json')
                self.assertFalse(status['passed']);self.assertIsNone(status['returncode']);self.assertTrue(status['error'])
                archive_path=gate.with_suffix('.tar.gz');self.assertTrue(archive_path.exists())
                checksum=pathlib.Path(str(archive_path)+'.sha256').read_text().split()[0]
                self.assertEqual(checksum,adapter.sha(archive_path.read_bytes()))
                with tarfile.open(archive_path) as archive:
                    self.assertEqual(json.load(archive.extractfile('audit-failure/raw-audit-status.json')),status)
                    self.assertEqual(archive.extractfile('audit-failure/raw-audit.json').read(),b'partial audit output\n' if failure_kind=='timeout' else b'')
                    self.assertEqual(archive.extractfile('audit-failure/raw-audit.stderr').read(),b'audit diagnostic\n' if failure_kind=='timeout' else b'')

if __name__=='__main__':unittest.main()
