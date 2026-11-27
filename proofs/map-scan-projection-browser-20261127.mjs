import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium, firefox } from 'playwright';
const [engine, count, base, candidate, out] = process.argv.slice(2);
assert(['chromium','firefox'].includes(engine) && ['10000','100000'].includes(count));
mkdirSync(out,{recursive:true});

const fixture = String.raw`
export const key = i => (i % 97 === 0 ? '道路:' : 'lane:') + i;
export const changed = (i,n) => i % Math.max(100, Math.floor(n/100)) === 0;
export const windows = [0,371,1043,1971,2641];
export function row(i, revision=0) {
  const x=(i*137%4096)+revision*31,y=i*73%4096;
  return {id:i,x,y,width:3+i%5,kind:i%3,revision,name:'lane-'+i,
    geometry:{type:'LineString',coordinates:Array.from({length:12},(_,j)=>[x+j*2,y+j%3])},
    attributes:{direction:i%2?'forward':'both',flags:[i%3===0,i%5===0],label:i%97===0?'道路 🚗':'local',speedLimit:30+i%4*10}};
}
export const inside=(v,start)=>v.x+v.width>=start&&v.x<start+1024&&v.y>=512&&v.y<3584&&v.kind!==2;
export function check(ok,label){if(!ok)throw Error(label);}
export function equal(a,b,label){check(JSON.stringify(a)===JSON.stringify(b),label);}
`;
const worker = String.raw`
import {key,changed,windows,row,check,equal} from '/fixture.js';
let S,old,next,api,n,iterator,held;
function scan(map,start){
  const ids=[],t=performance.now();
  const vs=api==='direct'?map.valuesView():(function*(){for(const k of map.keys())yield map.getView(k);})();
  for(const v of vs){
    const x=v.get('x');
    if(x>=start+1024||x+v.get('width')<start)continue;
    const y=v.get('y');
    if(y<512||y>=3584||v.equals('kind',2))continue;
    ids.push(v.get('id'));
  }
  return {ids,ms:performance.now()-t};
}
function verify(map,rev){
  const seen=new Uint8Array(n), keys=map.keys();
  const vs=api==='direct'?map.valuesView():(function*(){for(const k of map.keys())yield map.getView(k);})();
  for(const view of vs){
    const i=view.get('id');
    check(Number.isInteger(i)&&i>=0&&i<n&&!seen[i],'unique id');
    seen[i]=1;equal(keys.next().value,key(i),'key order');
    equal(view.toObject(),row(i,rev&&changed(i,n)?1:0),'complete record');
  }
  check(keys.next().done&&seen.every(x=>x===1),'complete scan');
  let rejected=false;try{map.set('forbidden',row(0));}catch(e){rejected=/read-only/.test(String(e));}
  check(rejected,'reader write rejection');
}
self.onmessage=async ({data:m})=>{try{
  check(crossOriginIsolated,'worker isolation');
  let result;
  if(m.phase==='first'||m.phase==='cold'){
    S=await import(m.module);api=m.api;n=m.n;
    old=(await S.initWorker(m.initial)).map;
    if(m.phase==='cold')next=(await S.initWorker(m.updated,{previous:{map:old}})).map;
  }
  if(m.phase==='updated')next=(await S.initWorker(m.updated,{previous:{map:old}})).map;
  if(['first','repeat','updated','retained'].includes(m.phase)){
    const map=m.phase==='updated'?next:old;
    result={scans:(m.phase==='first'?[windows[0]]:windows).map(start=>scan(map,start))};
  } else if(['points','points-repeat','cold'].includes(m.phase)){
    const ids=Array.from({length:1000},(_,j)=>(j*7919+17)%n),values=[],t=performance.now();
    for(const i of ids)values.push(old.get(key(i)),next.get(key(i)));
    const ms=performance.now()-t;
    for(let j=0;j<ids.length;j++){
      const i=ids[j];equal(values[j*2],row(i),'old point');equal(values[j*2+1],row(i,changed(i,n)?1:0),'new point');
    }
    result={ms,verified:true};
  } else if(m.phase==='verify'){verify(old,0);verify(next,1);result={verified:true};}
  else if(m.phase==='pause'){
    S=await import(m.module);old=(await S.initWorker(m.initial)).map;
    iterator=old.valuesView();held=iterator.next().value;
    result={first:held.toObject(),verified:true};
  } else if(m.phase==='resume'){
    const rest=[held,...iterator].map(v=>v.toObject());
    equal(rest,m.expected,'paused iterator');equal(held.toObject(),m.expected[0],'held view');
    const fork=(await S.initWorker(m.updated)).map;
    equal([...fork.valuesView()].map(v=>v.toObject()),m.fork,'fork');
    let rejected=false;try{old.set('forbidden',{id:9});}catch(e){rejected=/read-only/.test(String(e));}
    check(rejected,'lifetime write rejection');result={verified:true};
  } else throw Error('unknown phase '+m.phase);
  postMessage(result);
}catch(e){postMessage({error:String(e.stack??e)});}};
`;
const driver = String.raw`
import {key,changed,windows,row,inside,check,equal} from '/fixture.js';
function ask(w,m){return new Promise((resolve,reject)=>{
  w.onmessage=({data})=>data.error?reject(Error(data.error)):resolve(data);
  w.onerror=e=>reject(Error(e.message));w.postMessage(m);
});}
const workers=()=>Array.from({length:2},()=>new Worker('/worker.js',{type:'module'}));
async function exchange(ws,m){
  const start=performance.now(),readers=await Promise.all(ws.map(w=>ask(w,m)));
  return {roundTrip:performance.now()-start,readers};
}
export async function run(mode,n){
  check(crossOriginIsolated,'page isolation');
  const module=mode==='direct'||mode==='candidate-keyed'?'/candidate/shared.js':'/base/shared.js';
  const api=mode==='direct'?'direct':'keyed',S=await import(module);
  S.resetMap();
  const rows=Array.from({length:n},(_,i)=>[key(i),row(i)]);
  const edits=[];for(let i=0;i<n;i++)if(changed(i,n))edits.push([key(i),row(i,1)]);
  const t=performance.now(),old=new S.SharedMap('object').setMany(rows),construction=performance.now()-t;
  const ws=workers();let coldWs=[];
  try{
    const p=performance.now(),initial=S.getWorkerData({map:old},{copy:false}),prepareInitial=performance.now()-p;
    check(initial.arenas.every(a=>a.memory&&!a.copy),'shared initial');
    const first=await exchange(ws,{phase:'first',module,api,n,initial});
    const repeat=await exchange(ws,{phase:'repeat'});
    const u=performance.now(),next=old.setMany(edits),mutation=performance.now()-u;
    const v=performance.now(),updated=S.getWorkerData({map:next},{copy:false}),prepareUpdate=performance.now()-v;
    const after=await exchange(ws,{phase:'updated',updated});
    const retained=await exchange(ws,{phase:'retained'});
    const points=await exchange(ws,{phase:'points'}),pointsRepeat=await exchange(ws,{phase:'points-repeat'});
    const phases=[[first,0,[windows[0]]],[repeat,0,windows],[after,1,windows],[retained,0,windows]];
    const order=[];
    for(const [phase,rev,starts] of phases){
      equal(phase.readers[0].scans.map(s=>s.ids),phase.readers[1].scans.map(s=>s.ids),'worker order');
      for(const [i,start] of starts.entries()){
        const expected=[];for(let k=0;k<n;k++)if(inside(row(k,rev&&changed(k,n)?1:0),start))expected.push(k);
        const ids=phase.readers[0].scans[i].ids;
        equal([...ids].sort((a,b)=>a-b),expected,'complete filter');
        order.push(ids);
      }
      // The host compares order exactly across modes; avoid duplicating huge arrays in the raw timing payload.
      for(const r of phase.readers)for(const s of r.scans){s.count=s.ids.length;delete s.ids;}
    }
    check((await exchange(ws,{phase:'verify'})).readers.every(r=>r.verified),'full snapshots');
    coldWs=workers();const cold=await exchange(coldWs,{phase:'cold',module,api,n,initial,updated});
    check([points,pointsRepeat,cold].every(p=>p.readers.every(r=>r.verified)),'points');
    return {verified:true,order,construction,prepareInitial,prepareUpdate,mutation,arenaBytes:updated.arenas.reduce((a,b)=>a+b.used,0),
      first,repeat,updated:after,retained,points,pointsRepeat,cold};
  }finally{for(const w of [...ws,...coldWs])w.terminate();}
}
export async function lifetime(){
  const module='/candidate/shared.js',S=await import(module);
  check([...new S.SharedMap('object').valuesView()].length===0,'empty');
  let rejected=false;try{new S.SharedMap('number').valuesView().next();}catch(e){rejected=e instanceof TypeError;}
  check(rejected,'non-object guard');
  for(const copy of [false,true]){
    S.resetMap();
    const ks=['costarring','liquid','full-collision-0-U<EY?','full-collision-1-kJ5Nk','道路','é','e\u0301','🚗',''];
    const old=new S.SharedMap('object').setMany(ks.map((k,i)=>[k,{id:i,nested:{text:k},arr:[i,null]}]));
    const expected=[...old.entries()].map(e=>e[1]);
    const it=old.valuesView(),held=it.next().value,other=old.valuesView().next().value;
    check(held!==other,'independent views');equal(held.toObject(),other.toObject(),'independent contents');
    const source=S.getWorkerData({map:old},{copy:false}).arenas[0];
    const before=source.memory.buffer.byteLength;
    const w=new Worker('/worker.js',{type:'module'});
    try{
      const paused=await ask(w,{phase:'pause',module,initial:S.getWorkerData({map:old},{copy})});
      equal(paused.first,expected[0],'worker paused');
      new S.SharedMap('string').set('growth','x'.repeat(before*2));
      check(source.memory.buffer.byteLength>before,'actual growth');
      const fork=old.set(ks[0],{id:100}).delete(ks[1]).set('new',{id:101});
      equal([held,...it].map(v=>v.toObject()),expected,'owner paused after growth');
      equal(held.toObject(),expected[0],'owner held view');
      const result=await ask(w,{phase:'resume',updated:S.getWorkerData({map:fork},{copy}),expected,fork:[...fork.entries()].map(e=>e[1])});
      check(result.verified,'worker lifetime');
    }finally{w.terminate();}
  }
  return {verified:true,shared:true,copied:true};
}
`;
const assets={'/fixture.js':fixture,'/driver.js':driver,'/worker.js':worker};
const server=createServer((req,res)=>{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><title>Isolated proof</title>');}
  res.setHeader('Content-Type','text/javascript');
  if(Object.hasOwn(assets,path))return res.end(assets[path]);
  const match=/^\/(base|candidate)\/([a-zA-Z0-9_.-]+\.js)$/.exec(path);
  if(match){try{return res.end(readFileSync(join(resolve(match[1]==='base'?base:candidate),match[2])));}catch{}}
  res.statusCode=404;res.end('not found');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
const browser=await ({chromium,firefox}[engine]).launch({headless:true});
const modes=['view','direct','aa','candidate-keyed'];
const orders=modes.map((_,i)=>[...modes.slice(i),...modes.slice(0,i)]);
orders.push(...orders.map(o=>[...o].reverse()));
const report={engine,version:browser.version(),count:Number(count),orders,samples:[]};
const med=a=>{const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
try{
  const context=await browser.newContext();
  try{const page=await context.newPage();await page.goto(url);report.lifetime=await page.evaluate(async()=>{const d=await import('/driver.js');return d.lifetime();});assert(report.lifetime.verified);}
  finally{await context.close();}
  let oracle;
  for(let round=-1;round<8;round++)for(const mode of orders[(round+8)%8]){
    const ctx=await browser.newContext();
    try{
      const page=await ctx.newPage();await page.goto(url);
      const raw=await page.evaluate(async({mode,n})=>{const d=await import('/driver.js');return d.run(mode,n);},{mode,n:Number(count)});
      assert(raw.verified);
      if(oracle)assert.deepEqual(raw.order,oracle);else oracle=raw.order;
      delete raw.order;
      const max=p=>Math.max(...p.readers.map(r=>r.ms));
      const mixed=['first','repeat','updated','retained','points','pointsRepeat'].reduce((s,p)=>s+raw[p].roundTrip,0);
      const metrics={first:raw.first.roundTrip,repeat:raw.repeat.roundTrip,updated:raw.updated.roundTrip,retained:raw.retained.roundTrip,
        pointMs:max(raw.points),pointRepeatMs:max(raw.pointsRepeat),coldPointMs:max(raw.cold),coldRoundTrip:raw.cold.roundTrip,mixed,arenaBytes:raw.arenaBytes};
      report.samples.push({round,mode,...metrics,raw});
      writeFileSync(join(out,'browser-results.json'),JSON.stringify(report,null,2));
      console.log('BROWSER_TRIAL '+JSON.stringify({round,mode,...metrics}));
    }finally{await ctx.close();}
  }
  for(const mode of ['aa','candidate-keyed','direct']){
    const a=report.samples.filter(s=>s.round>=0&&s.mode==='view'),b=report.samples.filter(s=>s.round>=0&&s.mode===mode);
    const summary={};
    for(const k of ['first','repeat','updated','retained','pointMs','pointRepeatMs','coldPointMs','coldRoundTrip','mixed','arenaBytes']){
      summary[k]={baseline:med(a.map(s=>s[k])),other:med(b.map(s=>s[k])),pairedRatio:med(b.map((s,i)=>s[k]/a[i][k])),wins:b.filter((s,i)=>s[k]<a[i][k]).length};
    }
    console.log('BROWSER_SUMMARY '+JSON.stringify({engine,count,mode,summary}));
  }
}finally{await browser.close();await new Promise(r=>server.close(r));}
