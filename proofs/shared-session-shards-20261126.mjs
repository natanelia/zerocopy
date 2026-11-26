import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as z from 'zerocopy';
import { createSharedSession, connectSharedSession } from 'zerocopy/worker';
import { productId, product } from '../website/assets/catalog-core.mjs';

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
  if (layout === 'dense') return [...Array.from({length:count},(_,s)=>s), ...Array.from({length:100-count},(_,j)=>(j*7919+101)%n)];
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
const memory = () => { const m=process.memoryUsage(); return {heapUsed:m.heapUsed,arrayBuffers:m.arrayBuffers,external:m.external,rss:m.rss}; };
if (!isMainThread) {
  const {n,count,layout} = workerData;
  const expectedArenas=layout==='one'?1:count;
  // Diagnostic-only: count and time synchronous native instance construction in
  // each reader. Preserve the original native constructor and prototype.
  // Do not use instrumented timings as an unperturbed performance baseline.
  const instrument = workerData.instrument === true;
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
  parentPort.on('message', m => {
    if(m?.protocol==='zerocopy/session' && m.kind==='snapshot'){
      instanceCount=0;instanceMs=0;
      frame={sequence:m.sequence,received:performance.now(),arenas:m.data.arenas.length,
        handles:m.data.arenas.filter(a=>a.memory).length,copyBytes:m.data.arenas.reduce((sum,a)=>sum+(a.copy?.byteLength??0),0)};
    }
  });
  const error = e => parentPort.postMessage({proof:'error',error:String(e?.stack??e)});
  const reader = await connectSharedSession({endpoint:parentPort,channel:'shards',timeoutMs:60000,onError:error});
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
      parentPort.postMessage({proof:'probe',sequence:v,readerAcceptMs,queryMs,attachmentInstances,attachmentInstanceMs,queryInstances:instanceCount-attachmentInstances,queryInstanceMs:instanceMs-attachmentInstanceMs,arenas:frame.arenas,handles:frame.handles,copyBytes:frame.copyBytes,memory:memory()});
    } catch(e){ error(e); }
  }
  report(reader.current,reader.version); reader.subscribe(report);
  parentPort.on('message',m=>{
    if(m?.proof!=='verify')return;
    try{
      assert.equal(reader.version,updates);
      verify(original,n,count,0,layout); verify(middle,n,count,4,layout); verify(reader.current,n,count,updates,layout);
      parentPort.postMessage({proof:'verified',sequence:updates});
    }catch(e){error(e);}
  });
} else if (process.argv[2]==='--sample') {
  const [n,count]=process.argv.slice(3,5).map(Number), layout=process.argv[5], pair=Number(process.argv[6]), arm=process.argv[7];
  assert(['one','distinct','dense'].includes(layout)); assert(count>0&&count<=n);
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
  const workers=Array.from({length:2},()=>new Worker(new URL(import.meta.url),{workerData:{n,count,layout,instrument:arm.startsWith('profile-')}}));
  const session=createSharedSession(initial,{copy:false,channel:'shards',delivery:'all',timeoutMs:60000,onError:e=>errors.push(String(e))});
  const rows=[];
  function wait(worker,match,description){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(Error('Missing '+description)),60000);
      const onMessage=m=>{
        if(m?.proof==='error')finish(Error(m.error));
        else if(match(m))finish(undefined,{...m,received:performance.now()});
      };
      const onExit=code=>finish(Error('Worker exited '+code));
      const finish=(error,value)=>{clearTimeout(timer);worker.off('message',onMessage);worker.off('error',finish);worker.off('exit',onExit);error?reject(error):resolve(value);};
      worker.on('message',onMessage);worker.on('error',finish);worker.on('exit',onExit);
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
        readers:replies.map(({received,...r})=>({...r,roundTripMs:received-t})),used:arenaBytes(current),ownerMemory:memory()});
    }
    const verified=workers.map(w=>wait(w,m=>m?.proof==='verified'&&m.sequence===updates,'verified'));
    workers.forEach(w=>w.postMessage({proof:'verify'}));await Promise.all(verified);
    verify(initial,n,count,0,layout);verify(middle,n,count,4,layout);verify(current,n,count,updates,layout);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({n,count,layout,pair,arm,constructionMs,initialMs,initialUsed,initialReaders:initialReaders.map(({received,...r})=>({...r,roundTripMs:received-start})),rows,verified:true}));
  }finally{session.dispose();await Promise.all(workers.map(w=>w.terminate()));}
} else {
  const out=resolve(process.argv[2]), baseline=resolve(process.argv[3]), candidate=resolve('.'); assert(process.argv[2]&&process.argv[3]&&baseline!==candidate,'usage: node proofs/shared-session-shards-20261126.mjs RESULTS BASELINE_WORKTREE');
  mkdirSync(out,{recursive:true});
  const sha=cwd=>execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
  assert.equal(sha(baseline),BASE);
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  const scriptRel='proofs/shared-session-shards-20261126.mjs';
  function hashes(root){return Object.fromEntries(['worker.ts','worker-protocol.ts','shared.ts','arena.ts','persistent-core.wasm','website/assets/catalog-core.mjs',scriptRel,...readdirSync(root+'/dist').filter(p=>p.endsWith('.js')).map(p=>'dist/'+p)].map(p=>[p,hash(root+'/'+p)]));}
  const cases=[[1000,1,'one'],[10000,4,'distinct'],[10000,8,'distinct'],[100000,1,'one'],[100000,64,'one'],[100000,64,'distinct'],[100000,64,'dense']];
  const baseHashes=hashes(baseline),candidateHashes=hashes(candidate);
  for(const p of ['worker.ts','worker-protocol.ts','persistent-core.wasm','website/assets/catalog-core.mjs',scriptRel])assert.equal(baseHashes[p],candidateHashes[p],p);
  assert.notEqual(baseHashes['arena.ts'],candidateHashes['arena.ts']);
  assert.notEqual(baseHashes['shared.ts'],candidateHashes['shared.ts']);
  const data={base:BASE,head:sha(candidate),runtime:process.versions,cpu:cpus()[0]?.model,baseHashes,candidateHashes,cases,updates,measuredPairs:6,samples:[],complete:false};
  const file=out+'/raw.json';writeFileSync(file,JSON.stringify(data));
  function sample(n,count,layout,pair,arm){
      const root=arm==='candidate'||arm==='profile-candidate'?candidate:baseline;
      const args=[root+'/'+scriptRel,'--sample',String(n),String(count),layout,String(pair),arm];
      const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
      const prefix=out+'/'+[n,count,layout,pair,arm].join('-');
      writeFileSync(prefix+'.stdout',result.stdout??'');writeFileSync(prefix+'.stderr',result.stderr??'');
      if(result.status!==0)throw Error('Failed sample '+prefix+': '+(result.error?.message??result.status));
      const row=JSON.parse(result.stdout.trim());assert(row.verified&&row.rows.length===updates&&row.arm===arm&&row.pair===pair);
      for(const reads of [row.initialReaders,...row.rows.map(r=>r.readers)])for(const reader of reads){
        assert(Number.isSafeInteger(reader.attachmentInstances)&&reader.attachmentInstances>=0);
        assert(Number.isFinite(reader.attachmentInstanceMs)&&reader.attachmentInstanceMs>=0);
        if(!arm.startsWith('profile-'))assert.equal(reader.attachmentInstances,0);
      }
      data.samples.push(row);console.log(JSON.stringify(row));writeFileSync(file,JSON.stringify(data));return row;
  }
  // AB and identical-build AA, interleaved and alternated. Each arm is a
  // fresh process; no GC forcing. All fixtures and verification are identical.
  for(let pair=-1;pair<6;pair++)for(const [n,count,layout] of (pair%2===0?cases:cases.slice().reverse())){
    const cohorts=pair%2===0?[['base','candidate'],['aa-base','aa-control']]:[['aa-control','aa-base'],['candidate','base']];
    for(const arms of cohorts)for(const arm of arms)sample(n,count,layout,pair,arm);
  }
  // Separate attribution samples are not included in latency results.
  for(const [n,count,layout] of [[100000,64,'distinct'],[100000,64,'dense'],[100000,1,'one']]){
    sample(n,count,layout,-2,'profile-base');
    sample(n,count,layout,-2,'profile-candidate');
  }
  data.complete=true;writeFileSync(file,JSON.stringify(data));
}
