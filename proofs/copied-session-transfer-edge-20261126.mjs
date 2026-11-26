import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {SharedMap,resetMap,getWorkerData} from '../dist/shared.js';
import {createSharedSession,connectSharedSession} from '../dist/worker.js';
const waitVersion=(reader,version)=>new Promise((resolve,reject)=>{
 if(reader.version===version){resolve();return;}
 const timer=setTimeout(()=>{off();reject(Error('missing version '+version));},15000);
 const off=reader.subscribe((_,v)=>{if(v===version){clearTimeout(timer);off();resolve();}});
});
for(const delivery of ['all','latest']){
 resetMap();const child=new SharedMap('number').set('道路',1);
 resetMap();const parent=new SharedMap('SharedMap<number>').set('child',child);
 const initial={parent,alias:parent,child};
 assert.equal(getWorkerData(initial,{copy:false}).arenas.length,2);
 const channels=[new MessageChannel(),new MessageChannel()],seen=new WeakSet(),frames=[[],[]],errors=[];
 const session=createSharedSession(initial,{copy:true,delivery,onError:e=>errors.push(String(e)),timeoutMs:15000});
 let fail=false;
 for(const [i,{port1}] of channels.entries()){
  const native=port1.postMessage;
  port1.postMessage=function(...args){
   const f=args[0];
   if(f?.protocol==='zerocopy/session'&&f.kind==='snapshot'){
    if(i===0&&fail)throw Error('injected transfer send failure');
    const copies=f.data.arenas.map(a=>a.copy.buffer);
    assert.equal(copies.length,2);
    assert.equal(new Set(copies).size,2);
    for(const b of copies){assert(b instanceof ArrayBuffer&&b.byteLength>0&&!seen.has(b));seen.add(b);}
    if(i===0)assert.deepEqual(args[1],copies);else assert.equal(args.length,1);
    frames[i].push(f.sequence);
    const result=native.apply(this,args);
    assert(copies.every(b=>i===0?b.byteLength===0:b.byteLength>0));
    return result;
   }
   return native.apply(this,args);
  };
 }
 let readers=[];
 try{
  const pending=channels.map(({port1},i)=>session.connect(port1,i===0?{transferCopies:true}:{}));
  readers=await Promise.all(channels.map(({port2})=>connectSharedSession({endpoint:port2,timeoutMs:15000,onError:()=>{}})));
  await Promise.all(pending);
  const retained=readers.map(r=>r.current),versions=[[],[]],off=readers.map((r,i)=>r.subscribe((s,v)=>{
   assert.equal(s.parent.get('child').get('道路'),v+1);assert.equal(s.alias.get('child').get('道路'),v+1);assert.equal(s.child.get('道路'),v+1);
   versions[i].push(v);
  }));
  let c=child,p=parent;
  function publish(v){c=c.set('道路',v+1);p=p.set('child',c);assert.equal(session.publish({parent:p,alias:p,child:c}),v);}
  // Publish three synchronously while the first frame is in flight. Queue owns frame
  // metadata, not a detached payload, so later per-peer copies must still be fresh.
  const received=readers.map(r=>waitVersion(r,3));
  publish(1);publish(2);publish(3);await Promise.all(received);
  for(let i=0;i<2;i++){
   assert.deepEqual(versions[i],delivery==='all'?[1,2,3]:[1,3]);
   assert.equal(retained[i].parent.get('child').get('道路'),1);
   assert.equal(retained[i].child.get('道路'),1);
   assert.throws(()=>readers[i].current.child.set('bad',1),/read-only/);
  }
  assert.equal(child.get('道路'),1);assert.equal(c.get('道路'),4);
  off.forEach(f=>f());
  fail=true;
  const other=waitVersion(readers[1],4);publish(4);await other;
  assert(errors.some(s=>s.includes('injected transfer send failure')));
  assert.equal(readers[1].current.child.get('道路'),5);
  assert.equal(retained[0].child.get('道路'),1);
  // A new endpoint can connect to the latest owner version after the failed peer.
  const replacement=new MessageChannel();
  try{
   const ready=session.connect(replacement.port1,{transferCopies:true});
   const r=await connectSharedSession({endpoint:replacement.port2,timeoutMs:15000});
   await ready;assert.equal(r.version,4);assert.equal(r.current.parent.get('child').get('道路'),5);r.dispose();
  }finally{replacement.port1.close();replacement.port2.close();}
  console.log(JSON.stringify({delivery,frames,verified:true}));
 }finally{readers.forEach(r=>r.dispose());session.dispose();for(const {port1,port2} of channels){port1.close();port2.close();}}
}
const shared=createSharedSession(new SharedMap('number'),{copy:false});
const {port1,port2}=new MessageChannel();
try{assert.throws(()=>shared.connect(port1,{transferCopies:true}),/requires copy mode/);assert.throws(()=>shared.connect(port1,{transferCopies:'true'}),/must be boolean/);}
finally{shared.dispose();port1.close();port2.close();}
