// Analysis reads retained JSONL only; no arm imports or operation clocks.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {median,summary,logInterval,pointwiseDecision,hasCompleteReplicates} from './math.mjs';
import {fixture,expectedChecksum} from './core.mjs';
const [root,lane]=process.argv.slice(2),p=JSON.parse(readFileSync(new URL('./protocol.json',import.meta.url))),ledger=JSON.parse(readFileSync(path.join(root,'run/ledger.json'))),manifest=JSON.parse(readFileSync(path.join(root,'harness/manifest.json')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const complete=ledger.status==='complete'&&ledger.verificationAfter?.ok===true&&ledger.slots.every(s=>s.status==='complete'&&s.cleanup?.ownedGroupGone);
assert.equal(ledger.manifestSha256,sha(readFileSync(path.join(root,'harness/manifest.json'))));
const records=new Map();for(const slot of ledger.slots){if(slot.status!=='complete')continue;const bytes=readFileSync(path.join(root,'run',slot.id+'.stdout.jsonl'));assert.equal(sha(bytes),slot.stdoutSha256);records.set(slot.id,bytes.toString().trim().split('\n').map(JSON.parse));}
function absoluteDifference(ds){const s=summary(ds),radius=p.statistics.tCritical*s.sd/2;return {meanMs:s.mean,lowMs:s.mean-radius,highMs:s.mean+radius,df:3,pointwiseConfidence:.95,quartetDifferencesMs:ds,reportingScaleMs:p.startup.absoluteReportingMs,scaleOnlyNeverWaivesRelativeLoss:true,scaleComparison:s.mean-radius>p.startup.absoluteReportingMs?'above 50 microseconds':s.mean+radius<p.startup.absoluteReportingMs?'below 50 microseconds':'crosses 50 microseconds'};}
const cells=[];
for(const runtime of p.environmentOrders[lane][0]){
  const metrics=[...p.startup.metrics.map(metric=>({id:metric,kind:'startup',unit:'milliseconds',primary:false})),...(p.warmRuntimes[lane].includes(runtime)?p.cases.map(spec=>({...spec,kind:'warm'})):[])];
  for(const metric of metrics){
    const logs=[],deltas=[],aa={baseline:[],candidate:[]},absolute={baseline:[],candidate:[]},subjects=[],flags=complete?[]:['lane admission incomplete'];
    for(let block=0;block<4;block++){
      const values={baseline:[],candidate:[]};
      for(const slot of ledger.slots.filter(s=>s.mode==='measure'&&s.runtime===runtime&&s.block===block)){
        const rows=records.get(slot.id);if(!rows){flags.push('missing/failed slot '+slot.id);continue;}let value;
        if(metric.kind==='startup'){
          const selected=rows.filter(r=>r.kind==='startup'&&r.metric===metric.id);assert.equal(selected.length,1);value=selected[0].durationMs;assert(value>0&&Number.isFinite(value));
          assert.equal(rows.filter(r=>r.kind==='startup-validation').length,1);
        }else{
          const input=fixture(metric),digest=sha(JSON.stringify([input.entries,input.queries]));
          const start=rows.find(r=>r.kind==='case-start'&&r.case===metric.id);assert.equal(start.inputDigest,digest);assert.deepEqual(start.queryCounts,input.expected);
          const chunks=rows.filter(r=>r.kind==='chunk'&&r.case===metric.id);for(const row of chunks){assert.deepEqual(row.queryCounts,input.expected);assert.equal(row.checksum,expectedChecksum(input,row.operations));assert.equal(row.lastResult,input.expected[(row.operations-1)&3]);const after=rows.find(r=>r.kind==='chunk-validation'&&r.chunk===row.chunk);assert(after);assert.deepEqual(after.after,row.before);}
          const measured=chunks.filter(r=>r.phase==='measurement');assert.equal(measured.length,7);value=median(measured.map(r=>r.nsPerOperation));
          const diagnostic=rows.find(r=>r.kind==='diagnostics'&&r.case===metric.id);assert(diagnostic);
          for(const key of ['calibrationFloor','calibrationWarmupFlag','minimumDurationFloor','insufficientWarmup','warmupFlag','variabilityFlag'])if(diagnostic[key])flags.push(slot.id+': '+key);
        }
        values[slot.arm][slot.replicate]=value;absolute[slot.arm].push(value);subjects.push({slot:slot.id,arm:slot.arm,block,replicate:slot.replicate,value});
      }
      if(hasCompleteReplicates(values)){
        logs.push((Math.log(values.candidate[0])+Math.log(values.candidate[1])-Math.log(values.baseline[0])-Math.log(values.baseline[1]))/2);
        deltas.push((values.candidate[0]+values.candidate[1]-values.baseline[0]-values.baseline[1])/2);
        for(const arm of ['baseline','candidate'])aa[arm].push(Math.log(values[arm][1]/values[arm][0]));
      }
    }
    const interval=logs.length===4?logInterval(logs,p.statistics.tCritical):null,aaDiagnostics={};
    for(const arm of ['baseline','candidate'])if(aa[arm].length===4){const interval=logInterval(aa[arm],p.statistics.tCritical),flagged=aa[arm].some(x=>Math.abs(x)>Math.log(1.05))||interval.low>1||interval.high<1;aaDiagnostics[arm]={interval,individualBlockRatios:aa[arm].map(Math.exp),flagged};if(flagged)flags.push(arm+' A/A drift or >5% block discrepancy');}
    cells.push({lane,runtime,metric:metric.id,kind:metric.kind,unit:metric.unit,primary:metric.primary,pointwise95PercentInterval:interval,absoluteDifference:metric.kind==='startup'&&deltas.length===4?absoluteDifference(deltas):null,baseline:absolute.baseline.length?summary(absolute.baseline):null,candidate:absolute.candidate.length?summary(absolute.candidate):null,subjects,blockLogs:logs,aaDiagnostics,flags,provisionalLaneDecision:interval?pointwiseDecision(interval,p.statistics,flags.length===0):'inconclusive: fewer than four complete original blocks',decision:'awaiting complete two-lane admission; provisional lane estimate only'});
  }
}
const result={schema:1,lane,run:manifest.ciRun,origin:manifest.origin,manifestSha256:ledger.manifestSha256,laneComplete:complete,wholeStudyAdmitted:false,promotionAllowed:false,scope:p.purpose,firstUse:'numeric module import then first tiny spatial-only call in fresh process/profile; globally cold OS/compiler caches and range-first unmeasured',timerPrecision:'not independently measured; engine timer resolution/privacy rounding limit interpretation of small startup differences; no warm duration floor or synthetic startup replication',pointwiseNotSimultaneous:true,additionalSamplesAuthorized:false,oldRunPooled:false,cells};
writeFileSync(path.join(root,'lane-analysis.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({lane,cells:cells.length,laneComplete:complete,wholeStudyAdmitted:false}));
