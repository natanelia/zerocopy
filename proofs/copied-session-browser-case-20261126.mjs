import { entriesFor, productId, product } from '../website/assets/catalog-core.mjs';
const updates=8, editCount=25;
function assert(ok, msg='assertion failed'){if(!ok)throw Error(msg);}
function equal(a,b,msg){assert(JSON.stringify(a)===JSON.stringify(b),msg??'value mismatch');}
function expected(n,i,v){return product(i,i>=n-editCount?v:0);}
function check(map,n,v,full=false){
 assert(map.size===n,'size');const ids=full?Array.from({length:n},(_,i)=>i):[...Array.from({length:75},(_,i)=>Math.floor(i*(n-editCount)/75)),...Array.from({length:editCount},(_,i)=>n-editCount+i)];
 const start=performance.now(),values=ids.map(i=>map.get(productId(i))),ms=performance.now()-start;
 for(let i=0;i<ids.length;i++){equal(values[i],expected(n,ids[i],v),'record '+ids[i]);assert(Object.isFrozen(values[i]),'frozen');}
 return ms;
}
if(typeof document==='undefined'){
 const q=new URL(import.meta.url).searchParams,n=Number(q.get('n')),bundle=q.get('bundle');
 const {connectSharedSession}=await import('../'+bundle+'/worker.js');
 let frame;
 self.addEventListener('message',({data:m})=>{
  if(m?.protocol==='zerocopy/session'&&m.kind==='snapshot') frame={sequence:m.sequence,copyBytes:m.data.arenas.reduce((s,a)=>s+(a.copy?.byteLength??0),0),handles:m.data.arenas.filter(a=>a.memory).length};
 });
 try{
  const reader=await connectSharedSession({endpoint:self,channel:'copy-proof',timeoutMs:60000,onError:e=>postMessage({proof:'error',error:String(e.stack??e)})});
  const original=reader.current.map;
  function report(state,sequence){
   try{
    assert(frame.sequence===sequence,'frame sequence');
    const queryMs=check(state.map,n,sequence);
    equal(original.get(productId(n-1)),expected(n,n-1,0),'old root');
    let refused=false;try{state.map.set('forbidden',{});}catch(e){refused=/read-only/.test(String(e));}assert(refused,'reader writes forbidden');
    postMessage({proof:'probe',sequence,queryMs,copyBytes:frame.copyBytes,handles:frame.handles});
   }catch(e){postMessage({proof:'error',error:String(e.stack??e)});}
  }
  report(reader.current,reader.version);reader.subscribe(report);
  self.addEventListener('message',({data:m})=>{
   if(m?.proof!=='verify')return;
   try{assert(reader.version===updates);check(reader.current.map,n,updates,true);check(original,n,0,true);postMessage({proof:'verified',sequence:updates});}
   catch(e){postMessage({proof:'error',error:String(e.stack??e)});}
  });
 }catch(e){postMessage({proof:'error',error:String(e.stack??e)});}
}
function wait(w,kind,sequence){
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>done(Error('Missing '+kind+' '+sequence)),60000);
  const onMessage=({data:m})=>{if(m?.proof==='error')done(Error(m.error));else if(m?.proof===kind&&m.sequence===sequence)done(null,{...m,received:performance.now()});};
  const onError=e=>done(Error(e.message??'worker error'));
  function done(err,result){clearTimeout(timer);w.removeEventListener('message',onMessage);w.removeEventListener('error',onError);err?reject(err):resolve(result);}
  w.addEventListener('message',onMessage);w.addEventListener('error',onError);
 });
}
export async function sample(n,cohort,pair,arm,bundle){
 assert(crossOriginIsolated,'isolated browser required');
 const copy=!arm.endsWith('shared'),transfer=arm==='candidate-transfer';
 const z=await import('../'+bundle+'/shared.js'),{createSharedSession}=await import('../'+bundle+'/worker.js');
 z.resetMap();
 const initial=new z.SharedMap('object').setMany(entriesFor(n)),errors=[];
 const workers=Array.from({length:2},()=>{const url=new URL(import.meta.url);url.searchParams.set('n',n);url.searchParams.set('bundle',bundle);return new Worker(url,{type:'module'});});
 const sent=[0,0],seen=new WeakSet();
 for(const [i,w] of workers.entries()){
  const native=w.postMessage;w.postMessage=function(...args){
   const f=args[0];if(f?.protocol==='zerocopy/session'&&f.kind==='snapshot'){
    sent[i]++;
    if(transfer){
     const buffers=f.data.arenas.map(a=>a.copy.buffer);
     assert(args.length===2&&args[1].length===buffers.length,'transfer list');
     for(const [j,b] of buffers.entries()){assert(b===args[1][j]&&b instanceof ArrayBuffer&&b.byteLength>0&&!seen.has(b),'fresh peer copy');seen.add(b);}
     const result=native.apply(this,args);assert(buffers.every(b=>b.byteLength===0),'real detachment');return result;
    }
    assert(args.length===1,'unchanged default endpoint arguments');
   }
   return native.apply(this,args);
  };
 }
 const session=createSharedSession({map:initial},{copy,channel:'copy-proof',delivery:'all',timeoutMs:60000,onError:e=>errors.push(String(e))}),rows=[];
 try{
  const first=workers.map(w=>wait(w,'probe',0)),start=performance.now();
  const connected=session.connect(workers,transfer?{transferCopies:true}:{});
  const firstRows=await Promise.all(first);await connected;
  const firstUsed=z.getWorkerData({map:initial},{copy:false}).arenas[0].used;
  for(const r of firstRows){assert(r.copyBytes===(copy?firstUsed:0));assert(r.handles===(copy?0:1));}
  const initialMs=Math.max(...firstRows.map(r=>r.received))-start;
  let map=initial;
  for(let sequence=1;sequence<=updates;sequence++){
   map=map.setMany(Array.from({length:editCount},(_,i)=>[productId(n-editCount+i),product(n-editCount+i,sequence)]));
   const used=z.getWorkerData({map},{copy:false}).arenas[0].used,replies=workers.map(w=>wait(w,'probe',sequence));
   const t=performance.now(),version=session.publish({map}),publishMs=performance.now()-t;
   assert(version===sequence);
   const responses=await Promise.all(replies);
   for(const r of responses){assert(r.copyBytes===(copy?used:0));assert(r.handles===0);}
   rows.push({sequence,used,publishMs,roundTripMs:Math.max(...responses.map(r=>r.received))-t,readers:responses.map(({received,...r})=>({...r,roundTripMs:received-t}))});
  }
  const verified=workers.map(w=>wait(w,'verified',updates));workers.forEach(w=>w.postMessage({proof:'verify'}));await Promise.all(verified);
  equal(errors,[]);equal(sent,[updates+1,updates+1]);check(initial,n,0,true);check(map,n,updates,true);
  return {n,cohort,pair,arm,bundle,copy,transfer,initialMs,firstUsed,rows,verified:true};
 }finally{session.dispose();workers.forEach(w=>w.terminate());}
}
