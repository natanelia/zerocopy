import {build,edit,payload,repack,shouldRepack,arenaUsage} from './schema-lane-runtime.mjs';
import {lane,bounds,queryFor,matches,validate,equal,digest,mixedMode,mixedLane,mixedMetadata,mixedQuery,mixedMatches,validateMixed} from './lane-fixture.mjs';
const readerCount=4;
function send(w,m){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>done(Error('worker timeout')),90000);
  function onmessage(e){done(e.data.error?Error(e.data.error):null,e.data);}
  function onerror(e){done(Error(e.message));}
  function done(err,result){clearTimeout(timer);w.removeEventListener('message',onmessage);w.removeEventListener('error',onerror);err?reject(err):resolve(result);}
  w.addEventListener('message',onmessage);w.addEventListener('error',onerror);w.postMessage(m);
});}
const percentile=(a,q)=>a.slice().sort((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*q)-1)];
// A changing tile window: replace 10% of rows every fourth revision at
// similar map positions, with new unrelated keys and varied vertex lengths.
// Other revisions move/insert/remove vertices without changing identity.
function batch(rows,ids,rev,nextId,pattern,mixed){
  const n=ids.length,replace=rev%4===0,count=replace?Math.floor(n/10):rev%6===0?25:1,remove=[],upsert=[];
  for(let j=0;j<count;j++){
    const span=pattern==='local'?Math.floor(n/8):n,start=pattern==='local'?(Math.floor((rev-1)/24)%8)*span:0;
    const slot=start+((Math.imul(rev,8191)>>>0)+Math.floor(j*span/count))%span,id=ids[slot],old=rows.get(id);
    if(replace){
      const fresh=(mixed?mixedLane:lane)(nextId++),dx=old.left-fresh.left,dy=old.bottom-fresh.bottom;
      const xy=fresh.xy.map((v,k)=>v+(k%2?dy:dx)),r={...fresh,xy,...bounds(xy)};
      remove.push(id);upsert.push([r.id,r]);ids[slot]=r.id;
    }else{
      const xy=old.xy.slice();
      if(rev%3===0)xy.splice(2,0,(xy[0]+xy[2])/2,(xy[1]+xy[3])/2);
      else if(rev%3===1&&xy.length>8)xy.splice(2,2);
      else xy[(j%(xy.length/2))*2]+=rev%2?2:-1;
      upsert.push([id,{...old,xy,...bounds(xy),...(mixed&&rev%5===0?mixedMetadata(id,rev):{})}]);
    }
  }
  return {remove,upsert,nextId};
}
export async function run(mode,n,revisions=96,retention=2,pattern='spread'){
  if(!Number.isInteger(retention)||retention<1)throw Error('invalid retention');
  if(!crossOriginIsolated)throw Error('not isolated');
  const mixed=mixedMode(mode),initial=Array.from({length:n},(_,i)=>(mixed?mixedLane:lane)(i)),rows=new Map(initial.map(r=>[r.id,r])),ids=initial.map(r=>r.id),dead=[],retained=new Map(),events=[];
  // Track only named retained/current arena generations, not GC or resident memory.
  const heldArenas=new Map(),lastUsage=new Map();
  const heldIds=()=>[...heldArenas.values()].flat();
  let expiredVerified=0,verificationMs=0;
  const updateUsage=items=>{for(const a of items)lastUsage.set(a.id,a);};
  const sumUsage=ids=>{const a=[...new Set(ids)].map(id=>lastUsage.get(id));return {used:a.reduce((s,x)=>s+x.used,0),capacity:a.reduce((s,x)=>s+x.capacity,0),arenas:a.length};};
  let nextId=n;const t0=performance.now();let owner=build(mode,initial);const buildMs=performance.now()-t0;
  const initialWorkers=performance.now(),workers=Array.from({length:readerCount},()=>new Worker(new URL('./dynamic-worker.mjs',import.meta.url),{type:'module'}));
  try{
    for(let rev=0;rev<=revisions;rev++){
      const b=rev?batch(rows,ids,rev,nextId,pattern,mixed):{remove:[],upsert:[],nextId};nextId=b.nextId;
      for(const id of b.remove){rows.delete(id);dead.push(id);}for(const [id,r] of b.upsert)rows.set(id,r);
      const hold=rev===0||rev%24===0||rev===revisions;
      if(hold)retained.set(rev,{rows:new Map(rows),missing:dead.slice()});
      const queries=workers.map((_,w)=>rev%3===0?(mixed?mixedQuery:queryFor)(n,rev,w):null);
      const pointIds=workers.map((_,w)=>[...b.remove.slice(0,8),...b.upsert.slice(0,8).map(([id])=>id),...Array.from({length:8},(_,j)=>ids[(rev*997+w*103+j*7187)%n])]);
      const expected=queries.map((q,w)=>({points:pointIds[w].map(id=>rows.get(id)),visible:q?[...rows.values()].filter(r=>(mixed?mixedMatches:matches)(r,q)).map(mixed?validateMixed:validate).sort((a,b)=>a[0]-b[0]):null}));
      const t=performance.now();if(rev)owner=edit(mode,owner,b);const editMs=performance.now()-t;
      let compactionMs=0,handoff=null;
      if(shouldRepack(mode,rev,owner)){
        const start=performance.now(),before=arenaUsage(owner,mode);updateUsage(before);
        owner=repack(mode,owner);
        const after=arenaUsage(owner,mode);updateUsage(after);
        handoff=sumUsage([...heldIds(),...before.map(a=>a.id),...after.map(a=>a.id)]);
        compactionMs=performance.now()-start;
      }
      const mutationMs=performance.now()-t;
      const a=performance.now(),p=payload(mode,owner),payloadMs=performance.now()-a;
      const replies=await Promise.all(workers.map((w,i)=>send(w,{mode,n,rev,wire:p.wire,query:queries[i],ids:pointIds[i],hold})));
      const replyMs=performance.now()-a;
      const usage=arenaUsage(owner,mode);updateUsage(usage);if(hold)heldArenas.set(rev,usage.map(x=>x.id));
      const retainedUsage=sumUsage([...heldIds(),...usage.map(x=>x.id)]);
      for(let i=0;i<replies.length;i++){const r=replies[i];equal(r.rev,rev,'revision');equal(r.size,n,'size');equal(r.points,expected[i].points,'points');equal(r.visible,expected[i].visible,'visible');}
      events.push({rev,removed:b.remove.length,changed:b.upsert.length,mutationMs,editMs,compactionMs,handoff,retainedUsage,payloadMs,replyMs,editToAnswerMs:mutationMs+replyMs,firstElapsedMs:rev===0?performance.now()-initialWorkers:null,
        scan:!!queries[0],visibleRows:replies.reduce((s,r)=>s+(r.visible?.length??0),0),attachMs:Math.max(...replies.map(r=>r.attachMs)),pointMs:Math.max(...replies.map(r=>r.pointMs)),scanMs:Math.max(...replies.map(r=>r.scanMs)),memory:p.memory});
      // Verify each expiring root in all readers before releasing it. The same
      // lifetime and verification policy applies to every arm. This diagnostic
      // work is separately timed, outside edit-to-answer, as final digests are.
      if(hold&&retained.size>retention){
        const v=performance.now(),[oldRev,old]=retained.entries().next().value,oldIds=[...old.rows.keys()].sort((a,b)=>a-b);
        const history=[{rev:oldRev,ids:oldIds,missing:old.missing}],expected=[[oldRev,await digest(oldIds.length,i=>old.rows.get(oldIds[i]))]];
        for(const r of await Promise.all(workers.map(w=>send(w,{expire:true,mode,history}))))equal(r.digests,expected,'expired full rows');
        retained.delete(oldRev);heldArenas.delete(oldRev);expiredVerified++;verificationMs+=performance.now()-v;
      }
      events.at(-1).afterExpiryUsage=sumUsage([...heldIds(),...usage.map(x=>x.id)]);
    }
    const history=[],expected=[];
    for(const [rev,r] of retained){const ids=[...r.rows.keys()].sort((a,b)=>a-b);history.push({rev,ids,missing:r.missing});expected.push([rev,await digest(ids.length,i=>r.rows.get(ids[i]))]);}
    for(const r of await Promise.all(workers.map(w=>send(w,{verify:true,mode,history}))))equal(r.digests,expected,'retained full rows');
    const timed=events.slice(1);
    const releaseReplies=await Promise.all(workers.map(w=>send(w,{release:true,mode,ids:history.at(-1).ids})));
    for(const r of releaseReplies)equal(r.digest,expected.at(-1)[1],'current after release');
    const peakRetainedUsed=Math.max(...events.map(e=>e.retainedUsage.used));
    const peakHandoffUsed=Math.max(peakRetainedUsed,...events.map(e=>e.handoff?.used??0));
    return {mode,n,retention,pattern,expiredVerified,verificationMs,buildMs,firstMs:events[0].firstElapsedMs,totalEditToAnswerMs:timed.reduce((s,r)=>s+r.editToAnswerMs,0),
      p95EditToAnswerMs:percentile(timed.map(r=>r.editToAnswerMs),.95),p95PointMs:percentile(timed.map(r=>r.pointMs),.95),p95AttachMs:percentile(timed.map(r=>r.attachMs),.95),p95MutationMs:percentile(timed.map(r=>r.mutationMs),.95),p95ScanMs:percentile(timed.filter(r=>r.scan).map(r=>r.scanMs),.95),
      initial:events[0].memory,final:events.at(-1).memory,peakRetainedUsed,peakHandoffUsed,finalRetained:events.at(-1).afterExpiryUsage,compactions:timed.filter(e=>e.handoff).length,compactionMs:timed.reduce((s,e)=>s+e.compactionMs,0),releasedCurrentOnly:sumUsage(arenaUsage(owner,mode).map(a=>a.id)),events,digests:expected,verified:true};
  }finally{for(const w of workers)w.terminate();}
}
