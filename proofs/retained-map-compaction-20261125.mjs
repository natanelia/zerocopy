import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import * as api from '../dist/shared.js';
import { editsFor, entriesFor } from '../website/assets/catalog-core.mjs';

const base = '76ab6b53aa0d3b40202720ca12d9fcc904716cf2';
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const output = process.argv[2];
assert(output);
const git = (...args) => execFileSync('git',args,{encoding:'utf8'}).trim();
assert.equal(git('diff','--name-only',base,'HEAD').split('\n').filter(p=>p&&!['proofs/retained-map-compaction-20261125.mjs','.github/workflows/retained-map-compaction-proof.yml'].includes(p)).length,0);
const report = {base,head:git('rev-parse','HEAD'),runtime:process.versions, cpu:cpus()[0]?.model,
  hashes:Object.fromEntries(['compaction.ts','arena.ts','shared-map.ts','persistent-core.wasm','dist/shared.js','website/assets/catalog-core.mjs'].map(p=>[p,sha(p)])),samples:[]};
const modes=['one','two','eight','alias-eight'];
const collect=()=>{if(typeof globalThis.gc==='function')globalThis.gc();else globalThis.Bun?.gc?.(true);};
function prepare(n){
  api.resetMap();
  const initial=entriesFor(n), expected=new Map(initial.map(([k,v])=>[k,JSON.stringify(v)]));
  let current=new api.SharedMap('object').setMany(initial);
  const maps=[current], changes=[new Map()];
  for(let rev=1;rev<=7;rev++){
    const edits=editsFor(n,rev);
    current=current.setMany(edits); maps.push(current);
    const next=new Map(changes.at(-1));
    for(const [k,v] of edits)next.set(k,JSON.stringify(v));
    changes.push(next);
  }
  return {maps,changes,expected};
}
function inputFor(maps,mode){
  const revisions=mode==='one'?[7]:mode==='two'?[0,7]:mode==='eight'?[0,1,2,3,4,5,6,7]:Array(8).fill(7);
  return {revisions,input:Object.fromEntries(revisions.map((r,i)=>['r'+i,maps[r]]))};
}
function verify(output,owner,revisions){
  const verified=new Set();let records=0;
  for(let i=0;i<revisions.length;i++){
    const snapshot=output['r'+i], rev=revisions[i];
    assert.equal(snapshot.size,owner.expected.size);
    if(verified.has(snapshot)){assert.equal(rev,revisions[0]);continue;}
    verified.add(snapshot);
    const seen=new Set();
    for(const [k,v] of snapshot.entries()){
      assert(owner.expected.has(k)&&!seen.has(k),'unknown or duplicate key '+k);
      assert.equal(JSON.stringify(v),owner.changes[rev].get(k)??owner.expected.get(k),'record '+k);
      seen.add(k);
    }
    assert.equal(seen.size,owner.expected.size);records+=seen.size;
  }
  return records;
}
function sample(owner,n,mode,pair){
  const {revisions,input}=inputFor(owner.maps,mode);
  collect();
  const before=process.memoryUsage(), t=performance.now();
  const result=api.compactMany(input);
  const elapsedMs=performance.now()-t, after=process.memoryUsage();
  const {arenas}=api.getWorkerData(result,{copy:false});
  assert.equal(arenas.length,1);
  const source=api.getWorkerData(input,{copy:false}).arenas;
  assert.equal(source.length,1);
  const records=verify(result,owner,revisions);
  // Re-check original retained source roots after destination has been created.
  for(const r of new Set(revisions)){
    const map=owner.maps[r];assert.equal(map.size,n);
    for(const k of owner.changes[r].keys())assert.equal(JSON.stringify(map.get(k)),owner.changes[r].get(k));
  }
  return {n,mode,pair,elapsedMs,usedBytes:arenas[0].used,capacityBytes:arenas[0].memory.buffer.byteLength,
    sourceUsedBytes:source[0].used,heapBefore:before.heapUsed,heapAfter:after.heapUsed,rssBefore:before.rss,rssAfter:after.rss,records,verified:true};
}
for(const n of [10000,100000]){
  const owner=prepare(n);
  for(let pair=-1;pair<7;pair++){
    const order=modes.map((_,i)=>modes[(i+pair+1)%modes.length]);
    if(pair%2===1)order.reverse();
    for(const mode of order){
      const row=sample(owner,n,mode,pair);
      report.samples.push(row);
      console.log(JSON.stringify(row));
    }
  }
  if(n===100000&&!process.versions.bun){
    const {Session}=await import('node:inspector');
    for(const mode of ['one','eight']){
      const session=new Session();session.connect();
      const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(err,result)=>err?reject(err):resolve(result)));
      const {input,revisions}=inputFor(owner.maps,mode);
      collect();
      try{
        await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:100});
        await post('Profiler.start');
        const t=performance.now(), result=api.compactMany(input), elapsedMs=performance.now()-t;
        const {profile}=await post('Profiler.stop');
        assert(verify(result,owner,revisions)>0);
        writeFileSync(output+'.'+mode+'.cpuprofile',JSON.stringify(profile),{flag:'wx'});
        console.log('profile',mode,elapsedMs,profile.samples.length);
      }finally{session.disconnect();}
    }
  }
}
writeFileSync(output,JSON.stringify(report),{flag:'wx'});
