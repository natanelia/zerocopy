import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SharedList, getWorkerData } from '../dist/shared.js';
import { simplifyLineXY } from '../dist/geometry.js';
import { coordinates, exact, random } from './geometry-fixtures.mjs';
import { farthestReference, simplifyReference, simplifyWithKernel } from './geometry-simplify-reference.mjs';
const memory=getWorkerData({p:new SharedList('number')},{copy:false}).arenas[0].memory;
const binaries=['simplify-kernels.wasm','simplify-kernels-simd.wasm'].map(f=>readFileSync(f));
const kernels=binaries.map(bytes=>new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{memory}}).exports);
let checks=0;
function verify(values,label){
 const p=new SharedList('number').pushMany(values),count=values.length/2;
 for(const tolerance of [0,.01,.5,10,10000]){
  const expected=simplifyReference(values,tolerance);
  for(let i=0;i<kernels.length;i++)exact(simplifyWithKernel(kernels[i],p,tolerance),expected,`${label} kernel=${i} tol=${tolerance}`);
  exact(simplifyLineXY(p,tolerance),expected,`${label} public tol=${tolerance}`);checks+=3;
 }
 if(count)for(const first of [0,Math.min(15,count-1)]){
  const last=count-1,expected=farthestReference(values,first,last,0);
  for(const k of kernels){const index=k.farthestXY(p.root,p.depth,p.tail,p.size,first,last,0);assert.equal(index,expected.index,`${label} farthest index`);assert(Object.is(k.getFarthestDistance(),expected.distance),`${label} farthest squared distance`);checks+=2;}
 }
}
for(let seed=1;seed<=2048;seed++){
 const count=seed%193,values=coordinates(seed,count,seed&1?'road':'random');
 if(seed%7===0)for(let i=0;i<values.length;i++)values[i]*=2**((seed%1000)-500);
 if(seed%11===0)for(let i=2;i<values.length;i+=6){values[i]=values[0];values[i+1]=values[1];}
 verify(values,`seed=${seed} count=${count}`);
}
for(const count of [15,16,17,31,32,33,511,512,513,16385])verify(coordinates(919,count,'road'),`boundary=${count}`);
for(const values of [[],[0,0],[0,0,0,0],[-0,0,0,-0,-0,-0],[0,0,1,1,2,1,3,0],[1,1,1,1,1,1],[0,0,Number.MIN_VALUE,Number.MIN_VALUE,1,1],[1e308,1e308,-1e308,-1e308,0,0,1e308,1e308]])verify(values,'special');
const edgeMemory=new WebAssembly.Memory({initial:2,maximum:65536,shared:true});
for(const bytes of binaries){const k=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{memory:edgeMemory}}).exports;for(let count=2;count<=16;count++){const values=coordinates(count,count),tail=edgeMemory.buffer.byteLength-count*16;new Float64Array(edgeMemory.buffer,tail,count*2).set(values);const expected=farthestReference(values,0,count-1,0);assert.equal(k.farthestXY(0,0,tail,count*2,0,count-1,0),expected.index);assert(Object.is(k.getFarthestDistance(),expected.distance));checks+=2;}}
assert(!/v128|f64x2/.test(readFileSync('simplify-kernels.wat','utf8')));
assert(/f64x2.div/.test(readFileSync('simplify-kernels-simd.wat','utf8')));
console.log('SIMPLIFY EXACT',JSON.stringify({checks,seeds:2048,noEpsilon:true}));
const rows=[],median=a=>[...a].sort((a,b)=>a-b)[a.length>>1];let sink=0;
for(const count of [512,4096,16384])for(const kind of ['road','random']){
 const values=coordinates(91,count,kind),p=new SharedList('number').pushMany(values),tolerance=kind==='road'?.1:500;
 const fns={'js-reference':()=>simplifyReference(values,tolerance),scalar:()=>simplifyWithKernel(kernels[0],p,tolerance),simd:()=>simplifyWithKernel(kernels[1],p,tolerance),public:()=>simplifyLineXY(p,tolerance)};
 const expected=simplifyReference(values,tolerance);for(const[name,fn]of Object.entries(fns))exact(fn(),expected,`${name} ${kind}/${count}`);
 const iterations=Math.max(4,Math.floor(40000/count)),samples=Object.fromEntries(Object.keys(fns).map(n=>[n,[]]));
 for(let round=-5;round<15;round++){const order=Object.keys(fns);if(round&1)order.reverse();for(const name of order){const t=performance.now();for(let i=0;i<iterations;i++)sink+=fns[name]().length;const ms=performance.now()-t;if(round>=0)samples[name].push(ms);}}
 const ms=Object.fromEntries(Object.entries(samples).map(([n,s])=>[n,median(s)]));const row={count,kind,tolerance,iterations,retained:expected.length,ms,simdOverScalar:ms.scalar/ms.simd,publicOverJs:ms['js-reference']/ms.public,samples};rows.push(row);console.log('SIMPLIFY BENCH',JSON.stringify({...row,samples:undefined}));
}
mkdirSync('proofs/results',{recursive:true});writeFileSync(`proofs/results/geometry-simplify-${process.versions.bun?'bun':'node'}-${process.arch}.json`,JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:process.versions,arch:process.arch,cpu:cpus()[0]?.model,checks,seeds:2048,warmup:5,rounds:15,date:new Date().toISOString(),sourceSha256:createHash('sha256').update(readFileSync('simplify-kernels.as.ts')).digest('hex'),sink,rows},null,2));
if(process.env.PERF_GATE==='1')for(const r of rows.filter(r=>r.count>=4096)){assert(r.simdOverScalar>1.05,`SIMD did not win ${r.kind}/${r.count}`);assert(r.publicOverJs>1.05,`Public did not win ${r.kind}/${r.count}`);}
