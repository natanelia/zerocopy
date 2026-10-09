"""Bounded lane runner; imports and --help run no library subjects or operation clocks."""
import argparse, hashlib, json, os, pathlib, signal, subprocess, sys, time
import controller as inherited
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

def slots(protocol,lane,phase):
    environments=protocol['environmentOrders'][lane][0]
    warm=protocol['warmRuntimes'][lane]
    if phase in ('untimed','semantics'):
        return [{'id':f'{runtime}-{phase}-{arm}','runtime':runtime,'arm':arm,'warm':runtime in warm,'mode':phase} for runtime in environments if phase!='semantics' or runtime in ('chromium','firefox','webkit') for arm in ('baseline','candidate')]
    result=[{'id':f'{runtime}-calibration-{arm}','runtime':runtime,'arm':arm,'warm':True,'mode':'calibrate'} for runtime in environments if runtime in warm for arm in ('baseline','candidate')]
    for block in range(4):
        for runtime in protocol['environmentOrders'][lane][block]:
            seen={'baseline':0,'candidate':0}
            for position,arm in enumerate(protocol['orders'][block]):
                result.append({'id':f'{runtime}-b{block}-{position}-{arm}','runtime':runtime,'arm':arm,'warm':runtime in warm,'mode':'measure','block':block,'position':position,'replicate':seen[arm]})
                seen[arm]+=1
    return result

def proc(pid):
    try:
        text=pathlib.Path(f'/proc/{pid}/stat').read_text();parts=text[text.rfind(')')+2:].split()
        return {'pid':int(pid),'state':parts[0],'ppid':int(parts[1]),'group':int(parts[2]),'session':int(parts[3]),'startTicks':int(parts[19])}
    except (OSError,ValueError,IndexError):return None

def census(root,known):
    table={int(p.name):value for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() and (value:=proc(p.name))}
    parents={root}|{pid for pid,entry in known.items() if pid in table and table[pid]['startTicks']==entry['startTicks']}
    while True:
        found={pid for pid,value in table.items() if value['ppid'] in parents or pid==root}
        if found<=parents:break
        parents|=found
    for pid in parents:
        if pid in table:known[pid]=table[pid]
    alive=[value for pid,value in known.items() if pid in table and table[pid]['startTicks']==value['startTicks'] and table[pid]['state']!='Z']
    return alive,sum(inherited.rss(value['pid']) for value in alive)

def cleanup(child,known,grace):
    census(child.pid,known);groups={child.pid}|{v['group'] for v in known.values() if v['group']==v['pid']}
    # Only process-group leaders observed in the owned descendant tree are included.
    for group in groups:
        try:os.killpg(group,signal.SIGTERM)
        except ProcessLookupError:pass
    deadline=time.monotonic()+grace
    while time.monotonic()<deadline:
        child.poll();alive,_=census(child.pid,known)
        if not alive:break
        time.sleep(0.02)
    alive,_=census(child.pid,known)
    for group in groups:
        try:os.killpg(group,signal.SIGKILL)
        except ProcessLookupError:pass
    for value in alive:
        current=proc(value['pid'])
        if current and current['startTicks']==value['startTicks']:
            try:os.kill(value['pid'],signal.SIGKILL)
            except ProcessLookupError:pass
    try:child.wait(timeout=max(0.001,deadline-time.monotonic()))
    except subprocess.TimeoutExpired:pass
    # A final census accounts for surviving members even after a leader exits.
    final=[]
    for p in pathlib.Path('/proc').iterdir():
        if p.name.isdigit() and (value:=proc(p.name)) and value['state']!='Z' and (value['group'] in groups or (value['pid'] in known and value['startTicks']==known[value['pid']]['startTicks'])):final.append(value)
    return {'pid':child.pid,'group':child.pid,'ownedGroups':sorted(groups),'ownedProcessIdentities':list(known.values()),'returncode':child.poll(),'ownedGroupGone':not final,'survivors':final,'scope':'observed descendant identities plus all surviving members of their owned process groups'}

