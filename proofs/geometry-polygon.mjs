import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import { orient2d } from 'robust-predicates';
import turfPip from '@turf/boolean-point-in-polygon';
import turfWithin from '@turf/points-within-polygon';
import { SharedList, getWorkerData } from '../dist/shared.js';
import { preparePolygonXY, pointsWithinPolygonXY } from '../dist/geometry.js';
import { pairs, exact, bboxReference, random } from './geometry-fixtures.mjs';
import { polygonCase, integerMembership } from './geometry-polygon-fixtures.mjs';
const memory = getWorkerData({ p: new SharedList('number') }, { copy: false }).arenas[0].memory;
let fallbackCalls = 0;
const binaries = ['polygon-kernels.wasm', 'polygon-kernels-simd.wasm'].map(file => readFileSync(file));
const kernels = binaries.map(bytes => new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory }, predicates: { orient2d: (...args) => { fallbackCalls++; return orient2d(...args); } } }).exports);
const makeList = values => new SharedList('number').pushMany(values);
function select(k, points, rings, bounds, ignore) {
  const result = [];
  for (let base = 0; base < points.size; base += 32) {
    const n = Math.min(16, (points.size-base)/2), p = k.xyLeaf(points.root,points.depth,points.tail,points.size,base) >>> 0;
    const candidates = k.boxMaskXY(p,n,...bounds); let parity=0,boundary=0;
    for (const ring of rings) {
      const active = candidates & ~boundary; if (!active) break;
      const masks = k.ringMaskXY(p,n,active,ring.root,ring.depth,ring.tail,ring.size) >>> 0;
      parity ^= masks & 65535; boundary |= masks >>> 16;
    }
    let mask = candidates & (ignore ? parity & ~boundary : parity | boundary);
    while (mask) { const bit = mask & -mask; result.push(base/2+31-Math.clz32(bit)); mask ^= bit; }
  }
  return Uint32Array.from(result);
}
let checks=0, queries=0;
function verify(data, label, integer = false) {
  const rings=data.rings.map(makeList), p=makeList(data.values), polygon=preparePolygonXY(rings);
  const geo={ type:'Polygon', coordinates:data.rings.map(pairs) }, coords=pairs(data.values);
  for (const ignoreBoundary of [false,true]) {
    const expected=coords.flatMap((point,i) => turfPip(point,geo,{ignoreBoundary}) ? [i] : []);
    for (let i=0;i<kernels.length;i++) exact(select(kernels[i],p,rings,polygon.bounds,ignoreBoundary),expected,`${label} kernel=${i} boundary=${ignoreBoundary}`);
    exact(pointsWithinPolygonXY(p,polygon,{ignoreBoundary}),expected,`${label} public boundary=${ignoreBoundary}`); checks+=3; queries+=coords.length;
    if (integer) {
      exact(coords.flatMap(([x,y],i) => integerMembership(x,y,data.rings,ignoreBoundary) ? [i] : []),expected,`${label} BigInt boundary=${ignoreBoundary}`); checks++;
    }
    if (!ignoreBoundary) {
      const features={type:'FeatureCollection',features:coords.map((coordinates,i)=>({type:'Feature',geometry:{type:'Point',coordinates},properties:{i}}))};
      exact(turfWithin(features,geo).features.map(p=>p.properties.i),expected,`${label} Turf collection`); checks++;
    }
  }
}
for(let seed=1;seed<=1024;seed++) verify(polygonCase(seed),`seed=${seed}`);
for(const vertices of [3,15,16,17,31,32,33,511,512,513,2049]) verify(polygonCase(21,vertices,65),`vertices=${vertices}`);
for(let seed=1;seed<=256;seed++) {
  const rng=random(seed), values=[];
  for(let i=0;i<128;i++)values.push(Math.floor(rng()*25)-12,Math.floor(rng()*25)-12);
  verify({rings:[[-10,-10,10,-10,10,10,3,10,3,0,-3,0,-3,10,-10,10,-10,-10]],values},`integer seed=${seed}`,true);
}
verify({rings:[[0,0,10,0,10,10,0,10,0,0],[3,3,3,7,7,7,7,3,3,3]],values:[0,0,-0,0,3,3,5,5,1,1,NaN,0,Infinity,1,-Infinity,1]},'special');
verify({rings:[[0,0,0,0,1,0,1,1,0,1,0,0]],values:[0,0,1,1,.5,.5,2,2]},'repeated vertex');
assert(fallbackCalls>0,'robust fallback was not exercised');
// Raw load safety at the very end of a shared memory, for odd/even point blocks.
const edgeMemory=new WebAssembly.Memory({initial:2,maximum:65536,shared:true});
new Float64Array(edgeMemory.buffer,65536,10).set([0,0,10,0,10,10,0,10,0,0]);
for(const bytes of binaries) {
  const k=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{memory:edgeMemory},predicates:{orient2d}}).exports;
  for(let count=1;count<=16;count++) {
    const p=edgeMemory.buffer.byteLength-count*16; new Float64Array(edgeMemory.buffer,p,count*2).fill(1);
    assert.equal(k.ringMaskXY(p,count,(1<<count)-1,0,0,65536,10)&65535,(1<<count)-1);checks++;
  }
}
console.log('POLYGON EXACT',JSON.stringify({checks,queries,seeds:1280,fallbackCalls}));
const rows=[], median=a=>[...a].sort((a,b)=>a-b)[a.length>>1];let sink=0;
for(const vertices of [32,256])for(const count of [512,8192])for(const distribution of ['mixed','inside']) {
  const data=polygonCase(91,vertices,0), rng=random(229), bounds=bboxReference(data.rings[0]);
  const cx=(bounds[0]+bounds[2])/2,cy=(bounds[1]+bounds[3])/2,r=(bounds[2]-bounds[0])*(distribution==='inside'?.1:.65);
  data.values=[];for(let i=0;i<count;i++)data.values.push(cx+(rng()-.5)*r*2,cy+(rng()-.5)*r*2);
  const rings=data.rings.map(makeList),p=makeList(data.values),start=performance.now(),polygon=preparePolygonXY(rings),preparationMs=performance.now()-start;
  const coords=pairs(data.values),geo={type:'Polygon',coordinates:data.rings.map(pairs)},expected=coords.flatMap((c,i)=>turfPip(c,geo)?[i]:[]);
  const fns={ 'turf-indices':()=>Uint32Array.from(coords.flatMap((c,i)=>turfPip(c,geo)?[i]:[])), scalar:()=>select(kernels[0],p,rings,polygon.bounds,false), simd:()=>select(kernels[1],p,rings,polygon.bounds,false), public:()=>pointsWithinPolygonXY(p,polygon) };
  for(const [name,fn]of Object.entries(fns))exact(fn(),expected,`${name} benchmark`);
  const iterations=Math.max(4,Math.floor(2000000/(vertices*count))),samples=Object.fromEntries(Object.keys(fns).map(n=>[n,[]]));
  for(let round=-5;round<15;round++){const order=Object.keys(fns);if(round&1)order.reverse();for(const name of order){const t=performance.now();for(let i=0;i<iterations;i++)sink+=fns[name]().length;const ms=performance.now()-t;if(round>=0)samples[name].push(ms);}}
  const ms=Object.fromEntries(Object.entries(samples).map(([n,s])=>[n,median(s)])),row={vertices,count,distribution,iterations,preparationMs,ms,simdOverScalar:ms.scalar/ms.simd,publicOverTurf:ms['turf-indices']/ms.public,samples};rows.push(row);console.log('POLYGON BENCH',JSON.stringify({...row,samples:undefined}));
}
mkdirSync('proofs/results',{recursive:true});
writeFileSync(`proofs/results/geometry-polygon-${process.versions.bun?'bun':'node'}-${process.arch}.json`,JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:process.versions,arch:process.arch,cpu:cpus()[0]?.model,date:new Date().toISOString(),checks,queries,fallbackCalls,warmup:5,rounds:15,sourceSha256:createHash('sha256').update(readFileSync('polygon-kernels.as.ts')).digest('hex'),sink,rows},null,2));
if(process.env.PERF_GATE==='1')for(const r of rows.filter(r=>r.count>=8192)){assert(r.simdOverScalar>1.05,`SIMD did not win: ${r.vertices}/${r.distribution}`);assert(r.publicOverTurf>1.05,`Public did not win: ${r.vertices}/${r.distribution}`);}
