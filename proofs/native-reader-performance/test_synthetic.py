"""Synthetic protocol/statistical tests only. Never import, build or run a subject."""
import sys
sys.dont_write_bytecode = True
import copy
import contextlib
import io
import json
import math
from pathlib import Path
import signal
import tempfile
import unittest
from unittest import mock

import analyze
import authentication
import controller
import specification as s


def source_bytes():
    return {'passed':True,'arenas':[{'index':index,'used':256,'capacity':65536,'sha256':s.digest({'syntheticArena':index})} for index in range(26)]}


def row_data(row, main=50.0, component=25.0, count=None, initial_version=321, retained_variant=1):
    count = s.START_COUNTS[row] if count is None else count
    result = {'valueValid':True,'validations':[{'passed':True} for _ in range(11)],'batches':[],
              'initialVersion':initial_version,'retainedVariant':retained_variant,'initialSourceBytes':source_bytes(),'finalSourceBytes':source_bytes()}
    variant, offset = (1 if row in ('P1','C8','F8') else retained_variant if row in ('N8','W8') else 0),0
    session = 1 if row == 'P8' else initial_version if row in ('N8','W8') else 0
    for index in range(10):
        end = 1-variant if row in s.COMPONENT_ROWS and count%2 == 0 else variant
        expected = s.checksum(row,count,variant,result['initialVersion'])
        batch = {'stage':'warmup' if index < 3 else 'measured','trial':None,'index':index,
            'count':count,'startVariant':variant,'endVariant':end,'elapsedMs':main,
            'beforeVariant':1-variant if row in s.COMPONENT_ROWS else variant,
            'sessionSequenceStart':session,'sessionSequenceEnd':session+(count if row in s.COMPONENT_ROWS else 0),
            **({'acceptanceMs':component,'queryMs':component} if row in s.COMPONENT_ROWS else {}),
            'checksum':expected,'expectedChecksum':expected,'validated':True,'sequenceStart':offset,'sequenceEnd':offset+count}
        batch['sequenceReceiptSHA256']=s.digest({'row':row,**{key:batch[key] for key in ('count','beforeVariant','startVariant','endVariant',
            'sequenceStart','sequenceEnd','sessionSequenceStart','sessionSequenceEnd')}})
        result['batches'].append(batch)
        session=batch['sessionSequenceEnd']
        offset += count
        if row in s.COMPONENT_ROWS:
            variant = 1-end
    return result


def cold_receipt():
    return {'initialVersion':0,'firstChangedVersion':1,'initialChecksum':19312,'firstChangedChecksum':19313,
            'firstEligibleReuse':True,'validated':True}


def synthetic_observations(ratio=.90):
    observations = []
    for group in s.SEQUENCE:
        if group['mode'] != 'measurement':
            continue
        factor = ratio if group['arm'] == 'C' else 1
        report = {'coldValueValid':True,'coldReceipt':cold_receipt(),'cold':{key:factor for key in s.COLD},
                  'coldSourceBytesBefore':source_bytes(),'coldSourceBytesAfter':source_bytes(),
                  'fixture':{'sourceByteManifest':source_bytes()['arenas']},
                  'sourceAuthenticated':False,'rows':{row:row_data(row,50*factor,25*factor) for row in s.ROWS}}
        observations.append({'group':copy.deepcopy(group),'report':report,'authenticated':True,'counts':dict(s.START_COUNTS)})
    calibration = {engine:{row:{'count':s.START_COUNTS[row],'qualified':True,'trials':1} for row in s.ROWS} for engine in s.ENGINES}
    return observations,calibration


