from pathlib import Path
import json,math,statistics,hashlib,gzip,subprocess
root=Path('/workspace/scratch/83f1d4baba1f/zerocopy-r4-query')
proof=root/'proofs/queue-portable-20261105'
path=proof/'results/formal-01.json'
if path.exists(): raw=path.read_bytes()
else: raw=gzip.decompress(path.with_suffix('.json.gz').read_bytes())
assert len(raw)==1753792
assert hashlib.sha256(raw).hexdigest()=='3a7c9f31a4bb4fb86b2b9ecfc4cd0881073a21f64e66391d9b76e0436cd71930'
d=json.loads(raw);assert d['status']=='complete' and d['phase']=='formal'
assert len(d['cases'])==10 and len(d['pairs'])==120 and len(d['summary'])==20
assert d['hardware']['affinity']=='2'
assert d['source']['baseline']['commit']=='77599337867dbf785a5f0311d34637d0b36678fc'
assert d['source']['candidate']['commit']=='21172d84b71be2df0000b68757560e8d50f86381'
def near(a,b): assert abs(a-b)<=1e-12*max(1,abs(a),abs(b)),(a,b)
rows=[];sequences=[];calls=elements=batches=0;warm=[]
for pair in d['pairs']:
 assert pair['mode']=='ab'
 assert pair['order']==(['before','after'] if pair['pair']%2==0 else ['after','before'])
 assert pair[pair['order'][1]]['sequence']==pair[pair['order'][0]]['sequence']+1
 plan=next(p for p in d['plans'] if p['runtime']==pair['runtime'] and p['name']==pair['name'])
 for side in ['before','after']:
  s=pair[side];assert s['status']=='complete' and s['runtime']==pair['runtime'] and s['name']==pair['name']
  assert s['initialVerified'] and s['immutableBytesVerified']
  assert s['phase']=='measure' and not s['calibration'] and len(s['samples'])==11
  assert s['repeat']==plan['repeat'] and 1<=s['repeat']<=s['maxRepeat']
  assert s['expectedDigest']==plan['expectedDigest'] and s['arenaSha256']==plan['arenaSha256']
  assert len(s['warmup'])>=8 and len(s['warmup'])<=512
  near(s['warmupMs'],sum(r['ms'] for r in s['warmup']));assert s['warmupMs']>=500
  assert s['warmupCalls']==sum(r['repeat'] for r in s['warmup'])
  assert s['warmupCalls']*max(1,s['outputElements'])>=32768
  for r in s['warmup']+s['samples']:
   assert r['repeat']==s['repeat'] and r['ms']>0
   assert r['verifiedCalls']==r['repeat'] and r['verifiedElements']==r['repeat']*s['outputElements']
  near(s['medianMs'],statistics.median(r['ms']/s['repeat'] for r in s['samples']))
  near(s['minBatchMs'],min(r['ms'] for r in s['samples']))
  assert s['checkedCalls']==sum(r['repeat'] for r in s['warmup']+s['samples'])
  assert s['checkedElements']==s['checkedCalls']*s['outputElements']
  assert s['belowTargetBatches']==sum(r['ms']<20 for r in s['samples'])
  assert s['capped']==(s['repeat']==s['maxRepeat'])
  sequences.append(s['sequence']);calls+=s['checkedCalls'];elements+=s['checkedElements'];batches+=len(s['samples']);warm.append(s['warmupMs'])
assert sorted(sequences)==list(range(240)) and batches==2640
for s in d['summary']:
 ps=[p for p in d['pairs'] if p['runtime']==s['runtime'] and p['name']==s['name']]
 assert len(ps)==6 and [p['pair'] for p in ps]==list(range(6))
 ratios=[p['after']['medianMs']/p['before']['medianMs'] for p in ps]
 for a,b in zip(ratios,s['pairRatios']):near(a,b)
 logs=[math.log(r) for r in ratios];mean=statistics.mean(logs);half=2.570581835636314*statistics.stdev(logs)/math.sqrt(6)
 near(s['ratio'],math.exp(mean));near(s['lower95'],math.exp(mean-half));near(s['upper95'],math.exp(mean+half));assert s['degreesOfFreedom']==5
 near(s['beforeMedianMs'],statistics.median(p['before']['medianMs'] for p in ps));near(s['afterMedianMs'],statistics.median(p['after']['medianMs'] for p in ps))
 near(s['minRatio'],min(ratios));near(s['maxRatio'],max(ratios))
 rows.append({'runtime':s['runtime'],'case':s['name'],'ratio':s['ratio'],'interval95':[s['lower95'],s['upper95']],'adversePairs':sum(r>1 for r in ratios),'ratios':ratios})
identities=0
for side,where in [('baseline',Path('/workspace/scratch/83f1d4baba1f/zerocopy-r4-base')),('candidate',root)]:
 for group,entries in d['source'][side].items():
  if group=='commit':continue
  for name,wanted in entries.items():
   p=where/name
   if wanted is None:assert not p.exists(),str(p)
   else:assert hashlib.sha256(p.read_bytes()).hexdigest()==wanted,str(p)
   identities+=1
for name,wanted in d['source']['driver'].items():assert hashlib.sha256((proof/name).read_bytes()).hexdigest()==wanted,name;identities+=1
pilotPath=Path(d['pilotFile']['path']);pilotRaw=pilotPath.read_bytes() if pilotPath.exists() else gzip.decompress(pilotPath.with_suffix('.json.gz').read_bytes())
assert hashlib.sha256(pilotRaw).hexdigest()==d['pilotFile']['sha256']
pilot=json.loads(pilotRaw);assert d['plans']==pilot['plans'] and d['source']==pilot['source'] and d['config']==pilot['config'] and d['cases']==pilot['cases']
print(json.dumps({'status':'passed','rawBytes':len(raw),'rawSha256':hashlib.sha256(raw).hexdigest(),'processMedians':240,'pairRatios':120,'summaryIntervals':20,'measuredBatches':batches,'checkedCalls':calls,'checkedElements':elements,'warmupMsRange':[min(warm),max(warm)],'sourceDriverIdentityChecks':identities,'formalMatchesPilot':True,'rows':rows},indent=2))
