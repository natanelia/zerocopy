// Read-only final admission. Recompute every cell from admitted original evidence.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {analyzeLane} from './report.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const p=JSON.parse(readFileSync(path.join(here,'protocol.json')));

export function expectedCellIds(lane,protocol=p){
  assert(['x64','arm64'].includes(lane));
  return protocol.environmentOrders[lane][0].flatMap(runtime=>[
    ...protocol.startup.metrics.map(metric=>[lane,runtime,metric].join('/')),
    ...(protocol.warmRuntimes[lane].includes(runtime)?protocol.cases.map(spec=>[lane,runtime,spec.id].join('/')):[]),
  ]);
}

export function verifyAnalysis(stored,canonical,protocol=p){
  const lane=canonical.lane;
  assert.equal(stored?.lane,lane,'Stored report lane differs from admitted lane');
  assert.equal(stored?.laneComplete,true,'Stored report is incomplete');
  assert(Array.isArray(stored?.cells),'Report cell array missing');
  const ids=stored.cells.map(cell=>[cell.lane,cell.runtime,cell.metric].join('/'));
  assert.deepEqual(ids,expectedCellIds(lane,protocol),'Exact unique ordered cell identities required');
  assert.equal(new Set(ids).size,ids.length,'Duplicate report cell');
  const recomputed=analyzeLane(canonical,protocol);
  assert.deepEqual(stored,recomputed,'Saved analysis differs from independently recomputed admitted evidence');
  return recomputed;
}

export function admitLane(base,lane){
  const result=spawnSync('python3',[path.join(here,'artifact_admission.py'),'archived',base,lane],{
    encoding:'utf8',maxBuffer:128*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},
  });
  let receipt;
  try{receipt=JSON.parse(result.stdout||'{}');}catch{throw Error('Invalid artifact admission result');}
  assert.equal(result.status,0,receipt.error||result.error?.message||'Artifact admission process failed');
  assert.equal(receipt.admitted,true,'Artifact graph was not admitted');
  return verifyAnalysis(JSON.parse(readFileSync(path.join(base,'lane-analysis.json'))),receipt.canonical);
}

export function aggregate(directory,admit=admitLane){
  const lanes={},problems=[];
  for(const lane of ['x64','arm64']){
    try{lanes[lane]=admit(path.join(directory,'numeric-portability-'+lane),lane);}
    catch(error){problems.push({lane,error:String(error)});}
  }
  if(!problems.length){
    try{
      for(const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_WORKFLOW_SHA','GITHUB_REPOSITORY','GITHUB_REF']){
        assert.equal(typeof lanes.x64.run?.[key],'string');assert(lanes.x64.run[key].trim());
        assert.equal(lanes.x64.run[key],lanes.arm64.run?.[key]);
      }
      assert.equal(lanes.x64.run.GITHUB_RUN_ATTEMPT,'1');
      assert.deepEqual(lanes.x64.origin,lanes.arm64.origin);
      assert.equal(lanes.x64.packetSha256,lanes.arm64.packetSha256);
      assert.match(lanes.x64.packetSha256,/^[0-9a-f]{64}$/);
    }catch(error){problems.push({scope:'cross-lane identity',error:String(error)});}
  }
  const admitted=problems.length===0;
  // Invalid artifacts never supply cells or classifications to the final report.
  const cells=admitted?Object.values(lanes).flatMap(l=>l.cells).map(cell=>({...cell,decision:cell.provisionalLaneDecision})):[];
  const losses=cells.filter(c=>c.decision==='material loss supported in this cell');
  return {wholeStudyAdmitted:admitted,promotionAllowed:false,problems,cells,
    disposition:!admitted?'incomplete; preserve original partial evidence':losses.length?'do not advance fixed patch: supported relative loss':'bounded startup/portability result; retain every inconclusive cell and prior unresolved x64 warm control',
    supportedLosses:losses.map(c=>({lane:c.lane,runtime:c.runtime,metric:c.metric})),
    oldEvidence:'https://github.com/natanelia/zerocopy/actions/runs/37952544553',oldRunPooled:false,
    earlierInconclusiveWarmCellsRemainUnresolved:true,rangeFirstUnmeasured:true,
    absoluteStartupReportingScaleMs:0.05,absoluteScaleCannotWaiveRelativeLoss:true};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [directory,output]=process.argv.slice(2);
  assert(directory&&output,'Artifact directory and output are required');
  const result=aggregate(directory);
  writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({admitted:result.wholeStudyAdmitted,cells:result.cells.length,problems:result.problems,supportedLosses:result.supportedLosses}));
  if(!result.wholeStudyAdmitted)process.exitCode=1;
}
