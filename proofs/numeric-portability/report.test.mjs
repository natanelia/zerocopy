// Artificial records only: verifies startup decisions without real library or timing execution.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture,expectedChecksum} from './core.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),p=JSON.parse(readFileSync(path.join(here,'protocol.json'))),root=mkdtempSync(path.join(os.tmpdir(),'numeric-model-report-')),sha=x=>createHash('sha256').update(x).digest('hex');
try{
  mkdirSync(path.join(root,'run'));mkdirSync(path.join(root,'harness'));
  const manifest={ciRun:{GITHUB_RUN_ID:'synthetic',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'synthetic'},origin:{synthetic:true}};writeFileSync(path.join(root,'harness/manifest.json'),JSON.stringify(manifest));
  const ledger={status:'complete',verificationAfter:{ok:true},manifestSha256:sha(readFileSync(path.join(root,'harness/manifest.json'))),slots:[]};
  for(let block=0;block<4;block++)for(const runtime of p.environmentOrders.arm64[block]){
    const seen={baseline:0,candidate:0};for(let position=0;position<4;position++){
      const arm=p.orders[block][position],id=`${runtime}-b${block}-${position}-${arm}`,replicate=seen[arm]++,factor=arm==='candidate'?1.03:1,rows=[];
      for(const [metric,base] of [['import',.001],['first-spatial',.002],['sum',.003]])rows.push({kind:'startup',metric,durationMs:base*factor});rows.push({kind:'startup-validation'});
      for(const spec of p.cases){const input=fixture(spec),operations=spec.ladder[0];rows.push({kind:'case-start',case:spec.id,inputDigest:sha(JSON.stringify([input.entries,input.queries])),queryCounts:input.expected});for(let sample=0;sample<7;sample++){const chunk=rows.length;rows.push({kind:'chunk',case:spec.id,chunk,phase:'measurement',operations,durationMs:8,nsPerOperation:8e6/operations,queryCounts:input.expected,checksum:expectedChecksum(input,operations),lastResult:input.expected[(operations-1)&3],before:{model:true}});rows.push({kind:'chunk-validation',chunk,after:{model:true}});}rows.push({kind:'diagnostics',case:spec.id});}
      const raw=rows.map(JSON.stringify).join('\n')+'\n';writeFileSync(path.join(root,'run',id+'.stdout.jsonl'),raw);ledger.slots.push({id,runtime,arm,block,position,replicate,mode:'measure',status:'complete',cleanup:{ownedGroupGone:true},stdoutSha256:sha(raw)});
    }
  }
  writeFileSync(path.join(root,'run/ledger.json'),JSON.stringify(ledger));const result=spawnSync(process.execPath,[path.join(here,'report.mjs'),root,'arm64'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(readFileSync(path.join(root,'lane-analysis.json')));assert.equal(report.cells.length,16);assert.equal(report.wholeStudyAdmitted,false);
  for(const cell of report.cells.filter(c=>c.kind==='startup')){assert.equal(cell.provisionalLaneDecision,'material loss supported in this cell');assert(cell.absoluteDifference.highMs<.05);assert.equal(cell.absoluteDifference.scaleOnlyNeverWaivesRelativeLoss,true);assert.deepEqual(cell.flags,[]);}
  assert(report.cells.filter(c=>c.kind==='warm').every(c=>c.provisionalLaneDecision==='2% loss excluded pointwise; worthwhile gain unresolved'));
  console.log(JSON.stringify({syntheticReportCells:16,startupLossCellsBelow50Microseconds:6,realOperationClocksRead:false,librarySubjectsExecuted:false}));
}finally{rmSync(root,{recursive:true,force:true});}
