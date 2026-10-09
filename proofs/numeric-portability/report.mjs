// Analysis consumes only the authoritative validator's canonical observations.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {summary,logInterval,pointwiseDecision,hasCompleteReplicates} from './math.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export function analyzeLane(canonical,p){
  const {lane,manifest,slots}=canonical;assert(['x64','arm64'].includes(lane));assert(Array.isArray(slots));
  const expected=[];
  for(const runtime of p.environmentOrders[lane][0])if(p.warmRuntimes[lane].includes(runtime))for(const arm of ['baseline','candidate'])expected.push(`${runtime}-calibration-${arm}`);
  for(let block=0;block<4;block++)for(const runtime of p.environmentOrders[lane][block])for(let position=0;position<4;position++)expected.push(`${runtime}-b${block}-${position}-${p.orders[block][position]}`);
  assert.deepEqual(slots.map(s=>s.id),expected,'Complete exact canonical original slot set required');assert.equal(new Set(expected).size,expected.length);
  function absoluteDifference(ds){const s=summary(ds),radius=p.statistics.tCritical*s.sd/2;return {meanMs:s.mean,lowMs:s.mean-radius,highMs:s.mean+radius,df:3,pointwiseConfidence:.95,quartetDifferencesMs:ds,reportingScaleMs:p.startup.absoluteReportingMs,scaleOnlyNeverWaivesRelativeLoss:true,scaleComparison:s.mean-radius>p.startup.absoluteReportingMs?'above 50 microseconds':s.mean+radius<p.startup.absoluteReportingMs?'below 50 microseconds':'crosses 50 microseconds'};}
  const cells=[];
  for(const runtime of p.environmentOrders[lane][0]){
    const metrics=[...p.startup.metrics.map(metric=>({id:metric,kind:'startup',unit:'milliseconds',primary:false})),...(p.warmRuntimes[lane].includes(runtime)?p.cases.map(spec=>({...spec,kind:'warm'})):[])];
    for(const metric of metrics){
      const logs=[],deltas=[],aa={baseline:[],candidate:[]},absolute={baseline:[],candidate:[]},subjects=[],flags=[];
      for(let block=0;block<4;block++){
        const values={baseline:[],candidate:[]},quartet=slots.filter(s=>s.mode==='measure'&&s.runtime===runtime&&s.block===block);assert.equal(quartet.length,4);
        for(const slot of quartet){
          assert.equal(slot.arm,p.orders[block][slot.position]);assert([0,1].includes(slot.replicate));assert.equal(values[slot.arm][slot.replicate],undefined);
          let value;if(metric.kind==='startup')value=slot.evidence.startup[metric.id];
          else{const observation=slot.evidence.warm[metric.id];value=observation.medianNs;assert(Array.isArray(observation.flags));for(const flag of observation.flags)flags.push(slot.id+': '+flag);}
          assert(Number.isFinite(value)&&value>0);values[slot.arm][slot.replicate]=value;absolute[slot.arm].push(value);subjects.push({slot:slot.id,arm:slot.arm,block,replicate:slot.replicate,value});
        }
        assert(hasCompleteReplicates(values));logs.push((Math.log(values.candidate[0])+Math.log(values.candidate[1])-Math.log(values.baseline[0])-Math.log(values.baseline[1]))/2);
        deltas.push((values.candidate[0]+values.candidate[1]-values.baseline[0]-values.baseline[1])/2);for(const arm of ['baseline','candidate'])aa[arm].push(Math.log(values[arm][1]/values[arm][0]));
      }
      const interval=logInterval(logs,p.statistics.tCritical),aaDiagnostics={};
      for(const arm of ['baseline','candidate']){const interval=logInterval(aa[arm],p.statistics.tCritical),flagged=aa[arm].some(x=>Math.abs(x)>Math.log(1.05))||interval.low>1||interval.high<1;aaDiagnostics[arm]={interval,individualBlockRatios:aa[arm].map(Math.exp),flagged};if(flagged)flags.push(arm+' A/A drift or >5% block discrepancy');}
      cells.push({lane,runtime,metric:metric.id,kind:metric.kind,unit:metric.unit,primary:metric.primary,pointwise95PercentInterval:interval,absoluteDifference:metric.kind==='startup'?absoluteDifference(deltas):null,baseline:summary(absolute.baseline),candidate:summary(absolute.candidate),subjects,blockLogs:logs,aaDiagnostics,flags,provisionalLaneDecision:pointwiseDecision(interval,p.statistics,flags.length===0),decision:'awaiting complete two-lane admission; provisional lane estimate only'});
    }
  }
  return {schema:2,lane,run:canonical.run,origin:manifest.origin,manifestSha256:canonical.manifestSha256,packetSha256:canonical.packetSha256,laneComplete:true,wholeStudyAdmitted:false,promotionAllowed:false,scope:p.purpose,firstUse:'numeric module import then first tiny spatial-only call in fresh process/profile; globally cold OS/compiler caches and range-first unmeasured',timerPrecision:'not independently measured; engine timer resolution/privacy rounding limit interpretation of small startup differences; no warm duration floor or synthetic startup replication',pointwiseNotSimultaneous:true,additionalSamplesAuthorized:false,oldRunPooled:false,cells};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [root,lane]=process.argv.slice(2);assert(root&&lane);
  const check=spawnSync('python3',[path.join(here,'artifact_admission.py'),'lane',root,lane],{encoding:'utf8',maxBuffer:128*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  const validation=JSON.parse(check.stdout||'{}');assert.equal(check.status,0,validation.error||check.stderr||'Lane admission failed');assert.equal(validation.admitted,true);
  const p=JSON.parse(readFileSync(path.join(here,'protocol.json'))),result=analyzeLane(validation.canonical,p);
  writeFileSync(path.join(root,'lane-analysis.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({lane,cells:result.cells.length,laneComplete:true,wholeStudyAdmitted:false}));
}
