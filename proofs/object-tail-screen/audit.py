#!/usr/bin/env python3
"""Read-only, independently implemented complete/partial campaign reconstruction."""
import datetime, hashlib, json, math, pathlib, statistics, sys

CASES = ['map-object-512', 'map-number-512', 'map-string-512']
GROUPS = {'baseline-refinement': ['baseline', 'refinement'], 'original-refinement': ['original', 'refinement'],
          'baseline-aa': ['baseline', 'baseline'], 'original-aa': ['original', 'original'], 'refinement-aa': ['refinement', 'refinement']}
SEED = 0x6b3a912d
def schedule():
    state = SEED
    def next_random():
        nonlocal state
        state ^= (state << 13) & 0xffffffff
        state ^= state >> 17
        state ^= (state << 5) & 0xffffffff
        state &= 0xffffffff
        return state / 4294967296
    def shuffled(items):
        items = list(items)
        for i in range(len(items)-1, 0, -1):
            j = int(next_random() * (i+1)); items[i], items[j] = items[j], items[i]
        return items
    orientations = {(case, group): shuffled(['ABBA','ABBA','BAAB','BAAB']) for case in CASES for group in GROUPS}
    result = []
    for q in range(4):
        for case in shuffled(CASES):
            for group in shuffled(GROUPS):
                for pos, label in enumerate(orientations[case,group][q]):
                    result.append(dict(runtime='bun', workload=case, group=group, quartet=q, position=pos, label=label, role=GROUPS[group][label=='B']))
    return result
def read(path): return json.loads(path.read_text())
def digest(value): return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def interval(values):
    assert len(values)==4
    center=statistics.mean(values); half=3.182446305284263*statistics.stdev(values)/2
    return dict(ratio=math.exp(center),lower=math.exp(center-half),upper=math.exp(center+half),logRatios=values)
