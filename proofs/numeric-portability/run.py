"""Bounded lane runner; imports and --help run no library subjects or operation clocks."""
import argparse, hashlib, json, os, pathlib, signal, subprocess, sys, time
import controller as inherited
import evidence
import resource_ownership as resources
HERE=pathlib.Path(__file__).resolve().parent
def sha(path):
    digest=hashlib.sha256()
    with pathlib.Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()
# Browser payloads can exceed the controller RSS cap; retain the reviewed verifier with bounded-memory hashing.
inherited.sha=sha
read=inherited.read
write=inherited.write_new
update=inherited.update

def write_spawn_intent(path,record):
    """Persist uncertainty before Popen can create an unreturned child."""
    with pathlib.Path(path).open('x') as output:
        json.dump(record,output,indent=2);output.write('\n');output.flush();os.fsync(output.fileno())
    directory=os.open(str(pathlib.Path(path).parent),os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)

def slots(protocol,lane,phase):return evidence.schedule(lane,phase,protocol)
# Strict adapter helpers replace the permissive inherited RSS/ancestry helpers.
proc=resources.proc
census=resources.census
cleanup=resources.cleanup

def parse_rows(path):
    def unique(pairs):
        result={}
        for key,value in pairs:
            if key in result:raise evidence.InvalidEvidence('Duplicate JSON key '+key)
            result[key]=value
        return result
    return [json.loads(line,object_pairs_hook=unique,parse_constant=lambda value:(_ for _ in ()).throw(evidence.InvalidEvidence('Nonfinite JSON '+value))) for line in pathlib.Path(path).read_text().splitlines()]

def validate_rows(rows,slot,p,config=None,work=None,identity=None):
    assert config is not None, 'Exact bound subject config required'
    return evidence.validate_raw(rows,slot,config,p,work,identity)

def calibration_work(out,runtime,p):
    validated={}
    for arm in ('baseline','candidate'):
        identifier=f'{runtime}-calibration-{arm}'
        config=read(out/(identifier+'.config.json'));record=read(out/(identifier+'.receipt.json'))
        assert record['status']=='complete' and record['cleanup']['ownedGroupGone'] is True
        assert record['configSha256']==sha(out/(identifier+'.config.json'))
        assert record['stdoutSha256']==sha(out/(identifier+'.stdout.jsonl'))
        assert record['processSha256']==sha(out/(identifier+'.process.json'))
        assert record['cleanupSha256']==sha(out/(identifier+'.cleanup.json'))
        slot={'id':identifier,'runtime':runtime,'arm':arm,'warm':True,'mode':'calibrate'}
        validated[arm]=evidence.validate_raw(parse_rows(out/(identifier+'.stdout.jsonl')),slot,config,p)
    return evidence.derive_work(validated,p)

