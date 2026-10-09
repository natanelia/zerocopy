"""Synthetic/read-only preparation checks. Never calls an arm, browser or run.main."""
import ast,hashlib,json,pathlib,subprocess,unittest
from unittest.mock import patch
import run,ci
HERE=pathlib.Path(__file__).resolve().parent
P=json.loads((HERE/'protocol.json').read_text())
class Preparation(unittest.TestCase):
    def test_exact_schedule(self):
        full=[s for lane in ('x64','arm64') for s in run.slots(P,lane,'run')]
        measured=[s for s in full if s['mode']=='measure'];cal=[s for s in full if s['mode']=='calibrate']
        self.assertEqual(len(measured),112);self.assertEqual(sum(s['warm'] for s in measured),80);self.assertEqual(len(cal),10)
        self.assertEqual(sum(len(run.slots(P,lane,'untimed')) for lane in ('x64','arm64')),14)
        for lane in ('x64','arm64'):
            forward=P['environmentOrders'][lane][0]
            self.assertEqual(P['environmentOrders'][lane],[forward,forward[::-1],forward[::-1],forward])
            for block in range(4):
                for runtime in forward:
                    slots=[s for s in run.slots(P,lane,'run') if s.get('block')==block and s['runtime']==runtime]
                    self.assertEqual([s['arm'] for s in slots],P['orders'][block]);self.assertEqual(sorted((s['arm'],s['replicate']) for s in slots),[('baseline',0),('baseline',1),('candidate',0),('candidate',1)])
    def test_source_ancestry_and_common_test(self):ci.verify_source_chain()
    def test_gates_unchanged(self):
        self.assertEqual(len(ci.GATES),32);self.assertEqual(len(ci.STANDARD_GATES),23);self.assertEqual(len(ci.NUMERIC_GATES),9)
        self.assertIn(['bun','run','test'],ci.GATES);self.assertNotIn('--testTimeout',str(ci.GATES))
    def test_default_off(self):
        self.assertIs(json.loads((HERE/'activation.json').read_text())['enabled'],False)
        with self.assertRaises(AssertionError):ci.require_activation()
    def test_statistics_and_scope(self):
        self.assertEqual(P['statistics']['materialLossRatio'],1.02);self.assertEqual(P['statistics']['worthwhileGainRatio'],.95)
        self.assertEqual(P['startup']['absoluteReportingMs'],.05);self.assertEqual(P['startup']['firstOperation'],'countPointsInBox')
        self.assertEqual([c['id'] for c in P['cases']],['range-auto-1','range-auto-4','range-auto-4096','range-auto-32769','spatial-auto-16384'])
        self.assertNotIn('slice(offset)',(HERE/'core.mjs').read_text());self.assertIn('fail-fast: false',(HERE.parents[1]/'.github/workflows/numeric-portability.yml').read_text())
    def test_incomplete_rows_rejected(self):
        with self.assertRaises(AssertionError):run.validate_rows([{'kind':'startup','metric':'import','durationMs':1}],{'mode':'measure','warm':False},P)
    def test_fixture_mutation_changes_digest(self):
        origin=json.loads((HERE/'origin.json').read_text())
        for arm in ('baseline','candidate'):
            self.assertEqual(len(origin['expectedOutputs'][arm]),65)
            expected=next(x for x in origin['expectedOutputs'][arm] if x['path']=='dist/numeric.js')
            self.assertEqual(expected['bytes'],4303 if arm=='baseline' else 4427)
    def test_cleanup_receipts_include_browser_group(self):
        class FakeChild:
            pid=111
            def poll(self):return 0
            def wait(self,timeout):return 0
        known={pid:{'pid':pid,'group':pid,'ppid':111,'session':pid,'startTicks':1,'state':'S'} for pid in (111,222)}
        for survivor in (False,True):
            with patch.object(run,'census',return_value=([],0)),patch.object(run.os,'killpg') as kill,patch.object(run.pathlib.Path,'iterdir',return_value=([pathlib.Path('/proc/222')] if survivor else [])),patch.object(run,'proc',return_value=known[222]):
                result=run.cleanup(FakeChild(),known,2)
                self.assertEqual(result['ownedGroups'],[111,222]);self.assertEqual(result['ownedGroupGone'],not survivor)
                self.assertEqual({c.args[0] for c in kill.call_args_list},{111,222})
                self.assertEqual(len(result['survivors']),int(survivor))
    def test_no_subject_import_during_preparation(self):
        with patch.object(run.subprocess,'Popen',side_effect=AssertionError('No subject launch allowed')):
            run.slots(P,'x64','run');ci.verify_packet()
if __name__=='__main__':unittest.main()