def complete_report(mode='measurement',arm='B'):
    report={'schemaVersion':1,'status':'complete','workerCount':1,'valueValid':True,'failures':[],
            'disposed':True,'workerTerminated':True,'coldValueValid':True,'coldReceipt':cold_receipt(),
            'cold':{key:None if mode=='mechanism' else 1 for key in s.COLD},'untimed':mode=='mechanism',
            'coldSourceBytesBefore':source_bytes(),'coldSourceBytesAfter':source_bytes(),
            'rows':{},'counts':dict(s.START_COUNTS),
            'fixture':{'sourceArenaCount':26,'totalCommittedBytes':26*65536,'maxArenaCommittedBytes':65536,
                       'sourceByteManifest':source_bytes()['arenas'],'publicArenaCountsVerified':True,'sourceBytesStable':True},
            'phases':{'setupMs':0,'validationMs':0,'teardownMs':0},
            'protocol':{'realWorker':True,'workerRoute':'node:worker_threads','rowOrder':list(s.ROWS),'sequential':True,
                        'ackBeforeApplicationResponse':True,'countsVerified':True,'orderingVerified':True,'snapshotsN8':0,'rowCounts':{}}}
    responses=1
    for row in s.ROWS:
        data=row_data(row,count=(2 if row in ('N8','W8') else 1) if mode=='mechanism' else None,
                      initial_version=2 if mode=='mechanism' else 161 if mode=='calibration' else 321,
                      retained_variant=0 if mode=='mechanism' else 1)
        if mode=='mechanism':
            data['batches']=data['batches'][:1]
            for batch in data['batches']:
                batch.update(stage='mechanism',elapsedMs=None)
                if row in s.COMPONENT_ROWS: batch.update(acceptanceMs=None,queryMs=None)
            if row in ('P1','C8','F8'): data['initialNativeInstances']=1 if row=='P1' else 8
        elif mode=='calibration':
            data['batches']=data['batches'][:5]
            for index,batch in enumerate(data['batches']): batch.update(stage='warmup' if index<2 else 'pilot',trial=0)
            data['calibration']={'count':s.START_COUNTS[row],'qualified':True,'trials':1}
        report['rows'][row]=data
        if row in s.COMPONENT_ROWS:
            count=sum(b['count'] for b in data['batches']);responses+=count
            snapshots=count+(2 if row=='P8' else 1)
            report['protocol']['rowCounts'][row]={'passed':True,'snapshots':snapshots,'acks':snapshots,'lastSequence':snapshots-1,
                'copyFrames':snapshots if row=='C8' else 0,'fullMemoryFrames':snapshots if row=='F8' else 0 if row=='C8' else 1,
                'omittedKnownMemoryFrames':snapshots-1 if row in ('P8','P1') else 0}
    report['protocol']['applicationResponses']=responses
    if mode=='mechanism':
        report['mechanism']={'passed':True,'checks':{'initialP8':8,'laterP8':0 if arm=='C' else 8,
                             'laterP1':0 if arm=='C' else 1,'R8':8,'C8':8,'F8':8}}
    return report


class ScheduleTests(unittest.TestCase):
    def test_exact_schedule(self):
        self.assertEqual(len(s.SEQUENCE),80)
        self.assertEqual([sum(g['mode']==mode for g in s.SEQUENCE) for mode in ('mechanism','calibration','rehearsal','measurement')],[4,2,2,72])
        self.assertEqual([g['processOrder'] for g in s.SEQUENCE],list(range(80)))
        for block in range(1,13):
            groups = [g for g in s.SEQUENCE if g['block']==block]
            engines = ('node','bun') if block%2 else ('bun','node')
            self.assertEqual([g['engine'] for g in groups],list(engines[:1])*3+list(engines[1:])*3)
            for engine in engines:
                self.assertEqual(tuple(g['arm'] for g in groups if g['engine']==engine),s.ORDERS[(block-1)%6])

    def test_fixed_oracle_and_odd_alternation(self):
        self.assertEqual(sum((17*q)%128 for q in range(16)),1016)
        for row,expected in [('P1',[1016,101016]),('P8',[19312,19313]),('C8',[19312,19313]),('F8',[19312,147312])]:
            self.assertEqual([s.oracle_total(row,v) for v in (0,1)],expected)
            self.assertEqual(s.checksum(row,3,1),2*expected[1]+expected[0])
        self.assertEqual(s.checksum('N8',256,0,70),17920)
        self.assertEqual(s.checksum('W8',128,1),128*19313)

    def test_supervisor_copies_are_exact(self):
        for name,pinned in s.SUPERVISION_PINS.items():
            self.assertEqual(authentication.sha(Path(__file__).parent/name),pinned)

    def test_fixture_manifest_hash_is_canonical(self):
        case = authentication.read_json(Path(__file__).with_name('cases.json'))
        self.assertEqual(s.CASE_SHA256,s.digest(case))
        self.assertEqual(case['rowOrder'],list(s.ROWS))
        self.assertEqual(case['initialCounts'],s.START_COUNTS)
        self.assertEqual(case['countCaps'],s.CAP_COUNTS)
        self.assertEqual(case['queryIndexes'],[(17*q)%128 for q in range(16)])


