import {productId,product} from '../website/assets/catalog-core.mjs';
function assert(ok,msg='assertion failed'){if(!ok)throw Error(msg);}
assert.equal=(a,b)=>assert(Object.is(a,b),'expected '+String(b)+'; got '+String(a));
assert.notEqual=(a,b)=>assert(!Object.is(a,b),'unexpected identical value');
assert.deepEqual=(a,b)=>assert(JSON.stringify(a)===JSON.stringify(b),'deep equality');
assert.throws=(fn,pattern)=>{let threw=false;try{fn();}catch(e){threw=true;assert(pattern.test(String(e)),String(e));}assert(threw,'expected throw');};
const BASE = '84ad23a76ee197f45cbc7316017f28b5bbe93d6c', updates = 8, edits = 25;
const field = s => 'tile/' + s;
const equal = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));
const shardOf = (i, count) => i % count;
const sizeOf = (s, n, count) => Math.ceil((n - s) / count);
const changedShard = (v, count) => (v - 1) % count;
function revision(i, v, count, layout) {
  if (layout === 'dense') return Math.floor(i / count) < edits ? v : 0;
  if (Math.floor(i / count) >= edits) return 0;
  for (let s = v; s > 0; s--) if (changedShard(s, count) === shardOf(i, count)) return s;
  return 0;
}
function queryIndices(n, count, v, layout) {
  if (layout === 'dense' || layout === 'sparse-all') return [...Array.from({length:count},(_,s)=>s), ...Array.from({length:100-count},(_,j)=>(j*7919+101)%n)];
  const s = changedShard(v || 1, count);
  return [...Array.from({length: Math.min(edits, sizeOf(s, n, count))}, (_, j) => s+j*count),
    ...Array.from({length:75}, (_, j) => (j * 7919 + 101) % n)];
}
function query(state, n, count, v, layout) {
  const ids = queryIndices(n, count, v, layout);
  const keys = ids.map(productId);
  const start = performance.now();
  const values = ids.map((i, j) => state[field(shardOf(i,count))].get(keys[j]));
  const queryMs = performance.now() - start;
  for (let j = 0; j < ids.length; j++) {
    equal(values[j], product(ids[j], revision(ids[j], v, count, layout)));
    assert(Object.isFrozen(values[j]));
  }
  return queryMs;
}
function verify(state, n, count, v, layout) {
  assert.equal(Object.keys(state).length, count);
  for (let s=0;s<count;s++) {
    const map=state[field(s)];
    assert.equal(map.size,sizeOf(s,n,count));
    for(let i=s;i<n;i+=count) equal(map.get(productId(i)),product(i,revision(i,v,count,layout)));
    assert.equal(map.get('missing/道路'),undefined);
  }
}

