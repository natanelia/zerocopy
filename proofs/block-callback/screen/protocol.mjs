import assert from 'node:assert/strict';
export const ROLES = Object.freeze(['main', 'candidate', 'pr23']);
export const CONFIG = Object.freeze({ blocks:8, samples:21, targetBatchMs:40, warmupMs:500,
  measuredBatchFloorMs:10, measuredWarmupFloorMs:150, warmupMinElements:262144,
  maxWarmupMs:10000, scanMaxRepeat:10000000, compactWarmupCalls:512, compactGcEvery:32, compactMaxRepeat:2048,
  subjectTimeoutMs:60000, campaignTimeoutMs:1800000, prerequisitesTimeoutMs:2400000,
  totalJobTimeoutMinutes:95, margin:1.02, worthwhileUpper:1/1.02, confidenceLevel:0.95,
  seed:0x20261009, retryCount:0, node:'22.23.3', bun:'1.4.2', architecture:'x64', platform:'linux' });
export const STEP_BUDGETS = Object.freeze({ checkout:2, nodeSetup:2, bunSetup:2, verify:1, correctness:42, campaign:32, package:4, upload:5, reserve:5 });
const row = (id, kind, type, size, operation, target, note) => Object.freeze({id,name:id,kind,type,size,operation,target,edited:false,note});
export const CASES = Object.freeze([
  row('linked-number-4097','linked','number',4097,'forEach',true,'Large forward linked callback'),
  row('doubly-number-4097','doubly','number',4097,'forEach',true,'Large forward doubly callback'),
  row('reverse-number-4097','doubly','number',4097,'forEachReverse',true,'Large reverse doubly callback'),
  row('linked-string-4097','linked','string',4097,'forEach',true,'Repeated distinct Unicode strings; natural 2048-entry cache cap'),
  row('doubly-object-4097','doubly','object',4097,'forEach',true,'Repeated distinct nested JSON objects; natural 2048-entry cache cap'),
  row('linked-empty','linked','number',0,'forEach',false,'Empty forward callback control'),
  row('reverse-empty','doubly','number',0,'forEachReverse',false,'Empty reverse callback control'),
  row('linked-tail-32','linked','number',32,'forEach',false,'Tail-only forward callback control'),
  row('reverse-tail-32','doubly','number',32,'forEachReverse',false,'Tail-only reverse callback control'),
  row('vector-number-4097','list','number',4097,'forEach',false,'Unchanged SharedList callback control'),
]);
export const median = values => { const a=[...values].sort((x,y)=>x-y); assert(a.length); return a.length%2?a[a.length>>1]:(a[a.length/2-1]+a[a.length/2])/2; };
const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
export function schedule() {
  let state=CONFIG.seed>>>0;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
  const shuffle=input=>{const a=[...input];for(let i=a.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
  const permutations=[['main','candidate','pr23'],['main','pr23','candidate'],['candidate','main','pr23'],['candidate','pr23','main'],['pr23','main','candidate'],['pr23','candidate','main']];
  const rows=CASES.map(workload=>({workload, pilotOrder:shuffle(ROLES), blocks:[]}));
  const plan=[];
  for(let block=0;block<CONFIG.blocks;block++) for(const row of shuffle(rows)) {
    if(block===0) row.orders=shuffle([...permutations,...shuffle(permutations).slice(0,2)]);
    const order=row.orders[block],roles=[...order,...[...order].reverse()];
    const item={caseId:row.workload.id,block,roles};row.blocks.push(item);plan.push(item);
  }
  return {rows:rows.map(({orders,...row})=>row), measuredOrder:plan,
    counts:{cases:CASES.length,pilots:CASES.length*3,blocks:CASES.length*8,subjects:CASES.length*8*6,batches:CASES.length*8*6*21}};
}
export function freezeWork(workload,pilots) {
  assert.equal(pilots.length,3);assert.equal(new Set(pilots.map(p=>p.digest)).size,1);
  for(const p of pilots){assert.equal(p.phase,'pilot');assert(!p.repeatCapped&&!p.warmup.capped,'Calibration cap');assert(Number.isSafeInteger(p.repeat)&&p.repeat>0&&p.repeat<=CONFIG.scanMaxRepeat);assert(Number.isFinite(p.minMsPerScan)&&p.minMsPerScan>0);}
  const repeat=Math.max(...pilots.map(p=>p.repeat)),fastest=Math.min(...pilots.map(p=>p.minMsPerScan));
  const warmupScans=Math.ceil(Math.max(Math.ceil(CONFIG.warmupMinElements/Math.max(1,workload.size)),Math.ceil(CONFIG.warmupMs*1.25/fastest))/repeat)*repeat;
  assert(Number.isSafeInteger(warmupScans)&&warmupScans>0);
  return {repeat,warmupScans,expectedDigest:pilots[0].digest,fastestPilotMsPerScan:fastest};
}
export function interval(logs) {
  if(logs.length!==8)return {complete:false,n:logs.length,point:logs.length?Math.exp(mean(logs)):null,lower:null,upper:null};
  assert(logs.every(Number.isFinite));const m=mean(logs),sd=Math.sqrt(logs.reduce((s,x)=>s+(x-m)**2,0)/7),half=2.3646242515927844*sd/Math.sqrt(8);
  return {complete:true,n:8,point:Math.exp(m),lower:Math.exp(m-half),upper:Math.exp(m+half),confidenceLevel:0.95,df:7};
}
export function validateMeasured(s,work) {
  assert.equal(s.phase,'measure');assert.equal(s.samples.length,21);assert(s.samples.every(x=>Number.isFinite(x)&&x>0));
  assert.equal(s.repeat,work.repeat);assert.equal(s.prescribedWarmupScans,work.warmupScans);assert.equal(s.digest,work.expectedDigest);
  assert.equal(s.belowTargetBatches,s.samples.filter(x=>x<CONFIG.measuredBatchFloorMs).length);
  assert(Number.isFinite(s.warmup.elapsedMs)&&s.warmup.elapsedMs>=0);assert(Number.isSafeInteger(s.warmup.scans)&&s.warmup.scans>=0);
  assert.equal(s.warmupTimeShort,s.warmup.elapsedMs<CONFIG.measuredWarmupFloorMs);assert.equal(s.warmupWorkShort,s.warmup.scans!==work.warmupScans);
}
export function summarizeRow(row) {
  const ab={main:[],pr23:[]},aa=Object.fromEntries(ROLES.map(r=>[r,[]])),processes=[];
  const complete=row.blocks.filter(b=>b.subjects?.length===6&&b.subjects.every(s=>s.complete));
  let flags=0;
  for(const block of complete){
    const by=Object.fromEntries(ROLES.map(r=>[r,block.subjects.filter(s=>s.role===r)]));
    for(const r of ROLES){assert.equal(by[r].length,2);for(const s of by[r]){
      validateMeasured(s,row.work);
      flags+=Boolean(s.belowTargetBatches||s.warmup.capped||s.warmupTimeShort||s.warmupWorkShort);
      processes.push({sequence:s.sequence,role:r,block:block.block,nsPerScan:median(s.samples)/s.repeat*1e6});
    }aa[r].push(Math.log(median(by[r][1].samples)/median(by[r][0].samples)));}
    const log=r=>mean(by[r].map(s=>Math.log(median(s.samples)/s.repeat)));
    for(const other of ['main','pr23'])ab[other].push(log('candidate')-log(other));
  }
  const aaIntervals=Object.fromEntries(ROLES.map(r=>[r,{...interval(aa[r]),logRatios:aa[r]}]));
  const drift=Object.values(aaIntervals).some(x=>x.complete&&(x.point<1/CONFIG.margin||x.point>CONFIG.margin)&&(x.lower>1||x.upper<1));
  const usable=complete.length===8&&flags===0&&!drift;
  const comparisons=Object.fromEntries(['main','pr23'].map(r=>{const x=interval(ab[r]);return[r,{...x,logRatios:ab[r],usable,classification:!usable?'invalid-or-incomplete':x.lower>CONFIG.margin?'detected-material-loss':x.upper<=CONFIG.margin?'within-2-percent':'inconclusive'}];}));
  for(const x of Object.values(aaIntervals))x.equivalent=x.complete&&x.lower>=1/CONFIG.margin&&x.upper<=CONFIG.margin;
  return {caseId:row.workload.id,target:row.workload.target,completeBlocks:complete.length,flags,aaDrift:drift,usable,comparisons,aa:aaIntervals,processes};
}
export function decision(rows) {
  const summaries=rows.map(summarizeRow),complete=summaries.length===10&&summaries.every(s=>s.usable);
  const losses=summaries.flatMap(s=>['main','pr23'].filter(r=>s.usable&&s.comparisons[r].complete&&s.comparisons[r].lower>CONFIG.margin).map(r=>`${s.caseId}:candidate/${r}`));
  const worthwhile=summaries.filter(s=>s.target&&s.usable&&s.comparisons.pr23.upper<CONFIG.worthwhileUpper).map(s=>s.caseId);
  return {status:!complete?'incomplete-or-invalid':losses.length?'detected-material-loss':worthwhile.length?'admit-broader-validation':'no-worthwhile-incremental-evidence',losses,worthwhile,summaries,
    interpretation:'Pointwise screening evidence only. Inconclusive controls remain visible; no global acceptance or simultaneous guarantee.'};
}
