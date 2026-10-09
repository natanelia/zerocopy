"""Independent external cleanup owner for bounded synthetic probes only."""
from pathlib import Path
import json, os, signal, subprocess, sys, time
repo=Path(sys.argv[1]).resolve(); out=Path(sys.argv[2]).resolve(); assert not out.exists() or not any(out.iterdir()), 'Use a fresh private output directory; preserve prior probes'
out.mkdir(parents=True,exist_ok=True)
engines=sys.argv[3:]
assert engines
witness=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'],start_new_session=True)
records=[]
controllers=set()
def interrupt(signum, frame):
    raise RuntimeError('External guardian interrupted: '+str(signum))
signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
def members(group):
    result=[]
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            data=path.read_text(); fields=data[data.rfind(')')+2:].split()
            if int(fields[2])==group and fields[0] not in ['Z','X']:result.append(int(path.parent.name))
        except (FileNotFoundError,ProcessLookupError):pass
    return result
def kill(group):
    try:os.killpg(group,signal.SIGKILL)
    except ProcessLookupError:pass
try:
  for engine_index,engine in enumerate(engines):
    for name in ['success','nonzero','cap','descendant','interrupt','abrupt','exhausted']:
      prefix=out/f'engine-{engine_index}-{name}'
      log=open(str(prefix)+'.controller.log','w')
      child=subprocess.Popen([engine,str(repo/'proofs/heap-compaction-records-supervisor-synthetic.mjs'),'--case',name,str(prefix)],cwd=repo,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
      controllers.add(child.pid)
      deadline=time.monotonic()+10; interrupted=False; guardian_used=False
      try:
        while child.poll() is None:
          if name=='interrupt' and not interrupted and Path(str(prefix)+'.partial.ndjson').exists():
            os.kill(child.pid,signal.SIGTERM);interrupted=True
          if time.monotonic()>=deadline:
            guardian_used=True;kill(child.pid);break
          time.sleep(.01)
        child.wait(timeout=1)
      finally:
        log.close()
        receipt_path=Path(str(prefix)+'.command.json')
        receipt=json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        group=receipt.get('group')
        if group:
          if members(group):
            for _ in range(50):
              if not members(group):break
              time.sleep(.01)
          if members(group):guardian_used=True;kill(group)
        kill(child.pid); controllers.discard(child.pid)
      assert not guardian_used, (name,'external guardian was needed',prefix)
      assert child.returncode==({'interrupt':143,'abrupt':7}.get(name,0)),(name,child.returncode,Path(str(prefix)+'.controller.log').read_text())
      assert witness.poll() is None,'unrelated witness was killed'
      if group:assert not members(group),(name,group)
      if name=='abrupt':
        assert receipt['status']=='controller-exit-cleanup-unverified'
        assert 'preserve-this-record' in Path(str(prefix)+'.partial.ndjson').read_text()
      records.append({'engine':engine,'case':name,'passed':True,'controllerExit':child.returncode,'guardianDeadlineSeconds':10,'guardianNeeded':False,'ownedGroup':group,'ownedLiveAfter':members(group) if group else [],'unrelatedWitnessSurvived':True,'receipt':str(receipt_path)})
      (out/'summary.json').write_text(json.dumps({'passed':True,'complete':False,'records':records},indent=2)+'\n')
finally:
  # Independent owner cleanup is restricted to its own controller/witness IDs
  # and groups durably registered in this fresh, private test directory.
  for group in controllers:kill(group)
  for path in out.glob('*.command.json'):
    receipt=json.loads(path.read_text()); group=receipt.get('group')
    if group:kill(group)
  kill(witness.pid);witness.wait(timeout=1)
(out/'summary.json').write_text(json.dumps({'passed':True,'complete':True,'records':records},indent=2)+'\n')
print(json.dumps({'passed':True,'syntheticCases':len(records),'measurementModesRun':False}))