def launch(manifest,p,out,slot,lane,deadline,manifest_path):
    inherited.verify(manifest)
    is_browser=slot['runtime'] in ('chromium','firefox','webkit')
    config={**slot,'lane':lane,'protocol':p,'manifestPath':str(manifest_path),'manifestSha256':sha(manifest_path),'dist':str(pathlib.Path(manifest['sources'][slot['arm']]['path'])/'dist'),'admitted':True}
    if slot['mode']=='measure' and slot['warm']:config['work']=calibration_work(out,slot['runtime'],p)
    ownership=None
    if is_browser:
        config['ownershipJournal']=str(out/(slot['id']+'.ownership.jsonl'))
        config['ownershipBinding']={'slotId':slot['id'],'manifestSha256':config['manifestSha256'],'runtime':slot['runtime'],'lane':lane,'arm':slot['arm'],'mode':slot['mode']}
        ownership=resources.Ownership(config['ownershipJournal'],config['ownershipBinding'])
    config_path=out/(slot['id']+'.config.json');write(config_path,config)
    runtime=manifest['runtimes']['node' if is_browser else slot['runtime']]
    command=[runtime['path'],*runtime['args'],str(HERE/('browser-subject.mjs' if is_browser else 'node-subject.mjs')),str(config_path)]
    budget=p['budgets']['calibrationProcessWallSeconds' if slot['mode']=='calibrate' else 'measurementProcessWallSeconds' if slot['mode']=='measure' else 'untimedProcessWallSeconds']
    limit=min(deadline,time.monotonic()+budget)
    record={**slot,'command':command,'status':'started','spawnAttempted':False,'maximumTreeRssBytes':0,'controllerMaximumRssBytes':0,'hostBefore':inherited.host(),'manifestSha256':config['manifestSha256'],'configSha256':sha(config_path),'resourceAccounting':{'status':'incomplete','strictRss':True,'sampledNotPeak':True,'rssSampleCount':0}}
    output=out/(slot['id']+'.stdout.jsonl');error=out/(slot['id']+'.stderr.log');process_path=out/(slot['id']+'.process.json');cleanup_path=out/(slot['id']+'.cleanup.json');child=None;known={};failure=None;scope=None
    try:
        with output.open('xb') as stdout,error.open('xb') as stderr:
            scope=resources.begin_scope()
            write_spawn_intent(process_path,{'pid':None,'group':None,'command':command,'status':'spawn-intent','controller':scope.controller})
            record['spawnAttempted']=True
            child=subprocess.Popen(command,cwd=manifest['sources'][slot['arm']]['path'],stdout=stdout,stderr=stderr,start_new_session=True,env={**os.environ,'LANG':'C.UTF-8','TZ':'UTC','NO_COLOR':'1','PYTHONDONTWRITEBYTECODE':'1'})
            update(process_path,{'pid':child.pid,'group':child.pid,'command':command,'status':'birth-unconfirmed'})
            birth=resources.capture_root(child.pid,known)
            update(process_path,{'pid':child.pid,'group':child.pid,'command':command,'status':'spawned','identity':birth})
            while child.poll() is None:
                alive,rss=resources.census(child.pid,known,ownership=ownership,scope=scope)
                if not alive or rss==0:
                    if child.poll() is not None:break
                    raise resources.ResourceAccountingError('Live owner accounting cannot be established', {'pid':child.pid,'alive':alive,'rssBytes':rss})
                controller_rss=resources.rss_for_pid(os.getpid())
                assert controller_rss>0, 'Positive known controller accounting required'
                record['resourceAccounting']['rssSampleCount']+=1
                record['maximumTreeRssBytes']=max(record['maximumTreeRssBytes'],rss);record['controllerMaximumRssBytes']=max(record['controllerMaximumRssBytes'],controller_rss)
                assert rss<=p['memory']['maximumBrowserTreeRssBytes' if is_browser else 'maximumSubjectRssBytes'],'Subject process-tree RSS budget'
                assert controller_rss<=p['memory']['maximumControllerRssBytes'],'Controller RSS budget'
                assert output.stat().st_size+error.stat().st_size<=p['memory']['maximumOutputBytes'],'Output budget'
                assert time.monotonic()<limit,'Subject/whole-controller wall budget'
                time.sleep(p['memory']['rssPollMs']/1000)
            assert child.returncode==0,f'Subject exited {child.returncode}'
            assert time.monotonic()<=limit,'Subject wall budget at exit'
            assert record['resourceAccounting']['rssSampleCount']>0, 'No valid resource observations'
        record['resourceAccounting']['status']='complete';record['status']='complete'
    except BaseException as exc:
        failure=exc;record.update(status='failed',error=repr(exc))
        if isinstance(exc,resources.ResourceAccountingError):record['resourceAccountingError']=exc.evidence
    finally:
        receipt=None
        if child is not None:
            try:
                receipt=resources.cleanup(child,known,p['budgets']['terminationGraceSeconds'],ownership=ownership,scope=scope)
            except BaseException as exc:
                receipt={'pid':child.pid,'ownedGroupGone':False,'quiescence':'unknown','error':repr(exc)}
        else:
            # Even a failed Popen constructor can have forked before a signal.
            # A null local child is not a no-process proof.
            receipt={'pid':None,'group':None,'ownedGroupGone':False,'quiescence':'unknown',
                     'problems':['No captured child/terminal kernel ownership proof; spawn outcome is unverified'],
                     'spawnAttempted':record['spawnAttempted']}
        if receipt is not None:
            record['cleanup']=receipt
            if not receipt['ownedGroupGone'] or receipt.get('quiescence')!='verified':
                failure=failure or RuntimeError('Owned resource quiescence unknown or survivor remains');record.update(status='failed',fatalOwnedProcess=True)
            try:write(cleanup_path,receipt)
            except BaseException as exc:
                failure=failure or exc;record.update(status='failed',fatalOwnedProcess=True,cleanupReceiptError=repr(exc))
        if not record.get('fatalOwnedProcess'):
            try:
                for key,path in [('stdoutSha256',output),('stderrSha256',error),('processSha256',process_path),('cleanupSha256',cleanup_path)]:record[key]=sha(path) if path.exists() else None
                if ownership is not None:
                    journal_path=pathlib.Path(config['ownershipJournal'])
                    record['ownershipSha256']=sha(journal_path) if journal_path.exists() else None
            except BaseException as exc:
                failure=failure or exc;record.update(status='failed',finalizationError=repr(exc))
        update(out/(slot['id']+'.receipt.json'),record)
    if failure:raise failure
    try:
        assert output.stat().st_size+error.stat().st_size<=p['memory']['maximumOutputBytes']
        rows=parse_rows(output);identity={'process':read(process_path),'cleanup':read(cleanup_path)}
        evidence.validate_raw(rows,slot,config,p,config.get('work'),identity)
        ownership_rows=parse_rows(config['ownershipJournal']) if ownership else None
        resources.validate_resource_receipts(slot,config,read(process_path),read(cleanup_path),record,ownership_rows)
        inherited.verify(manifest)
    except BaseException as exc:
        record.update(status='failed',validationError=repr(exc));update(out/(slot['id']+'.receipt.json'),record);raise
    update(out/(slot['id']+'.receipt.json'),record);return record

