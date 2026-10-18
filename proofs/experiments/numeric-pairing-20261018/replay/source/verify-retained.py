#!/usr/bin/env python3
"""Independent binding and numerical replay of unmodified diagnostic records."""
import argparse,hashlib,json,math,pathlib,statistics

def verify(stage,reference):
    plan=json.loads((stage/'raw/plan.json').read_text()); groups={}; measured=warmup=0
    assert sorted(plan['inputs'])==['baseline','candidate']
    inputs={role:dict(sorted(plan['inputs'][role].items())) for role in ['baseline','candidate']}
    assert hashlib.sha256(json.dumps(inputs,separators=(',',':')).encode()).hexdigest()=='3f49dd934a3950240a09a0765b27716151f860cb7288dd3a1d1ed8687bb910d4', 'frozen build manifests'
    multiplier=plan.get('batchMultiplier',1); assert multiplier in (1,4)
    sizes=[2,1024,32768] if multiplier==1 else [2]; assert plan['sizes']==sizes
    expected=[]
    for size in sizes:
        for block in range(4):
            modes=['separate-aa','paired-aa','paired-ab'] if multiplier==1 else ['paired-aa','paired-ab']
            offset=block%len(modes); modes=modes[offset:]+modes[:offset]
            for mode in modes:
                roles=('BAAB' if block%2 else 'ABBA') if mode=='separate-aa' else 'P'
                expected += [dict(mode=mode,size=size,block=block,position=i,role=role) for i,role in enumerate(roles)]
    expected += [dict(mode='slow-control',size=1024,block=b,position=0,role='P') for b in range(4)]
    assert plan['schedule']==expected
    assert reference['planSha256']==hashlib.sha256((stage/'raw/plan.json').read_bytes()).hexdigest()
    anchor_index=next(i for i,a in enumerate(expected) if a['mode']=='paired-aa')
    anchor=json.loads((stage/'raw'/f'{anchor_index+1:03d}.json').read_text())['runtime']
    assert anchor['version']=='v22.16.0' and anchor['versions']['node']=='22.16.0'
    assert not anchor['versions'].get('bun') and anchor['arch']=='x64' and anchor['execArgv']==[]
    assert anchor['binarySha256']==plan['runtimeSha256'] and anchor['execPath']==plan['runtime']
    separate_runtime=dict(node=anchor['version'],bun=anchor['versions'].get('bun'),v8=anchor['versions']['v8'],arch=anchor['arch'],cpu=anchor['cpu'])
    for i,a in enumerate(expected):
        prefix=stage/'raw'/f'{i+1:03d}'; c=json.loads(prefix.with_suffix('.json').read_text())
        status=json.loads(prefix.with_suffix('.status.json').read_text())
        assert status['assignment']==a and status['exitCode']==0 and status['error'] is None
        assert json.loads(prefix.with_suffix('.assignment.json').read_text())==a
        separate=a['mode']=='separate-aa'
        if separate:
            assert c['plan']['sizes']==[a['size']], 'scheduled size'
            assert c['runtime']==separate_runtime, 'separate runtime'
            assert c['bundle']==plan['inputs']['candidate']
            rows=c['results']; measured+=sum(len(r['samples']) for r in rows);warmup+=sum(len(r['warmup']) for r in rows)
        else:
            assert c['size']==a['size'], 'scheduled size'
            assert c['block']==a['block'], 'scheduled block'
            assert c['kind']==a['mode'].replace('paired-',''), 'scheduled kind'
            assert c['runtime']==anchor, 'paired runtime'
            assert c['source']['A']==plan['inputs']['baseline' if a['mode']=='paired-ab' else 'candidate']
            assert c['source']['B']==plan['inputs']['candidate']
            rows=c['rows']; measured+=sum(2*len(r['samples']) for r in rows);warmup+=sum(2*len(r['warmup']) for r in rows)
        assert c['driver']==plan['originalDriverSha256' if separate else 'pairedDriverSha256']
        assert all(r['size']==a['size'] for r in rows)
        raw=pathlib.Path(str(prefix)+('.json.samples.ndjson' if separate else '.json.ndjson'))
        assert [json.loads(s) for s in raw.read_text().splitlines()]==(rows if separate else [x for r in rows for x in r['warmup']+r['samples']])
        groups.setdefault((a['mode'],a['size']),[]).append((a,c))
    checked=0
    assert [(r['mode'],r['size']) for r in reference['results']]==list(groups)
    for result in reference['results']:
        mode,size=result['mode'],result['size']; group=groups[(mode,size)]
        for index,row in enumerate(result['rows']):
            assert row['size']==size
            logs=[]
            for block in range(4):
                kids=[(a,c) for a,c in group if a['block']==block]
                if mode=='separate-aa':
                    pair=[]
                    for pos in [0,2]:
                        two={a['role']:c['results'][index]['samples'] for a,c in kids[pos:pos+2]}
                        pair.append(math.log(statistics.median(two['A'])/statistics.median(two['B'])))
                    logs.append(sum(pair)/2)
                else:
                    assert len(kids)==1
                    data=kids[0][1]['rows'][index]['samples']
                    logs.append(math.log(statistics.median([r['timings']['A']/r['timings']['B'] for r in data])))
            mean=sum(logs)/4;radius=3.182446305284263*math.sqrt(sum((x-mean)**2 for x in logs)/3/4)
            stats=dict(zip(['speedup','lower','upper'],map(math.exp,[mean,mean-radius,mean+radius])))
            assert all(math.isclose(row[k],v,rel_tol=1e-12,abs_tol=0) for k,v in stats.items())
            aa=mode.endswith('-aa');target=mode=='paired-ab' and size>=1024 and row['name'] in ['range-simd','range-public']
            point=stats['speedup']>=.95 and (not aa or stats['speedup']<=1/.95) and (not target or stats['speedup']>1.05)
            conf=stats['lower']>=.95 and (not aa or stats['upper']<=1/.95) and (not target or stats['lower']>1.05)
            assert (row['pointPass'],row['confidencePass'],row['pass'])==(point,conf,point and conf)
            checked+=1
    assert reference['processes']==len(expected) and reference['measuredBatches']==measured and reference['warmupBatches']==warmup
    missing=sum(a['mode']=='separate-aa' for a in expected)
    assert reference['separateProcessesWithoutPerChildBinaryAttestation']==missing
    return dict(processes=len(expected),rowsIndependentlyRecomputed=checked,measuredBatches=measured,warmupBatches=warmup,
                separateProcessesWithoutPerChildBinaryAttestation=missing,evidenceVerified=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('stage',type=pathlib.Path);p.add_argument('reference',type=pathlib.Path);p.add_argument('output',type=pathlib.Path)
    a=p.parse_args();result=verify(a.stage,json.loads(a.reference.read_text()))
    with a.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result))