class CalibrationTests(unittest.TestCase):
    def batches(self,row,times):
        batches, count = [],s.START_COUNTS[row]
        for trial,elapsed in enumerate(times):
            for index in range(5):
                batches.append({'stage':'warmup' if index<2 else 'pilot','trial':trial,'count':count,'elapsedMs':elapsed})
            if trial < len(times)-1:
                count = s.next_count(row,count,elapsed)
        return batches,count

    def test_target_trial_and_round_half_up(self):
        self.assertEqual(s.next_count('P8',32,64),25)
        self.assertEqual(s.next_count('P8',1,20),3)
        batches,count = self.batches('P8',[10,50])
        out = s.calibration_row('P8',batches,{'count':count,'qualified':True,'trials':2})
        self.assertEqual(out['count'],160)

    def test_control_miss_freezes_last_actually_tried(self):
        batches,count = self.batches('N8',[10,10,10])
        out = s.calibration_row('N8',batches,{'count':count,'qualified':False,'trials':3})
        self.assertEqual(out['count'],6400)
        with self.assertRaisesRegex(ValueError,'declaration'):
            s.calibration_row('N8',batches,{'count':32000,'qualified':False,'trials':3})

    def test_no_candidate_adaptation_or_extra_trials(self):
        batches,count = self.batches('P8',[50,50])
        with self.assertRaisesRegex(ValueError,'continued'):
            s.calibration_row('P8',batches,{'count':count,'qualified':True,'trials':2})
        for invalid in (0,-1,float('nan'),float('inf')):
            with self.assertRaises(ValueError):
                s.next_count('P8',32,invalid)

    def test_feasibility_is_whole_rehearsal_not_batch_sum(self):
        self.assertEqual(controller.feasibility(750,5,5)['requiredSeconds'],750)
        self.assertTrue(controller.feasibility(750,5,5)['admitted'])
        self.assertFalse(controller.feasibility(749.99,5,5)['admitted'])
        with self.assertRaises(ValueError):
            controller.feasibility(100,0,1)


class QualityTests(unittest.TestCase):
    def test_floor_per_batch_not_sum(self):
        batches = row_data('P8',main=5)['batches'][3:]
        self.assertFalse(analyze.batch_quality(batches)['qualified'])
        self.assertGreater(sum(b['elapsedMs'] for b in batches),20)

    def test_component_floor_independent(self):
        batches = row_data('P8',main=50,component=5)['batches'][3:]
        self.assertTrue(analyze.batch_quality(batches)['qualified'])
        self.assertFalse(analyze.batch_quality(batches,'acceptanceMs')['qualified'])

    def test_floor_exact_boundary(self):
        self.assertTrue(analyze.batch_quality(row_data('P8',main=20)['batches'][3:])['qualified'])

    def test_drift_and_sample_cv(self):
        batches = row_data('P8')['batches'][3:]
        for b,value in zip(batches,[40,40,40,50,60,60,60]): b['elapsedMs']=value
        quality = analyze.batch_quality(batches)
        self.assertFalse(quality['qualified'])
        self.assertEqual(quality['lastThreeFirstThree'],1.5)

    def test_cold_no_20_ms_floor(self):
        self.assertTrue(analyze.cold_quality([.001]*12)['qualified'])
        self.assertFalse(analyze.cold_quality([1]*6+[1.2]*6)['qualified'])
        self.assertFalse(analyze.cold_quality([1]*11+[float('nan')])['qualified'])

    def test_t_interval_uses_12_blocks(self):
        out = analyze.paired_interval([.9]*12,[1]*12)
        self.assertEqual(out['n'],12)
        self.assertAlmostEqual(out['lower'],.9)
        self.assertAlmostEqual(out['upper'],.9)
        with self.assertRaises(ValueError): analyze.paired_interval([.9]*84,[1]*84)
        logs = [.01*i for i in range(12)]
        out = analyze.paired_interval([math.exp(v) for v in logs],[1]*12)
        self.assertAlmostEqual(out['meanLogRatio'],.055)
        self.assertAlmostEqual(out['logUpper']-.055,s.T_CRITICAL*math.sqrt(.0013)/math.sqrt(12))


