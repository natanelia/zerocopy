"""Read-only independent arithmetic/identity audit of heap formal records."""
import sys, pathlib, json, hashlib, statistics, math, gzip

def near(actual, expected):
    assert abs(actual-expected) <= max(1e-12, abs(expected)*1e-10), (actual,expected)

counts = {"subjects":0,"pairs":0,"batches":0,"summaries":0,"hashes":0}
for arg in sys.argv[1:]:
    path=pathlib.Path(arg); stored=path.read_bytes(); raw=gzip.decompress(stored) if path.suffix=='.gz' else stored
    d=json.loads(raw); assert d['status']=='complete'
    print(path.name, 'bytes', len(raw), 'sha256', hashlib.sha256(raw).hexdigest())
    runtime=d['selectedRuntime']; assert len(d['pairs'])==60 and len(d['summary'])==10
    seen=set(); shortest=float('inf'); warms=[]
    for pair in d['pairs']:
        key=(pair['name'],pair['round']); assert key not in seen;seen.add(key)
        assert pair['runtime']==runtime and pair['round'] in range(6)
        assert pair['order']==(['after','before'] if pair['round']%2 else ['before','after'])
        assert pair['before']['outputHash']==pair['after']['outputHash']
        assert pair['before']['repeat']==pair['after']['repeat']
        for side in ('before','after'):
            s=pair[side]; assert s['runtime']==runtime and s['name']==pair['name']
            vals=[x['ms']/x['repeat'] for x in s['samples']]
            for x in s['samples']+s['warmup']:
                near(x['msPerOperation'],x['ms']/x['repeat'])
                assert x['repeat']==s['repeat']
                assert x['checkedValues']==x['repeat']*s['valuesPerOperation']
                assert x['checkedPriorities']==x['checkedValues']
                assert x['sharedAllocatedBytes']==0
            near(statistics.median(vals),s['medianMsPerOperation']); assert len(vals)==9
            warm=sum(x['ms'] for x in s['warmup']); near(warm,s['warmupTimedMs']);warms.append(warm)
            assert len(s['warmup'])>=8
            if pair['name']!='empty-full':assert warm>=500 and s['warmupTargetMet']
            else: assert warm>=500 or (len(s['warmup'])==256 and s['emptyWarmupCapHit'])
            shortest=min(shortest,min(x['ms'] for x in s['samples']))
            counts['subjects']+=1;counts['batches']+=len(vals)
    for summary in d['summary']:
        pairs=[p for p in d['pairs'] if p['name']==summary['name']];assert len(pairs)==6
        before=[statistics.median(x['ms']/x['repeat'] for x in p['before']['samples']) for p in pairs]
        after=[statistics.median(x['ms']/x['repeat'] for x in p['after']['samples']) for p in pairs]
        ratios=[a/b for a,b in zip(after,before)]; logs=list(map(math.log,ratios)); mean=statistics.mean(logs)
        half=2.57058183564*statistics.stdev(logs)/math.sqrt(6)
        for actual,expected in [(summary['ratio'],math.exp(mean)),(summary['beforeMs'],statistics.median(before)),
          (summary['afterMs'],statistics.median(after)),(summary['ratioCI95'][0],math.exp(mean-half)),
          (summary['ratioCI95'][1],math.exp(mean+half)),(summary['ratioRange'][0],min(ratios)),(summary['ratioRange'][1],max(ratios))]:near(actual,expected)
        assert len(summary['ratios'])==6
        for actual,expected in zip(summary['ratios'],ratios):near(actual,expected)
        print(runtime,summary['name'],f'{math.exp(mean):.9f}',f'[{math.exp(mean-half):.9f},{math.exp(mean+half):.9f}]',
          'adverse',sum(x>1 for x in ratios),'ratios',','.join(f'{x:.9f}' for x in ratios))
        counts['pairs']+=6;counts['summaries']+=1
    for side in ('before','after'):
        source=d['source'][side]; root=pathlib.Path(source['root'])
        for name,want in source['files'].items():
            assert hashlib.sha256((root/name).read_bytes()).hexdigest()==want,(side,name)
            counts['hashes']+=1
    driver=path.parent.parent/'benchmark.mjs';assert hashlib.sha256(driver.read_bytes()).hexdigest()==d['source']['driver'];counts['hashes']+=1
    print(runtime,'shortest measured batch ms',shortest,'warm-up ms range',min(warms),max(warms))
print(json.dumps({'status':'passed',**counts}))
