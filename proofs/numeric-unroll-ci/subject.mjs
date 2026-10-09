// Public numeric subject. Importing this file never imports an arm or reads a clock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {median, summary} from './math.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest = value => createHash('sha256').update(value).digest('hex');
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
export const SIMD_PROBE = Object.freeze([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]);
export const SCALAR_ALIAS = '?numeric-unroll-scalar-control';

export function fixture(spec) {
  const spatial = spec.operation === 'countPointsInBox';
  const entries = Object.freeze(Array.from({length:spec.size}, (_,i) => spatial
    ? (i & 1 ? ((Math.floor(i/2)*29+96)%193)-96 : ((Math.floor(i/2)*17+128)%257)-128)
    : ((i*17+128)%257)-128));
  const queries = spatial
    ? [[-32,-24,32,24],[200,200,220,220],[-128,-96,128,96],[0,0,0,0]].map(([minX,minY,maxX,maxY])=>Object.freeze({minX,minY,maxX,maxY}))
    : [[-32,32],[200,220],[-128,128],[0,0]].map(Object.freeze);
  Object.freeze(queries);
  const expected = Object.freeze(queries.map(q => {
    let count=0;
    if (spatial) {
      for(let i=0;i<entries.length;i+=2) count += Number(entries[i]>=q.minX && entries[i]<=q.maxX && entries[i+1]>=q.minY && entries[i+1]<=q.maxY);
    } else for(const value of entries) count += Number(value>=q[0] && value<=q[1]);
    return count;
  }));
  return {entries,queries,expected,inputDigest:digest([entries,queries])};
}
export function expectedChecksum(input, operations) {
  const count=Math.floor(operations/4)*input.expected.reduce((a,b)=>a+b,0)+input.expected.slice(0,operations%4).reduce((a,b)=>a+b,0);
  assert(Number.isSafeInteger(count)); return count;
}
export function rangeAutoBody(api, list, queries, operations) {
  let checksum=0,last=0;
  for(let i=0;i<operations;i++) { const q=queries[i&3]; last=api.countInRange(list,q[0],q[1]); checksum+=last; }
  return {checksum,last};
}
export function rangeScalarBody(api, list, queries, operations) {
  let checksum=0,last=0;
  for(let i=0;i<operations;i++) { const q=queries[i&3]; last=api.countInRange(list,q[0],q[1]); checksum+=last; }
  return {checksum,last};
}
export function spatialBody(api, list, queries, operations) {
  let checksum=0,last=0;
  for(let i=0;i<operations;i++) { last=api.countPointsInBox(list,queries[i&3]); checksum+=last; }
  return {checksum,last};
}
export function selectionGuard(automatic, scalar, seed, wasm = WebAssembly) {
  assert.notEqual(automatic.countInRange,scalar.countInRange,'Alias must have an independent module closure');
  assert.notEqual(automatic.countPointsInBox,scalar.countPointsInBox);
  const original=wasm.validate;
  const counts={automatic:0,scalar:0,repeated:0};
  try {
    wasm.validate=bytes=>{
      assert.deepEqual(Array.from(bytes),SIMD_PROBE,'Only the existing known probe may be observed');
      counts.automatic++; assert.equal(counts.automatic,1);
      const result=original.call(wasm,bytes); assert.equal(result,true,'Automatic SIMD selection required'); return result;
    };
    assert.equal(automatic.countInRange(seed,0,0),1);
    wasm.validate=bytes=>{
      assert.deepEqual(Array.from(bytes),SIMD_PROBE,'Only the existing known probe may be forced');
      counts.scalar++; assert.equal(counts.scalar,1); return false;
    };
    assert.equal(scalar.countInRange(seed,0,0),1);
    wasm.validate=()=>{ counts.repeated++; throw new Error('Selection must already be cached in both closures'); };
    assert.equal(automatic.countInRange(seed,0,0),1);
    assert.equal(scalar.countInRange(seed,0,0),1);
  } finally { wasm.validate=original; }
  assert.deepEqual(counts,{automatic:1,scalar:1,repeated:0});
  assert.equal(wasm.validate,original);
  return {automatic:'SIMD',scalar:'forced scalar',...counts,validateRestored:true,fixedAlias:SCALAR_ALIAS,firstUseMeasured:false};
}
export function clockFor(mode, clock=performance) {
  assert(['untimed','calibrate','measure'].includes(mode));
  if(mode==='untimed') return ()=>{throw new Error('Untimed subject forbids operation clocks');};
  return ()=>clock.now();
}
export function workCounts(spec, mode, work) {
  if(mode==='untimed') return [spec.ladder[0],spec.ladder.at(-1)];
  assert(work && spec.ladder.includes(work.operations)); return [work.operations];
}
export function requireTimedAdmission(config, directory) {
  if(config.mode==='untimed') return;
  const admission=JSON.parse(readFileSync(path.join(directory,'admission.json')));
  const manifest=JSON.parse(readFileSync(path.join(directory,'manifest.json')));
  assert.equal(admission.mode,'ci-screen'); assert.equal(admission.promotionAllowed,false);
  assert.deepEqual(admission.fullStandardGateStatus,{baseline:'passed-fresh-exact-source',candidate:'passed-fresh-exact-source'});
  assert.equal(admission.standardCommandsPerArm,23); assert.equal(admission.numericCommandsPerArm,9);
  assert.equal(admission.firstUseStatus,'unresolved');
  assert(['baseline','candidate'].includes(config.arm));
  assert.equal(path.resolve(config.entrypoint),path.join(manifest.sources[config.arm].path,'dist/shared.js'));
}
function snapshot(list) {
  const a=list.arena;
  return {root:list.root,depth:list.depth,tail:list.tail,size:list.size,type:list.type,
    used:a.used,capacity:a.memory.buffer.byteLength,memoryDigest:bytesDigest(new Uint8Array(a.memory.buffer))};
}

