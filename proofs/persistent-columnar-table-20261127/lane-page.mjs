import {build,edit,payload} from './lane-runtime.mjs';
import {lane,editsFor,queryFor,matches,validate,equal,digest} from './lane-fixture.mjs';
const revisions=24,readerCount=4;
function send(w,m){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>done(Error('worker timeout')),90000);
  function onmessage(e){done(e.data.error?Error(e.data.error):null,e.data);}
  function onerror(e){done(Error(e.message));}
  function done(err,result){clearTimeout(timer);w.removeEventListener('message',onmessage);w.removeEventListener('error',onerror);err?reject(err):resolve(result);}
  w.addEventListener('message',onmessage);w.addEventListener('error',onerror);w.postMessage(m);
});}
const percentile=(a,q)=>a.slice().sort((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*q)-1)];
export async function run(mode,n){
  if(!crossOriginIsolated)throw Error('not isolated');
  const rows=Array.from({length:n},(_,i)=>lane(i)),retained=new Map([[0,rows.slice()]]),events=[];
  const start=performance.now();let owner=build(mode,rows);const buildMs=performance.now()-start;
  const initialWorkers=performance.now(),workers=Array.from({length:readerCount},()=>new Worker(new URL('./lane-worker.mjs',import.meta.url),{type:'module'}));
  try{
    for(let rev=0;rev<=revisions;rev++){
      const edits=rev?editsFor(rows,rev):[];for(const [i,r] of edits)rows[i]=r;
      const hold=rev===0||rev===12||rev===revisions;
      if(hold&&rev)retained.set(rev,rows.slice());
      const queries=workers.map((_,w)=>rev%3===0?queryFor(n,rev,w):null);
      const ids=workers.map((_,w)=>[...edits.slice(0,16).map(([i])=>i),...Array.from({length:8},(_,j)=>(rev*997+w*103+j*7187)%n)]);
      const expected=queries.map((q,w)=>({points:ids[w].map(i=>rows[i]),visible:q?rows.filter(r=>matches(r,q)).map(validate):null}));
      const t=performance.now();if(rev)owner=edit(mode,owner,edits);const mutationMs=performance.now()-t;
      const a=performance.now(),p=payload(mode,owner,rev===0),payloadMs=performance.now()-a;
      const replies=await Promise.all(workers.map((w,i)=>send(w,{mode,n,rev,wire:p.wire,query:queries[i],ids:ids[i],hold})));
      const replyMs=performance.now()-a;
      for(let i=0;i<replies.length;i++){
        const r=replies[i];equal(r.rev,rev,'revision');equal(r.points,expected[i].points,'points');equal(r.visible,expected[i].visible,'visible');
      }
      events.push({rev,changed:edits.length,mutationMs,payloadMs,replyMs,editToAnswerMs:mutationMs+replyMs,firstElapsedMs:rev===0?performance.now()-initialWorkers:null,
        scan:!!queries[0],visibleRows:replies.reduce((s,r)=>s+(r.visible?.length??0),0),
        attachMs:Math.max(...replies.map(r=>r.attachMs)),pointMs:Math.max(...replies.map(r=>r.pointMs)),scanMs:Math.max(...replies.map(r=>r.scanMs)),memory:p.memory});
    }
    const expected=[];for(const [rev,r] of retained)expected.push([rev,await digest(n,i=>r[i])]);
    for(const r of await Promise.all(workers.map(w=>send(w,{verify:true,mode,n}))))equal(r.digests,expected,'retained full rows');
    const timed=events.slice(1);
    return {mode,n,buildMs,firstMs:events[0].firstElapsedMs,totalEditToAnswerMs:timed.reduce((s,r)=>s+r.editToAnswerMs,0),
      p95EditToAnswerMs:percentile(timed.map(r=>r.editToAnswerMs),.95),p95ScanMs:percentile(timed.filter(r=>r.scan).map(r=>r.scanMs),.95),
      initial:events[0].memory,final:events.at(-1).memory,events,digests:expected,verified:true};
  }finally{for(const w of workers)w.terminate();}
}
