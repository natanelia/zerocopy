// Portable public-call adapter. Importing this module imports no library and reads no clock.
export const check=(condition,message='Proof assertion failed')=>{if(!condition)throw new Error(message);};
export const equal=(actual,expected,message='Equality assertion failed')=>check(JSON.stringify(actual)===JSON.stringify(expected),message);
export const median=xs=>{check(xs.length&&xs.every(Number.isFinite));const a=[...xs].sort((x,y)=>x-y),n=a.length;return n%2?a[n>>1]:(a[n/2-1]+a[n/2])/2;};
export const summary=xs=>{const m=median(xs),mad=median(xs.map(x=>Math.abs(x-m)));return {median:m,mad,relativeMad:mad/m};};
export const SIMD_PROBE=[0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11];
export function fixture(spec) {
  const spatial=spec.operation==='countPointsInBox';
  const entries=Array.from({length:spec.size},(_,i)=>spatial?(i&1?((Math.floor(i/2)*29+96)%193)-96:((Math.floor(i/2)*17+128)%257)-128):((i*17+128)%257)-128);
  const queries=spatial?[[-32,-24,32,24],[200,200,220,220],[-128,-96,128,96],[0,0,0,0]].map(([minX,minY,maxX,maxY])=>({minX,minY,maxX,maxY})):[[-32,32],[200,220],[-128,128],[0,0]];
  const expected=queries.map(q=>{let n=0;if(spatial){for(let i=0;i<entries.length;i+=2)n+=Number(entries[i]>=q.minX&&entries[i]<=q.maxX&&entries[i+1]>=q.minY&&entries[i+1]<=q.maxY);}else for(const v of entries)n+=Number(v>=q[0]&&v<=q[1]);return n;});
  return {entries,queries,expected};
}
export function expectedChecksum(input,operations){const n=Math.floor(operations/4)*input.expected.reduce((a,b)=>a+b,0)+input.expected.slice(0,operations%4).reduce((a,b)=>a+b,0);check(Number.isSafeInteger(n));return n;}
export function body(api,list,spec,input,operations){let checksum=0,last=0;if(spec.operation==='countPointsInBox'){for(let i=0;i<operations;i++){last=api.countPointsInBox(list,input.queries[i&3]);checksum+=last;}}else{for(let i=0;i<operations;i++){const q=input.queries[i&3];last=api.countInRange(list,q[0],q[1]);checksum+=last;}}return {checksum,last};}
export function selectionGuard(automatic,scalar,seed,wasm=WebAssembly){
  check(automatic.countInRange!==scalar.countInRange&&automatic.countPointsInBox!==scalar.countPointsInBox,'Distinct physical sibling closures required');
  const original=wasm.validate,counts={automatic:0,scalar:0,repeated:0};
  try{
    wasm.validate=bytes=>{equal(Array.from(bytes),SIMD_PROBE);check(++counts.automatic===1);const value=original.call(wasm,bytes);check(value===true,'SIMD required for this study');return value;};
    check(automatic.countInRange(seed,0,0)===1);
    wasm.validate=bytes=>{equal(Array.from(bytes),SIMD_PROBE);check(++counts.scalar===1);return false;};
    check(scalar.countInRange(seed,0,0)===1);
    wasm.validate=()=>{counts.repeated++;throw Error('Selection cache not retained');};
    check(automatic.countInRange(seed,0,0)===1&&scalar.countInRange(seed,0,0)===1);
  }finally{wasm.validate=original;}
  equal(counts,{automatic:1,scalar:1,repeated:0});check(wasm.validate===original);return {automaticProbes:counts.automatic,scalarProbes:counts.scalar,repeated:counts.repeated,validateRestored:true,automatic:'SIMD',scalar:'forced scalar'};
}
export async function runCore(config,io){
  const {protocol:p,mode}=config;check(['untimed','calibrate','measure'].includes(mode));
  const timed=mode!=='untimed',now=()=>{check(timed,'Operation clocks forbidden in untimed subject');return io.now();};
  let ordinal=0;const emit=async row=>io.emit({...row,ordinal:ordinal++});
  async function snapshot(list){const a=list.arena;return {root:list.root,depth:list.depth,tail:list.tail,size:list.size,type:list.type,used:a.used,capacity:a.memory.buffer.byteLength,memoryDigest:await io.sha256(new Uint8Array(a.memory.buffer))};}
  // No arm import, SIMD selection or seed call occurs before this boundary.
  let started=mode==='measure'?now():null;
  const numeric=await io.importModule('numeric.js');
  const importMs=mode==='measure'?now()-started:null;
  if(mode==='measure'){check(importMs>0&&Number.isFinite(importMs));await emit({kind:'startup',metric:'import',durationMs:importMs});}
  const api=await io.importModule('shared.js');api.configureMemory({maximumBytes:p.memory.maximumArenaBytes});
  let seed=new api.SharedList('number').pushMany(mode==='untimed'?[0]:p.startup.entries),before=await snapshot(seed);
  if(mode==='untimed'){
    const scalar=await io.importModule('numeric-scalar-control.mjs');
    const selection=selectionGuard(numeric,scalar,seed);
    const after=await snapshot(seed);equal(after,before);await emit({kind:'selection',...selection,before,after});
  }else{
    started=mode==='measure'?now():null;
    const count=numeric.countPointsInBox(seed,p.startup.bounds);
    const callMs=mode==='measure'?now()-started:null;
    if(mode==='measure'){check(callMs>0&&Number.isFinite(callMs));await emit({kind:'startup',metric:'first-spatial',durationMs:callMs});await emit({kind:'startup',metric:'sum',durationMs:importMs+callMs});}
    check(count===p.startup.expected);equal(await snapshot(seed),before);await emit({kind:'startup-validation',firstOperation:'countPointsInBox',count,before,after:await snapshot(seed),endToEndApplicationStartup:false,timer:'performance.now, milliseconds',timerPrecision:'not independently measured; privacy rounding and engine resolution may limit small startup differences',nonpositiveDurationPolicy:'reject subject; never replicate or replace with warm timing'});
  }
  seed=null;api.resetSharedList();await io.collect();
  await emit({kind:'start',mode,runtime:config.runtime,lane:config.lane,operationClocks:timed,firstUse:mode==='measure'?'fresh-process spatial-only':'not an inferential startup observation',gc:io.gcKind});
  let chunks=0;
  async function chunk(spec,input,operations,phase,sample){
    check(spec.ladder.includes(operations));api.resetSharedList();await io.collect();await io.memory();
    let list=new api.SharedList('number').pushMany(input.entries),owner=list.arena;
    const before=await snapshot(list),treeSize=(spec.size-1)&~31,tailSize=spec.size-treeSize;
    check(list.size===spec.size&&list.type==='number'&&((list.root===0)===(treeSize===0)));check(list.tail>=65536&&list.tail+tailSize*8<=before.used&&before.capacity<=p.memory.maximumArenaBytes&&tailSize>=1&&tailSize<=32);
    for(let q=0;q<4;q++){const result=spec.operation==='countPointsInBox'?numeric.countPointsInBox(list,input.queries[q]):numeric.countInRange(list,...input.queries[q]);check(result===input.expected[q]);}
    equal(await snapshot(list),before);await io.collect();
    const start=timed?now():null,result=body(numeric,list,spec,input,operations),durationMs=timed?now()-start:null;
    if(timed)check(durationMs>0&&Number.isFinite(durationMs));
    // Flush the completed body before asynchronous validation; only later validated rows are admissible.
    const row={kind:'chunk',case:spec.id,chunk:chunks++,phase,sample:sample??null,operation:spec.operation,operations,durationMs,nsPerOperation:timed?durationMs*1e6/operations:null,checksum:result.checksum,lastResult:result.last,queryCounts:input.expected,valuesPerCall:spec.size,pointsPerCall:spec.points??null,treeSize,tailSize,before};
    await emit(row);
    check(result.checksum===expectedChecksum(input,operations)&&result.last===input.expected[(operations-1)&3]);
    const after=await snapshot(list);equal(after,before);check(list.arena===owner);
    for(let i=0;i<input.entries.length;i++)check(list.get(i)===input.entries[i]);equal(await snapshot(list),before);
    const afterValidation=await io.memory();list=null;owner=null;api.resetSharedList();await io.collect();const afterCleanup=await io.memory();
    await emit({kind:'chunk-validation',case:spec.id,chunk:row.chunk,after,afterValidation,afterCleanup,liveArenaCapacityBytes:before.capacity});return row;
  }
  // Prospectively fixed order, identical in every process and independent of quartet/environment order.
  for(const spec of config.warm?p.cases:[]){
    const input=fixture(spec),inputDigest=await io.sha256(new TextEncoder().encode(JSON.stringify([input.entries,input.queries]))),rows=[];
    await emit({kind:'case-start',case:spec.id,inputDigest,queryCounts:input.expected,inputEntries:input.entries.length});
    if(mode==='untimed'){
      rows.push(await chunk(spec,input,spec.ladder[0],'untimed-minimum'));rows.push(await chunk(spec,input,spec.ladder.at(-1),'untimed-maximum'));
    }else if(mode==='calibrate'){
      for(let i=0;i<p.calibration.warmupChunks;i++)rows.push(await chunk(spec,input,spec.ladder.at(-1),'calibration-warmup',i));
      const warmupBodyMs=rows.reduce((s,x)=>s+x.durationMs,0);await emit({kind:'calibration-diagnostics',case:spec.id,warmupBodyMs,insufficientWarmup:warmupBodyMs<p.calibration.minimumWarmupBodyMs});
      for(const operations of spec.ladder)for(let sample=0;sample<p.calibration.samplesPerLevel;sample++)rows.push(await chunk(spec,input,operations,'calibration',sample));
    }else{
      const work=config.work[spec.id];check(work&&spec.ladder.includes(work.operations));
      for(let sample=0;sample<p.measurement.warmupChunks;sample++)rows.push(await chunk(spec,input,work.operations,'warmup',sample));
      for(let sample=0;sample<p.measurement.samples;sample++)rows.push(await chunk(spec,input,work.operations,'measurement',sample));
      const warm=rows.filter(x=>x.phase==='warmup').map(x=>x.durationMs),measured=rows.filter(x=>x.phase==='measurement'),window=p.measurement.warmupComparisonWindow;
      const relativeWarmupDrift=median(warm.slice(-window))/median(warm.slice(-2*window,-window))-1,warmupBodyMs=warm.reduce((a,b)=>a+b,0),stats=summary(measured.map(x=>x.nsPerOperation));
      await emit({kind:'diagnostics',case:spec.id,calibrationFloor:!work.targetMet,calibrationWarmupFlag:work.calibrationWarmupFlag,minimumDurationFloor:measured.some(x=>x.durationMs<p.measurement.minimumChunkMs),warmupBodyMs,insufficientWarmup:warmupBodyMs<p.measurement.minimumWarmupBodyMs,relativeWarmupDrift,warmupFlag:Math.abs(relativeWarmupDrift)>p.measurement.warmupDriftFraction,variabilityFlag:stats.relativeMad>p.statistics.sampleRelativeMadDiagnosticFraction});
    }
    await emit({kind:'case-complete',case:spec.id,chunks:rows.length,inputDigest});
  }
  api.resetSharedList();await io.collect();await io.memory();await emit({kind:'complete',chunks,operationClocks:timed});
}
