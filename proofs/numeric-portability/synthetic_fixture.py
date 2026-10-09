"""Complete artificial protocol records for pure tests; never executes subjects or clocks."""
import copy,hashlib,json,math,pathlib
import evidence as e
P=e.P
ORIGIN=json.loads((e.HERE/'origin.json').read_text())

def snapshot(size,semantic=False):
    capacity=max(131072,math.ceil((65536+size*8+256)/65536)*65536)
    value={'root':65536 if size>32 else 0,'depth':1 if size>32 else 0,'tail':65536 if size else 0,'size':size,'used':65536+size*8+128,'capacity':capacity, 'digest' if semantic else 'memoryDigest':'ab'*32}
    if not semantic:value['type']='number'
    return value

def make_config(slot,lane,root='/synthetic',manifest_sha='cd'*32,work=None):
    root=pathlib.Path(root);config={**slot,'lane':lane,'protocol':copy.deepcopy(P),'manifestPath':str(root/'harness/manifest.json'),'manifestSha256':manifest_sha,'dist':str(root/'sources'/slot['arm']/'dist'),'admitted':True}
    if slot['mode']=='measure' and slot['warm']:config['work']=work or default_work()
    if slot['runtime'] not in ('node','bun'):
        phase='run' if slot['mode'] in ('measure','calibrate') else slot['mode'];config['ownershipJournal']=str(root/phase/(slot['id']+'.ownership.jsonl'));config['ownershipBinding']={k:v for k,v in {'slotId':slot['id'],'manifestSha256':manifest_sha,**{k:slot[k] for k in ('runtime','arm','mode')},'lane':lane}.items()}
    return config

def default_work():
    return {s['id']:{'operations':s['ladder'][0],'targetMet':True,'calibrationWarmupFlag':False,'calibration':{arm:{str(n):[12,12,12] for n in s['ladder']} for arm in ('baseline','candidate')}} for s in P['cases']}