export async function runSubject(config) {
  const protocol=JSON.parse(readFileSync(new URL('./protocol.json',import.meta.url),'utf8'));
  assert(['untimed','calibrate','measure'].includes(config.mode));
  assert(['baseline','candidate'].includes(config.arm));
  assert.equal(process.platform,'linux'); assert.equal(process.arch,protocol.architecture);
  const runtime=typeof Bun==='undefined'?'node':'bun';
  assert.equal(runtime,config.runtime);
  assert.equal(runtime==='node'?process.version:Bun.version,protocol.runtimeVersions[runtime]);
  requireTimedAdmission(config,path.dirname(fileURLToPath(import.meta.url)));
  const timed=config.mode!=='untimed';
  const now=clockFor(config.mode);
  if(!timed) Object.defineProperty(performance,'now',{configurable:true,value:now});
  const api=await import(pathToFileURL(config.entrypoint).href);
  api.configureMemory({maximumBytes:protocol.memory.maximumArenaBytes});
  const numericURL=new URL('./numeric.js',pathToFileURL(config.entrypoint));
  const automatic=await import(numericURL.href);
  const scalar=await import(numericURL.href+SCALAR_ALIAS);
  const collect=runtime==='bun'?()=>Bun.gc(true):()=>{assert.equal(typeof globalThis.gc,'function');globalThis.gc();};
  let seed=new api.SharedList('number').pushMany([0]);
  const selection=selectionGuard(automatic,scalar,seed);
  seed=null; api.resetSharedList(); collect();
  let highRss=0,chunks=0;
  function memory() {
    const m=process.memoryUsage(); highRss=Math.max(highRss,m.rss);
    assert(m.rss<=protocol.memory.maximumSubjectRssBytes,'Subject RSS limit'); return m;
  }
  function chunk(spec,input,operations,phase) {
    assert(spec.ladder.includes(operations));
    api.resetSharedList(); collect(); memory();
    let list=new api.SharedList('number').pushMany(input.entries);
    const selected=spec.mode==='scalar'?scalar:automatic;
    const body=spec.operation==='countPointsInBox'?spatialBody:spec.mode==='scalar'?rangeScalarBody:rangeAutoBody;
    const before=snapshot(list), treeSize=(spec.size-1)&~31, tailSize=spec.size-treeSize;
    let owner=list.arena;
    assert.equal(list.size,spec.size); assert.equal(list.type,'number');
    assert.equal(list.root===0,treeSize===0);
    assert(list.tail>=65536 && list.tail+tailSize*8<=before.used);
    assert(before.capacity<=protocol.memory.maximumArenaBytes);
    assert(tailSize>=1 && tailSize<=32);
    // Prime this Arena's instance, then verify every fixed query outside timing.
    for(let q=0;q<4;q++) {
      const actual=spec.operation==='countPointsInBox'?selected.countPointsInBox(list,input.queries[q]):selected.countInRange(list,...input.queries[q]);
      assert.equal(actual,input.expected[q]);
    }
    assert.deepEqual(snapshot(list),before); collect();
    const started=timed?now():null;
    const result=body(selected,list,input.queries,operations);
    const durationMs=timed?now()-started:null;
    assert.equal(result.checksum,expectedChecksum(input,operations));
    assert.equal(result.last,input.expected[(operations-1)&3]);
    const after=snapshot(list); assert.deepEqual(after,before); assert.equal(list.arena,owner);
    for(let i=0;i<input.entries.length;i++) assert.equal(list.get(i),input.entries[i]);
    assert.deepEqual(snapshot(list),before);
    assert.equal(digest([input.entries,input.queries]),input.inputDigest);
    const afterValidation=memory();
    list=null; owner=null; api.resetSharedList(); collect(); const afterCleanup=memory(); chunks++;
    return {phase,operation:spec.operation,selection:spec.mode,operations,durationMs,
      nsPerOperation:timed?durationMs*1e6/operations:null,
      checksum:result.checksum,lastResult:result.last,queryCounts:input.expected,
      valuesPerCall:spec.size,pointsPerCall:spec.points??null,treeSize,tailSize,
      before,after,liveArenaCapacityBytes:before.capacity,afterValidation,afterCleanup};
  }
  emit({kind:'start',mode:config.mode,runtime,version:runtime==='node'?process.version:Bun.version,
    pid:process.pid,arch:process.arch,selection,operationClockBlocked:!timed,firstUseStatus:'unresolved'});
  const offset=config.block??0;
  const cases=[...protocol.cases.slice(offset),...protocol.cases.slice(0,offset)];
  for(const spec of cases) {
    const input=fixture(spec),rows=[];
    if(config.mode==='untimed') {
      const [minimum,maximum]=workCounts(spec,config.mode);
      rows.push(chunk(spec,input,minimum,'untimed-minimum'));
      rows.push(chunk(spec,input,maximum,'untimed-maximum'));
    } else if(config.mode==='calibrate') {
      for(let i=0;i<protocol.calibration.warmupChunks;i++) rows.push(chunk(spec,input,spec.ladder.at(-1),'calibration-warmup'));
      const warmupBodyMs=rows.reduce((sum,x)=>sum+x.durationMs,0);
      emit({kind:'calibration-diagnostics',case:spec.id,warmupBodyMs,insufficientWarmup:warmupBodyMs<protocol.calibration.minimumWarmupBodyMs});
      for(const operations of spec.ladder) for(let sample=0;sample<protocol.calibration.samplesPerLevel;sample++) rows.push({...chunk(spec,input,operations,'calibration'),sample});
    } else {
      const work=config.work[spec.id]; workCounts(spec,config.mode,work);
      for(let sample=0;sample<protocol.measurement.warmupChunks;sample++) rows.push({...chunk(spec,input,work.operations,'warmup'),sample});
      for(let sample=0;sample<protocol.measurement.samples;sample++) rows.push({...chunk(spec,input,work.operations,'measurement'),sample});
      const warm=rows.filter(x=>x.phase==='warmup').map(x=>x.durationMs),measured=rows.filter(x=>x.phase==='measurement');
      const window=protocol.measurement.warmupComparisonWindow;
      const relativeWarmupDrift=median(warm.slice(-window))/median(warm.slice(-2*window,-window))-1;
      const warmupBodyMs=warm.reduce((a,b)=>a+b,0),stats=summary(measured.map(x=>x.nsPerOperation));
      emit({kind:'diagnostics',case:spec.id,calibrationFloor:!work.targetMet,calibrationWarmupFlag:work.calibrationWarmupFlag,
        minimumDurationFloor:measured.some(x=>x.durationMs<protocol.measurement.minimumChunkMs),warmupBodyMs,
        insufficientWarmup:warmupBodyMs<protocol.measurement.minimumWarmupBodyMs,relativeWarmupDrift,
        warmupFlag:Math.abs(relativeWarmupDrift)>protocol.measurement.warmupDriftFraction,
        variabilityFlag:stats.relativeMad>protocol.statistics.sampleRelativeMadDiagnosticFraction,stats});
    }
    emit({kind:'case',case:spec.id,operation:spec.operation,unit:spec.unit,itemsPerOperation:spec.itemsPerOperation,
      inputDigest:input.inputDigest,queryCounts:input.expected,inputEntries:input.entries.length,rows});
  }
  api.resetSharedList(); collect(); memory();
  emit({kind:'complete',chunks,highRss,resourceUsage:process.resourceUsage(),resourceUnits:protocol.resourceUnits,operationClocks:timed,firstUseStatus:'unresolved'});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await runSubject(JSON.parse(readFileSync(process.argv[2],'utf8')));
