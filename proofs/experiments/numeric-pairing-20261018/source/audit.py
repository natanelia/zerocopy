#!/usr/bin/env python3
"""Independent calculation of paired and separate-process estimates from all raw timings."""
import json,math,pathlib,statistics,hashlib
ROOT=pathlib.Path(__file__).resolve().parent
plan=json.loads((ROOT/'raw/plan.json').read_text())
reference=json.loads((ROOT/'audit.json').read_text())
groups={}
for i,a in enumerate(plan['schedule']):
 prefix=ROOT/'raw'/f'{i+1:03d}'
 status=json.loads(prefix.with_suffix('.status.json').read_text())
 assert status['assignment']==a and status['exitCode']==0 and status['error'] is None
 c=json.loads(prefix.with_suffix('.json').read_text())
 separate=a['mode']=='separate-aa'
 journal=[json.loads(s) for s in pathlib.Path(str(prefix)+('.json.samples.ndjson' if separate else '.json.ndjson')).read_text().splitlines()]
 assert journal==(c['results'] if separate else [x for r in c['rows'] for x in r['warmup']+r['samples']])
 groups.setdefault((a['mode'],a['size']),[]).append((a,c))
checked=0
for result in reference['results']:
 mode,size=result['mode'],result['size'];g=groups[(mode,size)]
 for index,row in enumerate(result['rows']):
  logs=[]
  for block in range(4):
   children=[(a,c) for a,c in g if a['block']==block]
   if mode=='separate-aa':
    pair=[]
    for pos in [0,2]:
     two={a['role']:c['results'][index]['samples'] for a,c in children[pos:pos+2]}
     pair.append(math.log(statistics.median(two['A'])/statistics.median(two['B'])))
    logs.append(sum(pair)/2)
   else:
    assert len(children)==1
    data=children[0][1]['rows'][index]['samples']
    logs.append(math.log(statistics.median([x['timings']['A']/x['timings']['B'] for x in data])))
  mean=sum(logs)/4
  radius=3.182446305284263*math.sqrt(sum((x-mean)**2 for x in logs)/3/4)
  stats=dict(zip(['speedup','lower','upper'],map(math.exp,[mean,mean-radius,mean+radius])))
  assert all(math.isclose(row[k],v,rel_tol=1e-12,abs_tol=0) for k,v in stats.items())
  aa=mode.endswith('-aa');target=mode=='paired-ab' and size>=1024 and row['name'] in ['range-simd','range-public']
  point=stats['speedup']>=0.95 and (not aa or stats['speedup']<=1/0.95) and (not target or stats['speedup']>1.05)
  conf=stats['lower']>=0.95 and (not aa or stats['upper']<=1/0.95) and (not target or stats['lower']>1.05)
  assert row['pointPass']==point and row['confidencePass']==conf and row['pass']==(point and conf)
  checked+=1
receipt={'processes':len(plan['schedule']),'rowsIndependentlyRecomputed':checked,'pass':True,'auditSha256':hashlib.sha256((ROOT/'audit.json').read_bytes()).hexdigest()}
with (ROOT/'independent-audit.json').open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
print(receipt)
