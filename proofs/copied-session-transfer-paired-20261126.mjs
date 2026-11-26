import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { entriesFor, productId, product } from '../website/assets/catalog-core.mjs';

const base='d57fc413ee5f67d0839f5a3a8ff36f4a51fb0341', updates=8, editCount=25;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const equal=(actual,expected)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected));
const sampleMemory=()=>{const m=process.memoryUsage();return {heapUsed:m.heapUsed,arrayBuffers:m.arrayBuffers,external:m.external,rss:m.rss};};
function expected(n,i,version){return product(i,i>=n-editCount?version:0);}
function check(map,n,version,full=false){
 assert.equal(map.size,n);
 const ids=full?Array.from({length:n},(_,i)=>i):[...Array.from({length:75},(_,i)=>Math.floor(i*(n-editCount)/75)),...Array.from({length:editCount},(_,i)=>n-editCount+i)];
 // Time the ordinary query, not the independent oracle or checks.
 const start=performance.now(),values=ids.map(i=>map.get(productId(i))),queryMs=performance.now()-start;
 for(let i=0;i<ids.length;i++){
  equal(values[i],expected(n,ids[i],version));
  assert(Object.isFrozen(values[i]));
 }
 return queryMs;
}
if(!isMainThread){
 const {n,bundle}=workerData;
 const {connectSharedSession}=await import('../'+bundle+'/worker.js');
 let frame;
 parentPort.on('message',m=>{
  if(m?.protocol==='zerocopy/session'&&m.kind==='snapshot'){
   frame={sequence:m.sequence,copyBytes:m.data.arenas.reduce((s,a)=>s+(a.copy?.byteLength??0),0),handles:m.data.arenas.filter(a=>a.memory).length};
  }
 });
 const reader=await connectSharedSession({endpoint:parentPort,channel:'copy-proof',timeoutMs:60000,onError:e=>parentPort.postMessage({proof:'error',error:String(e?.stack??e)})});
 const original=reader.current.map;
 function report(state,sequence){
  try{
   assert.equal(frame.sequence,sequence);
   const queryMs=check(state.map,n,sequence);
   equal(original.get(productId(n-1)),expected(n,n-1,0));
   assert.throws(()=>state.map.set('forbidden',{}),/read-only/);
   parentPort.postMessage({proof:'probe',sequence,queryMs,copyBytes:frame.copyBytes,handles:frame.handles,memory:sampleMemory()});
  }catch(e){parentPort.postMessage({proof:'error',error:String(e?.stack??e)});}
 }
 report(reader.current,reader.version);
 reader.subscribe(report);
 parentPort.on('message',m=>{
  if(m?.proof!=='verify')return;
  try{
   assert.equal(reader.version,updates);
   check(reader.current.map,n,updates,true);
   check(original,n,0,true);
   parentPort.postMessage({proof:'verified',sequence:updates});
  }catch(e){parentPort.postMessage({proof:'error',error:String(e?.stack??e)});}
 });
}else{
 const out=process.argv[2];assert(out);
 const report={base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:process.versions,cpu:cpus()[0]?.model,hashes:Object.fromEntries(['worker.ts','worker-protocol.ts','shared.ts','arena.ts','baseline-dist/shared.js','baseline-dist/worker.js','control-dist/shared.js','control-dist/worker.js','dist/shared.js','dist/worker.js','persistent-core.wasm'].map(p=>[p,hash(p)])),samples:[]};
 assert.equal(report.hashes['baseline-dist/shared.js'],report.hashes['control-dist/shared.js']);
 assert.equal(report.hashes['baseline-dist/worker.js'],report.hashes['control-dist/worker.js']);
 function wait(worker,kind,sequence){
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>finish(Error('Missing '+kind+' '+sequence)),60000);
   const onMessage=m=>{
    if(m?.proof==='error')finish(Error(m.error));
    else if(m?.proof===kind&&m.sequence===sequence)finish(undefined,{...m,received:performance.now()});
   };
   const onExit=code=>finish(Error('Worker exited '+code));
   const finish=(error,value)=>{clearTimeout(timer);worker.off('message',onMessage);worker.off('error',finish);worker.off('exit',onExit);error?reject(error):resolve(value);};
   worker.on('message',onMessage);worker.on('error',finish);worker.on('exit',onExit);
  });
 }
 async function sample(n,cohort,pair,arm,bundle){
  const copy=!arm.endsWith('shared'),transfer=arm==='candidate-transfer';
  const z=await import('../'+bundle+'/shared.js');
  const {createSharedSession}=await import('../'+bundle+'/worker.js');
  z.resetMap();
  const initial=new z.SharedMap('object').setMany(entriesFor(n));
  const errors=[],workers=Array.from({length:2},()=>new Worker(new URL(import.meta.url),{workerData:{n,bundle}}));
  const sent=[0,0];
  for(const [i,w] of workers.entries()){
   const native=w.postMessage;
   w.postMessage=function(...args){
    const frame=args[0];
    if(frame?.protocol==='zerocopy/session'&&frame.kind==='snapshot'){
     sent[i]++;
     if(transfer){
      assert.equal(args.length,2);
      const buffers=frame.data.arenas.map(a=>a.copy.buffer);
      assert.deepEqual(args[1],buffers);
      assert(buffers.every(b=>b.byteLength>0&&b instanceof ArrayBuffer));
      const result=native.apply(this,args);
      assert(buffers.every(b=>b.byteLength===0),'per-peer copies must be detached after posting');
      return result;
     }
     assert.equal(args.length,1,'default endpoint contract must remain one argument');
    }
    return native.apply(this,args);
   };
  }
  const session=createSharedSession({map:initial},{copy,channel:'copy-proof',delivery:'all',timeoutMs:60000,onError:e=>errors.push(String(e))});
  const rows=[];
  try{
   const first=workers.map(w=>wait(w,'probe',0)),start=performance.now();
   const connected=session.connect(workers,transfer?{transferCopies:true}:{});
   const firstRows=await Promise.all(first);await connected;
   const firstUsed=z.getWorkerData({map:initial},{copy:false}).arenas[0].used;
   for(const r of firstRows){assert.equal(r.copyBytes,copy?firstUsed:0);assert.equal(r.handles,copy?0:1);}
   const initialMs=Math.max(...firstRows.map(r=>r.received))-start;
   let map=initial;
   for(let sequence=1;sequence<=updates;sequence++){
    map=map.setMany(Array.from({length:editCount},(_,i)=>[productId(n-editCount+i),product(n-editCount+i,sequence)]));
    const used=z.getWorkerData({map},{copy:false}).arenas[0].used;
    const replies=workers.map(w=>wait(w,'probe',sequence));
    const t=performance.now(),version=session.publish({map}),publishMs=performance.now()-t;
    assert.equal(version,sequence);
    const responses=await Promise.all(replies);
    for(const r of responses){
     assert.equal(r.copyBytes,copy?used:0);
     assert.equal(r.handles,0);
    }
    rows.push({sequence,used,publishMs,roundTripMs:Math.max(...responses.map(r=>r.received))-t,readers:responses.map(({received,...r})=>({...r,roundTripMs:received-t})),ownerMemory:sampleMemory()});
   }
   const verified=workers.map(w=>wait(w,'verified',updates));
   workers.forEach(w=>w.postMessage({proof:'verify'}));await Promise.all(verified);
   assert.deepEqual(errors,[]);
   assert.deepEqual(sent,[updates+1,updates+1]);
   check(initial,n,0,true);
   check(map,n,updates,true);
   return {n,cohort,pair,arm,bundle,copy,transfer,initialMs,firstUsed,rows,verified:true};
  }finally{session.dispose();await Promise.all(workers.map(w=>w.terminate()));}
 }
 for(const n of [1000,10000,100000]){
  for(let pair=-1;pair<4;pair++){
   const cohorts=['AB','AA','default','shared'];
   for(const cohort of (pair%2===0?cohorts:cohorts.slice().reverse())){
    const arms=cohort==='AB'?[['base-copy','baseline-dist'],['candidate-transfer','dist']]
      :cohort==='AA'?[['base-copy','baseline-dist'],['control-copy','control-dist']]
      :cohort==='default'?[['base-copy','baseline-dist'],['candidate-copy','dist']]
      :[['base-shared','baseline-dist'],['candidate-shared','dist']];
    for(const [arm,bundle] of (pair%2===0?arms:arms.slice().reverse())){
     const row=await sample(n,cohort,pair,arm,bundle);
     report.samples.push(row);console.log(JSON.stringify(row));
     writeFileSync(out,JSON.stringify(report));
    }
   }
  }
 }
}
