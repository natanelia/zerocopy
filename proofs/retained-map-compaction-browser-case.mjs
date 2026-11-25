import {entriesFor,editsFor,product,productId} from '../website/assets/catalog-core.mjs';
const check=(ok,msg)=>{if(!ok)throw new Error(msg);};
const equal=(a,b,msg)=>check(JSON.stringify(a)===JSON.stringify(b),msg);
const enc=new TextEncoder();
const hex=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s))),x=>x.toString(16).padStart(2,'0')).join('');
const modulePath=arm=>'/'+({base:'baseline-dist',control:'control-dist',candidate:'dist'}[arm])+'/shared.js';
async function summarize(maps,oracle){
 const result={};
 for(const [name,map] of Object.entries(maps)){
  const expected=oracle?.[name],seen=expected?new Set():null,hashes=[];
  let records=0,chunk=[];
  for(const [key,value] of map.entries()){
   const json=JSON.stringify(value);
   if(expected){check(!seen.has(key)&&expected.get(key)===json,'oracle mismatch '+name+' '+key);seen.add(key);}
   chunk.push(JSON.stringify([key,json]));records++;
   if(chunk.length===1024){hashes.push(await hex(chunk.join('\n')));chunk=[];}
  }
  if(chunk.length)hashes.push(await hex(chunk.join('\n')));
  check(records===map.size&&(!expected||records===expected.size),'count mismatch '+name);
  result[name]={records,hash:await hex(hashes.join(':'))};
 }
 return result;
}
const keys=['product/000000','product/007919','product/009999','product/099999','new/3/7','missing/1'];
const probe=maps=>Object.fromEntries(Object.entries(maps).map(([k,m])=>[k,keys.map(id=>JSON.stringify(m.get(id))??null)]));
const expectedProbe=oracle=>Object.fromEntries(Object.entries(oracle).map(([k,m])=>[k,keys.map(id=>m.get(id)??null)]));
function prepare(api,n,mode){
 api.resetMap();
 const initial=entriesFor(n);
 let current=new api.SharedMap('object').setMany(initial),expected=new Map(initial.map(([k,v])=>[k,JSON.stringify(v)]));
 const maps=[current],oracle=[expected],revisions=mode==='dense-four'?3:7;
 for(let rev=1;rev<=revisions;rev++){
  expected=new Map(expected);let edits=editsFor(n,rev);
  if(mode==='churn'){
   const gone=Array.from({length:150},(_,i)=>productId((rev-1)*150+i));
   current=current.deleteMany(gone);for(const k of gone)expected.delete(k);
   edits=Array.from({length:150},(_,i)=>['new/'+rev+'/'+i,product(i,rev)]);
  }else if(mode==='dense-four')edits=Array.from({length:n/2},(_,i)=>[productId(i),product(i,rev)]);
  current=current.setMany(edits);for(const [k,v] of edits)expected.set(k,JSON.stringify(v));
  maps.push(current);oracle.push(expected);
 }
 const revs=mode==='shuffled'?[0,7,2,5,1,6,3,4]:Array.from({length:revisions+1},(_,i)=>i);
 return {input:Object.fromEntries(revs.map(r=>['r'+r,maps[r]])),oracle:Object.fromEntries(revs.map(r=>['r'+r,oracle[r]]))};
}
if(typeof WorkerGlobalScope!=='undefined'&&self instanceof WorkerGlobalScope){
 const api=await import(modulePath(new URL(self.location.href).searchParams.get('arm')));
 let held;
 self.onmessage=async({data})=>{
  try{
   let value;
   if(data.op==='attach'){held=await api.initWorker(data.payload);value=probe(held);}
   else if(data.op==='probe')value=probe(held);
   else if(data.op==='digest')value=await summarize(held);
   else if(data.op==='release'){held=undefined;value=true;}
   else throw new Error('unknown op');
   self.postMessage({value});
  }catch(e){self.postMessage({error:String(e?.stack||e)});}
 };
 self.postMessage({ready:true});
}
function peer(arm){
 const worker=new Worker(new URL(import.meta.url+'?arm='+arm),{type:'module'});
 const next=()=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('worker timeout'));},120000);
  const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);};
  const onMessage=({data})=>{cleanup();data.error?reject(new Error(data.error)):resolve(data);};
  const onError=e=>{cleanup();reject(new Error(e.message||'worker error'));};
  worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);
 });
 const ready=next().then(v=>check(v.ready,'worker not ready'));
 return {ready,async ask(op,payload){const pending=next();worker.postMessage({op,payload});return (await pending).value;},close(){worker.terminate();}};
}
function arenaInfo(payload){
 check(payload.arenas.length===1,'expected one arena');
 const a=payload.arenas[0];return {id:a.id,used:a.used,capacity:a.memory.buffer.byteLength};
}
export async function run(arm,n,mode,fullWorker){
 check(crossOriginIsolated,'shared-memory isolation required');
 const api=await import(modulePath(arm));
 let {input,oracle}=prepare(api,n,mode);
 const old=peer(arm),switching=peer(arm);
 try{
  await Promise.all([old.ready,switching.ready]);
  let source=api.getWorkerData(input,{copy:false});
  const src=arenaInfo(source),expected=expectedProbe(oracle);
  for(const answer of await Promise.all([old.ask('attach',source),switching.ask('attach',source)]))equal(answer,expected,'old attach');
  const t=performance.now(),result=api.compactMany(input),compactMs=performance.now()-t;
  const destination=api.getWorkerData(result,{copy:false}),dst=arenaInfo(destination);
  check(src.id!==dst.id,'compaction must allocate distinct arena');
  const switched=await switching.ask('attach',destination),handoffMs=performance.now()-t;
  equal(switched,expected,'new worker answer');
  equal(await old.ask('probe'),expected,'old worker after switch');
  const original=await summarize(input,oracle),packed=await summarize(result,oracle);
  if(fullWorker){
   equal(await old.ask('digest'),original,'old worker full iteration');
   equal(await switching.ask('digest'),packed,'new worker full iteration');
   const readOnly=await api.initWorker(api.getWorkerData(input,{copy:true}));
   equal(await summarize(api.compactMany(readOnly),oracle),packed,'read-only compaction order');
  }
  // Logical retained data arena accounting only, not process RSS or GC.
  input=null;source=null;api.resetMap();
  equal(await old.ask('release'),true,'old worker release');old.close();
  equal(await switching.ask('probe'),expected,'new reader after release');
  return {arm,n,mode,compactMs,handoffMs,original,packed,sourceUsedBytes:src.used,usedBytes:dst.used,
   sourceCapacityBytes:src.capacity,capacityBytes:dst.capacity,trackedHandoffUsedBytes:src.used+dst.used,
   trackedAfterReleaseUsedBytes:dst.used,trackedHandoffCapacityBytes:src.capacity+dst.capacity,
   trackedAfterReleaseCapacityBytes:dst.capacity,fullWorker,verified:true};
 }finally{old.close();switching.close();api.resetMap();}
}
