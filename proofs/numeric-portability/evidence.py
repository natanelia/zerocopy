"""Authoritative pure raw protocol validation. No subjects, clocks, subprocesses or network."""
import hashlib,json,math,pathlib,re
HERE=pathlib.Path(__file__).resolve().parent
P=json.loads((HERE/'protocol.json').read_text())
GOLDEN=json.loads((HERE/'expected-fixtures.json').read_text())['cases']
class InvalidEvidence(AssertionError):pass

def require(value,message):
    if not value:raise InvalidEvidence(message)
def integer(value,minimum=0):return type(value) is int and value>=minimum
def number(value,positive=False):return type(value) in (int,float) and math.isfinite(value) and (value>0 if positive else True)
def same_number(a,b):return number(a) and number(b) and abs(a-b)<=max(1,abs(a),abs(b))*1e-12
def equivalent(a,b):
    if type(a) in (int,float) and type(b) in (int,float):return same_number(a,b)
    if type(a)!=type(b):return False
    if isinstance(a,dict):return a.keys()==b.keys() and all(equivalent(a[k],b[k]) for k in a)
    if isinstance(a,list):return len(a)==len(b) and all(equivalent(x,y) for x,y in zip(a,b))
    return a==b
def shape(row,fields,optional=()):
    require(isinstance(row,dict),'Row must be object')
    require(set(row)==set(fields)| (set(row)&set(optional)),f'Exact fields required for {row.get("kind")}: {set(row)^set(fields)}')