def make_raw(slot,config,work=None,pid=111,browser_pid=222,browser_version='synthetic-browser',startup_factor=None):
    mode=slot['mode'];runtime=slot['runtime'];browser=runtime not in ('node','bun');rows=[];core=[]
    emit=lambda row:core.append({**row,'ordinal':len(core)})
    if mode=='semantics':core=semantic_rows();rows.extend(core)
    else:
        if mode=='measure':
            factor=startup_factor if startup_factor is not None else (1.03 if slot['arm']=='candidate' else 1)
            for metric,base in [('import',.001),('first-spatial',.002),('sum',.003)]:emit({'kind':'startup','metric':metric,'durationMs':base*factor})
        if mode in ('measure','calibrate'):
            before=snapshot(2);emit({'kind':'startup-validation','firstOperation':'countPointsInBox','count':1,'before':before,'after':copy.deepcopy(before),'endToEndApplicationStartup':False,'timer':'performance.now, milliseconds','timerPrecision':'synthetic numbers, never measured','nonpositiveDurationPolicy':'reject subject; never replicate or replace with warm timing'})
        else:
            before=snapshot(1);emit({'kind':'selection',**selection(),'before':before,'after':copy.deepcopy(before)})
        emit({'kind':'start','mode':mode,'runtime':runtime,'lane':config['lane'],'operationClocks':mode!='untimed','firstUse':'fresh-process spatial-only' if mode=='measure' else 'not an inferential startup observation','gc':'natural browser GC; no portable forced-GC API' if browser else 'explicit inherited Node/Bun collection'})
        chunks=0
        for spec in P['cases'] if slot['warm'] else []:
            model=e.fixture(spec);emit({'kind':'case-start','case':spec['id'],**model})
            if mode=='untimed':plan=[('untimed-minimum',None,spec['ladder'][0]),('untimed-maximum',None,spec['ladder'][-1])]
            elif mode=='calibrate':plan=[('calibration-warmup',i,spec['ladder'][-1]) for i in range(32)]+[('calibration',i,n) for n in spec['ladder'] for i in range(3)]
            else:
                work=work or config['work'];n=work[spec['id']]['operations'];plan=[('warmup',i,n) for i in range(32)]+[('measurement',i,n) for i in range(7)]
            warm=[];measured=[]
            for index,(phase,sample,operations) in enumerate(plan):
                if mode=='calibrate' and index==32:emit({'kind':'calibration-diagnostics','case':spec['id'],'warmupBodyMs':384,'insufficientWarmup':False})
                before=snapshot(spec['size']);q=model['queryCounts'];duration=None if mode=='untimed' else 12
                row={'kind':'chunk','case':spec['id'],'chunk':chunks,'phase':phase,'sample':sample,'operation':spec['operation'],'operations':operations,'durationMs':duration,'nsPerOperation':None if duration is None else duration*1e6/operations,'checksum':(operations//4)*sum(q)+sum(q[:operations%4]),'lastResult':q[(operations-1)%4],'queryCounts':q,'valuesPerCall':spec['size'],'pointsPerCall':spec.get('points'),'treeSize':(spec['size']-1)&~31,'tailSize':spec['size']-((spec['size']-1)&~31),'before':before};emit(row)
                usage={'rss':'externally sampled browser process tree','jsHeapBytes':None} if browser else {'rss':33554432,'heapTotal':8388608,'heapUsed':4194304,'external':2097152,'arrayBuffers':1048576}
                emit({'kind':'chunk-validation','case':spec['id'],'chunk':chunks,'after':copy.deepcopy(before),'afterValidation':usage,'afterCleanup':copy.deepcopy(usage),'liveArenaCapacityBytes':before['capacity']});chunks+=1
                if phase in ('warmup','calibration-warmup'):warm.append(duration)
                if phase=='measurement':measured.append(row)
            if mode=='measure':emit({'kind':'diagnostics','case':spec['id'],**e.diagnostic(warm,measured,work[spec['id']])})
            emit({'kind':'case-complete','case':spec['id'],'chunks':len(plan),'inputDigest':model['inputDigest']})
        emit({'kind':'complete','chunks':chunks,'operationClocks':mode!='untimed'});rows.extend(core)
    if not browser:rows.append({'kind':'process-complete','pid':pid,'version':P['runtimeVersions'][runtime],'highRss':33554432,'resourceUsage':{'maxRSS':32768},'resourceUnits':P['resourceUnits']})
    else:
        birth={'kind':'browser-process','pid':browser_pid,'ppid':pid,'group':browser_pid,'session':browser_pid,'startTicks':2,'state':'S','spawnargs':['/synthetic/browser','--user-data-dir=/tmp/synthetic-profile'],'executable':'/synthetic/browser','profile':'/tmp/synthetic-profile-'+slot['id'],'profileInitiallyEmpty':True,'profileMechanism':'explicit -profile argument' if runtime=='firefox' else 'explicit --user-data-dir argument','spawnAttempt':1,'ownershipJournal':config['ownershipJournal']}
        response_specs=[('/',b'<!doctype html><title>Numeric portability proof</title>')]
        names=['browser-semantics.mjs','core.mjs','semantic-worker.mjs'] if mode=='semantics' else ['core.mjs']
        response_specs += [('/'+name,(e.HERE/name).read_bytes()) for name in names]
        responses=[]
        for path,data in response_specs:responses.append({'kind':'http-response','request':len(responses),'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'cacheControl':'no-store','originIsolation':True})
        for name in ['dist/numeric.js','dist/shared.js']+(['dist/numeric-scalar-control.mjs'] if mode in ('semantics','untimed') else []):
            source='dist/numeric.js' if name.endswith('numeric-scalar-control.mjs') else name;entry=next(x for x in ORIGIN['expectedOutputs'][slot['arm']] if x['path']==source)
            responses.append({'kind':'http-response','request':len(responses),'path':'/'+name,'bytes':entry['bytes'],'sha256':entry['sha256'],'cacheControl':'no-store','originIsolation':True})
        rows=[birth,*responses,*rows,{'kind':'browser-complete','version':browser_version,'origin':'http://127.0.0.1:12345','requests':len(responses),'resourceTimings':[] if mode=='measure' else None,'localHttpOnly':True,'globallyColdCompilerOrOsCache':False}]
    return rows

def selection():return {'automaticProbes':1,'scalarProbes':1,'repeated':0,'validateRestored':True,'automatic':'SIMD','scalar':'forced scalar'}
def worker_snapshot(size):return {'used':65536+size*8+128,'root':65536,'tail':65536,'size':size,'depth':1,'digest':'ab'*32}
def semantic_rows():
    rows=[]
    for operation,sizes in [('countInRange',[*range(33),33,63,64,65,1023,1024,1025,32769]),('countPointsInBox',[0,1,2,3,4,5,15,16,17,31,32,33,513,16385])]:
        for mode in ('auto','scalar'):
            for size in sizes:
                before=snapshot(size*(2 if operation=='countPointsInBox' else 1),True);rows.append({'kind':'kernel-semantic','mode':mode,'operation':operation,'size':size,'actualCounts':e.semantic_oracle(operation,size),'before':before,'after':copy.deepcopy(before)})
    for copy_mode in (False,True):
        for mode in ('auto','scalar'):
            row={'kind':'worker-semantic','copy':copy_mode,'mode':mode,'countChecks':6,'actualGrowth':True,'capacityBefore':131072,'capacityAfter':524288,'ready':{'ready':True,'selection':mode,'probes':1,'selectionResult':mode=='auto'},'ownerCounts':[33,1,17],'overlap':'scheduled tasks; not individual load overlap','passed':True}
            for phase in ('first','during','final'):
                full=copy_mode or phase!='during';before=[worker_snapshot(n) if full else {'root':65536,'tail':65536,'size':n,'depth':1,'values':[1]*n} for n in (33,34)]
                row[phase]={'counts':[33,17],'readOnly':True,'before':before,'after':copy.deepcopy(before),'memoryPreserved':'whole buffers across isolated read' if full else 'visible snapshot across concurrent owner writes'}
            rows.append(row)
    rows.append({'kind':'semantics-complete','checks':2782,'selection':selection(),'exceptionTransfer':False,'sharedAndCopiedActualWorkers':True});return rows

def canonical_lane(lane):
    calibrated={};slots=[]
    for slot in e.schedule(lane,'run'):
        work=e.derive_work(calibrated[slot['runtime']]) if slot['mode']=='measure' and slot['warm'] else None
        config=make_config(slot,lane,work=work);result=e.validate_raw(make_raw(slot,config),slot,config,work=work)
        if slot['mode']=='calibrate':calibrated.setdefault(slot['runtime'],{})[slot['arm']]=result
        slots.append({**slot,'evidence':result})
    run={'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'1'*40,'GITHUB_WORKFLOW_SHA':'1'*40,'GITHUB_REPOSITORY':'natanelia/zerocopy','GITHUB_REF':'refs/heads/proof/numeric-portability-20261009'}
    return {'syntheticOnly':True,'lane':lane,'manifest':{'origin':ORIGIN},'run':run,'manifestSha256':'3'*64,'packetSha256':'2'*64,'slots':slots,'phaseSlots':{'run':slots}}
