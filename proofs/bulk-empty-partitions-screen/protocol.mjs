// Pure protocol: no subject imports, clocks, processes, or I/O.
export const CASES = ['P8', 'P128', 'Large', 'Dense16', 'Empty', 'One', 'Four', 'Read'];
export const STARTUP = ['import', 'constructor', 'firstSetMany'];
export const ENGINES = ['Node', 'Bun'];
export const ARMS = ['baseline', 'candidate'];
export const G0 = {P8:256,P128:16,Large:1,Dense16:128,Empty:16384,One:1024,Four:256,Read:4096};
export const GMAX = {P8:1024,P128:64,Large:2,Dense16:512,Empty:1048576,One:8192,Four:2048,Read:1048576};
export const D = {P8:4974,P128:79374,Large:2653808,Dense16:9934,Empty:0,One:634,Four:2494,Read:0};
export const S = Object.fromEntries(CASES.map(k => [k,k === 'Large' ? 65536 : 2605070]));
export const M = 67108864, H = 4194304, T95 = 1.894578605061305, T975 = 2.3646242515927844;
export const DENSE = [4,21,2,5,8,3,6,9,22,7,19,23,0,18,20,1];
export function check(ok, message) { if (!ok) throw Error(message); }
export const key = i => `item:${String(i).padStart(5,'0')}`;
export const missing = i => `absent:${String(i).padStart(5,'0')}`;
export const rotate = r => [...CASES.slice(r % 8), ...CASES.slice(0,r % 8)];
export function schedule() {
  const rows = [0,1,2,3].map(i => ({id:`cal-${i}`,kind:'calibration',engine:ENGINES[i<2?0:1],arm:'baseline',repetition:i,rotation:2*i,order:rotate(2*i)}));
  for (let r=0;r<8;r++) for (const e of (r%2 ? [1,0] : [0,1])) for (const arm of ((r+e)%2 ? [...ARMS].reverse() : ARMS))
    rows.push({id:`obs-${r}-${ENGINES[e]}-${arm}`,kind:'observation',engine:ENGINES[e],arm,repetition:r,rotation:r,order:rotate(r)});
  return rows;
}
export function quantum(readings) {
  check(readings.length===4096,'clock preflight count');
  let q=Infinity;
  for(let i=1;i<readings.length;i++) { const delta=BigInt(readings[i])-BigInt(readings[i-1]); check(delta>=0n,'clock reversed'); if(delta>0n) q=Math.min(q,Number(delta)/1e6); }
  check(Number.isFinite(q)&&q>0,'no positive clock quantum'); return q;
}
export const resolution = q => Math.max(1,1000*q);
export function positiveTimes(xs, n) { check(xs.length===n&&xs.every(x=>Number.isFinite(x)&&x>0),'invalid duration'); }
export function propose(name, measured, q) {
  positiveTimes(measured,4); check(q>0&&Number.isFinite(q),'invalid quantum');
  const totalMs=measured.reduce((a,b)=>a+b,0), short=measured.some(t=>t<resolution(q));
  const proposed=short ? GMAX[name] : 2**Math.ceil(Math.log2(Math.max(G0[name],G0[name]*40/totalMs)));
  check(Number.isSafeInteger(proposed)&&proposed>0,'invalid proposed count');
  return {totalMs,q,proposed,calibration_short:short,target_duration_unknown:short,capReason:proposed>GMAX[name]?'fixed memory/operation ceiling':null};
}
export function freezeCounts(calibrations) {
  check(calibrations.length===4,'four calibrations required');
  const expected=schedule().slice(0,4);
  calibrations.forEach((c,i)=>check(c.complete&&c.arm==='baseline'&&c.id===expected[i].id&&c.engine===expected[i].engine,'invalid calibration identity'));
  return Object.fromEntries(CASES.map(name=>{
    const proposals=calibrations.map(c=>propose(name,c.cases[name].measured,c.q));
    return [name,{G:Math.min(GMAX[name],Math.max(...proposals.map(x=>x.proposed))),Gmax:GMAX[name],proposals}];
  }));
}
export function allocation(name, before, after, cumulativeCalls, calls) {
  for(const p of [before,after]) check(Number.isSafeInteger(p.used)&&p.used>=65536&&Number.isSafeInteger(p.capacity)&&p.capacity>=p.used&&p.capacity%65536===0,'invalid arena descriptor');
  check(after.used>=before.used&&after.capacity>=before.capacity,'allocator rewound');
  check(after.used-before.used<=calls*D[name],'allocation delta bound');
  check(after.used<=S[name]+cumulativeCalls*D[name],'allocation lifetime bound');
  check(after.capacity<=Math.max(131072,Math.ceil(after.used/65536)*65536)&&after.capacity<=M,'capacity bound');
}
export function interval(xs,t=T95) {
  check(xs.length===8&&xs.every(Number.isFinite),'eight finite observations required');
  const mean=xs.reduce((a,b)=>a+b,0)/8, sd=Math.sqrt(xs.reduce((a,b)=>a+(b-mean)**2,0)/7), se=sd/Math.sqrt(8);
  return {mean,sd,se,lower:mean-t*se,upper:mean+t*se};
}
export function paired(baseline,candidate) {
  positiveTimes(baseline,8); positiveTimes(candidate,8);
  const logRatios=baseline.map((b,i)=>Math.log(candidate[i]/b)), a=interval(logRatios), b=interval(logRatios,T975);
  return {logRatios,ratio:Math.exp(a.mean),lower95:Math.exp(a.lower),upper95:Math.exp(a.upper),upper975:Math.exp(b.upper),meanLog:a.mean,sdLog:a.sd};
}
export function readiness(rows,name) {
  check(rows.length===8,'readiness requires eight children');
  if(STARTUP.includes(name)) return {pass:rows.every(r=>r.startup[name]>=resolution(r.q)),startup:true};
  const chunks=rows.map(r=>r.cases[name]);
  chunks.forEach(c=>{positiveTimes(c.warm,2);positiveTimes(c.measured,4);});
  const resolved=chunks.every((c,i)=>[c.warm[1],...c.measured].every(t=>t>=resolution(rows[i].q))&&c.measured.reduce((a,b)=>a+b,0)>=20);
  const warm=interval(chunks.map(c=>Math.log(c.measured[0]/c.warm[1])));
  const stability=interval(chunks.map(c=>Math.log((c.measured[0]+c.measured[1])/(c.measured[2]+c.measured[3]))));
  const settled=[warm,stability].every(x=>x.lower>=Math.log(.95)&&x.upper<=Math.log(1.05));
  return {pass:resolved&&settled,resolved,settled,warm,stability};
}
export function validateContents(snapshot, expected) {
  check(snapshot.size===expected.size,'size mismatch');
  const entries=[...snapshot.entries()]; check(entries.length===expected.size,'iteration size mismatch');
  const found=new Set();
  for(const [k,v] of entries) { check(!found.has(k)&&expected.has(k),'unexpected/duplicate key'); found.add(k); check(JSON.stringify(v)===JSON.stringify(expected.get(k)),'iteration value mismatch'); }
  for(const [k,v] of expected) check(JSON.stringify(snapshot.get(k))===JSON.stringify(v),'lookup value mismatch');
  for(let i=0;i<128;i++) check(snapshot.get(missing(i))===undefined,'absent lookup mismatch');
  return entries.sort(([a],[b])=>a.localeCompare(b));
}
export function compareEndpoints(a,b) {
  check(JSON.stringify(a.order)===JSON.stringify(b.order),'paired order differs');
  check(JSON.stringify(a.counts)===JSON.stringify(b.counts),'paired counts differ');
  check(JSON.stringify(a.validation)===JSON.stringify(b.validation),'paired bytes/root/used/capacity/contents differ');
  for(const name of CASES) check(a.cases[name].sink===b.cases[name].sink,'paired sink differs');
}
export function compareEndpoint(a,b,name) {
  check(JSON.stringify(a.order)===JSON.stringify(b.order),'paired order differs');
  if(STARTUP.includes(name)) check(JSON.stringify(a.validation.startup)===JSON.stringify(b.validation.startup),'paired startup endpoint differs');
  else {check(a.counts[name]===b.counts[name],'paired count differs');check(JSON.stringify(a.validation.cases[name])===JSON.stringify(b.validation.cases[name]),'paired case endpoint differs');check(a.cases[name].sink===b.cases[name].sink,'paired sink differs');}
}
export function analyze(rows,{studyFailed=false}={}) {
  const observations=rows.filter(r=>r.kind==='observation'), endpoints={}, unresolved=[];
  check(new Set(rows.map(r=>r.id)).size===rows.length,'duplicate child');
  for(const row of rows) check(schedule().some(x=>x.id===row.id&&x.engine===row.engine&&x.arm===row.arm&&x.kind===row.kind),'unknown child');
  for(const engine of ENGINES) {
    endpoints[engine]={};
    for(const name of [...CASES,...STARTUP]) {
      const available=r=>(r.validatedEndpoints??(r.complete?[...CASES,...STARTUP]:[])).includes(name);
      const groups=Object.fromEntries(ARMS.map(arm=>[arm,observations.filter(r=>r.engine===engine&&r.arm===arm&&available(r)).sort((a,b)=>a.repetition-b.repetition)]));
      const complete=ARMS.every(arm=>groups[arm].length===8&&groups[arm].every((r,i)=>r.repetition===i));
      if(!complete) { endpoints[engine][name]={complete:false,quality:false}; unresolved.push(`${engine}/${name}: incomplete pairs`); continue; }
      groups.baseline.forEach((b,i)=>compareEndpoint(b,groups.candidate[i],name));
      const values=arm=>groups[arm].map(r=>STARTUP.includes(name)?r.startup[name]:r.cases[name].measured.reduce((a,b)=>a+b,0)/(4*r.counts[name]));
      const quality=Object.fromEntries(ARMS.map(arm=>[arm,readiness(groups[arm],name)]));
      const stats=paired(values('baseline'),values('candidate'));
      endpoints[engine][name]={complete:true,...stats,readiness:quality,quality:ARMS.every(arm=>quality[arm].pass),childFailures:[...groups.baseline,...groups.candidate].filter(r=>!r.complete).map(r=>({id:r.id,error:r.parentFailure??r.error??'child incomplete'}))};
    }
  }
  const qualifyingPrimaries=['P8','P128'].filter(name=>ENGINES.every(e=>{const x=endpoints[e][name];return x.complete&&x.quality&&x.upper975<=.9;}));
  const regressionVeto=ENGINES.some(e=>Object.values(endpoints[e]).some(x=>x.complete&&x.lower95>1.02));
  // A guard set excludes exactly one qualifying primary. If both qualify, P8 is the fixed first choice.
  const selectedPrimary=qualifyingPrimaries[0]??null;
  const guardsClear=ENGINES.every(e=>[...CASES,...STARTUP].filter(k=>k!==selectedPrimary).every(k=>{
    const x=endpoints[e][k], pass=x.complete&&x.quality&&x.ratio<=1&&x.upper95<=1.02;
    if(!pass) unresolved.push(`${e}/${k}: ${!x.complete?'incomplete':!x.quality?'short or unsettled':x.ratio>1?'point adverse':'interval unresolved'}`); return pass;
  }));
  // Enumerate all unresolved guards even when a preceding guard failed.
  for(const e of ENGINES) for(const k of [...CASES,...STARTUP]) if(k!==selectedPrimary) { const x=endpoints[e][k]; if(!(x.complete&&x.quality&&x.ratio<=1&&x.upper95<=1.02)) { const reason=`${e}/${k}: ${!x.complete?'incomplete':!x.quality?'short or unsettled':x.ratio>1?'point adverse':'interval unresolved'}`; if(!unresolved.includes(reason))unresolved.push(reason); } }
  const studyComplete=rows.length===36&&rows.every(r=>r.complete),studyValid=studyComplete&&!studyFailed;
  return {studyComplete,studyValid,eligibleForSeparatelyReviewedFollowOn:studyValid&&qualifyingPrimaries.length>0&&!regressionVeto,endpoints,qualifyingPrimaries,selectedPrimary,primaryQualified:qualifyingPrimaries.length>0,regressionVeto,guardsClear,unresolved:[...new Set(unresolved)],scope:'Fixed two-warm-chunk fresh-process screen only; no promotion or general performance claim.'};
}
