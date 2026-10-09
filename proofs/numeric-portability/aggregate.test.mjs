// Final report identities/decisions and retained attack probes; no runtime subjects.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {analyzeLane} from './report.mjs';
import {aggregate,verifyAnalysis,expectedCellIds} from './aggregate.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),protocol=JSON.parse(readFileSync(path.join(here,'protocol.json')));
const generator=String.raw`
import json,sys
sys.path.insert(0,sys.argv[1])
import evidence as e
from synthetic_fixture import make_config,make_raw
results={}
for lane in ('x64','arm64'):
    slots=[];calibration={};works={}
    for slot in e.schedule(lane,'run'):
        work=None
        if slot['mode']=='measure' and slot['warm']:
            if slot['runtime'] not in works: works[slot['runtime']]=e.derive_work(calibration[slot['runtime']])
            work=works[slot['runtime']]
        config=make_config(slot,lane,work=work)
        result=e.validate_raw(make_raw(slot,config,work=work),slot,config,work=work)
        if slot['mode']=='calibrate':calibration.setdefault(slot['runtime'],{})[slot['arm']]=result
        slots.append({**slot,'evidence':result})
    run={'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40,'GITHUB_WORKFLOW_SHA':'a'*40,'GITHUB_REPOSITORY':'natanelia/zerocopy','GITHUB_REF':'refs/heads/proof/numeric-portability-20261009'}
    results[lane]={'lane':lane,'manifest':{'origin':json.load(open(sys.argv[1]+'/origin.json'))},'run':run,'packetSha256':'b'*64,'manifestSha256':'c'*64,'slots':slots}
print(json.dumps(results))
`;
const check=spawnSync('python3',['-c',generator,here],{encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
assert.equal(check.status,0,check.stderr);
const canonical=JSON.parse(check.stdout),reports={};
for(const lane of ['x64','arm64']){
  reports[lane]=JSON.parse(JSON.stringify(analyzeLane(canonical[lane],protocol)));
  assert.deepEqual(verifyAnalysis(reports[lane],canonical[lane],protocol),reports[lane]);
  assert.equal(new Set(expectedCellIds(lane)).size,lane==='x64'?30:16);
}
const good=aggregate('/synthetic',(_base,lane)=>verifyAnalysis(reports[lane],canonical[lane],protocol));
assert.equal(good.wholeStudyAdmitted,true);assert.equal(good.cells.length,46);assert.equal(good.supportedLosses.length,21);
assert(good.cells.filter(c=>c.kind==='startup').every(c=>c.absoluteDifference.highMs<.05&&c.decision==='material loss supported in this cell'));
let rejected=0;
for(const mutation of [
  r=>{r.cells[1]=structuredClone(r.cells[0]);},
  r=>{r.cells.reverse();},
  r=>{r.cells[0].runtime='forged-runtime';},
  r=>{r.cells[0].metric='forged-metric';},
  r=>{r.cells[0].provisionalLaneDecision='worthwhile gain supported in this cell';},
  r=>{r.cells[0].pointwise95PercentInterval.low=.1;},
  r=>{r.cells[0].subjects=[];},
  r=>{r.cells[0].flags=['forged'];},
  r=>{r.run.GITHUB_RUN_ID='';},
  r=>{delete r.origin;},
  r=>{delete r.packetSha256;},
  r=>{r.laneComplete=false;},
  r=>{r.cells=[];},
]){
  const forged=structuredClone(reports.arm64);mutation(forged);
  assert.throws(()=>verifyAnalysis(forged,canonical.arm64,protocol));
  const result=aggregate('/synthetic',(_base,lane)=>verifyAnalysis(lane==='arm64'?forged:reports[lane],canonical[lane],protocol));
  assert.equal(result.wholeStudyAdmitted,false);assert.deepEqual(result.cells,[]);assert.deepEqual(result.supportedLosses,[]);rejected++;
}
const out=mkdtempSync(path.join(os.tmpdir(),'numeric-final-reject-'));
try{
  for(const name of ['synthetic-empty-ledgers','synthetic-duplicate-cells']){
    const target=path.join('/workspace/shared/zerocopy-numeric-portability-review-20261009/statistics',name);
    // Reject the retained report itself against valid canonical evidence too,
    // independently of the CLI's inactive/current-run trust-anchor rejection.
    for(const lane of ['x64','arm64']){
      const stored=JSON.parse(readFileSync(path.join(target,'numeric-portability-'+lane,'lane-analysis.json')));
      assert.throws(()=>verifyAnalysis(stored,canonical[lane],protocol));
    }
    const result=spawnSync(process.execPath,[path.join(here,'aggregate.mjs'),target,path.join(out,name+'.json')],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    assert.equal(result.status,1,result.stderr);
    const saved=JSON.parse(readFileSync(path.join(out,name+'.json')));
    assert.equal(saved.wholeStudyAdmitted,false);assert.deepEqual(saved.cells,[]);assert.deepEqual(saved.supportedLosses,[]);
  }
}finally{rmSync(out,{recursive:true,force:true});}
console.log(JSON.stringify({syntheticOnly:true,admittedCells:46,supportedTinyStartupLosses:21,forgedReportsRejected:rejected,retainedReportsRejectedDirectly:4,retainedExploitsRejected:2,librarySubjectsExecuted:false,browserEnginesLaunched:false,realOperationClocksRead:false}));
