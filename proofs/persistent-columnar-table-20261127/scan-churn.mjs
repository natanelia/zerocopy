// Proof-only: establish publication/churn baseline before changing the storage layout.
import assert from 'node:assert/strict';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {SharedMap,SharedList,getWorkerData,initWorker} from '../../dist/shared.js';
import {ColumnTable} from './table.mjs';
import {ColumnTable as PagedTable} from './table-paged.mjs';
import {ColumnTable as FastPagedTable} from './table-paged-fast.mjs';
import {ColumnTable as SessionTable,openPublisher,openReader} from './table-paged-session.mjs';
import {ColumnTable as RunsTable,openPublisher as openRunsPublisher,openReader as openRunsReader} from './table-paged-runs.mjs';
const isSession=mode=>mode.includes('-session');
const isRuns=mode=>mode.includes('-runs');
const tableClass=mode=>isRuns(mode)?RunsTable:isSession(mode)?SessionTable:mode.includes('-fast-paged')?FastPagedTable:mode.endsWith('-paged')?PagedTable:ColumnTable;
const schema={x:'float64',y:'float64',speed:'uint8',kind:'uint8',active:'boolean'};
const fields=Object.keys(schema), widths=[8,8,1,1,1];
const key=i=> (i%31===0?'道路/':'lane/')+((Math.imul(i,2654435761)>>>0).toString(36))+'/'+i;
const row=i=>Object.freeze({x:i%997,y:(i*37)%991,speed:30+i%61,kind:i%4,active:i%5!==0});
// Moving viewport: some successive publications reuse a viewport, others change
// its position and selectivity. No mode may reuse a stale result.
const queryFor=rev=>{const t=Math.floor(rev/16);return {minX:100+(t*73)%400,maxX:300+(t*73)%400+(t%3)*120,minY:80+(t*41)%250,maxY:500+(t*41)%250,kind:t%4};};
const filters=q=>[{column:'active',eq:true},{column:'kind',eq:q.kind},{column:'x',min:q.minX,max:q.maxX},{column:'y',min:q.minY,max:q.maxY}];
const qualifies=(r,q)=>r.active&&r.kind===q.kind&&r.x>=q.minX&&r.x<=q.maxX&&r.y>=q.minY&&r.y<=q.maxY;
function scanRows(rows,q){let count=0,total=0;for(const r of rows)if(qualifies(r,q)){count++;total+=r.speed;}return {count,total};}
const isTable=m=>m.startsWith('table'),isJSON=m=>m.startsWith('json');
const hashRows=(n,get)=>{const h=createHash('sha256');for(let i=0;i<n;i++){const r=get(i);h.update(JSON.stringify(fields.map(f=>r[f]))+'\n');}return h.digest('hex');};
function build(mode,rows){
  if(isJSON(mode))return {map:new SharedMap('object').setMany(rows.map((r,i)=>[key(i),r]))};
  if(mode==='native')return {map:new Map(rows.map((r,i)=>[key(i),r]))};
  const index=new SharedMap('number').setMany(rows.map((_,i)=>[key(i),i]));
  if(isTable(mode))return {index,table:tableClass(mode).fromRows(schema,rows,{blockRows:Number(mode.split('-')[1])})};
  return {index,columns:Object.fromEntries(fields.map(f=>[f,new SharedList(schema[f]==='boolean'?'boolean':'number').pushMany(rows.map(r=>r[f]))]))};
}
function edit(mode,owner,edits){
  if(isJSON(mode))return {map:owner.map.setMany(edits.map(([i,r])=>[key(i),r]))};
  if(mode==='native'){const map=new Map(owner.map);for(const [i,r] of edits)map.set(key(i),r);return {map};}
  if(isTable(mode))return {index:owner.index,table:owner.table.editMany(edits.map(([i,r])=>[i,{x:r.x,speed:r.speed}]))};
  return {index:owner.index,columns:{...owner.columns,x:owner.columns.x.setMany(edits.map(([i,r])=>[i,r.x])),speed:owner.columns.speed.setMany(edits.map(([i,r])=>[i,r.speed]))}};
}
function payload(mode,owner){
  if(mode==='native')return owner;
  if(isTable(mode))return {data:getWorkerData({index:owner.index},{copy:false}),table:owner.table.descriptor()};
  return {data:getWorkerData(isJSON(mode)?{map:owner.map}:{index:owner.index,...owner.columns},{copy:false})};
}
function footprint(mode,p){
  if(mode==='native')return null;
  const indexUsed=p.data.arenas.reduce((s,a)=>s+a.used,0);
  return {used:indexUsed+(p.table?.used??0),capacity:p.data.arenas.reduce((s,a)=>s+a.memory.buffer.byteLength,0)+(p.table?.memory.buffer.byteLength??0),
    columnUsed:p.table?.used??null,indexUsed:p.table?indexUsed:null};
}
function attribution(prev,next){
  const a=prev.table.descriptor(),b=next.table.descriptor(),blocks=Math.ceil(a.rows/a.blockRows),slots=blocks*fields.length;
  if(a.root===b.root)return {directory:0,blocks:0,changedBlocks:0,padding:0};
  let directory=slots*4;
  function addresses(d){
    if(d.format==='column-proof-v0')return new Uint32Array(d.memory.buffer,d.root,slots);
    const top=new Uint32Array(d.memory.buffer,d.root,Math.ceil(slots/64)),out=new Uint32Array(slots);
    for(let i=0;i<top.length;i++)out.set(new Uint32Array(d.memory.buffer,top[i],Math.min(64,slots-i*64)),i*64);
    return out;
  }
  if(a.format==='column-proof-paged-v0'){
    const x=new Uint32Array(a.memory.buffer,a.root,Math.ceil(slots/64)),y=new Uint32Array(b.memory.buffer,b.root,x.length);
    directory=y.byteLength;
    for(let i=0;i<x.length;i++)if(x[i]!==y[i])directory+=Math.min(64,slots-i*64)*4;
  }
  const before=addresses(a),after=addresses(b);
  let data=0,changedBlocks=0;
  for(let j=0;j<slots;j++)if(before[j]!==after[j]){
    const c=Math.floor(j/blocks),i=j%blocks;data+=widths[c]*Math.min(a.blockRows,a.rows-i*a.blockRows);changedBlocks++;
  }
  const padding=b.used-a.used-directory-data;
  assert(padding>=0);return {directory,blocks:data,changedBlocks,padding};
}
async function attach(mode,p,previous){
  if(mode==='native'){for(const r of p.map.values())Object.freeze(r);return p;}
  const attached=await initWorker(p.data,{previous:previous?.attached});
  if(isSession(mode)){
    const reader=previous?.reader??(isRuns(mode)?openRunsReader:openReader)(p.tableSession,{reuse:!mode.includes('-full')});
    const table=previous?reader.accept(p.tableSession):reader.snapshot;
    return {attached,index:attached.index,table,reader};
  }
  if(isTable(mode))return {attached,index:attached.index,table:tableClass(mode).attach(p.table)};
  if(isJSON(mode))return {attached,map:attached.map};
  return {attached,index:attached.index,columns:Object.fromEntries(fields.map(f=>[f,attached[f]]))};
}
function get(mode,s,i){
  if(mode==='native'||isJSON(mode))return s.map.get(key(i));
  const slot=s.index.get(key(i));assert.equal(slot,i);
  if(isTable(mode))return s.table.rowDirect(slot);
  return Object.freeze(Object.fromEntries(fields.map(f=>[f,s.columns[f].get(slot)])));
}
function scan(mode,s,n,q){
  if(mode==='native')return scanRows(s.map.values(),q);
  if(isJSON(mode)){let count=0,total=0;
    for(const v of s.map.valuesView()){
      if(v.get('active')!==true||v.get('kind')!==q.kind)continue;
      const x=v.get('x'),y=v.get('y');
      if(x>=q.minX&&x<=q.maxX&&y>=q.minY&&y<=q.maxY){count++;total+=v.get('speed');}
    }return {count,total};
  }
  if(isTable(mode))return s.table.aggregate(filters(q),'speed');
  const {x,y,active,kind,speed}=s.columns;let count=0,total=0;
  for(let i=0;i<n;i++)if(active.get(i)&&kind.get(i)===q.kind){
    const a=x.get(i),b=y.get(i);if(a>=q.minX&&a<=q.maxX&&b>=q.minY&&b<=q.maxY){count++;total+=speed.get(i);}
  }return {count,total};
}
function idsFor(n,revision,pattern){
  const start=(Math.imul(revision,8191)>>>0)%n;
  if(pattern==='single')return [start];
  if(pattern==='burst'){
    const count=revision%48===0?Math.floor(n/10):revision%12===0?1024:1;
    return Array.from({length:count},(_,j)=>(start+Math.floor(j*n/count))%n);
  }
  return Array.from({length:25},(_,j)=>(start+(pattern==='clustered'?j:Math.floor(j*n/25)))%n);
}
if(!isMainThread){
  const {mode,n}=workerData;let current,last=-1;const retained=new Map();
  parentPort.on('message',async m=>{
    try{
      if(m.kind==='verify'){
        parentPort.postMessage({digests:[...retained].map(([r,s])=>[r,hashRows(n,i=>get(mode,s,i))])});return;
      }
      assert.equal(m.revision,last+1);
      const start=performance.now();current=await attach(mode,m.payload,current);
      const attachMs=performance.now()-start;
      if(m.retain)retained.set(m.revision,current);
      const s=performance.now(),points=m.ids.map(i=>get(mode,current,i)),pointMs=performance.now()-s;
      const q=performance.now(),result=m.scan?scan(mode,current,n,m.query):null,scanMs=performance.now()-q;
      last=m.revision;
      parentPort.postMessage({revision:last,points,result,attachMs,pointMs,scanMs});
    }catch(e){parentPort.postMessage({error:String(e?.stack??e)});}
  });
}else if(process.argv[2]==='--case'){
  const mode=process.argv[3],n=Number(process.argv[4]),pattern=process.argv[5],revisions=96,readerCount=4;
  const rows=Array.from({length:n},(_,i)=>row(i)),retained=new Map([[0,rows.slice()]]),events=[];
  const start=performance.now();let owner=build(mode,rows);const buildMs=performance.now()-start;
  const publisher=isSession(mode)?(isRuns(mode)?openRunsPublisher:openPublisher)(owner.table):null;
  const workers=Array.from({length:readerCount},()=>new Worker(new URL(import.meta.url),{workerData:{mode,n},execArgv:[]}));
  function send(w,m){return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>fail(Error('worker timeout')),120000);
    function cleanup(){clearTimeout(timer);w.off('message',receive);w.off('error',fail);}
    function receive(v){cleanup();v.error?reject(Error(v.error)):resolve(v);}
    function fail(e){cleanup();reject(e);}
    w.once('message',receive);w.once('error',fail);w.postMessage(m);
  });}
  try{
    for(let rev=0;rev<=revisions;rev++){
      const changed=rev?idsFor(n,rev,pattern):[],edits=changed.map(i=>{
        const r=Object.freeze({...rows[i],x:(rows[i].x+17)%1009,speed:(rows[i].speed+1)%100});rows[i]=r;return [i,r];
      });
      const ids=[...changed,...Array.from({length:16},(_,j)=>(rev*997+j*7187)%n)];
      const wantsScan=rev%8===0||rev===revisions,hold=rev===0||rev===revisions/2||rev===revisions;
      const query=queryFor(rev),expected=ids.map(i=>rows[i]),expectedScan=wantsScan?scanRows(rows,query):null;
      if(hold&&rev)retained.set(rev,rows.slice());
      const prev=owner,t=performance.now();if(rev)owner=edit(mode,owner,edits);const mutationMs=performance.now()-t;
      const a=performance.now(),p=payload(mode,owner);
      // Both session modes send exactly the same protocol. Separate owner-side
      // footprint accounting keeps the full descriptor out of the worker message.
      const wire=publisher?{data:p.data,tableSession:rev?publisher.publish(owner.table):publisher.initial()}:p;
      const payloadMs=performance.now()-a;
      const replies=await Promise.all(workers.map(w=>send(w,{kind:'query',revision:rev,payload:wire,ids,scan:wantsScan,query,retain:hold})));
      const replyMs=performance.now()-a;
      for(const r of replies){assert.equal(r.revision,rev);assert.deepEqual(r.points,expected);assert.deepEqual(r.result,expectedScan);}
      events.push({rev,mutationMs,payloadMs,replyMs,editToAnswerMs:mutationMs+replyMs,scan:wantsScan,
        attachMs:Math.max(...replies.map(r=>r.attachMs)),pointMs:Math.max(...replies.map(r=>r.pointMs)),scanMs:Math.max(...replies.map(r=>r.scanMs)),
        footprint:footprint(mode,p),allocation:rev&&isTable(mode)?attribution(prev,owner):null});
    }
    const peakBeforeVerificationRSSKiB=process.resourceUsage().maxRSS;
    const expected=[...retained].map(([r,s])=>[r,hashRows(n,i=>s[i])]);
    for(const r of await Promise.all(workers.map(w=>send(w,{kind:'verify'}))))assert.deepEqual(r.digests,expected);
    console.log(JSON.stringify({mode,n,pattern,revisions,readerCount,buildMs,events,peakBeforeVerificationRSSKiB,
      peakRSSKiB:process.resourceUsage().maxRSS,digests:expected,verified:true}));
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
}else{
  const [out='churn-results.json',pattern='single',roundArg='5']=process.argv.slice(2);
  assert(['single','spread','burst'].includes(pattern));const rounds=Number(roundArg),n=100000;
  const modes=['lists','json-direct','table-32-session','table-32-session-runs','table-32-session-runs-control','table-256-session','table-256-session-runs'];
  const report={previousPagedHead:'5779abb3eb164678a986482e315db1a7c2d3da93',base:'84ad23a76ee197f45cbc7316017f28b5bbe93d6c',jsonControl:'172839f20b24392d96ba21723fd300efa2e5ee8b',
    node:process.version,cpu:cpus()[0].model,pattern,rounds,n,modes,rows:[]};
  const quantile=(xs,q)=>{const a=[...xs].sort((a,b)=>a-b);return a[Math.ceil(a.length*q)-1];};
  for(let round=-1;round<rounds;round++){
    const offset=(round+1)%modes.length,order=[...modes.slice(offset),...modes.slice(0,offset)];if(round%2===1)order.reverse();
    for(const mode of order){
      const run=JSON.parse(execFileSync(process.execPath,[new URL(import.meta.url).pathname,'--case',mode,String(n),pattern],
        {encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024}));
      assert(run.verified);run.round=round;report.rows.push(run);writeFileSync(out,JSON.stringify(report));
      const e=run.events.slice(1),sum=k=>e.reduce((s,v)=>s+v[k],0),allocation=e.reduce((a,v)=>{if(v.allocation)for(const k of Object.keys(a))a[k]+=v.allocation[k];return a;},{directory:0,blocks:0,changedBlocks:0,padding:0});
      const initial=run.events[0].footprint,final=e.at(-1).footprint;
      console.log(JSON.stringify({mode,round,n,pattern,buildMs:run.buildMs,firstMs:run.events[0].replyMs,
        totalEditToAnswerMs:sum('editToAnswerMs'),mutationMs:sum('mutationMs'),replyMs:sum('replyMs'),
        p95EditToAnswerMs:quantile(e.map(v=>v.editToAnswerMs),.95),
        p95PointOnlyMs:quantile(e.filter(v=>!v.scan).map(v=>v.editToAnswerMs),.95),
        p95ScanMs:quantile(e.filter(v=>v.scan).map(v=>v.editToAnswerMs),.95),
        sumAttachMs:sum('attachMs'),sumPointMs:sum('pointMs'),sumScanMs:sum('scanMs'),
        p95AttachMs:quantile(e.map(v=>v.attachMs),.95),p95LocalPointMs:quantile(e.map(v=>v.pointMs),.95),p95LocalScanMs:quantile(e.filter(v=>v.scan).map(v=>v.scanMs),.95),
        initial,final,allocation,peakBeforeVerificationRSSKiB:run.peakBeforeVerificationRSSKiB,verified:run.verified}));
    }
  }
}
