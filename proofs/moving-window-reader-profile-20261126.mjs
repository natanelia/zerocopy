// Read-only attribution study. No changes to production source or cache policy.
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { Session } from 'node:inspector';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import * as z from '../dist/shared.js';
import { entriesFor, productId, product } from '../website/assets/catalog-core.mjs';
const base='d57fc413ee5f67d0839f5a3a8ff36f4a51fb0341';
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function median(xs){const a=[...xs].sort((a,b)=>a-b),i=a.length>>1;return a.length%2?a[i]:(a[i-1]+a[i])/2;}
function verify(values,expected){
  assert.equal(values.length,expected.length);
  for(let i=0;i<values.length;i++){
    const v=values[i];assert.equal(JSON.stringify(v),expected[i]);
    assert(Object.isFrozen(v)&&Object.isFrozen(v.metadata)&&Object.isFrozen(v.metadata.tags)&&Object.isFrozen(v.attributes));
  }
}
function time(fn){const t=performance.now(),values=fn();return {ms:performance.now()-t,values};}
function post(s,method,params={}){return new Promise((resolve,reject)=>s.post(method,params,(err,data)=>err?reject(err):resolve(data)));}
async function profile(fn,expected){
  const session=new Session();session.connect();
  let iterations=0,last,profile;
  try{
    await post(session,'Profiler.enable');
    await post(session,'Profiler.setSamplingInterval',{interval:500});
    await post(session,'Profiler.start');
    const deadline=performance.now()+1200;
    do{last=fn();iterations++;}while(performance.now()<deadline);
    ({profile}=await post(session,'Profiler.stop'));
    verify(last,expected);
    assert(profile.samples?.length>0);
    return {iterations,profile};
  }finally{session.disconnect();}
}
if(!isMainThread){
  parentPort.once('message',async m=>{
    try{
      const {map}=await z.initWorker(m.payload);
      const count=Math.min(1000,Math.floor(m.n/2)),start=m.n-count;
      const keys=Array.from({length:count},(_,i)=>productId(start+i));
      const expected=Array.from({length:count},(_,i)=>JSON.stringify(product(start+i)));
      // Match baseline first-touch history. At 1k this is an admitted control.
      for(let i=0;i<Math.min(4000,start);i++)map.get(productId(i));
      const first=keys.map(k=>map.get(k));verify(first,expected);
      const a=map.arena, view=a.dv;
      // This is a diagnostic upper bound on removing lookup overhead, not a
      // public API or candidate. All arms resolve addresses before timing.
      const leaves=keys.map(k=>a.find(map.root,k));assert(leaves.every(Boolean));
      const viaGet=()=>keys.map(k=>map.get(k));
      const viaLeaf=()=>leaves.map(p=>a.leafValue('object',p,0,view));
      const direct=m.arm==='leaf';
      const fn=direct?viaLeaf:viaGet;
      const rounds=[],refs=[],nestedRefs=[];
      for(let i=0;i<15;i++){
        const {ms,values}=time(fn);rounds.push(ms);verify(values,expected);
        refs.push(values.reduce((s,v,j)=>s+Number(v===first[j]),0));
        nestedRefs.push(values.reduce((s,v,j)=>s+Number(v.metadata===first[j].metadata),0));
      }
      const admitted=m.n===1000?count:0;
      assert(refs.every(x=>x===admitted)&&nestedRefs.every(x=>x===admitted),'unexpected identity behavior');
      // Profile separately so profiler overhead is absent from timings.
      const p=m.profile?await profile(fn,expected):undefined;
      parentPort.postMessage({rounds,refs,nestedRefs,count,verified:true,profile:p});
    }catch(e){parentPort.postMessage({error:String(e?.stack??e)});}
  });
}else{
  const out=process.argv[2];assert(out);mkdirSync(out,{recursive:true});
  const report={base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:process.versions,cpu:cpus()[0]?.model,
    hashes:Object.fromEntries(['arena.ts','freeze-json.ts','utf8.ts','read-cache.ts','shared-map.ts','dist/shared.js','persistent-core.wasm'].map(p=>[p,sha(p)])),samples:[]};
  async function sample(n,cohort,pair,arm,payload,profile=false){
    const w=new Worker(new URL(import.meta.url));
    try{
      const result=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('worker timeout')),60000);
        w.on('error',e=>{clearTimeout(timer);reject(e);});
        w.on('exit',code=>{if(code!==0){clearTimeout(timer);reject(Error('worker exit '+code));}});
        w.once('message',m=>{clearTimeout(timer);m.error?reject(Error(m.error)):resolve(m);});
        w.postMessage({n,arm,payload,profile});
      });
      assert(result.verified);const p=result.profile;delete result.profile;
      const row={n,cohort,pair,arm,...result,medianMs:median(result.rounds.slice(3))};
      if(p){
        const name=n+'-'+arm+'.cpuprofile';
        writeFileSync(out+'/'+name,JSON.stringify(p.profile));
        row.profileFile=name;row.profileIterations=p.iterations;
      }
      report.samples.push(row);console.log(JSON.stringify(row));return row;
    }finally{await w.terminate();}
  }
  for(const n of [1000,10000,100000]){
    z.resetMap();const map=new z.SharedMap('object').setMany(entriesFor(n));
    const payload=z.getWorkerData({map},{copy:false});
    for(let pair=-1;pair<7;pair++){
      for(const cohort of (pair%2===0?['AB','AA']:['AA','AB'])){
        const arms=cohort==='AB'?['get','leaf']:['get','control'];
        for(const arm of (pair%2===0?arms:arms.slice().reverse()))await sample(n,cohort,pair,arm,payload);
      }
    }
    if(n===100000)for(const arm of ['get','leaf'])await sample(n,'profile',-1,arm,payload,true);
    writeFileSync(out+'/raw.json',JSON.stringify(report));
  }
}
