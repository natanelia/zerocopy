"""Focused B2 counterexamples, complete artificial positives, no subjects/clocks."""
import copy,json,pathlib,unittest
import evidence as e
import synthetic_fixture as f
P=e.P
class Evidence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.slot=next(s for s in e.schedule('arm64','run') if s['mode']=='measure');cls.config=f.make_config(cls.slot,'arm64');cls.rows=f.make_raw(cls.slot,cls.config)
    def validate(self,rows,config=None,slot=None):return e.validate_raw(rows,slot or self.slot,config or self.config,work=(config or self.config).get('work'))
    def reject(self,mutator):
        rows=copy.deepcopy(self.rows);mutator(rows)
        with self.assertRaises((e.InvalidEvidence,KeyError,TypeError,ValueError)):self.validate(rows)
    def test_complete_positive_and_startup_separation(self):
        result=self.validate(self.rows);self.assertEqual(len(result['warm']),5);self.assertTrue(all(v['flags']==[] for v in result['warm'].values()));self.assertTrue(all(0<v<5 for v in result['startup'].values()))
    def test_required_startup_identity_and_memory(self):
        for key,value in [('count',0),('firstOperation','countInRange'),('endToEndApplicationStartup',True)]:
            with self.subTest(key=key):self.reject(lambda rows:next(r for r in rows if r['kind']=='startup-validation').__setitem__(key,value))
        self.reject(lambda rows:next(r for r in rows if r['kind']=='startup-validation')['after'].__setitem__('used',1))
        self.reject(lambda rows:next(r for r in rows if r['kind']=='startup-validation')['after'].__setitem__('root',False))
        for key,value in [('runtime','bun'),('lane','x64'),('mode','untimed'),('operationClocks',False)]:
            with self.subTest(key=key):self.reject(lambda rows:next(r for r in rows if r['kind']=='start').__setitem__(key,value))
    def test_startup_set_types_and_sum(self):
        self.reject(lambda rows:rows.pop(0));self.reject(lambda rows:rows.insert(0,copy.deepcopy(rows[0])))
        for value in [None,True,0,-1,float('nan'),float('inf')]:
            with self.subTest(value=value):self.reject(lambda rows:rows[0].__setitem__('durationMs',value))
        self.reject(lambda rows:next(r for r in rows if r.get('metric')=='sum').__setitem__('durationMs',99))
    def test_exact_work_sample_phase_counts_and_oracle(self):
        for key,value in [('operations',1),('sample',True),('sample',99),('phase','measurement'),('chunk',True),('queryCounts',[0]*4),('checksum',0),('lastResult',True),('valuesPerCall',True),('treeSize',False),('tailSize',True),('nsPerOperation',99)]:
            with self.subTest(key=key,value=value):self.reject(lambda rows:next(r for r in rows if r['kind']=='chunk').__setitem__(key,value))
        self.reject(lambda rows:rows.pop(next(i for i,r in enumerate(rows) if r['kind']=='chunk')))
        self.reject(lambda rows:next(r for r in rows if r['kind']=='case-start').__setitem__('inputDigest','0'*64))
        self.reject(lambda rows:next(r for r in rows if r['kind']=='case-complete').__setitem__('chunks',7))
        self.reject(lambda rows:next(r for r in rows if r['kind']=='complete').__setitem__('chunks',0))
    def test_diagnostics_recomputed_not_missing_false(self):
        self.reject(lambda rows:next(r for r in rows if r['kind']=='diagnostics').pop('warmupFlag'))
        self.reject(lambda rows:next(r for r in rows if r['kind']=='diagnostics').__setitem__('minimumDurationFloor',True))
        def subfloor(rows):
            for r in rows:
                if r['kind']=='chunk' and r['phase']=='measurement':r['durationMs']=1;r['nsPerOperation']=1e6/r['operations']
        self.reject(subfloor)
        rows=copy.deepcopy(self.rows);subfloor(rows)
        for spec in P['cases']:
            warm=[r['durationMs'] for r in rows if r['kind']=='chunk' and r['case']==spec['id'] and r['phase']=='warmup'];measured=[r for r in rows if r['kind']=='chunk' and r['case']==spec['id'] and r['phase']=='measurement']
            row=next(r for r in rows if r['kind']=='diagnostics' and r['case']==spec['id']);row.update(e.diagnostic(warm,measured,self.config['work'][spec['id']]))
        result=self.validate(rows);self.assertTrue(all('minimumDurationFloor' in v['flags'] for v in result['warm'].values()))
    def test_calibration_complete_and_common_work(self):
        arms={}
        for arm in ['baseline','candidate']:
            slot=next(s for s in e.schedule('arm64','run') if s['mode']=='calibrate' and s['runtime']=='node' and s['arm']==arm);config=f.make_config(slot,'arm64');rows=f.make_raw(slot,config);arms[arm]=e.validate_raw(rows,slot,config)
            bad=copy.deepcopy(rows);next(r for r in bad if r['kind']=='calibration-diagnostics')['insufficientWarmup']=True
            with self.assertRaises(e.InvalidEvidence):e.validate_raw(bad,slot,config)
        work=e.derive_work(arms);self.assertEqual(work,f.default_work());self.assertTrue(all(v['targetMet'] for v in work.values()))
        config=copy.deepcopy(self.config);config['work'][P['cases'][0]['id']]['operations']=P['cases'][0]['ladder'][1]
        with self.assertRaises(e.InvalidEvidence):e.validate_raw(self.rows,self.slot,config,work=work)
        with self.assertRaises((e.InvalidEvidence,KeyError)):e.derive_work({'baseline':arms['baseline']})
    def test_resources_memory_and_terminal(self):
        self.reject(lambda rows:next(r for r in rows if r['kind']=='chunk-validation')['after'].__setitem__('memoryDigest','0'*64))
        self.reject(lambda rows:next(r for r in rows if r['kind']=='chunk-validation').__setitem__('chunk',False))
        self.reject(lambda rows:next(r for r in rows if r['kind']=='chunk-validation')['afterValidation'].__setitem__('rss',0))
        self.reject(lambda rows:rows.pop());self.reject(lambda rows:rows[-1].__setitem__('version','v0'))
    def test_semantics_requires_raw_corpus_and_worker_observations(self):
        slot=e.schedule('x64','semantics')[0];config=f.make_config(slot,'x64');rows=f.make_raw(slot,config);self.assertEqual(e.validate_raw(rows,slot,config)['semanticChecks'],2782)
        for kind in ['kernel-semantic','worker-semantic']:
            bad=[r for r in rows if r['kind']!=kind]
            with self.assertRaises(e.InvalidEvidence):e.validate_raw(bad,slot,config)
        bad=copy.deepcopy(rows);next(r for r in bad if r['kind']=='kernel-semantic')['actualCounts'][0]+=1
        with self.assertRaises(e.InvalidEvidence):e.validate_raw(bad,slot,config)
        bad=copy.deepcopy(rows);next(r for r in bad if r['kind']=='worker-semantic')['during']['after'][0]['values'][0]=99
        with self.assertRaises(e.InvalidEvidence):e.validate_raw(bad,slot,config)
        bad=copy.deepcopy(rows);next(r for r in bad if r['kind']=='worker-semantic')['ownerCounts'][1]=True
        with self.assertRaises(e.InvalidEvidence):e.validate_raw(bad,slot,config)
        bad=copy.deepcopy(rows);next(r for r in bad if r['kind']=='worker-semantic')['ready']['probes']=True
        with self.assertRaises(e.InvalidEvidence):e.validate_raw(bad,slot,config)
    def test_retained_review_malformed_rows_rejected(self):
        directory=pathlib.Path('/workspace/shared/zerocopy-numeric-portability-review-20261009/statistics/synthetic-invalid-rows/run')
        if not directory.exists():self.skipTest('Original independent counterexamples are local retained evidence')
        files=list(directory.glob('*.stdout.jsonl'));self.assertEqual(len(files),32)
        by_id={s['id']:s for s in e.schedule('arm64','run')}
        for file in files:
            identifier=file.name.removesuffix('.stdout.jsonl');slot=by_id[identifier];config=f.make_config(slot,'arm64');rows=[json.loads(line) for line in file.read_text().splitlines()]
            with self.subTest(slot=identifier),self.assertRaises((e.InvalidEvidence,KeyError,TypeError)):e.validate_raw(rows,slot,config,work=config.get('work'))
if __name__=='__main__':unittest.main()
