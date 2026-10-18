#!/usr/bin/env python3
"""One sealed, serial method diagnostic. No retries, deleted samples, or acceptance override."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,time,platform
ROOT=pathlib.Path(__file__).resolve().parent
WORK=ROOT.parent
OUT=ROOT/'raw'
assert not OUT.exists(), 'Refuse to replace a prior experiment'
OUT.mkdir()
sha=lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
node=pathlib.Path(shutil.which('node')).resolve()
original=WORK/'repo/proofs/numeric-tree-process.mjs'
paired=ROOT/'paired.mjs'
baseline=WORK/'evidence/baseline-build'
candidate=WORK/'evidence/candidate-build'
allowed=sorted(os.sched_getaffinity(0)); cpu=allowed[0]; os.sched_setaffinity(0,{cpu})
env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','SYSTEMROOT'] if k in os.environ}
bundle=lambda d: {str(p.relative_to(d)):sha(p) for p in sorted(d.rglob('*')) if p.is_file() and (p.name=='package.json' or p.suffix=='.wasm' or (p.suffix=='.js' and p.parent.name=='dist'))}
identities={'baseline':bundle(baseline),'candidate':bundle(candidate)}
assert identities['baseline']['numeric-kernels.wasm']==identities['candidate']['numeric-kernels.wasm']
assert sha(WORK.parent/'numeric-tree-X64-d16d82c9.zip')=='c47098bfa2c34c916b058fd38b3178dc85289b68b69141c88afeeea90ef837fb'
plan={'created':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'purpose':'diagnostic only; neither clears original plan version 2 nor replaces failed evidence',
 'sizes':[2,1024,32768],'blocks':4,'warmup':7,'samples':21,'work':8000000,'regressionFloor':0.95,'improvementFloor':1.05,'aaCeiling':1/0.95,
 'sourceCommit':'d16d82c9ac8b4264870c8c3687b25b53a6e553bf','baselineCommit':'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e',
 'inputArtifact':12123443213,'inputZipSha256':sha(WORK.parent/'numeric-tree-X64-d16d82c9.zip'),
 'originalDriverSha256':sha(original),'pairedDriverSha256':sha(paired),'controllerSha256':sha(__file__),
 'runtime':str(node),'runtimeSha256':sha(node),'host':platform.platform(),'allowedCpusBeforePin':allowed,'cpu':cpu,'inputs':identities,
 'limits':'Three preselected diagnostic sizes, not full coverage. Node x64 only. Different local Node version from hosted input. Warm scans only. Two independent arenas, at most 64 MiB each. No memory or startup speed claim. Existing four-block 95% t critical value and thresholds retained, estimator changed to per-process median of paired ratios. New timings cannot be pooled into the original method.',
 'schedule':[]}
for size in plan['sizes']:
 for block in range(4):
  groups=['separate-aa','paired-aa','paired-ab']
  groups=groups[block%3:]+groups[:block%3]
  for mode in groups:
   for pos,role in enumerate(('BAAB' if block&1 else 'ABBA') if mode=='separate-aa' else 'P'):
    plan['schedule'].append({'mode':mode,'size':size,'block':block,'position':pos,'role':role})
for block in range(4):plan['schedule'].append({'mode':'slow-control','size':1024,'block':block,'position':0,'role':'P'})
(OUT/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
scratch=ROOT/'scratch'; scratch.mkdir()
for index,item in enumerate(plan['schedule']):
 prefix=OUT/f'{index+1:03d}'
 (prefix.with_suffix('.assignment.json')).write_text(json.dumps(item)+'\n')
 a=scratch/'A';b=scratch/'B'
 for target,source in [(a,baseline if item['mode']=='paired-ab' else candidate),(b,candidate)]:
  if target.exists():shutil.rmtree(target)
  shutil.copytree(source,target)
  assert bundle(target)==identities['baseline' if source==baseline else 'candidate']
 output=prefix.with_suffix('.json')
 if item['mode']=='separate-aa':
  config={'moduleDir':str(a),'output':str(output),'sizes':[item['size']]}
  args=[str(node),str(original),'--child',str(scratch/'job.json')]
 else:
  config={'aDir':str(a),'bDir':str(b),'size':item['size'],'block':item['block'],'output':str(output),'kind':item['mode'].replace('paired-','')}
  args=[str(node),str(paired),str(scratch/'job.json')]
 (scratch/'job.json').write_text(json.dumps(config)+'\n')
 (prefix.with_suffix('.config.json')).write_text(json.dumps(config)+'\n')
 start=time.time()
 with prefix.with_suffix('.log').open('xb') as log:
  try:
   run=subprocess.run(args,cwd=scratch,env=env,stdout=log,stderr=log,timeout=240)
   status={'assignment':item,'exitCode':run.returncode,'error':None,'wallSeconds':time.time()-start}
  except Exception as exc:
   status={'assignment':item,'exitCode':None,'error':repr(exc),'wallSeconds':time.time()-start}
 prefix.with_suffix('.status.json').write_text(json.dumps(status)+'\n')
 print(index+1,len(plan['schedule']),item['mode'],item['size'],item['block'],status['exitCode'],flush=True)
assert sha(paired)==plan['pairedDriverSha256'] and sha(original)==plan['originalDriverSha256'] and sha(__file__)==plan['controllerSha256']
assert bundle(baseline)==identities['baseline'] and bundle(candidate)==identities['candidate'] and sha(node)==plan['runtimeSha256']
