// Baseline only: fresh real Node reader, first-touch saturation, later hot window,
// retained snapshots across sparse updates. No monkeypatches inside timing.
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import * as z from '../dist/shared.js';
import { entriesFor, productId, product, editsFor } from '../website/assets/catalog-core.mjs';

const base='d57fc413ee5f67d0839f5a3a8ff36f4a51fb0341';
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function ids(n,phase){
  // Disjoint, spatially localized regions with realistic nearby queries.
  const count=Math.min(1000,Math.floor(n/2));
  const first=phase==='hot'?n-count:0;
  return Array.from({length:count},(_,i)=>productId(first+i));
}
function assertValues(values,keys,updated){
  for(let i=0;i<keys.length;i++){
    const index=Number(keys[i].slice(8)),expected=updated.get(keys[i])??product(index);
    assert.equal(JSON.stringify(values[i]),JSON.stringify(expected),keys[i]);
    assert(Object.isFrozen(values[i])&&Object.isFrozen(values[i].metadata)&&Object.isFrozen(values[i].metadata.tags));
  }
}
function measure(map,keys){
  const t=performance.now(), result=keys.map(k=>map.get(k));
  return {ms:performance.now()-t,result};
}
if(!isMainThread){
  parentPort.on('message',async m=>{
    try{
      const t=performance.now();
      let previous;
      const initial=await z.initWorker(m.initial);
      const attachMs=performance.now()-t;
      const keys=ids(m.n,'hot'),prefill=Array.from({length:Math.min(4000,m.n-keys.length)},(_,i)=>productId(i));
      const first=measure(initial.map,m.mode==='saturated'?prefill:keys);
      // Report a useful initial answer before the longer warm-query exercise.
      assertValues(first.result,m.mode==='saturated'?prefill:keys,new Map());
      parentPort.postMessage({kind:'first',attachMs,firstQueryMs:first.ms,count:first.result.length});
      const firstHot=measure(initial.map,keys);assertValues(firstHot.result,keys,new Map());
      const rounds=[], sameRefs=[];
      for(let i=0;i<12;i++){
        const x=measure(initial.map,keys);rounds.push(x.ms);
        sameRefs.push(x.result.reduce((sum,v,j)=>sum+Number(v===firstHot.result[j]),0));
        assertValues(x.result,keys,new Map());
      }
      const t2=performance.now();
      previous=await z.initWorker(m.updated,{previous:initial});
      const reattachMs=performance.now()-t2;
      const edited=measure(previous.map,keys);
      const oracle=new Map(editsFor(m.n,1));assertValues(edited.result,keys,oracle);
      assertValues(measure(initial.map,keys).result,keys,new Map());
      assert.throws(()=>previous.map.set(keys[0],{}),/read-only/);
      const reuse=edited.result.reduce((sum,v,j)=>sum+Number(v===firstHot.result[j]),0);
      parentPort.postMessage({kind:'done',firstHotMs:firstHot.ms,repeatMs:rounds,sameRefs,reattachMs,editedMs:edited.ms,reusedAfterPublication:reuse,
        hotCount:keys.length,heapUsed:process.memoryUsage().heapUsed,verified:true});
    }catch(error){parentPort.postMessage({kind:'error',error:String(error?.stack??error)});}
  });
}else{
  const out=process.argv[2];assert(out);
  const report={base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:process.versions,cpu:cpus()[0]?.model,
    hashes:Object.fromEntries(['arena.ts','read-cache.ts','shared-map.ts','dist/shared.js','persistent-core.wasm'].map(p=>[p,sha(p)])),samples:[]};
  async function sample(n,mode,cohort,pair,arm,initial,updated,used){
    const start=performance.now(), worker=new Worker(new URL(import.meta.url));
    let first;
    try{
      const result=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('worker timeout')),30000);
        worker.on('error',e=>{clearTimeout(timer);reject(e);});
        worker.on('exit',code=>{if(code!==0){clearTimeout(timer);reject(Error('worker exit '+code));}});
        worker.on('message',m=>{
          if(m.kind==='first')first={...m,workerToFirstMs:performance.now()-start};
          if(m.kind==='error'){clearTimeout(timer);reject(Error(m.error));}
          if(m.kind==='done'){clearTimeout(timer);resolve(m);}
        });
        worker.postMessage({n,mode,initial,updated});
      });
      assert(first&&result.verified);
      return {n,mode,cohort,pair,arm,...first,...result,sourceUsedBytes:used};
    }finally{await worker.terminate();}
  }
  for(const n of [1000,10000,100000]){
    z.resetMap();
    const map=new z.SharedMap('object').setMany(entriesFor(n)), changed=map.setMany(editsFor(n,1));
    const initial=z.getWorkerData({map},{copy:false}),updated=z.getWorkerData({map:changed},{copy:false});
    const used=updated.arenas[0].used;
    for(let pair=-1;pair<7;pair++){
      // A/B compares identical runtime under different access histories, not
      // baseline versus a candidate. A/A runs identical saturation histories.
      for(const cohort of (pair%2===0?['history','AA']:['AA','history'])){
        const arms=cohort==='history'?[['fresh','fresh'],['saturated','saturated']]:[['base','saturated'],['control','saturated']];
        for(const [arm,mode] of (pair%2===0?arms:arms.slice().reverse())){
          const row=await sample(n,mode,cohort,pair,arm,initial,updated,used);
          report.samples.push(row);console.log(JSON.stringify(row));
        }
      }
    }
    writeFileSync(out,JSON.stringify(report));
  }
}