def audit(root):
    plan=schedule(); assert read(root/'plan.json')['plan']==plan
    manifest=read(root/'manifest.json'); fixed=read(root/'fixed-work.json')
    package_hashes={}
    for role,build in manifest['builds'].items():
        items=[['dist/'+name,sha] for name,sha in build['dist']]+[['package.json',hashlib.sha256(b'{"type":"module","private":true}\n').hexdigest()]]
        package_hashes[role]=digest(items)
    valid=[]; issues=[]; pids=set(); previous_end=None; fixture_by_case={}
    def subject(prefix, config, role):
        nonlocal previous_end
        start=read(pathlib.Path(str(prefix)+'.started.json')); process=read(pathlib.Path(str(prefix)+'.process.json'))
        assert start['config']==config and start['role']==role and start['runtime']=='bun'
        assert start['packageDigest']==package_hashes[role]
        assert process['status']==0 and not process.get('signal') and not process.get('error')
        assert pathlib.Path(str(prefix)+'.stderr.txt').read_text()==''
        assert process['pid'] not in pids; pids.add(process['pid'])
        begin=datetime.datetime.fromisoformat(start['started']); end=datetime.datetime.fromisoformat(process['ended'])
        assert begin<=end
        if previous_end is not None: assert previous_end<=begin
        previous_end=end
        lines=[json.loads(x) for x in pathlib.Path(str(prefix)+'.stdout.jsonl').read_text().splitlines()]
        assert lines[-1]['event']=='result' and sum(x['event']=='result' for x in lines)==1
        assert not any(x['event']=='failure' for x in lines)
        r=lines[-1]['result']; case=config['workload']
        assert r['phase']==config['phase'] and r['workload']==case and r['schema']==1
        assert r['runtime']['name']=='bun' and r['runtime']['version']=='1.4.2' and r['runtime']['arch']=='x64'
        assert r['runtime']['pid']==process['pid'] and r['runtime']['execArgv']==[]
        assert r['packageDigest']==package_hashes[role]
        assert r['fixtureDigest']==digest(r['fixture'])==r['postFixtureDigest']
        assert r['opsPerSweep']==512
        comparison=(r['fixture'],r['opsPerSweep'],r['expectedPerSweep'])
        if case in fixture_by_case: assert fixture_by_case[case]==comparison
        fixture_by_case[case]=comparison
        samples=r['pilot'] if config['phase']=='pilot' else [r['warm']]+r['samples']
        for x in samples:
            assert 0 < x['sweeps'] <= 16777216 and isinstance(x['sweeps'],int)
            assert math.isfinite(x['ms']) and x['ms']>0
            assert x['sink']==x['sweeps']*r['expectedPerSweep']
        if config['phase']=='pilot':
            assert r['pilot'][-1]['ms']>=40
            assert [x['attempt'] for x in lines if x['event']=='pilot']==r['pilot']
        else:
            assert len(r['samples'])==21 and r['sweeps']==config['sweeps']
            assert r['warm']['sweeps']==config['warmSweeps'] and r['warm']['ms']>=150
            assert all(x['sweeps']==config['sweeps'] and x['ms']>=10 for x in r['samples'])
            assert [x['sample'] for x in lines if x['event']=='warm']==[r['warm']]
            assert [x['sample'] for x in lines if x['event']=='sample']==r['samples']
            assert [x['index'] for x in lines if x['event']=='sample']==list(range(21))
        return r
    pilot_ordinal=0
    for case in CASES:
        pilots=[]
        for role in ['baseline','original','refinement']:
            try: pilots.append(subject(root/'pilots'/f'{pilot_ordinal:05}',dict(phase='pilot',workload=case),role))
            except Exception as e: issues.append(dict(phase='pilot',ordinal=pilot_ordinal,error=repr(e)))
            pilot_ordinal+=1
        if len(pilots)==3:
            expected=dict(sweeps=max(p['pilot'][-1]['sweeps'] for p in pilots),warmSweeps=max(math.ceil(p['pilot'][-1]['sweeps']*500/p['pilot'][-1]['ms']) for p in pilots))
            assert fixed[case]==expected
    for ordinal,item in enumerate(plan):
        prefix=root/'measurements'/f'{ordinal:05}'
        try:
            outcome=read(pathlib.Path(str(prefix)+'.outcome.json'))
            assert all(outcome[k]==v for k,v in item.items()) and outcome['ordinal']==ordinal
            if not outcome['valid']: raise ValueError(outcome.get('reason','invalid subject'))
            assert len(issues)==0 or all(x['phase']!='pilot' for x in issues), 'measurements started after pilot failure'
            r=subject(prefix,dict(phase='measure',workload=item['workload'],**fixed[item['workload']]),item['role'])
            valid.append(dict(**item,ordinal=ordinal,median=statistics.median(x['ms'] for x in r['samples'])))
        except Exception as e: issues.append(dict(phase='measure',ordinal=ordinal,**item,error=repr(e)))
    groups=[]
    for case in CASES:
        for group in GROUPS:
            rows=[r for r in valid if r['workload']==case and r['group']==group]
            record=dict(workload=case,group=group,validSubjects=len(rows))
            if len(rows)==16:
                logs=[]
                for q in range(4):
                    subset=[r for r in rows if r['quartet']==q]
                    logs.append(statistics.mean(math.log(r['median']) for r in subset if r['label']=='B')-statistics.mean(math.log(r['median']) for r in subset if r['label']=='A'))
                record.update(interval(logs))
                record['aaDrift']=(record['ratio']<1/1.02 or record['ratio']>1.02) and (record['lower']>1 or record['upper']<1)
            else: record['invalid']=True
            groups.append(record)
    if (root/'summary.json').exists():
        summary=read(root/'summary.json')
        for group in groups:
            if not group.get('invalid'):
                original=next(c for c in summary['cells'] if c['workload']==group['workload'])['groups'][group['group']]
                for key in ['ratio','lower','upper']: assert math.isclose(original[key],group[key],rel_tol=1e-12,abs_tol=1e-12)
        assert summary['complete']==(not issues and len(valid)==240)
    return dict(complete=not issues and len(valid)==240,validSubjects=len(valid),scheduledSubjects=240,issues=issues,groups=groups,subjects=valid,globalClearance=False)
if __name__=='__main__':
    try: report=audit(pathlib.Path(sys.argv[1]).resolve())
    except Exception as error: report=dict(complete=False,globalClearance=False,metadataFailure=repr(error),scheduledSubjects=240)
    print(json.dumps(report,indent=2))
    if not report['complete']: sys.exit(1)
