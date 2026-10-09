// Combine original lane admissions, never pool their observations.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [directory,output]=process.argv.slice(2),lanes={},problems=[];
for(const lane of ['x64','arm64']){
  const base=path.join(directory,'numeric-portability-'+lane);
  try{
    const preservation=JSON.parse(readFileSync(path.join(base,'preservation.json')));assert.equal(preservation.status,'complete');assert.equal(preservation.quiescence,'verified-from-owned-receipts');
    const inventory=JSON.parse(readFileSync(path.join(base,'artifact-inventory.json')));
    for(const entry of inventory.files){assert(!path.isAbsolute(entry.path)&&!entry.path.split('/').includes('..'));const file=path.join(base,entry.path);assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());const bytes=readFileSync(file);assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);}
    const analysis=JSON.parse(readFileSync(path.join(base,'lane-analysis.json')));assert.equal(analysis.lane,lane);assert.equal(analysis.laneComplete,true);assert.equal(analysis.cells.length,lane==='x64'?30:16);lanes[lane]=analysis;
  }catch(error){problems.push({lane,error:String(error)});if(existsSync(path.join(base,'lane-analysis.json'))){try{lanes[lane]=JSON.parse(readFileSync(path.join(base,'lane-analysis.json')));}catch{}}}
}
if(!problems.length){try{for(const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA'])assert.equal(lanes.x64.run[key],lanes.arm64.run[key]);assert.equal(lanes.x64.run.GITHUB_RUN_ATTEMPT,'1');assert.deepEqual(lanes.x64.origin,lanes.arm64.origin);}catch(error){problems.push({scope:'cross-lane identity',error:String(error)});}}
const admitted=problems.length===0,cells=Object.values(lanes).flatMap(l=>Array.isArray(l.cells)?l.cells:[]).map(cell=>({...cell,decision:admitted?cell.provisionalLaneDecision:'inconclusive: whole-study admission incomplete'})),losses=cells.filter(c=>c.decision==='material loss supported in this cell');
const result={wholeStudyAdmitted:admitted,promotionAllowed:false,problems,cells,disposition:!admitted?'incomplete; preserve original partial evidence':losses.length?'do not advance fixed patch: supported relative loss':'bounded startup/portability result; retain every inconclusive cell and prior unresolved x64 warm control',supportedLosses:losses.map(c=>({lane:c.lane,runtime:c.runtime,metric:c.metric})),oldEvidence:'https://github.com/natanelia/zerocopy/actions/runs/37952544553',oldRunPooled:false,earlierInconclusiveWarmCellsRemainUnresolved:true,rangeFirstUnmeasured:true,absoluteStartupReportingScaleMs:0.05,absoluteScaleCannotWaiveRelativeLoss:true};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({admitted,cells:cells.length,problems,supportedLosses:result.supportedLosses}));