def main():
    parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['semantics','untimed','run']);parser.add_argument('--root',required=True);parser.add_argument('--lane',choices=['x64','arm64'],required=True);args=parser.parse_args()
    assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('GITHUB_RUN_ATTEMPT')=='1','Original authorized CI attempt only'
    root=pathlib.Path(args.root);manifest_path=root/'harness/manifest.json';manifest=read(manifest_path);p=read(HERE/'protocol.json');policy=read(root/'harness/admission.json')
    assert policy['fullStandardGateStatus']=={a:'passed-fresh-exact-source' for a in ('baseline','candidate')}
    assert policy['mode']=='ci-screen' and policy['promotionAllowed'] is False
    if args.phase=='run':
        guard=read(root/'untimed/ledger.json');assert guard['status']=='complete' and all(s['status']=='complete' for s in guard['slots'])
        if args.lane=='x64':assert read(root/'semantics/ledger.json')['status']=='complete'
    out=root/args.phase;out.mkdir(exist_ok=False)
    planned=slots(p,args.lane,args.phase);ledger={'phase':args.phase,'lane':args.lane,'status':'started','manifestSha256':sha(manifest_path),'slots':[{**s,'status':'pending'} for s in planned]};write(out/'ledger.json',ledger)
    budget=p['budgets']['controllerWallSeconds'][args.lane] if args.phase=='run' else p['budgets']['untimedControllerWallSeconds'];deadline=time.monotonic()+budget
    if args.phase!='run':deadline=min(deadline,read(root/'run.json')['supplementalAdmissionDeadlineMonotonicSeconds'])
    assert time.monotonic()<deadline, 'Supplemental admission budget expired'
    assert deadline+2<=read(root/'run.json')['workDeadlineMonotonicSeconds'],'Entire fixed controller budget must remain'
    def interrupted(signum,frame):raise TimeoutError('Controller interrupted or expired')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGALRM,interrupted);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
    try:
        resources.enable_subreaper()
        for index,slot in enumerate(planned):
            ledger['slots'][index]['status']='started';update(out/'ledger.json',ledger)
            result=launch(manifest,p,out,slot,args.lane,deadline,manifest_path);ledger['slots'][index]=result;update(out/'ledger.json',ledger)
        inherited.verify(manifest);ledger.update(status='complete',verificationAfter={'ok':True})
    except BaseException as exc:
        ledger.update(status='incomplete',error=repr(exc))
        if 'index' in locals():ledger['slots'][index].update(status='failed',error=repr(exc))
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);update(out/'ledger.json',ledger)
if __name__=='__main__':main()