class DecisionTests(unittest.TestCase):
    def test_scoped_same_primary_both_engines(self):
        obs,cal = synthetic_observations()
        result = analyze.analyze(obs,cal,True)
        self.assertTrue(result['screenComplete'])
        self.assertEqual(result['decision'],'promising-scoped-lead')
        self.assertEqual(result['qualifiedPrimaryRows'],['P1','P8'])
        self.assertFalse(result['performanceClaimAuthorized'])

    def test_different_primary_wins_do_not_combine(self):
        obs,cal = synthetic_observations(1)
        for observation in obs:
            g = observation['group']
            if g['arm']=='C':
                row='P1' if g['engine']=='node' else 'P8'
                observation['report']['rows'][row]=row_data(row,45)
        self.assertEqual(analyze.analyze(obs,cal,True)['decision'],'no-lead')

    def test_n8_aa_bias_blocks_both_primaries(self):
        obs,cal = synthetic_observations()
        for o in obs:
            if o['group']['arm']=='A' and o['group']['engine']=='node':
                o['report']['rows']['N8']=row_data('N8',53)
        result=analyze.analyze(obs,cal,True)
        self.assertEqual(result['decision'],'no-lead')
        self.assertTrue(result['endpoints']['node']['P8.elapsedMs']['n8BaselineBias'])

    def test_adverse_short_component_vetoes(self):
        obs,cal = synthetic_observations()
        for o in obs:
            for b in o['report']['rows']['C8']['batches']:
                b['queryMs']=1.1 if o['group']['arm']=='C' else 1
        result=analyze.analyze(obs,cal,True)
        endpoint=result['endpoints']['node']['C8.queryMs']
        self.assertEqual(result['decision'],'veto-unchanged-candidate')
        self.assertFalse(endpoint['qualityQualified'])
        self.assertTrue(endpoint['veto'])

    def test_adverse_survives_unrelated_incomplete_endpoint(self):
        obs,cal=synthetic_observations()
        for o in obs:
            if o['group']['arm']=='C' and o['group']['engine']=='node':
                o['report']['cold']['workerImportMs']=1.1
        del obs[0]['report']['rows']['F8']
        result=analyze.analyze(obs,cal,False)
        self.assertTrue(result['incompleteWithAdverseEvidence'])
        self.assertIn({'engine':'node','endpoint':'cold.workerImportMs'},result['adverseVetoes'])

    def test_adverse_survives_missing_or_nonfinite_auxiliary_a(self):
        for unavailable in (None,float('nan'),float('inf')):
            with self.subTest(unavailable=unavailable):
                obs,cal=synthetic_observations(1)
                for o in obs:
                    if o['group']['engine']=='node' and o['group']['arm']=='C':
                        o['report']['rows']['C8']=row_data('C8',60)
                before=analyze.analyze(obs,cal,True)['endpoints']['node']['C8.elapsedMs']['candidateBaseline']
                auxiliary=next(o for o in obs if o['group']['engine']=='node' and o['group']['arm']=='A')
                auxiliary['report']['rows']['C8']['batches'][3]['elapsedMs']=unavailable
                result=analyze.analyze(obs,cal,True)
                endpoint=result['endpoints']['node']['C8.elapsedMs']
                self.assertEqual(endpoint['candidateBaseline'],before)
                self.assertAlmostEqual(endpoint['candidateBaseline']['lower'],1.2)
                self.assertTrue(endpoint['candidateBaselineSourceValueValidFullSample'])
                self.assertFalse(endpoint['sourceValueValidFullSample'])
                self.assertEqual(endpoint['status'],'adverse-veto')
                self.assertEqual(result['decision'],'veto-unchanged-candidate')
                self.assertTrue(result['incompleteWithAdverseEvidence'])
                self.assertFalse(result['screenComplete'])
                self.assertEqual(result['qualifiedPrimaryRows'],[])

    def test_adverse_cold_survives_unauthenticated_auxiliary_a(self):
        obs,cal=synthetic_observations(1)
        for o in obs:
            if o['group']['engine']=='node' and o['group']['arm']=='C':
                o['report']['cold']['workerImportMs']=1.2
        auxiliary=next(o for o in obs if o['group']['engine']=='node' and o['group']['arm']=='A')
        auxiliary['authenticated']=False
        result=analyze.analyze(obs,cal,True)
        endpoint=result['endpoints']['node']['cold.workerImportMs']
        self.assertAlmostEqual(endpoint['candidateBaseline']['lower'],1.2)
        self.assertTrue(endpoint['veto'])
        self.assertFalse(endpoint['sourceValueValidFullSample'])
        self.assertTrue(result['incompleteWithAdverseEvidence'])

    def test_missing_auxiliary_process_prevents_favorable_clearance(self):
        obs,cal=synthetic_observations(.9)
        auxiliary=next(o for o in obs if o['group']['engine']=='node' and o['group']['arm']=='A')
        obs.remove(auxiliary)
        result=analyze.analyze(obs,cal,True)
        endpoint=result['endpoints']['node']['P8.elapsedMs']
        self.assertAlmostEqual(endpoint['candidateBaseline']['upper'],.9)
        self.assertTrue(endpoint['candidateBaselineSourceValueValidFullSample'])
        self.assertFalse(endpoint['sourceValueValidFullSample'])
        self.assertFalse(endpoint['promisingWithinEngine'])
        self.assertEqual(endpoint['status'],'unresolved')
        self.assertFalse(result['screenComplete'])
        self.assertEqual(result['decision'],'no-lead')
        self.assertEqual(result['qualifiedPrimaryRows'],[])

    def test_missing_candidate_or_baseline_never_establishes_adverse_interval(self):
        for arm in ('B','C'):
            with self.subTest(arm=arm):
                obs,cal=synthetic_observations(1.2)
                subject=next(o for o in obs if o['group']['engine']=='node' and o['group']['arm']==arm)
                subject['report']['rows']['C8']['batches'][3]['elapsedMs']=None
                result=analyze.analyze(obs,cal,True)
                endpoint=result['endpoints']['node']['C8.elapsedMs']
                self.assertFalse(endpoint['candidateBaselineSourceValueValidFullSample'])
                self.assertNotIn('candidateBaseline',endpoint)
                self.assertFalse(endpoint['veto'])
                self.assertFalse(result['screenComplete'])

    def test_wrong_value_cannot_establish_latency(self):
        obs,cal=synthetic_observations(1.1)
        for o in obs:
            o['report']['rows']['P8']['batches'][4]['checksum'] += 1
        result=analyze.analyze(obs,cal,True)
        endpoint=result['endpoints']['node']['P8.elapsedMs']
        self.assertFalse(endpoint['sourceValueValidFullSample'])
        self.assertFalse(endpoint['veto'])

    def test_driver_authentication_echo_is_not_authority(self):
        obs,cal=synthetic_observations()
        obs[0]['authenticated']=False
        obs[0]['report']['sourceAuthenticated']=True
        result=analyze.analyze(obs,cal,True)
        self.assertFalse(result['screenComplete'])
        self.assertEqual(result['decision'],'no-lead')

    def test_duplicate_or_relabelled_process_rejected(self):
        obs,cal=synthetic_observations()
        result=analyze.analyze(obs+[obs[0]],cal,True)
        self.assertFalse(result['screenComplete'])
        obs[0]['group']['processOrder']+=1
        self.assertFalse(analyze.analyze(obs,cal,True)['screenComplete'])

    def test_control_calibration_miss_unresolved_not_dropped(self):
        obs,cal=synthetic_observations()
        cal['node']['R8']['qualified']=False
        result=analyze.analyze(obs,cal,True)
        self.assertEqual(result['endpoints']['node']['R8.elapsedMs']['status'],'unresolved')
        self.assertTrue(result['screenComplete'])
        self.assertEqual(result['decision'],'promising-scoped-lead')

    def test_quality_failure_never_removes_observation(self):
        obs,cal=synthetic_observations()
        obs[0]['report']['rows']['P8']['batches'][3]['elapsedMs']=10
        result=analyze.analyze(obs,cal,True)
        endpoint=result['endpoints']['node']['P8.elapsedMs']
        self.assertEqual(len(endpoint['valuesByArmInBlockOrder']['B']),12)
        self.assertFalse(endpoint['qualityQualified'])
        self.assertFalse(endpoint['promisingWithinEngine'])