def median(values):
    require(values and all(number(v) for v in values),'Finite nonempty values required');values=sorted(values);n=len(values)
    return values[n//2] if n%2 else (values[n//2-1]+values[n//2])/2
def total(values):
    result=0
    for value in values:result+=value
    return result

def schedule(lane,phase,protocol=P):
    require(lane in ('x64','arm64') and phase in ('semantics','untimed','run'),'Unknown schedule')
    runtimes=protocol['environmentOrders'][lane][0];warm=protocol['warmRuntimes'][lane]
    if phase!='run':return [{'id':f'{runtime}-{phase}-{arm}','runtime':runtime,'arm':arm,'warm':runtime in warm,'mode':phase} for runtime in runtimes if phase!='semantics' or runtime in ('chromium','firefox','webkit') for arm in ('baseline','candidate')]
    result=[{'id':f'{runtime}-calibration-{arm}','runtime':runtime,'arm':arm,'warm':True,'mode':'calibrate'} for runtime in runtimes if runtime in warm for arm in ('baseline','candidate')]
    for block in range(4):
        for runtime in protocol['environmentOrders'][lane][block]:
            seen={'baseline':0,'candidate':0}
            for position,arm in enumerate(protocol['orders'][block]):
                result.append({'id':f'{runtime}-b{block}-{position}-{arm}','runtime':runtime,'arm':arm,'warm':runtime in warm,'mode':'measure','block':block,'position':position,'replicate':seen[arm]});seen[arm]+=1
    return result

def fixture(spec):
    spatial=spec['operation']=='countPointsInBox';size=spec['size']
    values=[(((i//2*29+96)%193)-96 if i&1 else ((i//2*17+128)%257)-128) if spatial else ((i*17+128)%257)-128 for i in range(size)]
    queries=[{'minX':a,'minY':b,'maxX':c,'maxY':d} for a,b,c,d in [(-32,-24,32,24),(200,200,220,220),(-128,-96,128,96),(0,0,0,0)]] if spatial else [[-32,32],[200,220],[-128,128],[0,0]]
    expected=[sum(int(values[i]>=q['minX'] and values[i]<=q['maxX'] and values[i+1]>=q['minY'] and values[i+1]<=q['maxY']) for i in range(0,size,2)) if spatial else sum(int(v>=q[0] and v<=q[1]) for v in values) for q in queries]
    digest=hashlib.sha256(json.dumps([values,queries],separators=(',',':')).encode()).hexdigest()
    require(GOLDEN[spec['id']]=={'inputDigest':digest,'queryCounts':expected,'inputEntries':size},'Frozen fixture disagrees with independent oracle')
    return {'inputDigest':digest,'queryCounts':expected,'inputEntries':size}

def memory_snapshot(value,size,protocol=P,semantic=False):
    fields={'root','depth','tail','size','used','capacity','digest' if semantic else 'memoryDigest'}| (set() if semantic else {'type'})
    shape(value,fields)
    require(all(integer(value[k]) for k in ('root','depth','tail','size','used','capacity')),'Memory descriptor integer fields')
    require(value['size']==size and (semantic or value['type']=='number'),'Snapshot fixture identity')
    require(re.fullmatch('[0-9a-f]{64}',value['digest' if semantic else 'memoryDigest']) is not None,'Memory SHA-256 required')
    require(0<value['capacity']<=protocol['memory']['maximumArenaBytes'] and value['capacity']%65536==0 and value['used']<=value['capacity'],'Arena capacity/used bounds')
    require(value['depth']<=6,'Tree depth bound')
    tree=(size-1)&~31 if size else 0;tail=size-tree
    require((value['root']==0)==(tree==0),'Root/tree agreement')
    if size:require(value['tail']>=65536 and value['tail']+tail*8<=value['used'],'Visible tail inside arena')
    if tree:require(65536<=value['root']<value['used'],'Tree root inside arena')
    return value

def usage(value,runtime,protocol=P):
    require(isinstance(value,dict),'Memory accounting record required')
    if runtime in ('node','bun'):
        require('rss' in value and integer(value['rss'],1) and value['rss']<=protocol['memory']['maximumSubjectRssBytes'],'Native RSS must be positive known bytes')
        require(all(integer(v) for v in value.values()),'Native memory accounting values')
    else:
        shape(value,{'rss','jsHeapBytes'});require(value['rss']=='externally sampled browser process tree','Browser RSS accounting mode')
        require(value['jsHeapBytes'] is None or integer(value['jsHeapBytes']),'Browser heap accounting value')

def derive_work(calibration_by_arm,protocol=P):
    require(set(calibration_by_arm)=={'baseline','candidate'},'Both calibration arms required')
    work={}
    for spec in protocol['cases']:
        arrays={arm:{str(n):sorted(calibration_by_arm[arm]['calibration'][spec['id']]['levels'][str(n)]) for n in spec['ladder']} for arm in ('baseline','candidate')}
        require(all(len(v)==protocol['calibration']['samplesPerLevel'] for a in arrays.values() for v in a.values()),'Complete fixed calibration samples')
        chosen=next((n for n in spec['ladder'] if all(median(arrays[a][str(n)])>=protocol['calibration']['targetChunkMs'] for a in arrays)),None)
        work[spec['id']]={'operations':chosen if chosen is not None else spec['ladder'][-1],'targetMet':chosen is not None,'calibrationWarmupFlag':any(calibration_by_arm[a]['calibration'][spec['id']]['insufficientWarmup'] for a in arrays),'calibration':arrays}
    return work

def diagnostic(warm,measured,work,protocol=P):
    window=protocol['measurement']['warmupComparisonWindow'];drift=median(warm[-window:])/median(warm[-2*window:-window])-1
    ns=[r['nsPerOperation'] for r in measured];m=median(ns);mad=median([abs(x-m) for x in ns]);body=total(warm)
    return {'calibrationFloor':not work['targetMet'],'calibrationWarmupFlag':work['calibrationWarmupFlag'],'minimumDurationFloor':any(r['durationMs']<protocol['measurement']['minimumChunkMs'] for r in measured),'warmupBodyMs':body,'insufficientWarmup':body<protocol['measurement']['minimumWarmupBodyMs'],'relativeWarmupDrift':drift,'warmupFlag':abs(drift)>protocol['measurement']['warmupDriftFraction'],'variabilityFlag':mad/m>protocol['statistics']['sampleRelativeMadDiagnosticFraction']}

class Reader:
    def __init__(self,rows):self.rows=rows;self.at=0
    def take(self,kind):
        require(self.at<len(self.rows),f'Missing {kind}');row=self.rows[self.at];self.at+=1;require(row.get('kind')==kind,f'Expected {kind}, found {row.get("kind")}');return row
    def done(self):require(self.at==len(self.rows),'Unexpected extra core rows')

def validate_raw(rows,slot,config,protocol=P,work=None,identity=None):
    require(isinstance(rows,list) and rows,'Nonempty raw rows required');require(protocol==P,'Only sealed prospective protocol accepted')
    require(equivalent(config.get('protocol'),protocol) and config.get('admitted') is True,'Config must carry exact sealed protocol')
    for key,value in slot.items():require(config.get(key)==value,f'Config/slot mismatch {key}')
    lane=config.get('lane');runtime=slot['runtime'];mode=slot['mode'];require(lane in protocol['environmentOrders'] and runtime in protocol['environmentOrders'][lane][0],'Runtime/lane mismatch')
    require(slot['warm']==(runtime in protocol['warmRuntimes'][lane]),'Unexpected warm cell scope')
    require(mode in ('semantics','untimed','calibrate','measure'),'Unknown subject mode')
    browser=runtime not in ('node','bun');aux=[r for r in rows if 'ordinal' not in r];core=[r for r in rows if 'ordinal' in r]
    require(all(isinstance(r,dict) and isinstance(r.get('kind'),str) for r in rows),'Typed raw records')
    if mode=='semantics':return validate_semantics(rows,slot,config,protocol,identity)
    require(all(integer(r['ordinal']) for r in core) and [r['ordinal'] for r in core]==list(range(len(core))),'Exact contiguous raw ordinal set/order')
    reader=Reader(core);timed=mode!='untimed';result={'startup':None,'warm':{},'calibration':{},'metadata':{'runtime':runtime,'lane':lane,'mode':mode}}
    if mode=='measure':
        startup={}
        for metric in protocol['startup']['metrics']:
            row=reader.take('startup');shape(row,{'kind','ordinal','metric','durationMs'});require(row['metric']==metric and number(row['durationMs'],True),'Exact finite startup observations');startup[metric]=row['durationMs']
        require(same_number(startup['sum'],startup['import']+startup['first-spatial']),'Startup sum mismatch');result['startup']=startup
    if mode in ('measure','calibrate'):
        row=reader.take('startup-validation');shape(row,{'kind','ordinal','firstOperation','count','before','after','endToEndApplicationStartup','timer','timerPrecision','nonpositiveDurationPolicy'})
        require(row['firstOperation']==protocol['startup']['firstOperation'] and row['count']==protocol['startup']['expected'] and type(row['count']) is int,'First spatial result must equal exact oracle')
        memory_snapshot(row['before'],2,protocol);memory_snapshot(row['after'],2,protocol);require(row['before']==row['after'],'Startup memory changed')
        require(row['endToEndApplicationStartup'] is False and row['timer']=='performance.now, milliseconds' and all(isinstance(row[k],str) and row[k] for k in ('timerPrecision','nonpositiveDurationPolicy')),'Startup scope/timer fields required')
    else:
        row=reader.take('selection');shape(row,{'kind','ordinal','automatic','scalar','repeated','validateRestored','automaticProbes','scalarProbes','before','after'})
        require(row['automatic']=='SIMD' and row['scalar']=='forced scalar' and all(integer(row[k]) for k in ('automaticProbes','scalarProbes','repeated')) and row['automaticProbes']==1 and row['scalarProbes']==1 and row['repeated']==0 and row['validateRestored'] is True,'Exact selection evidence required')
        memory_snapshot(row['before'],1,protocol);memory_snapshot(row['after'],1,protocol);require(row['before']==row['after'],'Untimed seed memory changed')
    start=reader.take('start');shape(start,{'kind','ordinal','mode','runtime','lane','operationClocks','firstUse','gc'})
    require((start['mode'],start['runtime'],start['lane'])==(mode,runtime,lane) and start['operationClocks'] is timed,'Raw mode/runtime/lane/clock identity')
    require(start['firstUse']==('fresh-process spatial-only' if mode=='measure' else 'not an inferential startup observation'),'First-use classification')
    require(start['gc']==('natural browser GC; no portable forced-GC API' if browser else 'explicit inherited Node/Bun collection'),'Fixed GC mechanism')
    cases=protocol['cases'] if slot['warm'] else [];chunks=0
    if mode=='measure' and cases:require(work is not None and equivalent(config.get('work'),work),'Common calibrated work must match both arms')
    elif 'work' in config:require(False,'Unexpected work in non-warm/non-measure subject')
    for spec in cases:
        model=fixture(spec);row=reader.take('case-start');shape(row,{'kind','ordinal','case','inputDigest','queryCounts','inputEntries'})
        require(row['case']==spec['id'] and integer(row['inputEntries']) and all(integer(n) for n in row['queryCounts']) and all(row[k]==v for k,v in model.items()),'Fixed ordered case/input oracle mismatch')
        phase_plan=[]
        if mode=='untimed':phase_plan=[('untimed-minimum',None,spec['ladder'][0]),('untimed-maximum',None,spec['ladder'][-1])]
        elif mode=='calibrate':phase_plan=[('calibration-warmup',i,spec['ladder'][-1]) for i in range(protocol['calibration']['warmupChunks'])]+[('calibration',i,n) for n in spec['ladder'] for i in range(protocol['calibration']['samplesPerLevel'])]
        else:phase_plan=[('warmup',i,work[spec['id']]['operations']) for i in range(protocol['measurement']['warmupChunks'])]+[('measurement',i,work[spec['id']]['operations']) for i in range(protocol['measurement']['samples'])]
        warm=[];measured=[];levels={str(n):[] for n in spec['ladder']};calibration_diag=None
        for offset,(phase,sample,operations) in enumerate(phase_plan):
            if mode=='calibrate' and offset==protocol['calibration']['warmupChunks']:
                calibration_diag={'warmupBodyMs':total(warm),'insufficientWarmup':total(warm)<protocol['calibration']['minimumWarmupBodyMs']}
                row=reader.take('calibration-diagnostics');shape(row,{'kind','ordinal','case',*calibration_diag});require(row['case']==spec['id'] and equivalent({k:row[k] for k in calibration_diag},calibration_diag),'Calibration diagnostics must be independently derived')
            row=reader.take('chunk');shape(row,{'kind','ordinal','case','chunk','phase','sample','operation','operations','durationMs','nsPerOperation','checksum','lastResult','queryCounts','valuesPerCall','pointsPerCall','treeSize','tailSize','before'})
            require((row['case'],row['chunk'],row['phase'],row['sample'],row['operation'],row['operations'])==(spec['id'],chunks,phase,sample,spec['operation'],operations),'Exact chunk/phase/sample/operation schedule required')
            require(integer(row['chunk']) and (row['sample'] is None if sample is None else integer(row['sample'])),'Typed chunk/sample identities')
            require(integer(row['operations'],1) and row['operations'] in spec['ladder'],'Operations must be fixed ladder count')
            tree=(spec['size']-1)&~31;tail=spec['size']-tree
            require(integer(row['valuesPerCall'],1) and row['valuesPerCall']==spec['size'] and (row['pointsPerCall'] is None if 'points' not in spec else integer(row['pointsPerCall'],1) and row['pointsPerCall']==spec['points']) and integer(row['treeSize']) and integer(row['tailSize']) and row['treeSize']==tree and row['tailSize']==tail,'Work-unit/tree/tail identity')
            q=model['queryCounts'];expected=(operations//4)*sum(q)+sum(q[:operations%4])
            require(row['queryCounts']==q and all(integer(n) for n in row['queryCounts']) and integer(row['lastResult']) and type(row['checksum']) is int and row['checksum']==expected and row['lastResult']==q[(operations-1)%4],'Exact fixture counts/checksum required')
            memory_snapshot(row['before'],spec['size'],protocol)
            if timed:require(number(row['durationMs'],True) and number(row['nsPerOperation'],True) and same_number(row['nsPerOperation'],row['durationMs']*1e6/operations),'Finite duration/unit relationship')
            else:require(row['durationMs'] is None and row['nsPerOperation'] is None,'Untimed rows cannot contain clocks')
            validation=reader.take('chunk-validation');shape(validation,{'kind','ordinal','case','chunk','after','afterValidation','afterCleanup','liveArenaCapacityBytes'})
            memory_snapshot(validation['after'],spec['size'],protocol)
            require(validation['case']==spec['id'] and integer(validation['chunk']) and validation['chunk']==chunks and validation['after']==row['before'] and integer(validation['liveArenaCapacityBytes']) and validation['liveArenaCapacityBytes']==row['before']['capacity'],'Mandatory unchanged memory/descriptor validation')
            usage(validation['afterValidation'],runtime,protocol);usage(validation['afterCleanup'],runtime,protocol);chunks+=1
            if phase in ('warmup','calibration-warmup'):warm.append(row['durationMs'])
            elif phase=='measurement':measured.append(row)
            elif phase=='calibration':levels[str(operations)].append(row['durationMs'])
        if mode=='measure':
            diag=diagnostic(warm,measured,work[spec['id']],protocol);row=reader.take('diagnostics');shape(row,{'kind','ordinal','case',*diag})
            require(row['case']==spec['id'] and equivalent({k:row[k] for k in diag},diag),'Warm diagnostics must match independent raw recomputation')
            flags=[k for k in ('calibrationFloor','calibrationWarmupFlag','minimumDurationFloor','insufficientWarmup','warmupFlag','variabilityFlag') if diag[k]]
            result['warm'][spec['id']]={'medianNs':median([r['nsPerOperation'] for r in measured]),'flags':flags,'diagnostics':diag}
        elif mode=='calibrate':result['calibration'][spec['id']]={'levels':levels,**calibration_diag}
        row=reader.take('case-complete');shape(row,{'kind','ordinal','case','chunks','inputDigest'});require(row['case']==spec['id'] and integer(row['chunks']) and row['chunks']==len(phase_plan) and row['inputDigest']==model['inputDigest'],'Case terminal count/input binding')
    row=reader.take('complete');shape(row,{'kind','ordinal','chunks','operationClocks'});require(integer(row['chunks']) and row['chunks']==chunks and row['operationClocks'] is timed,'Exact complete chunk/clock count');reader.done()
    validate_auxiliary(aux,slot,config,identity)
    return result

def validate_auxiliary(rows,slot,config,identity=None):
    runtime=slot['runtime'];browser=runtime not in ('node','bun')
    if not browser:
        require(len(rows)==1,'Exactly one native process terminal required');row=rows[0];shape(row,{'kind','pid','version','highRss','resourceUsage','resourceUnits'})
        require(row['kind']=='process-complete' and integer(row['pid'],1) and row['version']==P['runtimeVersions'][runtime],'Native runtime terminal identity')
        require(integer(row['highRss'],1) and row['highRss']<=P['memory']['maximumSubjectRssBytes'],'Native sampled RSS')
        require(isinstance(row['resourceUsage'],dict) and integer(row['resourceUsage'].get('maxRSS'),1) and row['resourceUnits']==P['resourceUnits'],'Native resource usage units')
        if identity and 'process' in identity:require(row['pid']==identity['process']['pid'],'Native PID/receipt binding')
        return
    allowed={'http-response','browser-process','browser-complete'};require(all(r.get('kind') in allowed for r in rows),'Unexpected browser auxiliary/error row')
    spawned=[r for r in rows if r['kind']=='browser-process'];terminal=[r for r in rows if r['kind']=='browser-complete'];requests=[r for r in rows if r['kind']=='http-response']
    require(len(spawned)==len(terminal)==1 and requests,'Complete unique browser process/terminal/request evidence')
    row=spawned[0];require(integer(row.get('spawnAttempt')) and row.get('spawnAttempt')==1 and row.get('profileInitiallyEmpty') is True and all(integer(row.get(k),1) for k in ('pid','group','session','startTicks')),'Browser birth/profile evidence')
    require(row['pid']==row['group']==row['session'] and isinstance(row.get('profile'),str) and row['profile'],'Detached fresh browser identity')
    require(row.get('ownershipJournal')==config.get('ownershipJournal'),'Browser journal configuration binding')
    require(all(integer(r.get('request')) for r in requests) and [r.get('request') for r in requests]==list(range(len(requests))),'Exact HTTP response sequence')
    for response in requests:
        shape(response,{'kind','request','path','bytes','sha256','cacheControl','originIsolation'});require(integer(response['bytes']) and re.fullmatch('[0-9a-f]{64}',response['sha256']) and response['cacheControl']=='no-store' and response['originIsolation'] is True,'Frozen isolated local response')
    row=terminal[0];shape(row,{'kind','version','origin','requests','resourceTimings','localHttpOnly','globallyColdCompilerOrOsCache'})
    require(isinstance(row['version'],str) and row['version'] and re.fullmatch(r'http://127\.0\.0\.1:[0-9]+',row['origin']) and integer(row['requests']) and row['requests']==len(requests),'Browser terminal version/origin/count')
    require(row['localHttpOnly'] is True and row['globallyColdCompilerOrOsCache'] is False,'Browser cost/cache scope')
    if slot['mode']=='measure':
        require(isinstance(row['resourceTimings'],list),'Browser resource timing list')
        for resource in row['resourceTimings']:
            shape(resource,{'name','startTime','duration','transferSize','encodedBodySize'});require(resource['name'].startswith(row['origin']+'/') and all(number(resource[k]) and resource[k]>=0 for k in ('startTime','duration','transferSize','encodedBodySize')),'Local finite browser resource timing')
    else:require(row['resourceTimings'] is None,'Untimed/calibration resource timings must not become observations')

def selection(value):
    require(equivalent(value,{'automaticProbes':1,'scalarProbes':1,'repeated':0,'validateRestored':True,'automatic':'SIMD','scalar':'forced scalar'}) and all(integer(value[k]) for k in ('automaticProbes','scalarProbes','repeated')),'Exact semantic selection evidence')

def semantic_oracle(operation,size):
    if operation=='countInRange':
        values=[i%13-6 for i in range(size)];special=[math.nan,math.inf,-math.inf,-0.,0.,float.fromhex('0x0.0000000000001p-1022'),-float.fromhex('0x0.0000000000001p-1022'),float.fromhex('0x1.fffffffffffffp+1023'),-float.fromhex('0x1.fffffffffffffp+1023')]
        for i in range(min(size,len(special))):values[i]=special[i]
        return [sum(int(v>=lo and v<=hi) for v in values) for lo in [-math.inf,-0.,2,math.inf,math.nan] for hi in [-math.inf,0,4,math.inf,math.nan]]
    values=[i%31-15 for i in range(size*2)]
    if size:values[0]=math.nan
    if size>1:values[2]=math.inf
    if size>2:values[5]=-math.inf
    return [sum(int(values[i]>=lo and values[i]<=10 and values[i+1]>=-10 and values[i+1]<=hi) for i in range(0,len(values),2)) for lo in [-math.inf,-0.,2,math.inf,math.nan] for hi in [-math.inf,0,12,math.inf,math.nan]]

def validate_semantics(rows,slot,config,protocol=P,identity=None):
    require(slot['runtime'] in ('chromium','firefox','webkit') and slot['mode']=='semantics','Browser-only semantic scope')
    auxiliary=[r for r in rows if r.get('kind') in ('http-response','browser-process','browser-complete')]
    semantic=[r for r in rows if r.get('kind') not in ('http-response','browser-process','browser-complete')]
    reader=Reader(semantic);checks=0
    for operation,sizes in [('countInRange',[*range(33),33,63,64,65,1023,1024,1025,32769]),('countPointsInBox',[0,1,2,3,4,5,15,16,17,31,32,33,513,16385])]:
        for mode in ('auto','scalar'):
            for size in sizes:
                row=reader.take('kernel-semantic');shape(row,{'kind','mode','operation','size','actualCounts','before','after'})
                require(integer(row['size']) and (row['mode'],row['operation'],row['size'])==(mode,operation,size),'Exact browser semantic case order')
                require(row['actualCounts']==semantic_oracle(operation,size) and all(integer(n) for n in row['actualCounts']),'Browser semantic counts must match independent oracle')
                memory_snapshot(row['before'],size*(2 if operation=='countPointsInBox' else 1),protocol,semantic=True);memory_snapshot(row['after'],size*(2 if operation=='countPointsInBox' else 1),protocol,semantic=True);require(row['after']==row['before'],'Browser semantic memory changed');checks+=25
    for copy in (False,True):
        for mode in ('auto','scalar'):
            row=reader.take('worker-semantic');shape(row,{'kind','copy','mode','countChecks','actualGrowth','capacityBefore','capacityAfter','ready','first','during','final','ownerCounts','overlap','passed'})
            require(row['copy'] is copy and row['mode']==mode and integer(row['countChecks']) and row['countChecks']==6 and row['actualGrowth'] is True and row['passed'] is True,'Exact worker semantic scope')
            require(integer(row['capacityBefore'],65536) and integer(row['capacityAfter']) and row['capacityBefore']<row['capacityAfter']<=protocol['memory']['maximumArenaBytes'],'Actual bounded owner growth')
            require(equivalent(row['ready'],{'ready':True,'selection':mode,'probes':1,'selectionResult':mode=='auto'}) and integer(row['ready']['probes']),'Worker selection identity')
            require(row['ownerCounts']==[33,1,17] and all(integer(n) for n in row['ownerCounts']) and row['overlap']=='scheduled tasks; not individual load overlap','Owner immutable snapshot counts/scope')
            for phase in ('first','during','final'):
                result=row[phase];shape(result,{'counts','readOnly','before','after','memoryPreserved'});require(result['counts']==[33,17] and all(integer(n) for n in result['counts']) and result['readOnly'] is True and equivalent(result['before'],result['after']),'Worker count/read-only/memory evidence')
                require(isinstance(result['before'],list) and len(result['before'])==2,'Two worker snapshots')
                full=copy or phase!='during'
                require(result['memoryPreserved']==('whole buffers across isolated read' if full else 'visible snapshot across concurrent owner writes'),'Honest concurrent memory-check scope')
                for value,size in [*zip(result['before'],(33,34)),*zip(result['after'],(33,34))]:
                    if full:
                        shape(value,{'used','root','tail','size','depth','digest'});require(all(integer(value[k]) for k in ('used','root','tail','size','depth')) and value['size']==size and re.fullmatch('[0-9a-f]{64}',value['digest']),'Worker memory descriptor/hash')
                    else:
                        shape(value,{'root','tail','size','depth','values'});require(value['size']==size and value['values']==[1]*size and all(number(n) and n==1 for n in value['values']) and all(integer(value[k]) for k in ('root','tail','size','depth')),'Stable published visible snapshot')
            checks+=8
    row=reader.take('semantics-complete');shape(row,{'kind','checks','selection','exceptionTransfer','sharedAndCopiedActualWorkers'})
    require(integer(row['checks']) and row['checks']==checks==2782 and row['exceptionTransfer'] is False and row['sharedAndCopiedActualWorkers'] is True,'Complete semantic counts and no historical exceptions');selection(row['selection']);reader.done();validate_auxiliary(auxiliary,slot,config,identity)
    return {'startup':None,'warm':{},'calibration':{},'metadata':{'runtime':slot['runtime'],'lane':config['lane'],'mode':'semantics'},'semanticChecks':checks}
