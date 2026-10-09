#!/usr/bin/env python3
"""Clean-runner adapter for the byte-preserved, independently reviewed screen."""
import datetime
import base64
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = 'natanelia/zerocopy'
BRANCH = 'perf/object-read-simplified-tail-20261009'
WORKFLOW = '.github/workflows/object-tail-focused-screen.yml'
CI_INTENT = 'proofs/object-tail-ci/intent.json'
HARNESS = 'proofs/object-tail-screen'
HARNESS_DIGEST = 'f814ddaca8d22056be8ef5c063d8d2dcfe0851af7e6f651c3108e96b43293fad'
PINS = {'baseline': '3773c6e519c7c0958da13727ed1082f449f3ee25',
        'original': '042b41a7f68a89a10751f285eef79259adfe4aa3',
        'refinement': '25b55f5dfacb926dc3d7354234c6d69326329071'}
LOCK_SHA = '9a66d94c2fbd6c9d37917c53264f8c08ac58a42a6c75eb425dd905539eb1a1fe'
MAX_REFERENCE_BYTES = 16 * 1024 * 1024
MAX_HISTORY_RUNS = 20
HISTORY_TIMEOUT_SECONDS = 180

def read(path): return json.loads(path.read_text())
def sha(data): return hashlib.sha256(data).hexdigest()
def json_hash(data): return sha(json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode())
def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream: stream.write(data)
def save(path, data): write_new(path, (json.dumps(data, indent=2) + '\n').encode())
def git(repo, *args): return subprocess.check_output(['git', '-C', str(repo), *args])
def git_text(repo, *args): return git(repo, *args).decode().strip()
def utc_now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def file_list(root):
    result=[]
    for path in sorted(root.rglob('*')):
        assert not path.is_symlink(), 'symlink in review/reference input'
        if path.is_file(): result.append([str(path.relative_to(root)), sha(path.read_bytes())])
    return result
def identity(repo):
    harness_files=[row for row in file_list(repo/HARNESS) if row[0] != 'intent.json']
    assert json_hash(harness_files)==HARNESS_DIGEST, 'reviewed harness bytes changed'
    assert read(repo/HARNESS/'intent.json')==dict(schema=1,measure=False,reviewedHarnessSha256='',checkedManifestSha256='')
    adapter_files=[['proofs/object-tail-ci/'+name,digest] for name,digest in file_list(repo/'proofs/object-tail-ci') if name != 'intent.json']
    adapter_files.append([WORKFLOW,sha((repo/WORKFLOW).read_bytes())]); adapter_files.sort()
    return dict(harnessDigest=HARNESS_DIGEST,harnessFiles=harness_files,adapterDigest=json_hash(adapter_files),adapterFiles=adapter_files)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None