class EvidenceTests(unittest.TestCase):
    def transport_fixture(self, root):
        def write(name,value):
            path=root/name
            path.write_text(json.dumps(value,sort_keys=True))
            return path,authentication.sha(path)
        archive,archive_sha=write('ready-inputs.tar',{'synthetic':'archive bytes only; never extracted'})
        inventory,inventory_sha=write('ready-inventory.json',{'synthetic.txt':{'sha256':'1'*64,'mode':420}})
        method,method_sha=write('transport-method.json',{'wholeCapSeconds':180,'synthetic':True})
        preparation={'readyInputArchiveSHA256':archive_sha,'readyInputInventorySHA256':inventory_sha}
        preparation_path,preparation_sha=write('preparation.json',preparation)
        raw=root/'raw';raw.mkdir()
        (raw/'custody.json').write_text(json.dumps({'synthetic':True,'preparationReceiptSHA256':preparation_sha}))
        (raw/'raw-evidence-seal.json').write_text(json.dumps(authentication.inventory(raw)))
        receipt={'schemaVersion':1,'kind':'native-reader-performance-transport','status':'complete','bounded':True,
                 'noRebuild':True,'noTargetImports':True,'extractionVerified':True,'ownedGroupsEmpty':True,
                 'preparationReceiptSHA256':preparation_sha,**preparation,'reviewedTransportMethodSHA256':method_sha,
                 'elapsedSeconds':12,'wholeCapSeconds':180,'rawEvidenceSealSHA256':authentication.sha(raw/'raw-evidence-seal.json')}
        receipt_path,receipt_sha=write('transport.json',receipt)
        review={**preparation,'reviewedTransportMethodSHA256':method_sha,'checks':{'boundedTransportReviewed':True}}
        manifest={'preparationReceiptPath':str(preparation_path),'preparationReceiptSHA256':preparation_sha,
                  'transportReceiptPath':str(receipt_path),'transportReceiptSHA256':receipt_sha,'transportMethodPath':str(method),
                  'readyInputArchivePath':str(archive),'readyInputInventoryPath':str(inventory),'transportEvidenceRoot':str(raw)}
        return manifest,preparation,review,receipt

    def test_transport_preserves_preparation_without_future_receipt_prereview(self):
        with tempfile.TemporaryDirectory() as d:
            manifest,preparation,review,receipt=self.transport_fixture(Path(d))
            result=authentication.authenticate_transport(manifest,preparation,review)
            self.assertEqual(result['receipt'],receipt)
            self.assertEqual(authentication.sha(manifest['preparationReceiptPath']),manifest['preparationReceiptSHA256'])
            self.assertNotIn('transportReceiptSHA256',review)

    def test_transport_contract_rejects_cost_custody_and_recipe_changes(self):
        with tempfile.TemporaryDirectory() as d:
            manifest,preparation,review,receipt=self.transport_fixture(Path(d))
            mutations=[('elapsedSeconds',value) for value in (0,-1,181,float('nan'),float('inf'),True)]
            mutations += [(name,False) for name in ('bounded','noRebuild','noTargetImports','extractionVerified','ownedGroupsEmpty')]
            mutations += [(name,'0'*64) for name in ('preparationReceiptSHA256','readyInputArchiveSHA256',
                                                   'readyInputInventorySHA256','reviewedTransportMethodSHA256')]
            mutations += [('wholeCapSeconds',181),('rawEvidenceSealSHA256',None),('status','incomplete')]
            for field,value in mutations:
                with self.subTest(field=field,value=value):
                    changed={**receipt,field:value}
                    with self.assertRaises(ValueError):
                        authentication.validate_transport_contract(changed,preparation,review,{'wholeCapSeconds':180},manifest['preparationReceiptSHA256'])
            with self.assertRaisesRegex(ValueError,'review absent'):
                authentication.validate_transport_contract(receipt,preparation,{**review,'checks':{}},{'wholeCapSeconds':180},manifest['preparationReceiptSHA256'])

    def test_transport_rejects_altered_archive_inventory_recipe_or_raw_evidence(self):
        for field in ('readyInputArchivePath','readyInputInventoryPath','transportMethodPath','transportReceiptPath','transportEvidenceRoot'):
            with self.subTest(field=field),tempfile.TemporaryDirectory() as d:
                manifest,preparation,review,receipt=self.transport_fixture(Path(d))
                path=Path(manifest[field])
                if field=='transportEvidenceRoot': path=path/'custody.json'
                path.write_text('{}')
                with self.assertRaises(ValueError):
                    authentication.authenticate_transport(manifest,preparation,review)

    def test_complete_protocol_reports(self):
        for mode in ('mechanism','calibration','rehearsal','measurement'):
            group=next(g for g in s.SEQUENCE if g['mode']==mode)
            analyze.validate_report(complete_report(mode),group,s.START_COUNTS)

    def test_mechanism_cannot_contain_timing(self):
        report=complete_report('mechanism');report['cold']['workerImportMs']=1
        with self.assertRaisesRegex(ValueError,'untimed'):
            analyze.validate_report(report,s.SEQUENCE[0])

    def test_sequence_receipt_and_source_bytes_checked(self):
        row=row_data('P8');row['batches'][3]['sequenceReceiptSHA256']='0'*64
        with self.assertRaisesRegex(ValueError,'receipt hash'):
            analyze.validate_row('P8',row,'measurement',s.START_COUNTS)
        row=row_data('P8');row['finalSourceBytes']['arenas'][0]['sha256']='1'*64
        with self.assertRaisesRegex(ValueError,'source bytes'):
            analyze.validate_row('P8',row,'measurement',s.START_COUNTS)

    def test_per_row_protocol_counts_independent(self):
        report=complete_report();report['protocol']['rowCounts']['P8']['acks']-=1
        group=next(g for g in s.SEQUENCE if g['mode']=='measurement')
        with self.assertRaisesRegex(ValueError,'snapshot/ack'):
            analyze.validate_report(report,group,s.START_COUNTS)

    def test_json_duplicate_nonfinite_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'input.json'
            for text in ('{"x":1,"x":2}','{"x":NaN}'):
                p.write_text(text)
                with self.assertRaises(ValueError): authentication.read_json(p)

    def test_tree_extra_file_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'raw.json').write_text('{}')
            seal={'schemaVersion':1,'methodSHA256':s.METHOD_SHA256,'files':authentication.inventory(root)}
            (root/'FINAL-SEAL.json').write_text(json.dumps(seal))
            pin=authentication.sha(root/'FINAL-SEAL.json')
            authentication.verify_final_seal(root,pin)
            (root/'extra').write_text('extra')
            with self.assertRaisesRegex(ValueError,'mismatch'): authentication.verify_final_seal(root,pin)
            (root/'alias').symlink_to(root/'raw.json')
            with self.assertRaisesRegex(ValueError,'symlink'): authentication.inventory(root)

    def test_external_digest_required(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'approval.json';p.write_text('{"authorized":true}')
            with self.assertRaises(ValueError): authentication.verified_json(p,'0'*64)
            with self.assertRaises(ValueError): authentication.verified_json(p,None)

    def test_failed_correctness_cannot_be_approved_by_audit_flag(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'status.json').write_text('{"status":"incomplete"}')
            audit={'schemaVersion':1,'kind':'native-reader-terminal-correctness-audit','disposition':'successful-terminal-correctness',
                   'independent':True,'baselineCommit':s.BASELINE_COMMIT,'candidateDiffSHA256':s.CANDIDATE_DIFF_SHA256,
                   'candidateSources':s.CANDIDATE_SOURCES,'evidenceSealSHA256':'0'*64}
            with mock.patch.object(authentication,'verify_tree_seal',return_value={}):
                with self.assertRaisesRegex(ValueError,'did not complete'):
                    authentication._terminal_correctness(root,audit)

    def test_missing_prerequisite_launches_nothing_and_seals_failure(self):
        handlers={number:signal.getsignal(number) for number in (signal.SIGINT,signal.SIGTERM,signal.SIGALRM)}
        try:
            with tempfile.TemporaryDirectory() as d:
                root=Path(d);out=root/'evidence'
                with (mock.patch.object(controller,'authenticate',side_effect=ValueError('missing approved correctness')),
                     mock.patch.object(controller.Supervisor,'run',side_effect=AssertionError('TARGET MUST NOT LAUNCH')) as launch,
                     contextlib.redirect_stdout(io.StringIO()) as captured):
                    code=controller.main(['--binding',str(root/'absent.json'),'--binding-sha256','0'*64,
                        '--approval',str(root/'absent-approval.json'),'--approval-sha256','1'*64,'--output',str(out)])
                self.assertEqual(code,1);launch.assert_not_called()
                status=authentication.read_json(out/'status.json')
                self.assertEqual(status['groupsStarted'],0)
                self.assertEqual(status['status'],'incomplete')
                terminal=json.loads(captured.getvalue())
                self.assertTrue(terminal['finalSealVerified'])
                authentication.verify_final_seal(out,terminal['finalSealSHA256'])
        finally:
            for number,handler in handlers.items(): signal.signal(number,handler)


if __name__ == '__main__':
    unittest.main(verbosity=2)