def parse_rows(path):
    lines=path.read_text().splitlines();rows=[json.loads(line) for line in lines]
    ordinal=[r['ordinal'] for r in rows if 'ordinal' in r]
    assert ordinal==list(range(len(ordinal))),'Missing/duplicate/reordered core row'
    assert not any(r['kind'] in ('server-error',) for r in rows)
    return rows

def validate_rows(rows,slot,p):
    assert rows
    if slot['mode']=='semantics':
        assert len([r for r in rows if r['kind']=='semantics-complete'])==1
        workers=[r for r in rows if r['kind']=='worker-semantic']
        assert {(r['copy'],r['mode']) for r in workers}=={(copy,mode) for copy in (False,True) for mode in ('auto','scalar')}
        return
    assert len([r for r in rows if r['kind']=='complete'])==1
    starts=[r for r in rows if r['kind']=='start'];assert len(starts)==1 and starts[0]['mode']==slot['mode']
    startup=[r for r in rows if r['kind']=='startup']
    if slot['mode']=='measure':
        assert [r['metric'] for r in startup]==p['startup']['metrics']
        assert all(isinstance(r['durationMs'],(float,int)) and r['durationMs']>0 for r in startup)
        assert startup[2]['durationMs']==startup[0]['durationMs']+startup[1]['durationMs']
        assert len([r for r in rows if r['kind']=='startup-validation'])==1
    else:assert not startup
    if slot['mode']=='untimed':assert len([r for r in rows if r['kind']=='selection' and r['automatic']=='SIMD' and r['scalar']=='forced scalar' and r['validateRestored']])==1
    expected=p['cases'] if slot['warm'] else []
    assert [r['case'] for r in rows if r['kind']=='case-start']==[c['id'] for c in expected]
    assert [r['case'] for r in rows if r['kind']=='case-complete']==[c['id'] for c in expected]
    chunks=[r for r in rows if r['kind']=='chunk'];validations=[r for r in rows if r['kind']=='chunk-validation']
    assert [r['chunk'] for r in chunks]==list(range(len(chunks)))==[r['chunk'] for r in validations]
    for row,validation in zip(chunks,validations):
        assert row['case']==validation['case'] and row['before']==validation['after']
        q=row['queryCounts'];n=row['operations'];assert row['checksum']==(n//4)*sum(q)+sum(q[:n%4]) and row['lastResult']==q[(n-1)%4]
        if slot['mode']=='untimed':assert row['durationMs'] is None and row['nsPerOperation'] is None
        else:assert row['durationMs']>0 and row['nsPerOperation']==row['durationMs']*1e6/n
    for spec in expected:
        rows_for_case=[r for r in chunks if r['case']==spec['id']]
        count={'untimed':2,'calibrate':p['calibration']['warmupChunks']+len(spec['ladder'])*p['calibration']['samplesPerLevel'],'measure':p['measurement']['warmupChunks']+p['measurement']['samples']}[slot['mode']]
        assert len(rows_for_case)==count
        if slot['mode']=='untimed':assert [r['operations'] for r in rows_for_case]==[spec['ladder'][0],spec['ladder'][-1]]
    return

def calibration_work(out,runtime,p):
    per_arm={arm:parse_rows(out/f'{runtime}-calibration-{arm}.stdout.jsonl') for arm in ('baseline','candidate')};work={}
    for spec in p['cases']:
        by_arm={}
        for arm,rows in per_arm.items():
            by_arm[arm]={count:sorted(r['durationMs'] for r in rows if r['kind']=='chunk' and r['case']==spec['id'] and r['phase']=='calibration' and r['operations']==count) for count in spec['ladder']}
            assert all(len(values)==3 for values in by_arm[arm].values())
        chosen=next((count for count in spec['ladder'] if all(by_arm[arm][count][1]>=p['calibration']['targetChunkMs'] for arm in by_arm)),None)
        work[spec['id']]={'operations':chosen or spec['ladder'][-1],'targetMet':chosen is not None,'calibrationWarmupFlag':any(r['insufficientWarmup'] for rows in per_arm.values() for r in rows if r['kind']=='calibration-diagnostics' and r['case']==spec['id']),'calibration':by_arm}
    return work

def launch(manifest,p,out,slot,lane,deadline,manifest_path):
    inherited.verify(manifest)
    config={**slot,'lane':lane,'protocol':p,'manifestPath':str(manifest_path),'manifestSha256':sha(manifest_path),'dist':str(pathlib.Path(manifest['sources'][slot['arm']]['path'])/'dist'),'admitted':True}
    if slot['mode']=='measure' and slot['warm']:config['work']=calibration_work(out,slot['runtime'],p)
    config_path=out/(slot['id']+'.config.json');write(config_path,config)
    is_browser=slot['runtime'] in ('chromium','firefox','webkit');runtime=manifest['runtimes']['node' if is_browser else slot['runtime']]
    command=[runtime['path'],*runtime['args'],str(HERE/('browser-subject.mjs' if is_browser else 'node-subject.mjs')),str(config_path)]
    budget=p['budgets']['calibrationProcessWallSeconds' if slot['mode']=='calibrate' else 'measurementProcessWallSeconds' if slot['mode']=='measure' else 'untimedProcessWallSeconds']
    limit=min(deadline,time.monotonic()+budget);record={**slot,'command':command,'status':'started','maximumTreeRssBytes':0,'controllerMaximumRssBytes':0,'hostBefore':inherited.host(),'manifestSha256':config['manifestSha256']}
    output=out/(slot['id']+'.stdout.jsonl');error=out/(slot['id']+'.stderr.log');child=None;known={};failure=None
    try:
        with output.open('xb') as stdout,error.open('xb') as stderr:
            child=subprocess.Popen(command,cwd=manifest['sources'][slot['arm']]['path'],stdout=stdout,stderr=stderr,start_new_session=True,env={**os.environ,'LANG':'C.UTF-8','TZ':'UTC','NO_COLOR':'1'})
            write(out/(slot['id']+'.process.json'),{'pid':child.pid,'group':child.pid,'command':command,'status':'spawned'})
            while child.poll() is None:
                alive,rss=census(child.pid,known);record['maximumTreeRssBytes']=max(record['maximumTreeRssBytes'],rss);record['controllerMaximumRssBytes']=max(record['controllerMaximumRssBytes'],inherited.rss(os.getpid()))
                assert rss<=p['memory']['maximumBrowserTreeRssBytes' if is_browser else 'maximumSubjectRssBytes'],'Subject process-tree RSS budget'
                assert record['controllerMaximumRssBytes']<=p['memory']['maximumControllerRssBytes'],'Controller RSS budget'
                assert output.stat().st_size+error.stat().st_size<=p['memory']['maximumOutputBytes'],'Output budget'
                assert time.monotonic()<limit,'Subject/whole-controller wall budget'
                time.sleep(p['memory']['rssPollMs']/1000)
            assert child.returncode==0,f'Subject exited {child.returncode}'
            assert time.monotonic()<=limit,'Subject wall budget at exit'
        record['status']='complete'
    except BaseException as exc:failure=exc;record.update(status='failed',error=repr(exc))
    finally:
        if child is not None:
            receipt=cleanup(child,known,p['budgets']['terminationGraceSeconds']);write(out/(slot['id']+'.cleanup.json'),receipt);record['cleanup']=receipt
            if not receipt['ownedGroupGone']:failure=RuntimeError('Owned process remains; stable evidence unknown');record.update(status='failed',fatalOwnedProcess=True)
        if not record.get('fatalOwnedProcess'):
            record['stdoutSha256']=sha(output) if output.exists() else None;record['stderrSha256']=sha(error) if error.exists() else None
        update(out/(slot['id']+'.receipt.json'),record)
    if failure:raise failure
    try:
        assert output.stat().st_size+error.stat().st_size<=p['memory']['maximumOutputBytes']
        rows=parse_rows(output);validate_rows(rows,slot,p)
        if is_browser:
            assert len([r for r in rows if r['kind']=='browser-complete'])==1
            processes=[r for r in rows if r['kind']=='browser-process']
            assert len(processes)==1 and processes[0]['spawnAttempt']==1 and processes[0]['profileInitiallyEmpty'] is True
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