def api_request(path):
    assert not path.startswith('/') and '://' not in path
    return urllib.request.Request('https://api.github.com/repos/'+REPOSITORY+'/'+path, headers={
        'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
def api_json(path, timeout=60):
    with urllib.request.build_opener(NoRedirect()).open(api_request(path),timeout=timeout) as response:
        data=response.read(2*1024*1024+1); assert len(data)<=2*1024*1024; return json.loads(data)
def artifact_bytes(artifact_id):
    opener=urllib.request.build_opener(NoRedirect())
    try: response=opener.open(api_request('actions/artifacts/'+str(artifact_id)+'/zip'),timeout=60)
    except urllib.error.HTTPError as error:
        assert error.code==302
        location=error.headers.get('Location'); assert location
        url=urllib.parse.urlsplit(location); host=(url.hostname or '').lower()
        assert url.scheme=='https' and not url.username and not url.password and url.port in (None,443)
        assert host.endswith(('.blob.core.windows.net','.githubusercontent.com','.actions.githubusercontent.com'))
        # No Authorization header or redirect following on the download request.
        response=opener.open(urllib.request.Request(location),timeout=60)
    with response:
        data=response.read(MAX_REFERENCE_BYTES+1); assert len(data)<=MAX_REFERENCE_BYTES; return data
def extract_reference(data, directory):
    archive=directory/'reference.zip'; write_new(archive,data)
    expected={'manifest.json','checked.json','receipt.json'}
    with zipfile.ZipFile(archive) as stream:
        entries=stream.infolist()
        assert len(entries)==3 and {entry.filename for entry in entries}==expected
        assert sum(entry.file_size for entry in entries)<=MAX_REFERENCE_BYTES
        for entry in entries:
            assert not entry.is_dir() and (entry.external_attr>>16)&0o170000 in (0,0o100000)
            content=stream.read(entry); assert len(content)==entry.file_size
            write_new(directory/entry.filename,content)

def validate_intent(repo, intent, ids, event_name, before):
    keys={'schema','measure','reviewedHarnessSha256','reviewedAdapterSha256','validatedCheckCommit',
          'validatedCheckRun','validatedArtifactId','validatedArtifactZipSha256','validatedManifestSha256'}
    assert set(intent)==keys and type(intent['schema']) is int and intent['schema']==1 and type(intent['measure']) is bool
    for key in ['validatedCheckRun','validatedArtifactId']: assert type(intent[key]) is int
    for key in keys-{'schema','measure','validatedCheckRun','validatedArtifactId'}: assert type(intent[key]) is str
    if not intent['measure']:
        assert all(intent[key]=='' for key in keys-{'schema','measure','validatedCheckRun','validatedArtifactId'})
        assert intent['validatedCheckRun']==intent['validatedArtifactId']==0
        return False
    # An activated revision cannot be manually redispatched for more timing.
    assert event_name=='push', 'activation requires the first nonforced push only'
    assert intent['reviewedHarnessSha256']==ids['harnessDigest']
    assert intent['reviewedAdapterSha256']==ids['adapterDigest']
    assert re.fullmatch('[0-9a-f]{40}',intent['validatedCheckCommit']) and before==intent['validatedCheckCommit']
    parents=git_text(repo,'rev-list','--parents','-n','1','HEAD').split()
    assert len(parents)==2 and parents[1]==before, 'activation must have exactly one parent, the validated check commit'
    assert git_text(repo,'diff','--name-only',before,'HEAD').splitlines()==[CI_INTENT]
    assert intent['validatedCheckRun']>0 and intent['validatedArtifactId']>0
    for key in ['validatedArtifactZipSha256','validatedManifestSha256']: assert re.fullmatch('[0-9a-f]{64}',intent[key])
    # No path-limited log: history simplification can hide a measured side branch
    # behind an ours merge. Inspect every reachable commit, deduplicating blobs.
    history=git_text(repo,'rev-list',before).splitlines(); assert history
    blobs=set()
    for revision in history:
        entry=git_text(repo,'ls-tree',revision,'--',CI_INTENT)
        if not entry: continue
        blob=entry.split()[2]
        if blob in blobs: continue
        blobs.add(blob)
        assert json.loads(git(repo,'cat-file','blob',blob))['measure'] is False, 'no second activation in any reachable history'
    assert blobs, 'checks-only intent must exist in prior reachable history'
    return True

def verify_previous_starts(repo, gate, current_run_id):
    """Reject replay, including commits removed from the reachable Git history."""
    directory=gate/'ci-start-history';directory.mkdir()
    started=time.monotonic();status=dict(started=utc_now(),passed=False,maxRuns=MAX_HISTORY_RUNS,maxSeconds=HISTORY_TIMEOUT_SECONDS)
    def request(path, filename):
        remaining=HISTORY_TIMEOUT_SECONDS-(time.monotonic()-started)
        assert remaining>0, 'previous-CI-start verification budget exhausted'
        response=api_json(path,timeout=min(30,remaining));save(directory/filename,response)
        assert time.monotonic()-started<=HISTORY_TIMEOUT_SECONDS, 'previous-CI-start verification budget exhausted'
        return response
    try:
        query=urllib.parse.urlencode({'branch':BRANCH,'per_page':MAX_HISTORY_RUNS})
        listing=request('actions/workflows/'+pathlib.PurePosixPath(WORKFLOW).name+'/runs?'+query,'runs.json')
        runs=listing['workflow_runs']
        assert type(listing['total_count']) is int and 0<listing['total_count']<=MAX_HISTORY_RUNS
        assert listing['total_count']==len(runs), 'incomplete workflow-start history; fail closed'
        assert len({run['id'] for run in runs})==len(runs)
        current=[run for run in runs if run['id']==current_run_id];assert len(current)==1, 'current CI start absent from history'
        head=git_text(repo,'rev-parse','HEAD')
        assert current[0]['head_sha']==head and current[0]['run_attempt']==1 and current[0]['event']=='push'
        checked_commits={}
        for run in runs:
            assert run['head_branch']==BRANCH and run['path']==WORKFLOW
            assert re.fullmatch('[0-9a-f]{40}',run['head_sha'])
            if run['id']==current_run_id: continue
            assert run['head_sha']!=head, 'this activation commit already started CI; replay prohibited'
            commit=run['head_sha']
            if commit not in checked_commits:
                contents=request('contents/'+CI_INTENT+'?ref='+commit,commit+'-contents.json')
                assert contents['type']=='file' and contents['path']==CI_INTENT and contents['encoding']=='base64'
                assert type(contents['size']) is int and 0<contents['size']<=32768
                data=base64.b64decode(''.join(contents['content'].split()),validate=True)
                assert len(data)==contents['size']
                assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==contents['sha']
                previous=json.loads(data);save(directory/(commit+'-intent.json'),previous)
                assert previous['measure'] is False, 'a previous activation already started CI, even if its commit was rewound'
                checked_commits[commit]=True
        status.update(passed=True,currentRun=current_run_id,verifiedCheckCommits=sorted(checked_commits),totalRuns=len(runs))
    except Exception as error:
        status['error']=repr(error)
        raise
    finally:
        status['ended']=utc_now();save(directory/'status.json',status)

def verify_prior(intent, ids, gate):
    run_id=intent['validatedCheckRun']; commit=intent['validatedCheckCommit']; artifact_id=intent['validatedArtifactId']
    prior=gate/'prior-check'; prior.mkdir()
    run=api_json('actions/runs/'+str(run_id)); save(prior/'run.json',run)
    assert run['id']==run_id and run['head_sha']==commit and run['head_branch']==BRANCH
    assert run['status']=='completed' and run['conclusion']=='success' and run['run_attempt']==1
    assert run['event']=='push' and run['path']==WORKFLOW and run['repository']['full_name']==REPOSITORY
    jobs=api_json('actions/runs/'+str(run_id)+'/attempts/1/jobs?per_page=100');save(prior/'jobs.json',jobs)
    assert jobs['total_count']==1 and len(jobs['jobs'])==1
    job=jobs['jobs'][0]
    assert job['name']=='focused-screen' and job['run_id']==run_id and job['head_sha']==commit
    assert job['status']=='completed' and job['conclusion']=='success'
    for name in ['Resolve and verify prospective CI intent','Build and validate pinned sources','Retain complete and partial evidence','Upload check reference','Upload complete or partial evidence']:
        match=[step for step in job['steps'] if step['name']==name]; assert len(match)==1 and match[0]['conclusion']=='success'
    timing=[step for step in job['steps'] if step['name']=='Run one bounded focused campaign']
    assert len(timing)==1 and timing[0]['conclusion']=='skipped'
    artifact=api_json('actions/artifacts/'+str(artifact_id));save(prior/'artifact.json',artifact)
    assert artifact['id']==artifact_id and artifact['expired'] is False
    assert artifact['name']==f'object-tail-check-{commit}-{run_id}'
    assert artifact['workflow_run']['id']==run_id and artifact['workflow_run']['head_sha']==commit
    data=artifact_bytes(artifact_id);assert sha(data)==intent['validatedArtifactZipSha256']
    extract_reference(data,prior)
    assert sha((prior/'manifest.json').read_bytes())==intent['validatedManifestSha256']
    manifest=read(prior/'manifest.json');checked=read(prior/'checked.json');receipt=read(prior/'receipt.json')
    assert receipt['sourceCommit']==commit and receipt['runId']==run_id and receipt['measure'] is False
    assert receipt['harnessDigest']==ids['harnessDigest'] and receipt['adapterDigest']==ids['adapterDigest']
    assert receipt['manifestSha256']==intent['validatedManifestSha256']
    assert receipt['checkedSha256']==sha((prior/'checked.json').read_bytes())
    assert manifest['harnessDigest']==HARNESS_DIGEST and manifest['pins']==PINS
    assert checked['passed'] is True and checked['timed'] is False and len(checked['results'])==18
    assert checked['harnessDigest']==HARNESS_DIGEST
    assert {(r['runtime'],r['workload'],r['role']) for r in checked['results']}=={
        (runtime,case,role) for runtime in ['node','bun'] for case in ['map-object-512','map-number-512','map-string-512'] for role in PINS}

def command(gate, name, args, cwd, timeout, extra_env=None):
    prefix=gate/'commands'/name; prefix.parent.mkdir(parents=True,exist_ok=True)
    record=dict(args=[str(x) for x in args],cwd=str(cwd),started=utc_now(),timeoutSeconds=timeout,explicitEnvironment=extra_env or {})
    save(pathlib.Path(str(prefix)+'.started.json'),record)
    environment=os.environ.copy(); environment.pop('GH_TOKEN',None)
    if extra_env: environment.update(extra_env)
    code=None; error=None
    try:
        with pathlib.Path(str(prefix)+'.log').open('xb') as output:
            run=subprocess.run(record['args'],cwd=cwd,env=environment,stdout=output,stderr=subprocess.STDOUT,timeout=timeout)
            code=run.returncode
    except Exception as failure: error=repr(failure)
    save(pathlib.Path(str(prefix)+'.finished.json'),dict(ended=utc_now(),returncode=code,error=error))
    assert code==0 and error is None, 'command failed: '+name+'; complete/partial log retained'

def reconcile_manifests(previous, current):
    assert {k:v for k,v in current.items() if k!='environment'}=={k:v for k,v in previous.items() if k!='environment'}
    allowed={'cpus','release','totalMemory','execPath'}
    assert set(previous['environment'])==set(current['environment'])
    for key in set(current['environment'])-allowed:
        assert current['environment'][key]==previous['environment'][key], 'runtime identity changed across CI runs: '+key

def reconcile_checks(previous, current):
    assert len(previous['results'])==len(current['results'])==18
    for before,after in zip(previous['results'],current['results']):
        for key in ['runtime','workload','role']:assert before[key]==after[key]
        for key in ['schema','phase','workload','fixture','fixtureDigest','postFixtureDigest','opsPerSweep','expectedPerSweep','checkSink','packageDigest']:
            assert before['result'][key]==after['result'][key], 'fixture/work identity changed across CI runs: '+key

def prepare(repo, gate):
    state=read(gate/'ci-state.json'); ids=identity(repo);assert ids==read(gate/'adapter-identity.json')
    command(gate,'adapter-self-tests',['python3','-B',str(repo/'proofs/object-tail-ci/test_ci.py')],repo,120)
    harness=gate/'harness';shutil.copytree(repo/HARNESS,harness)
    dependencies=gate.parent/'object-tail-focused-dependencies';dependencies.mkdir()
    write_new(dependencies/'package.json',git(repo,'show',PINS['baseline']+':package.json'))
    shutil.copyfile(harness/'frozen-bun.lock',dependencies/'bun.lock'); assert sha((dependencies/'bun.lock').read_bytes())==LOCK_SHA
    command(gate,'dependency-install',['bun','install','--frozen-lockfile','--ignore-scripts'],dependencies,300)
    toolchain=gate/'toolchain';toolchain.mkdir()
    for name in ['package.json','bun.lock']:shutil.copyfile(dependencies/name,toolchain/name)
    roots={}
    for role,pin in PINS.items():
        root=gate/'builds'/role; root.parent.mkdir(parents=True,exist_ok=True)
        command(gate,role+'-checkout',['git','worktree','add','--detach',str(root),pin],repo,60)
        roots[role]=str(root.resolve()); (root/'node_modules').symlink_to(dependencies/'node_modules',target_is_directory=True)
        shutil.copyfile(harness/'frozen-bun.lock',root/'bun.lock')
        source=gate/'sources'/role;source.mkdir(parents=True)
        write_new(source/'source.tar',git(repo,'archive','--format=tar',pin))
        write_new(source/'git-tree.txt',git(repo,'ls-tree','-r',pin))
        save(source/'identity.json',dict(commit=pin,tree=git_text(repo,'rev-parse',pin+'^{tree}'),sourceArchiveSha256=sha((source/'source.tar').read_bytes())))
        for script,limit in [('build:wasm',300),('build:browser',120),('build:types',120),('typecheck',120)]:
            command(gate,role+'-'+script.replace(':','-'),['bun','run',script],root,limit)
    save(gate/'roots.json',roots)
    for runtime,args in [('node',['node','--test']),('bun',['bun','test'])]:
        command(gate,'protocol-'+runtime,args+[str(harness/'cached-object-read-protocol.node.mjs'),str(harness/'protocol.test.mjs')],repo,120)
    semantic=[]
    for role,root_arg in roots.items():
        root=pathlib.Path(root_arg)
        command(gate,role+'-semantic',['bun',str(harness/'semantic-probe.mjs'),str(root)],repo,120)
        value=read(gate/'commands'/(role+'-semantic.log'));assert value['passed']==15;semantic.append(value)
        if role=='baseline':
            shutil.copyfile(pathlib.Path(roots['refinement'])/'cached-object-read.test.ts',root/'cached-object-read.test.ts')
            overlay=gate/'overlays/baseline-cached-object-read.test.ts';overlay.parent.mkdir()
            shutil.copyfile(root/'cached-object-read.test.ts',overlay)
        command(gate,role+'-focused',['bun','run','test','cached-object-read.test.ts','--reporter=json','--outputFile='+str(gate/'commands'/(role+'-focused-results.json'))],root,120,
                {'CACHED_OBJECT_EXPECTED_SLOT_READS':'3' if role=='baseline' else '1'})
        tests=read(gate/'commands'/(role+'-focused-results.json'))
        assert tests['success'] is True and tests['numTotalTests']==21 and tests['numPassedTests']==21
    assert semantic[0]==semantic[1]==semantic[2]
    command(gate,'fixtures',['node',str(harness/'controller.mjs'),'check',str(gate/'roots.json'),str(gate/'validation')],repo,300)
    manifest=read(gate/'validation/manifest.json'); checked=read(gate/'validation/checked.json')
    assert manifest['harnessDigest']==HARNESS_DIGEST and manifest['pins']==PINS
    assert checked['passed'] is True and checked['timed'] is False and len(checked['results'])==18
    if state['measure']:
        previous=read(gate/'prior-check/manifest.json')
        # Only environment metadata may differ across the two clean CI runners.
        reconcile_manifests(previous,manifest)
        reconcile_checks(read(gate/'prior-check/checked.json'),checked)
        save(gate/'ci-environment-transition.json',dict(previous=previous['environment'],current=manifest['environment'],
             currentManifestSha256=sha((gate/'validation/manifest.json').read_bytes()),previousManifestSha256=state['intent']['validatedManifestSha256'],
             policy='Only recorded runner CPU, kernel, memory and filesystem paths may differ; source/build/harness/runtime binary identities match. Same-job controller check and measure use the current exact manifest.'))
    receipt=dict(sourceCommit=git_text(repo,'rev-parse','HEAD'),runId=int(os.environ['GITHUB_RUN_ID']),measure=state['measure'],
                 harnessDigest=HARNESS_DIGEST,adapterDigest=ids['adapterDigest'],
                 manifestSha256=sha((gate/'validation/manifest.json').read_bytes()),checkedSha256=sha((gate/'validation/checked.json').read_bytes()),
                 focusedTestsPerRole=21,semanticGroupsPerRole=15,fixtureChecks=18,fullSuiteRun=False)
    reference=gate/'check-reference';reference.mkdir();
    for name in ['manifest.json','checked.json']:shutil.copyfile(gate/'validation'/name,reference/name)
    save(reference/'receipt.json',receipt);save(gate/'ready.json',receipt)
    print(json.dumps(receipt))

def measure(repo, gate):
    state=read(gate/'ci-state.json');assert state['measure'] is True
    ids=identity(repo);assert ids==read(gate/'adapter-identity.json')
    ready=read(gate/'ready.json');assert ready['harnessDigest']==HARNESS_DIGEST
    manifest=gate/'validation/manifest.json';assert sha(manifest.read_bytes())==ready['manifestSha256']
    # Prospectively approved bridge: bind the unchanged controller to this same
    # job's successful fresh check, after exact prior-artifact verification.
    intent=dict(schema=1,measure=True,reviewedHarnessSha256=HARNESS_DIGEST,checkedManifestSha256=ready['manifestSha256'])
    local=gate/'harness/intent.json';assert read(local)['measure'] is False
    local.write_text(json.dumps(intent,indent=2)+'\n');save(gate/'controller-activation.json',intent)
    command(gate,'campaign',['node',str(gate/'harness/controller.mjs'),'measure',str(gate/'roots.json'),str(gate/'validation')],repo,35*60)

def retain(repo, gate):
    gate.mkdir(parents=True,exist_ok=True)
    retained=gate/'reviewed-inputs';retained.mkdir()
    shutil.copytree(repo/HARNESS,retained/'harness')
    shutil.copytree(repo/'proofs/object-tail-ci',retained/'adapter')
    shutil.copyfile(repo/WORKFLOW,retained/'workflow.yml')
    save(retained/'identity.json',dict(commit=git_text(repo,'rev-parse','HEAD'),tree=git_text(repo,'rev-parse','HEAD^{tree}'),runId=os.environ.get('GITHUB_RUN_ID'),runAttempt=os.environ.get('GITHUB_RUN_ATTEMPT')))
    for role in PINS:
        root=gate/'builds'/role
        if root.exists():
            target=gate/'retained-builds'/role;target.mkdir(parents=True)
            if (root/'dist').exists(): shutil.copytree(root/'dist',target/'dist')
            for path in list(root.glob('*.wasm'))+[root/'package.json',root/'bun.lock']:
                if path.is_file(): shutil.copyfile(path,target/path.name)
    campaign=gate/'validation/campaign';audit_code=None;audit_error=None
    if campaign.exists():
        audit_started=utc_now()
        # Direct file streams retain partial stdout and stderr even when the
        # auditor cannot launch or times out. Archive creation must still run.
        with (gate/'raw-audit.json').open('xb') as output,(gate/'raw-audit.stderr').open('xb') as errors:
            try:
                audit=subprocess.run(['python3',str(repo/HARNESS/'audit.py'),str(campaign)],stdout=output,stderr=errors,timeout=60)
                audit_code=audit.returncode
            except Exception as failure:
                audit_error=repr(failure)
        save(gate/'raw-audit-status.json',dict(started=audit_started,ended=utc_now(),returncode=audit_code,error=audit_error,passed=audit_code==0 and audit_error is None))
    hashes=[[str(p.relative_to(gate)),sha(p.read_bytes())] for p in sorted(gate.rglob('*')) if p.is_file() and not p.is_symlink() and 'builds' not in p.relative_to(gate).parts]
    save(gate/'evidence-sha256.json',hashes)
    destination=gate.with_suffix('.tar.gz')
    def include(info):
        relative=pathlib.PurePosixPath(info.name).parts
        if len(relative)>1 and relative[1]=='builds': return None
        assert info.isfile() or info.isdir(), 'links/special files prohibited in retained evidence'
        return info
    with tarfile.open(destination,'x:gz') as archive: archive.add(gate,arcname=gate.name,filter=include)
    write_new(pathlib.Path(str(destination)+'.sha256'),(sha(destination.read_bytes())+'  '+destination.name+'\n').encode())
    assert audit_code in (None,0) and audit_error is None, 'raw audit failed, timed out, or was incomplete; partial archive was retained'

def main():
    mode,gate_arg=sys.argv[1:];repo=pathlib.Path(__file__).resolve().parents[2];gate=pathlib.Path(gate_arg).resolve()
    assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('GITHUB_REPOSITORY')==REPOSITORY
    assert os.environ.get('GITHUB_RUN_ATTEMPT')=='1'
    if mode=='intent':
        gate.mkdir();ids=identity(repo);save(gate/'adapter-identity.json',ids)
        intent=read(repo/CI_INTENT);enabled=validate_intent(repo,intent,ids,os.environ['EVENT_NAME'],os.environ.get('BEFORE_SHA',''))
        assert os.environ.get('GITHUB_REF')=='refs/heads/'+BRANCH
        if enabled:
            verify_previous_starts(repo,gate,int(os.environ['GITHUB_RUN_ID']))
            verify_prior(intent,ids,gate)
        save(gate/'ci-state.json',dict(measure=enabled,intent=intent))
        with open(os.environ['GITHUB_OUTPUT'],'a') as output:output.write('measure='+str(enabled).lower()+'\n')
        print(json.dumps(dict(measure=enabled,harnessDigest=ids['harnessDigest'],adapterDigest=ids['adapterDigest'])))
    elif mode=='prepare':prepare(repo,gate)
    elif mode=='measure':measure(repo,gate)
    elif mode=='retain':retain(repo,gate)
    else:raise ValueError('unknown mode')

if __name__=='__main__':main()
