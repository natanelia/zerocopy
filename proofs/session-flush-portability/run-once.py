"""Finite preregistered schedule. No replacement, resume, retry or noise repair."""
import datetime
import json
import os
from pathlib import Path
import signal
import sys
import time
from host import ROOT, read, write, sha, check_pins, check_activation, check_inventory, supervised

def main(group):
    if group not in ['arm','browsers']: raise ValueError('Fixed group required')
    if os.environ.get('GITHUB_RUN_ATTEMPT') != '1': raise ValueError('Attempt 1 only; no rerun')
    activation=check_activation()
    protocol=read(ROOT/'PROTOCOL.json'); limits=protocol['limits'][group]
    output=ROOT/'results'/group; preflight=read(output/'PREFLIGHT.json')
    if preflight['state']!='passed': raise ValueError('Correctness/preparation did not pass')
    runtime_bytes=(output/'RUNTIME.json').read_bytes(); manifest=json.loads(runtime_bytes)
    if manifest['activation']!=activation:raise ValueError('Activation bindings changed since preflight')
    if sha(runtime_bytes)!=preflight['runtimeManifestSHA256']: raise ValueError('Runtime freeze mismatch')
    check_pins();check_inventory(manifest['dependencies']);check_inventory(manifest['browserFiles'])
    for runtime, item in manifest['executables'].items():
        if sha(Path(item['path']).read_bytes())!=item['sha256']: raise ValueError('Executable changed: '+runtime)
    work=output/'screen';work.mkdir(exist_ok=False)
    started=time.monotonic()
    job_deadline=read(output/'JOB.json')['subjectsDeadlineEpoch']
    record={'schema':1,'state':'running','group':group,'commands':[],'events':[],'frozenCounts':{},'error':None,
      'startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtimeManifestSHA256':sha(runtime_bytes),
      'inputPinsSHA256':check_pins(),'protocolSHA256':sha((ROOT/'PROTOCOL.json').read_bytes()),
      'runIdentity':manifest['runner'],'screenSecondsCap':limits['screenSeconds']}
    event_stream=(work/'schedule.jsonl').open('x')
    calibrations={};frozen={}
    def event(value):
        record['events'].append(value);event_stream.write(json.dumps(value)+'\n');event_stream.flush();os.fsync(event_stream.fileno())
    def run(mode,runtime,item,arm,slot):
        check_pins()
        remaining=min(limits['screenSeconds']-(time.monotonic()-started)-8,job_deadline-time.time()-8)
        if remaining<=4: raise TimeoutError('Screen deadline')
        id=('cal-'+runtime+'-'+item['name']+'-'+arm) if mode=='calibrate' else ('measure-'+runtime+'-'+item['name']+'-'+str(slot))
        result=work/(id+'.json');stem=work/id
        frozen_path=frozen.get(runtime)
        frozen_hash=sha(frozen_path.read_bytes()) if mode=='measure' else None
        identity={'id':id,'mode':mode,'runtime':runtime,'caseName':item['name'],'arm':arm,'slot':slot}
        event({'event':'launch',**identity,'frozenCountsSHA256':frozen_hash})
        runtime_exe=manifest['executables']['bun' if runtime=='bun' else 'node']['path']
        argv=[runtime_exe,'subject.mjs' if group=='arm' else 'browser.mjs',mode,runtime,arm,str(slot),item['name'],str(result),str(output/'RUNTIME.json')]
        if mode=='measure': argv.append(str(frozen_path))
        command={**identity,'argv':argv,'cwd':str(ROOT),'result':str(result.relative_to(output)),
          'receipt':str((work/(id+'.receipt.json')).relative_to(output)),'frozenCountsSHA256':frozen_hash}
        record['commands'].append(command) # A started but interrupted command remains visible.
        receipt=supervised(argv,ROOT,stem,min(limits['subjectSeconds'],remaining),limits['subjectRSSMiB'],True)
        value=read(result)
        if not value['passed'] or not value['disposed']: raise ValueError('Subject did not validate')
        for key in ['mode','runtime','caseName','arm','slot']:
            if value[key]!=identity[key]: raise ValueError('Subject identity mismatch')
        if value['runtimeManifestSHA256']!=sha(runtime_bytes) or value['inputPinsSHA256']!=record['inputPinsSHA256']: raise ValueError('Subject pins mismatch')
        command['resultSHA256']=sha(result.read_bytes());command['receiptSHA256']=sha((work/(id+'.receipt.json')).read_bytes())
        if mode=='calibrate': calibrations[(runtime,item['name'],arm)]=value
        elif value['frozenCountsSHA256']!=frozen_hash: raise ValueError('Frozen counts changed')
        event({'event':'finish','id':id,'resultSHA256':command['resultSHA256'],'receiptSHA256':command['receiptSHA256']})
    def freeze(runtime):
        cases={}
        for item in protocol['cases']:
            values={arm:calibrations[(runtime,item['name'],arm)] for arm in ['baseline','candidate']}
            rows={arm:{'sha256':sha((work/('cal-'+runtime+'-'+item['name']+'-'+arm+'.json')).read_bytes()),
              **{key:values[arm][key] for key in ['cycles','capped','capReason']}} for arm in values}
            common=item['role']=='control';maximum=max(value['cycles'] for value in values.values())
            cases[item['name']]={'calibrations':rows,'cycles':{arm:maximum if common else values[arm]['cycles'] for arm in values},'common':common}
        value={'runtime':runtime,**{key:record[key] for key in ['protocolSHA256','inputPinsSHA256','runtimeManifestSHA256']},'cases':cases}
        path=work/('frozen-'+runtime+'.json');write(path,value);frozen[runtime]=path
        record['frozenCounts'][runtime]=str(path.relative_to(output))
        event({'event':'freeze','runtime':runtime,'path':str(path.relative_to(output)),'sha256':sha(path.read_bytes())})
    try:
        engines=protocol['runtimeGroups'][group]
        # ARM case->Node/Bun; each browser engine completes before the next starts.
        groups=[engines] if group=='arm' else [[engine] for engine in engines]
        for engines_now in groups:
            for item in protocol['cases']:
                for runtime in engines_now:
                    for arm in ['baseline','candidate']:run('calibrate',runtime,item,arm,-1)
            for runtime in engines_now:freeze(runtime)
            for slot,arm in enumerate(protocol['armOrder']):
                for item in protocol['cases']:
                    for runtime in engines_now:run('measure',runtime,item,arm,slot)
        if len(record['commands'])!=(80 if group=='arm' else 120):raise ValueError('Finite subject schedule mismatch')
        if time.monotonic()-started>limits['screenSeconds'] or time.time()>job_deadline:raise TimeoutError('Screen deadline')
        record['state']='passed'
    except BaseException as error:record['state']='failed';record['error']=repr(error)
    finally:
        try:check_pins()
        except BaseException as error:record['state']='failed';record['error']=(record['error'] or '')+'; '+repr(error)
        record['elapsedSeconds']=time.monotonic()-started
        write(output/'SCREEN.json',record);event_stream.close()
    if record['state']!='passed':raise SystemExit(1)

if __name__=='__main__':main(sys.argv[1])
