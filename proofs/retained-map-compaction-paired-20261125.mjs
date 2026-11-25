import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { entriesFor, editsFor, product, productId } from '../website/assets/catalog-core.mjs';
import * as baseline from '../baseline-dist/shared.js';
import * as control from '../control-dist/shared.js';
import * as candidate from '../dist/shared.js';
const base='76ab6b53aa0d3b40202720ca12d9fcc904716cf2';
const output=process.argv[2]; assert(output);
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const report={base,candidateSource:'6cf0dee378f3225ec9934638fcc3056e79b7cabb',head:git('rev-parse','HEAD'),runtime:process.versions,cpu:cpus()[0]?.model,
 hashes:Object.fromEntries(['compaction.ts','arena.ts','shared-map.ts','persistent-core.wasm','baseline-dist/shared.js','control-dist/shared.js','dist/shared.js'].map(p=>[p,sha(p)])),samples:[]};
assert.equal(report.hashes['baseline-dist/shared.js'],report.hashes['control-dist/shared.js']);
const collect=()=>{if(typeof globalThis.gc==='function')globalThis.gc();else globalThis.Bun?.gc?.(true);};
function prepare(api,n,mode){
 api.resetMap();
 const initial=entriesFor(n);
 let current=new api.SharedMap('object').setMany(initial), expected=new Map(initial.map(([k,v])=>[k,JSON.stringify(v)]));
 const maps=[current], oracle=[expected];
 const revisions=mode==='dense'?1:mode==='dense-four'?3:7;
 for(let rev=1;rev<=revisions;rev++){
   expected=new Map(expected);
   let edits=editsFor(n,rev);
   if(mode==='churn'){
     const gone=Array.from({length:150},(_,i)=>productId((rev-1)*150+i));
     current=current.deleteMany(gone); for(const k of gone)expected.delete(k);
     edits=Array.from({length:150},(_,i)=>['new/'+rev+'/'+i,product(i,rev)]);
   }else if(mode==='dense'||mode==='dense-four'){
     edits=Array.from({length:n/2},(_,i)=>[productId(i),product(i,rev)]);
   }
   current=current.setMany(edits); for(const [k,v] of edits)expected.set(k,JSON.stringify(v));
   maps.push(current);oracle.push(expected);
 }
 const revs=mode==='one'?[7]:mode==='two'?[0,7]:mode==='alias-eight'?Array(8).fill(7):mode==='dense'?[0,1]:mode==='dense-four'?[0,1,2,3]:Array.from({length:8},(_,i)=>i);
 return {input:Object.fromEntries(revs.map((r,i)=>['r'+i,maps[r]])),expected:revs.map(r=>oracle[r]),revs};
}
function verify(result,owner){
 let records=0; const verified=new Map();
 for(let i=0;i<owner.revs.length;i++){
   const m=result['r'+i],expected=owner.expected[i];assert.equal(m.size,expected.size);
   if(verified.has(m)){assert.equal(verified.get(m),expected);continue;}
   verified.set(m,expected);
   const seen=new Set();
   for(const [k,v] of m.entries()){assert(expected.has(k)&&!seen.has(k),k);assert.equal(JSON.stringify(v),expected.get(k),k);seen.add(k);}
   assert.equal(seen.size,expected.size);
   let j=0;for(const [k,v] of expected){if(j++%997===0)assert.equal(JSON.stringify(m.get(k)),v);}
   records+=seen.size;
 }
 return records;
}
async function sample(api,n,mode,cohort,pair,arm){
 const owner=prepare(api,n,mode);
 collect();
 const before=process.memoryUsage(),t=performance.now(),result=api.compactMany(owner.input),elapsedMs=performance.now()-t,after=process.memoryUsage();
 const src=api.getWorkerData(owner.input,{copy:false}), dst=api.getWorkerData(result,{copy:false});
 assert.equal(src.arenas.length,1);assert.equal(dst.arenas.length,1);
 const records=verify(result,owner);
 // Every case and arm verifies both wire variants and the original retained roots.
 if(pair===0){
   verify(owner.input,owner);
   for(const copy of [false,true])verify(await api.initWorker(api.getWorkerData(result,{copy})),owner);
 }
 return {n,mode,cohort,pair,arm,elapsedMs,usedBytes:dst.arenas[0].used,capacityBytes:dst.arenas[0].memory.buffer.byteLength,sourceUsedBytes:src.arenas[0].used,
  heapBefore:before.heapUsed,heapAfter:after.heapUsed,rssBefore:before.rss,rssAfter:after.rss,records,verified:true,transportVerified:pair===0};
}
for(const n of [10000,100000]){
 for(const mode of ['one','two','eight','alias-eight','churn','dense','dense-four']){
   for(const cohort of ['AB','AA']){
     const arms=cohort==='AB'?[['base',baseline],['candidate',candidate]]:[['base',baseline],['control',control]];
     for(let pair=-1;pair<(cohort==='AB'?7:3);pair++){
       const order=(pair%2===0?arms:arms.slice().reverse());
       for(const [arm,api] of order){
         const row=await sample(api,n,mode,cohort,pair,arm);
         report.samples.push(row);console.log(JSON.stringify(row));
       }
     }
   }
   writeFileSync(output,JSON.stringify(report));
 }
}
