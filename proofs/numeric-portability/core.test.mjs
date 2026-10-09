import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fixture,body,expectedChecksum,runCore,selectionGuard,SIMD_PROBE} from './core.mjs';
import {guardEngineSpawn} from './launch-guard.mjs';
import {logInterval,pointwiseDecision} from './math.mjs';
const protocol=JSON.parse(readFileSync(new URL('./protocol.json',import.meta.url))),golden=JSON.parse(readFileSync(new URL('./expected-fixtures.json',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');let checks=0;
for(const spec of protocol.cases){const input=fixture(spec),old=golden.cases[spec.id];assert.equal(sha(JSON.stringify([input.entries,input.queries])),old.inputDigest);assert.deepEqual(input.expected,old.queryCounts);assert.equal(input.entries.length,old.inputEntries);for(const n of spec.ladder){assert(Number.isSafeInteger(expectedChecksum(input,n)));}checks+=8;}
const stats=protocol.statistics;assert.equal(pointwiseDecision(logInterval(Array(4).fill(Math.log(1.03)),stats.tCritical),stats,true),'material loss supported in this cell');checks++;
// Only fake API objects and a fake integer clock follow; no library import or Wasm execution.
const originalValidate=WebAssembly.validate;WebAssembly.validate=()=>true;
try{
  const tiny={...protocol,cases:protocol.cases.slice(0,2).map(c=>({...c,ladder:[4,8]}))};
  const create=()=>{
    let rows=[],trace=[],ticks=0,clockReads=0;
    class SharedList{constructor(){this.values=[];this.arena={used:65536,memory:{buffer:new ArrayBuffer(131072)}};this.root=0;this.depth=0;this.tail=65536;this.size=0;this.type='number';}pushMany(values){this.values=[...values];this.size=values.length;this.arena.used+=values.length*8;return this;}get(i){return this.values[i];}}
    const makeNumeric=()=>{let probed=false;const probe=()=>{if(!probed){WebAssembly.validate(new Uint8Array(SIMD_PROBE));probed=true;}};return {countInRange:(list,lo,hi)=>{trace.push('range');probe();return list.values.filter(v=>v>=lo&&v<=hi).length;},countPointsInBox:(list,q)=>{trace.push('spatial');probe();let n=0;for(let i=0;i<list.size;i+=2)n+=Number(list.values[i]>=q.minX&&list.values[i]<=q.maxX&&list.values[i+1]>=q.minY&&list.values[i+1]<=q.maxY);return n;}};};
    const numeric=makeNumeric(),scalar=makeNumeric(),shared={SharedList,configureMemory:()=>{},resetSharedList:()=>{}};
    const io={importModule:async name=>{trace.push('import '+name);return name==='shared.js'?shared:name==='numeric.js'?numeric:scalar;},sha256:sha,emit:row=>{rows.push(row);trace.push('emit '+row.kind+(row.metric?' '+row.metric:''));},now:()=>{clockReads++;ticks+=20;trace.push('clock');return ticks;},memory:()=>({rss:0}),collect:()=>{},gcKind:'synthetic'};
    return {io,rows,trace,get clockReads(){return clockReads;}};
  };
  {
    const startupOnly=create(),times=[1,1.001,2,2.002];startupOnly.io.now=()=>times.shift();
    await runCore({mode:'measure',protocol:tiny,runtime:'synthetic',lane:'x64',warm:false},startupOnly.io);
    const startups=startupOnly.rows.filter(r=>r.kind==='startup');assert.equal(startups.length,3);assert(startups.every(r=>r.durationMs>0&&r.durationMs<5));assert.equal(startupOnly.rows.filter(r=>r.kind==='diagnostics'||r.kind==='chunk').length,0);assert.equal(times.length,0);checks+=4;
  }
  for(const mode of ['untimed','calibrate','measure']){
    const model=create(),config={mode,protocol:tiny,runtime:'synthetic',lane:'x64',warm:true,work:Object.fromEntries(tiny.cases.map(c=>[c.id,{operations:4,targetMet:true,calibrationWarmupFlag:false}]))};
    await runCore(config,model.io);
    assert.deepEqual(model.rows.filter(r=>r.kind==='case-start').map(r=>r.case),tiny.cases.map(c=>c.id));assert.deepEqual(model.rows.map(r=>r.ordinal),model.rows.map((_,i)=>i));
    const chunks=model.rows.filter(r=>r.kind==='chunk');assert.equal(chunks.length,model.rows.filter(r=>r.kind==='chunk-validation').length);
    if(mode==='untimed'){assert.equal(model.clockReads,0);assert.equal(model.rows.filter(r=>r.kind==='startup').length,0);assert.equal(model.rows.find(r=>r.kind==='selection').automatic,'SIMD');}
    if(mode==='measure'){
      const firstSpatial=model.trace.indexOf('spatial');assert(firstSpatial>model.trace.indexOf('emit startup import'));assert(firstSpatial<model.trace.indexOf('range'));
      assert.deepEqual(model.rows.filter(r=>r.kind==='startup').map(r=>[r.metric,r.durationMs]),[['import',20],['first-spatial',20],['sum',40]]);
      assert.equal(model.rows.filter(r=>r.kind==='diagnostics').length,2);
    }
    checks+=9;
  }
}finally{WebAssembly.validate=originalValidate;}
// Model the exact Playwright internal retry: only one engine child may be created.
for(const args of [['--headless','--user-data-dir=/fresh/profile'],['-headless','-profile','/fresh/profile'],['--headless','--inspector-pipe','--user-data-dir=/fresh/profile']]){
  const spawned=[],fake={spawn:(...args)=>{spawned.push(args);return {pid:123,spawnargs:args};}},original=fake.spawn;
  const guard=guardEngineSpawn(fake,{executable:'/engine',profile:'/fresh/profile'});
  fake.spawn('/helper',['--version']);fake.spawn('/engine',['--version']);assert.equal(guard.state.attempts,0);
  fake.spawn('/engine',args);assert.equal(guard.state.attempts,1);
  assert.throws(()=>fake.spawn('/engine',args),/retry forbidden/);assert.equal(spawned.length,3);guard.restore();assert.equal(fake.spawn,original);checks+=5;
}
{const fake={spawn:()=>{throw Error('Unexpected actual spawn');}},guard=guardEngineSpawn(fake,{executable:'/engine',profile:'/fresh/profile'});assert.throws(()=>fake.spawn('/engine',['--headless']),/explicit fresh profile/);guard.restore();checks++;}
console.log(JSON.stringify({syntheticChecks:checks,librarySubjectsExecuted:false,realOperationClocksRead:false}));