if (typeof document==='undefined') {
  const q=new URL(import.meta.url).searchParams,n=Number(q.get('n')),count=Number(q.get('count')),layout=q.get('layout');
  const {connectSharedSession}=await import('../'+q.get('bundle')+'/worker.js');
  const expectedArenas=layout==='one'?1:count;
  // Diagnostic-only: count and time synchronous native instance construction in
  // each reader. Preserve the original native constructor and prototype.
  // Do not use instrumented timings as an unperturbed performance baseline.
  const instrument = q.get('instrument')==='true';
  let instanceCount=0, instanceMs=0;
  if(instrument) {
    const NativeInstance=WebAssembly.Instance;
    WebAssembly.Instance=new Proxy(NativeInstance,{construct(target,args,newTarget){
      const t=performance.now();
      try{return Reflect.construct(target,args,newTarget);}
      finally{instanceCount++;instanceMs+=performance.now()-t;}
    }});
  }
  let frame;
  self.addEventListener('message', ({data:m}) => {
    if(m?.protocol==='zerocopy/session' && m.kind==='snapshot'){
      instanceCount=0;instanceMs=0;
      frame={sequence:m.sequence,received:performance.now(),arenas:m.data.arenas.length,
        handles:m.data.arenas.filter(a=>a.memory).length,copyBytes:m.data.arenas.reduce((sum,a)=>sum+(a.copy?.byteLength??0),0)};
    }
  });
  const error = e => self.postMessage({proof:'error',error:String(e?.stack??e)});
  const reader = await connectSharedSession({endpoint:self,channel:'shards',timeoutMs:60000,onError:error});
  const original=reader.current;
  let previous=original, middle;
  function report(state,v){
    try {
      const readerAcceptMs=performance.now()-frame.received;
      const attachmentInstances=instanceCount,attachmentInstanceMs=instanceMs;
      assert.equal(frame.sequence,v); assert.equal(frame.arenas,expectedArenas);
      assert.equal(frame.handles,v===0?expectedArenas:0); assert.equal(frame.copyBytes,0);
      if(v>0) for(let s=0;s<count;s++) {
        if(layout==='dense'||s===changedShard(v,count)) assert.notEqual(state[field(s)],previous[field(s)]);
        else assert.equal(state[field(s)],previous[field(s)]);
      }
      const queryMs=query(state,n,count,v,layout);
      if(v>0){
        const s=changedShard(v,count);
        equal(original[field(s)].get(productId(s)),product(s,0));
        assert.throws(()=>state[field(s)].set('forbidden',{}),/read-only/);
      }
      if(v===4) middle=state;
      previous=state;
      self.postMessage({proof:'probe',sequence:v,readerAcceptMs,queryMs,attachmentInstances,attachmentInstanceMs,queryInstances:instanceCount-attachmentInstances,queryInstanceMs:instanceMs-attachmentInstanceMs,arenas:frame.arenas,handles:frame.handles,copyBytes:frame.copyBytes});
    } catch(e){ error(e); }
  }
  report(reader.current,reader.version); reader.subscribe(report);
  self.addEventListener('message',({data:m})=>{
    if(m?.proof!=='verify')return;
    try{
      assert.equal(reader.version,updates);
      verify(original,n,count,0,layout); verify(middle,n,count,4,layout); verify(reader.current,n,count,updates,layout);
      self.postMessage({proof:'verified',sequence:updates});
    }catch(e){error(e);}
  });
}
export async function sample(n,count,layout,pair,arm,bundle){
  assert(crossOriginIsolated,'isolated browser required');
  const z=await import('../'+bundle+'/shared.js'),{createSharedSession}=await import('../'+bundle+'/worker.js');
  assert(['one','distinct','dense','sparse-all'].includes(layout)); assert(count>0&&count<=n);
  z.configureMemory({maximumBytes:64*1024*1024});
  z.resetMap();
  const state={};
  const constructionStart=performance.now();
  for(let s=0;s<count;s++){
    if(layout!=='one'&&s>0) z.resetMap();
    const entries=[];
    for(let i=s;i<n;i+=count)entries.push([productId(i),product(i)]);
    state[field(s)]=new z.SharedMap('object').setMany(entries);
  }
  const constructionMs=performance.now()-constructionStart;
  const initial=state, errors=[];
  const expectedArenas=layout==='one'?1:count;
  const arenaBytes = value => {
    const data=z.getWorkerData(value,{copy:false});
    assert.equal(data.arenas.length,expectedArenas);
    return data.arenas.reduce((sum,a)=>sum+a.used,0);
  };
  const initialUsed=arenaBytes(initial);
  const workers=Array.from({length:2},()=>{const url=new URL(import.meta.url);for(const [k,v] of Object.entries({n,count,layout,bundle,instrument:arm.startsWith('profile-')}))url.searchParams.set(k,String(v));return new Worker(url,{type:'module'});});
  const session=createSharedSession(initial,{copy:false,channel:'shards',delivery:'all',timeoutMs:60000,onError:e=>errors.push(String(e))});
  const rows=[];
  function wait(worker,match,description){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(Error('Missing '+description)),60000);
      const onMessage=({data:m})=>{
        if(m?.proof==='error')finish(Error(m.error));
        else if(match(m))finish(undefined,{...m,received:performance.now()});
      };
      const onError=e=>finish(Error(e.message??'worker error'));
      const finish=(error,value)=>{clearTimeout(timer);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);error?reject(error):resolve(value);};
      worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);
    });
  }
  function receive(v){
    const probes=workers.map(w=>wait(w,m=>m?.proof==='probe'&&m.sequence===v,'probe '+v));
    const acks=workers.map(w=>wait(w,m=>m?.protocol==='zerocopy/session'&&m.kind==='ack'&&m.sequence===v,'ack '+v));
    return {probes:Promise.all(probes),acks:Promise.all(acks)};
  }
  try{
    const first=receive(0), start=performance.now();
    const connected=session.connect(workers);
    const initialReaders=await first.probes;
    const initialMs=Math.max(...initialReaders.map(r=>r.received))-start;
    await first.acks; await connected;
    let current=initial, middle;
    for(let v=1;v<=updates;v++){
      const shards=layout==='dense'?Array.from({length:count},(_,s)=>s):[changedShard(v,count)];
      const batches=shards.map(s=>[s,Array.from({length:Math.min(edits,sizeOf(s,n,count))},(_,j)=>{const i=s+j*count;return [productId(i),product(i,v)];})]);
      const tEdit=performance.now();
      const next={...current};for(const [s,entries] of batches) next[field(s)]=current[field(s)].setMany(entries);
      current=next;
      const editMs=performance.now()-tEdit;
      if(v===4)middle=current;
      const response=receive(v),t=performance.now();
      const version=session.publish(current),publishMs=performance.now()-t;
      assert.equal(version,v);
      const replies=await response.probes, ack=await response.acks;
      rows.push({sequence:v,edited:batches.reduce((sum,[,entries])=>sum+entries.length,0),editMs,publishMs,roundTripMs:Math.max(...replies.map(r=>r.received))-t,ackMs:Math.max(...ack.map(r=>r.received))-t,
        readers:replies.map(({received,...r})=>({...r,roundTripMs:received-t})),used:arenaBytes(current)});
    }
    const verified=workers.map(w=>wait(w,m=>m?.proof==='verified'&&m.sequence===updates,'verified'));
    workers.forEach(w=>w.postMessage({proof:'verify'}));await Promise.all(verified);
    verify(initial,n,count,0,layout);verify(middle,n,count,4,layout);verify(current,n,count,updates,layout);
    assert.deepEqual(errors,[]);
    return {n,count,layout,pair,arm,bundle,constructionMs,initialMs,initialUsed,initialReaders:initialReaders.map(({received,...r})=>({...r,roundTripMs:received-start})),rows,verified:true};
  }finally{session.dispose();workers.forEach(w=>w.terminate());}
}
