// Proof only. Compare opt-in bounded FIFO admission with default ordinary get.
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { entriesFor, productId, product } from '../website/assets/catalog-core.mjs';
const base='d57fc413ee5f67d0839f5a3a8ff36f4a51fb0341';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const med=xs=>{const a=[...xs].sort((a,b)=>a-b),i=a.length>>1;return a.length%2?a[i]:(a[i-1]+a[i])/2;};
const ids=(start,count)=>Array.from({length:count},(_,i)=>productId(start+i));
function edits(n){const k=Math.min(100,n);return Array.from({length:k},(_,i)=>[productId(n-k+i),product(n-k+i,1)]);}
function check(values,keys,oracle){
 for(let i=0;i<keys.length;i++){
  const expected=oracle.get(keys[i]);
  if(expected===undefined&&keys[i].startsWith('missing/')){assert.equal(values[i],undefined);continue;}
  const v=values[i];assert.equal(JSON.stringify(v),expected??JSON.stringify(product(Number(keys[i].slice(8)))),keys[i]);
  assert(Object.isFrozen(v)&&Object.isFrozen(v.metadata)&&Object.isFrozen(v.metadata.tags)&&Object.isFrozen(v.attributes));
 }
}
function bounds(map){
 const a=map.arena;
 assert(a.objects.size<=2048&&a.objectBytes>=0&&a.objectBytes<=2097152);
 const q=a.windowEviction;
 if(q){
  assert(q.count>=0&&q.count<=2048&&q.count<=a.objects.size);
  assert.equal(q.slots.length,2048);
  // FIFO metadata must represent exactly the live ordinary JSON records.
  const queued=new Set(Array.from({length:q.count},(_,i)=>q.slots[(q.head+i)%2048]));
  assert.equal(queued.size,q.count);
  assert.deepEqual(queued,new Set([...a.objects].filter(([,v])=>v.jsonLength>=0).map(([p])=>p)));
 }
 return {entries:a.objects.size,jsonBytes:a.objectBytes,keyEntries:a.objectKeys?.size??0,adaptiveActive:!!q,heapUsed:process.memoryUsage().heapUsed};
}
if(!isMainThread){
 parentPort.once('message',async m=>{
  try{
   const z=await import(m.arm==='base'||m.arm==='control'?'../baseline-dist/shared.js':'../dist/shared.js');
   const adaptive=m.arm==='adaptive';
   const t=performance.now(),initial=await z.initWorker(m.initial);
   if(adaptive)initial.map.arena.enableExperimentalWindowCache();
   const attachMs=performance.now()-t, map=initial.map, n=m.n, size=Math.min(1000,Math.floor(n/4));
   const original=new Map(), changed=new Map(edits(n).map(([k,v])=>[k,JSON.stringify(v)]));
   const measurements=[], memory=[];
   function query(reader,keys,label,oracle){
    const t=performance.now(),values=keys.map(k=>reader.get(k)),ms=performance.now()-t;
    check(values,keys,oracle);
    measurements.push({label,ms,count:keys.length});
    memory.push(bounds(reader));
    return values;
   }
   const prefill=ids(0,Math.min(4000,n-size));
   query(map,prefill,'prefill',original);
   parentPort.postMessage({kind:'first',attachMs,firstQueryMs:measurements[0].ms});
   const saved=map.get(prefill[0]),hot=ids(n-size,size);
   const first=query(map,hot,'first-hot',original);
   for(let i=0;i<6;i++){
    const values=query(map,hot,'repeat-hot',original);
    if(!adaptive&&n>=10000)assert(values.every((v,j)=>v!==first[j]&&v.metadata!==first[j].metadata));
    if(adaptive||n===1000)assert(values.every((v,j)=>v===first[j]));
   }
   // Moving viewport, overlapping by 50%, then a return to the original window.
   for(let step=1;step<=5;step++){
    const keys=ids(Math.max(0,n-size-Math.floor(size/2)*step),size);
    query(map,keys,'pan-first',original);
    for(let r=0;r<4;r++)query(map,keys,'pan-repeat',original);
   }
   query(map,hot,'return-hot',original);
   // Uniform scatter, including misses, to expose overhead outside local reads.
   const scatter=Array.from({length:Math.min(n,4000)},(_,i)=>i%13===0?'missing/'+i:productId((i*7919)%n));
   query(map,scatter,'scatter',original);
   if(!adaptive)assert.equal(map.get(prefill[0]),saved,'default admitted identity changed');
   const start=performance.now(),next=await z.initWorker(m.updated,{previous:initial});
   if(adaptive)next.map.arena.enableExperimentalWindowCache();
   const reattachMs=performance.now()-start;
   query(next.map,hot,'publication-first',changed);
   for(let i=0;i<4;i++)query(next.map,hot,'publication-repeat',changed);
   query(map,hot,'old-after-publication',original);
   assert.throws(()=>next.map.set(hot[0],{}),/read-only/);
   if(adaptive){
    assert.equal(!!map.arena.windowEviction,n>=10000,'unexpected activation history');
    if(map.arena.windowEviction)assert.equal(map.arena.objectKeys,undefined,'eviction retained a second key-to-object reference');
    assert.equal(next.map.arena.windowEviction,undefined,'fresh reader should keep fast admitted hits');
   }
   parentPort.postMessage({kind:'done',measurements,memory,reattachMs,verified:true});
  }catch(error){parentPort.postMessage({kind:'error',error:String(error?.stack??error)});}
 });
}else{
 const out=process.argv[2];assert(out);
 const z=await import('../baseline-dist/shared.js');
 const report={base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:process.versions,cpu:cpus()[0]?.model,
 hashes:Object.fromEntries(['arena.ts','baseline-dist/shared.js','dist/shared.js','persistent-core.wasm'].map(p=>[p,hash(p)])),samples:[]};
 async function sample(n,cohort,pair,arm,initial,updated){
  const start=performance.now(),worker=new Worker(new URL(import.meta.url));let first;
  try{
   const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('worker timeout')),60000);
    worker.on('error',e=>{clearTimeout(timer);reject(e);});
    worker.on('message',m=>{
     if(m.kind==='first')first={...m,workerToFirstMs:performance.now()-start};
     if(m.kind==='error'){clearTimeout(timer);reject(Error(m.error));}
     if(m.kind==='done'){clearTimeout(timer);resolve(m);}
    });
    worker.postMessage({n,arm,initial,updated});
   });
   assert(first&&result.verified);
   const summaries={};
   for(const label of new Set(result.measurements.map(m=>m.label)))summaries[label]=med(result.measurements.filter(m=>m.label===label).map(m=>m.ms));
   const row={n,cohort,pair,arm,...first,...result,summaries,
     sourceUsedBytes:updated.arenas[0].used,peakObservedHeap:Math.max(...result.memory.map(x=>x.heapUsed))};
   report.samples.push(row);console.log(JSON.stringify(row));
  }finally{await worker.terminate();}
 }
 for(const n of [1000,10000,100000]){
  z.resetMap();const map=new z.SharedMap('object').setMany(entriesFor(n)),updatedMap=map.setMany(edits(n));
  const initial=z.getWorkerData({map},{copy:false}),updated=z.getWorkerData({map:updatedMap},{copy:false});
  for(let pair=-1;pair<7;pair++){
   for(const cohort of (pair%2===0?['AB','AA','default']:['default','AA','AB'])){
    if(cohort!=='AB'&&pair>=3)continue;
    const arms=cohort==='AB'?['base','adaptive']:cohort==='AA'?['base','control']:['base','disabled'];
    for(const arm of (pair%2===0?arms:arms.slice().reverse()))await sample(n,cohort,pair,arm,initial,updated);
   }
  }
  writeFileSync(out,JSON.stringify(report));
 }

 // Untimed mixed/nested/oversized control; separate from paired measurements.
 const candidate=await import('../dist/shared.js');
 for(const copy of [false,true]){
  candidate.resetMap();
  const owner=new candidate.SharedMap('object');
  const a=owner.arena;
  const child=new candidate.SharedList('number').push(42);
  const nested=new candidate.SharedMap('SharedList<number>',0,0,a).set('child',child);
  const data=owner.setMany(Array.from({length:5000},(_,i)=>['key/'+i,{i,nested:[i]}]))
    .set('large',{pad:'x'.repeat(2097152)}).set('道路/🚗',{value:1}).set('null',null);
  const attached=await candidate.initWorker(candidate.getWorkerData({data,nested},{copy}));
  const reader=attached.data.arena;
  assert.equal(reader,attached.nested.arena);
  reader.enableExperimentalWindowCache();
  const held=attached.nested.get('child');
  const old=attached.data.get('key/0');
  const oversized=attached.data.get('large');
  assert.equal(reader.windowEviction,undefined,'oversized miss must not trigger eviction');
  assert.notEqual(oversized,attached.data.get('large'));
  for(let i=1;i<5000;i++)assert.deepEqual(attached.data.get('key/'+i),{i,nested:[i]});
  assert(reader.windowEviction);
  assert.equal(attached.nested.get('child'),held);
  assert.equal(held.get(0),42);
  assert.deepEqual(old,{i:0,nested:[0]});
  assert.notEqual(attached.data.get('key/0'),old);
  assert.equal(attached.data.get('null'),null);
  assert.deepEqual(attached.data.get('道路/🚗'),{value:1});
  bounds(attached.data);
 }
 console.error('Mixed/nested/oversized cache qualification passed');
}
