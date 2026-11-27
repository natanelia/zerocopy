import {build,edit,payload} from './dynamic-runtime.mjs';
import {lane,bounds,queryFor,matches,validate,equal,digest} from './lane-fixture.mjs';
const revisions=48,readerCount=4;
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
function batch(rows,ids,rev,nextId){
  const n=ids.length,replace=rev%4===0,count=replace?Math.floor(n/10):rev%6===0?25:1,remove=[],upsert=[];
  for(let j=0;j<count;j++){
    const slot=((Math.imul(rev,8191)>>>0)+Math.floor(j*n/count))%n,id=ids[slot],old=rows.get(id);
    if(replace){
      const fresh=lane(nextId++),dx=old.left-fresh.left,dy=old.bottom-fresh.bottom;
      const xy=fresh.xy.map((v,k)=>v+(k%2?dy:dx)),r={...fresh,xy,...bounds(xy)};
      remove.push(id);upsert.push([r.id,r]);ids[slot]=r.id;
    }else{
      const xy=old.xy.slice();
      if(rev%3===0)xy.splice(2,0,(xy[0]+xy[2])/2,(xy[1]+xy[3])/2);
      else if(rev%3===1&&xy.length>8)xy.splice(2,2);
      else xy[(j%(xy.length/2))*2]+=rev%2?2:-1;
      upsert.push([id,{...old,xy,...bounds(xy)}]);
    }
  }
  return {remove,upsert,nextId};
}
export async function run(mode,n){
  if(!crossOriginIsolated)throw Error('not isolated');
  const initial=Array.from({length:n},(_,i)=>lane(i)),rows=new Map(initial.map(r=>[r.id,r])),ids=initial.map(r=>r.id),dead=[],retained=new Map(),events=[];
  let nextId=n;const t0=performance.now();let owner=build(mode,initial);const buildMs=performance.now()-t0;
  const initialWorkers=performance.now(),workers=Array.from({length:readerCount},()=>new Worker(new URL('./dynamic-worker.mjs',import.meta.url),{type:'module'}));
  try{
    for(let rev=0;rev<=revisions;rev++){
      const b=rev?batch(rows,ids,rev,nextId):{remove:[],upsert:[],nextId};nextId=b.nextId;
      for(const id of b.remove){rows.delete(id);dead.push(id);}for(const [id,r] of b.upsert)rows.set(id,r);
      const hold=rev===0||rev===24||rev===revisions;
      if(hold)retained.set(rev,{rows:new Map(rows),missing:dead.slice()});
      const queries=workers.map((_,w)=>rev%3===0?queryFor(n,rev,w):null);
      const pointIds=workers.map((_,w)=>[...b.remove.slice(0,8),...b.upsert.slice(0,8).map(([id])=>id),...Array.from({length:8},(_,j)=>ids[(rev*997+w*103+j*7187)%n])]);
      const expected=queries.map((q,w)=>({points:pointIds[w].map(id=>rows.get(id)),visible:q?[...rows.values()].filter(r=>matches(r,q)).map(validate).sort((a,b)=>a[0]-b[0]):null}));
      const t=performance.now();if(rev)owner=edit(mode,owner,b);const mutationMs=performance.now()-t;
      const a=performance.now(),p=payload(mode,owner),payloadMs=performance.now()-a;
      const replies=await Promise.all(workers.map((w,i)=>send(w,{mode,n,rev,wire:p.wire,query:queries[i],ids:pointIds[i],hold})));
      const replyMs=performance.now()-a;
      for(let i=0;i<replies.length;i++){const r=replies[i];equal(r.rev,rev,'revision');equal(r.size,n,'size');equal(r.points,expected[i].points,'points');equal(r.visible,expected[i].visible,'visible');}
      events.push({rev,removed:b.remove.length,changed:b.upsert.length,mutationMs,payloadMs,replyMs,editToAnswerMs:mutationMs+replyMs,firstElapsedMs:rev===0?performance.now()-initialWorkers:null,
        scan:!!queries[0],visibleRows:replies.reduce((s,r)=>s+(r.visible?.length??0),0),attachMs:Math.max(...replies.map(r=>r.attachMs)),pointMs:Math.max(...replies.map(r=>r.pointMs)),scanMs:Math.max(...replies.map(r=>r.scanMs)),memory:p.memory});
    }
    const history=[],expected=[];
    for(const [rev,r] of retained){const ids=[...r.rows.keys()].sort((a,b)=>a-b);history.push({rev,ids,missing:r.missing});expected.push([rev,await digest(ids.length,i=>r.rows.get(ids[i]))]);}
    for(const r of await Promise.all(workers.map(w=>send(w,{verify:true,mode,history}))))equal(r.digests,expected,'retained full rows');
    const timed=events.slice(1);
    return {mode,n,buildMs,firstMs:events[0].firstElapsedMs,totalEditToAnswerMs:timed.reduce((s,r)=>s+r.editToAnswerMs,0),
      p95EditToAnswerMs:percentile(timed.map(r=>r.editToAnswerMs),.95),p95ScanMs:percentile(timed.filter(r=>r.scan).map(r=>r.scanMs),.95),
      initial:events[0].memory,final:events.at(-1).memory,events,digests:expected,verified:true};
  }finally{for(const w of workers)w.terminate();}
}
