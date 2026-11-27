import assert from 'node:assert/strict';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import {SharedMap,SharedList,getWorkerData,initWorker} from '../../dist/shared.js';
import {ColumnTable} from './table.mjs';
const schema={x:'float64',y:'float64',speed:'uint8',kind:'uint8',active:'boolean'};
const fields=Object.keys(schema),key=i=>'lane/'+i;
const row=i=>Object.freeze({x:i%997,y:(i*37)%991,speed:30+i%61,kind:i%4,active:i%5!==0});
const queries=Array.from({length:5},(_,i)=>({min:50+i*80,max:500+i*80,ymin:100+i*20,ymax:700+i*20,kind:i%4}));
const pointIds=n=>Array.from({length:Math.min(1000,n)},(_,i)=>(i*8191+7)%n);
const digestRows=(n,get)=>{const h=createHash('sha256');for(let i=0;i<n;i++){const r=get(i);h.update(JSON.stringify(fields.map(f=>r[f]))+'\n');}return h.digest('hex');};
function scanRows(rows,q) {
  let count=0,total=0;
  for(const r of rows)if(r.active&&r.kind===q.kind&&r.x>=q.min&&r.x<=q.max&&r.y>=q.ymin&&r.y<=q.ymax){count++;total+=r.speed;}
  return {count,total};
}
const filters=q=>[{column:'x',min:q.min,max:q.max},{column:'y',min:q.ymin,max:q.ymax},{column:'active',eq:true},{column:'kind',eq:q.kind}];
const point=(get,ids)=>ids.reduce((s,i)=>{const r=get(i);return s+r.x+r.y+r.speed+r.kind+Number(r.active);},0);
const isTable=m=>m.startsWith('table'),isJSON=m=>m.startsWith('json');
function build(mode,rows){
  if(isJSON(mode))return {map:new SharedMap('object').setMany(rows.map((r,i)=>[key(i),r]))};
  if(mode==='native')return {map:new Map(rows.map((r,i)=>[key(i),r]))};
  // Keep an equivalent stable string-key lookup index for the numeric column arms.
  const index=new SharedMap('number').setMany(rows.map((_,i)=>[key(i),i]));
  if(isTable(mode))return {index,table:ColumnTable.fromRows(schema,rows,{blockRows:Number(mode.split('-')[1])})};
  return {index,columns:Object.fromEntries(fields.map(f=>[f,new SharedList(schema[f]==='boolean'?'boolean':'number').pushMany(rows.map(r=>r[f]))]))};
}
function edit(mode,owner,edits){
  if(isJSON(mode))return {map:owner.map.setMany(edits.map(([i,r])=>[key(i),r]))};
  if(mode==='native'){const map=new Map(owner.map);for(const [i,r] of edits)map.set(key(i),r);return {map};}
  // All modes receive the same logical rows. Only changed fields should be written.
  if(isTable(mode))return {index:owner.index,table:owner.table.editMany(edits.map(([i,r])=>[i,{x:r.x,speed:r.speed}]))};
  return {index:owner.index,columns:{...owner.columns,x:owner.columns.x.setMany(edits.map(([i,r])=>[i,r.x])),speed:owner.columns.speed.setMany(edits.map(([i,r])=>[i,r.speed]))}};
}
function payload(mode,owner){
  if(mode==='native')return owner;
  if(isTable(mode))return {data:getWorkerData({index:owner.index},{copy:false}),table:owner.table.descriptor()};
  return {data:getWorkerData(isJSON(mode)?owner.map?{map:owner.map}:{}:{index:owner.index,...owner.columns},{copy:false})};
}
function footprint(mode,p){
  if(mode==='native')return null;
  return {used:p.data.arenas.reduce((s,a)=>s+a.used,0)+(p.table?.used??0),capacity:p.data.arenas.reduce((s,a)=>s+a.memory.buffer.byteLength,0)+(p.table?.memory.buffer.byteLength??0),arenas:p.data.arenas.length+Number(!!p.table),tableUsed:p.table?.used??null,indexUsed:p.table?p.data.arenas.reduce((s,a)=>s+a.used,0):null};
}
async function attach(mode,p,previous){
  if(mode==='native'){for(const r of p.map.values())Object.freeze(r);return p;}
  const attached=await initWorker(p.data,{previous:previous?.attached});
  if(isTable(mode))return {attached,index:attached.index,table:ColumnTable.attach(p.table)};
  if(isJSON(mode))return {attached,map:attached.map};
  return {attached,index:attached.index,columns:Object.fromEntries(fields.map(f=>[f,attached[f]]))};
}
function getRow(mode,s,i){
  if(mode==='native'||isJSON(mode))return s.map.get(key(i));
  const slot=s.index.get(key(i));assert.equal(slot,i);
  if(isTable(mode))return mode.endsWith('-direct')?s.table.rowDirect(slot):s.table.row(slot);
  return Object.freeze(Object.fromEntries(fields.map(f=>[f,s.columns[f].get(slot)])));
}
function scan(mode,s,q,n){
  if(mode==='native'||mode==='json'||mode==='json-control')return scanRows(s.map.values(),q);
  if(mode==='json-direct'){
    let count=0,total=0;
    for(const v of s.map.valuesView()){
      if(v.get('active')!==true||v.get('kind')!==q.kind)continue;
      const x=v.get('x'),y=v.get('y');if(x>=q.min&&x<=q.max&&y>=q.ymin&&y<=q.ymax){count++;total+=v.get('speed');}
    }
    return {count,total};
  }
  if(mode==='json-view'){
    let count=0,total=0;
    for(const k of s.map.keys()){
      const v=s.map.getView(k);if(v.get('active')!==true||v.get('kind')!==q.kind)continue;
      const x=v.get('x'),y=v.get('y');if(x>=q.min&&x<=q.max&&y>=q.ymin&&y<=q.ymax){count++;total+=v.get('speed');}
    }
    return {count,total};
  }
  if(isTable(mode))return s.table.aggregate(filters(q),'speed');
  const {x,y,kind,active,speed}=s.columns;let count=0,total=0;
  for(let i=0;i<n;i++)if(active.get(i)&&kind.get(i)===q.kind){
    const a=x.get(i),b=y.get(i);if(a>=q.min&&a<=q.max&&b>=q.ymin&&b<=q.ymax){count++;total+=speed.get(i);}
  }
  return {count,total};
}
if(!isMainThread){
  const {mode,n}=workerData;let current,initial;
  parentPort.on('message',async m=>{
    try{
      if(m.kind==='verify'){
        parentPort.postMessage({initial:digestRows(n,i=>getRow(mode,initial,i)),latest:digestRows(n,i=>getRow(mode,current,i))});return;
      }
      const a=performance.now();if(m.payload)current=await attach(mode,m.payload,current);
      initial??=current;const attachMs=performance.now()-a;
      const t=performance.now(),results=m.queries.map(q=>scan(mode,m.old?initial:current,q,n)),scanMs=performance.now()-t;
      const start=performance.now(),points=point(i=>getRow(mode,m.old?initial:current,i),m.ids),pointMs=performance.now()-start;
      parentPort.postMessage({results,points,attachMs,scanMs,pointMs});
    }catch(error){parentPort.postMessage({error:String(error?.stack??error)});}
  });
}else if(process.argv[2]==='--case'){
  const mode=process.argv[3],n=Number(process.argv[4]),rows=Array.from({length:n},(_,i)=>row(i)),original=rows.slice(),ids=pointIds(n);
  let t=performance.now(),owner=build(mode,rows),buildMs=performance.now()-t;
  const phases=[];let workers=[];
  const send=(w,m)=>new Promise((resolve,reject)=>{
    const onError=e=>{cleanup();reject(e);},onMessage=v=>{cleanup();v.error?reject(Error(v.error)):resolve(v);};
    const timer=setTimeout(()=>onError(Error('worker timeout')),120000);
    function cleanup(){clearTimeout(timer);w.off('message',onMessage);w.off('error',onError);}
    w.once('message',onMessage);w.once('error',onError);w.postMessage(m);
  });
  async function phase(name,withPayload,qs,old=false,create=false){
    const expected=old?original:rows,expectedResults=qs.map(q=>scanRows(expected,q)),expectedPoints=point(i=>expected[i],ids);
    const begin=performance.now();
    if(create)workers=[0,1].map(()=>new Worker(new URL(import.meta.url),{workerData:{mode,n},execArgv:[]}));
    const p=withPayload?payload(mode,owner):undefined,afterPayload=performance.now();
    const result=await Promise.all(workers.map(w=>send(w,{kind:'query',payload:p,queries:qs,ids,old})));
    const elapsedMs=performance.now()-begin;
    for(const r of result){assert.deepEqual(r.results,expectedResults);assert.equal(r.points,expectedPoints);}
    phases.push({name,elapsedMs,payloadAndStartupMs:afterPayload-begin,attachMs:Math.max(...result.map(r=>r.attachMs)),scanMs:Math.max(...result.map(r=>r.scanMs)),pointMs:Math.max(...result.map(r=>r.pointMs)),footprint:p?footprint(mode,p):null});
  }
  try{
    await phase('first',true,[queries[0]],false,true);
    await phase('warm',false,queries);
    for(const [name,count] of [['sparse',Math.min(25,n)],['dense',Math.max(1,Math.floor(n/10))]]){
      const edits=Array.from({length:count},(_,j)=>{const i=Math.floor(j*n/count),r=Object.freeze({...rows[i],x:rows[i].x+17,speed:(rows[i].speed+1)%100});rows[i]=r;return [i,r];});
      const start=performance.now();owner=edit(mode,owner,edits);const mutationMs=performance.now()-start;
      await phase(name,true,[queries[1],queries[2]]);phases.at(-1).mutationMs=mutationMs;
    }
    await phase('history',false,[queries[3],queries[4]],true);
    const peakMixedRSSKiB=process.resourceUsage().maxRSS;
    // Separate fresh, point-only reader attachment. No preceding scan or cache warming.
    const fresh=[0,1].map(()=>new Worker(new URL(import.meta.url),{workerData:{mode,n},execArgv:[]}));
    try{
      const start=performance.now(),p=payload(mode,owner);
      const rs=await Promise.all(fresh.map(w=>send(w,{kind:'query',payload:p,queries:[],ids})));
      const elapsedMs=performance.now()-start;
      const expected=point(i=>rows[i],ids);
      for(const rr of rs){assert.equal(rr.points,expected);assert.deepEqual(rr.results,[]);}
      phases.push({name:'fresh-point',elapsedMs,pointMs:Math.max(...rs.map(r=>r.pointMs)),attachMs:Math.max(...rs.map(r=>r.attachMs)),footprint:footprint(mode,p)});
    }finally{await Promise.all(fresh.map(w=>w.terminate()));}
    const peakBeforeVerificationRSSKiB=process.resourceUsage().maxRSS;
    const expectedOld=digestRows(n,i=>original[i]),expectedNew=digestRows(n,i=>rows[i]);
    const digests=await Promise.all(workers.map(w=>send(w,{kind:'verify'})));
    for(const r of digests){assert.equal(r.initial,expectedOld);assert.equal(r.latest,expectedNew);}
    // Capture measured-phase RSS separately from post-verification high-water if needed in follow-up.
    console.log(JSON.stringify({mode,n,buildMs,phases,peakMixedRSSKiB,peakBeforeVerificationRSSKiB,peakRSSKiB:process.resourceUsage().maxRSS,digests,verified:true}));
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
}else{
  const [output='columnar-results.json',roundArg='5',sizeArg='1000,10000,100000']=process.argv.slice(2);
  const rounds=Number(roundArg),sizes=sizeArg.split(',').map(Number);
  const modes=['json','json-control','json-view','json-direct','lists','table-256','table-256-direct','table-1024-direct','native'];
  const report={node:process.version,cpu:cpus()[0].model,rounds,sizes,modes,rows:[],base:'84ad23a76ee197f45cbc7316017f28b5bbe93d6c',control:'172839f20b24392d96ba21723fd300efa2e5ee8b: exact shared-map.ts runtime source, the only runtime diff from base',note:'peakMixedRSSKiB is high-water through mixed/history phases; peakBeforeVerificationRSSKiB includes extra fresh point readers; peakRSSKiB includes exhaustive verification. Not browser PSS.'};
  for(const n of sizes)for(let r=-1;r<rounds;r++){
    const offset=(r+1)%modes.length,order=[...modes.slice(offset),...modes.slice(0,offset)];
    if(r%2===1)order.reverse();
    for(const mode of order){
      const result=JSON.parse(execFileSync(process.execPath,[new URL(import.meta.url).pathname,'--case',mode,String(n)],{encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024}));
      assert(result.verified);result.round=r;report.rows.push(result);console.log(JSON.stringify(result));writeFileSync(output,JSON.stringify(report));
    }
  }
}
