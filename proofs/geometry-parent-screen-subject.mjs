// A single fresh process uses one physical portable package and one frozen shape.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CASES, CONFIG, METHODS, describeSamples } from './geometry-parent-screen-protocol.mjs';
import { runPilot } from './geometry-parent-screen-timing.mjs';
import { coordinates, bboxReference, pairs, exact } from './geometry-fixtures.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ORIGINAL = 'b1a43ae6e0689d0e651f03dcb78a45182b674f84bef58434bdf35fca34dea11b';
export function callableSource(source) {
  assert.equal(hash(source),ORIGINAL,'Original callable source changed');
  const call = source.slice(source.indexOf('  function call(k, points) {'),source.indexOf('\n  let checks = 0;'));
  const fixture = source.slice(source.indexOf('    const values = kind ==='),source.indexOf('\n    for (const [name, fn] of Object.entries(functions))'));
  const timedLoop = source.match(/for \(let i = 0; i < iterations; i\+\+\) sink \+= functions\[name\]\(\)\[0\];/g);
  assert.equal(timedLoop?.length,1); assert(call.startsWith('  function call')); assert(fixture.includes('const functions ='));
  return {call,fixture,timedLoop:timedLoop[0]};
}
export function requireTiming(phase, env=process.env) {
  if (phase === 'verify') return;
  assert.equal(env.GITHUB_ACTIONS,'true','No local latency measurement');
  assert.equal(env.GEOMETRY_PARENT_SCREEN_TIMING,'1','Only the guarded CI controller may time');
  assert.equal(env.GITHUB_RUN_ATTEMPT,'1');
  assert.equal(env.GITHUB_REF,'refs/heads/perf/geometry-parent-cache-20261008');
}
function runtime() {
  return {name:process.versions.bun?'bun':'node',version:process.versions.bun??process.versions.node,
    versions:process.versions,arch:process.arch,platform:process.platform,pid:process.pid,execPath:realpathSync(process.execPath),execArgv:process.execArgv};
}
function physical() {
  const entry = join(root,'dist','geometry.js'), shared = join(root,'dist','shared.js'), pkg=join(root,'package.json');
  for (const path of [root,entry,shared,pkg,fileURLToPath(import.meta.url)]) assert.equal(realpathSync(path),resolve(path),'Noncanonical package path');
  const paths={};
  function walk(dir) { for (const item of readdirSync(dir,{withFileTypes:true})) { const path=join(dir,item.name); assert(!item.isSymbolicLink()); if(item.isDirectory())walk(path);else paths[path.slice(root.length+1)]=hash(readFileSync(path)); } }
  walk(root);
  return {root,entry,shared,package:pkg,files:Object.fromEntries(Object.entries(paths).sort(([a],[b])=>a.localeCompare(b)))};
}
export async function subject(request) {
  const result={schema:1,status:'running',phase:request.phase,workload:request.name,runtime:runtime(),methods:{},flags:[]};
  let memory,before;
  try {
    assert(['verify','pilot','measure'].includes(request.phase)); requireTiming(request.phase);
    assert.deepEqual(process.execArgv,[]); assert.equal(process.env.NODE_OPTIONS??'',''); assert.equal(process.env.BUN_OPTIONS??'','');
    if(request.phase!=='verify') { assert.equal(process.platform,'linux'); assert(['x64','arm64'].includes(process.arch)); assert.equal(result.runtime.version,result.runtime.name==='node'?'22.23.3':'1.4.2'); }
    result.physical=physical();
    const api=await import(pathToFileURL(join(root,'dist','shared.js')).href);
    const {bboxXY}=await import(pathToFileURL(join(root,'dist','geometry.js')).href);
    const spec=CASES.find(c=>c.name===request.name); assert(spec,'Unknown shape');
    memory=api.getWorkerData({points:new api.SharedList('number')},{copy:false}).arenas[0].memory;
    const kernelBytes=readFileSync(join(root,'geometry-kernels.wasm'));
    result.rawWasmSha256=hash(kernelBytes);
    const kernel=new WebAssembly.Instance(new WebAssembly.Module(kernelBytes),{env:{memory}}).exports;
    const original=readFileSync(new URL('./geometry-bbox.mjs',import.meta.url),'utf8'), source=callableSource(original);
    // Exact source slices retain original input generation, raw/public/flat/forEach
    // callables and sink consumption. Turf remains callable in the original proof;
    // its independent exactness is a required prerequisite, not a timed method.
    const build=new Function('SharedList','coordinates','pairs','bboxReference','bboxXY','turfBBox','kernel','count','kind',
      source.call+'\n'+source.fixture+'\nreturn {p,values,expected,functions};');
    const f=build(api.SharedList,coordinates,pairs,bboxReference,bboxXY,()=>{throw new Error('Turf is prerequisite-only');},kernel,spec.count,spec.kind);
    for(const name of [...METHODS,'shared-forEach']) exact(f.functions[name](),f.expected,name);
    result.expectedDigest=hash(new Uint8Array(new Float64Array(f.expected).buffer));
    result.fixture={...spec,seed:913,depth:f.p.depth,size:f.p.size,valuesSha256:hash(new Uint8Array(new Float64Array(f.values).buffer)),expected:f.expected.map(x=>Object.is(x,-0)?'-0':String(x))};
    const descriptor=()=>{const a=api.getWorkerData({points:f.p},{copy:false}).arenas[0];return {used:a.used,byteLength:a.memory.buffer.byteLength,sha256:hash(new Uint8Array(a.memory.buffer))};};
    before=descriptor(); result.before=before;
    const execute=new Function('functions','name','iterations','let sink = 0; '+source.timedLoop+' return sink;');
    const batch=(name,iterations,method)=>{
      const start=performance.now();
      const sink=execute(f.functions,name,iterations);
      const ms=performance.now()-start;
      assert(Number.isFinite(ms)&&ms>0); assert(Number.isFinite(sink));
      // Complete tuples are checked outside timing; preserve original first-lane consumption.
      (method.batches??=[]).push({iterations,ms,sink}); method.sink=sink; method.consumedOperations=(method.consumedOperations??0)+iterations;
      return ms;
    };
    for(const name of METHODS) result.methods[name]={phase:request.phase,status:'running',expectedDigest:result.expectedDigest,flags:[]};
    if(request.phase==='pilot') for(const name of METHODS) {
      const m=result.methods[name]; runPilot(m,n=>batch(name,n,m),()=>performance.now()); m.status='completed';
    }
    if(request.phase==='measure') {
      assert.deepEqual(Object.keys(request.plans).sort(),[...METHODS].sort());
      for(const name of METHODS) {
        const plan=request.plans[name],m=result.methods[name];
        assert(plan.valid); assert.equal(plan.expectedDigest,result.expectedDigest);
        assert(Number.isSafeInteger(plan.repeat)&&plan.repeat>0&&plan.repeat<=CONFIG.maxRepeat);
        assert(Number.isSafeInteger(plan.warmupOperations)&&plan.warmupOperations>0&&plan.warmupOperations<=CONFIG.maxWarmupCalls);
        assert.equal(plan.warmupOperations%plan.repeat,0);
        Object.assign(m,{repeat:plan.repeat,prescribedWarmupOperations:plan.warmupOperations,samples:[],warmup:{operations:0,elapsedMs:0,batches:[]}});
      }
      let round=0; result.batchOrder=[];
      while(METHODS.some(name=>result.methods[name].warmup.operations<request.plans[name].warmupOperations)) {
        const order=(round+++(request.orderOffset??0))&1?[...METHODS].reverse():METHODS;
        for(const name of order) {
          const m=result.methods[name],plan=request.plans[name]; if(m.warmup.operations===plan.warmupOperations)continue;
          const ms=batch(name,plan.repeat,m); m.warmup.batches.push({repeat:plan.repeat,ms}); m.warmup.operations+=plan.repeat; m.warmup.elapsedMs+=ms;
        }
      }
      for(let sample=0;sample<CONFIG.samples;sample++) {
        const order=(sample+(request.orderOffset??0))&1?[...METHODS].reverse():[...METHODS]; result.batchOrder.push(order);
        for(const name of order) { const m=result.methods[name]; m.samples.push(batch(name,m.repeat,m)); }
      }
      for(const name of METHODS) {
        const m=result.methods[name]; if(m.warmup.elapsedMs<CONFIG.minWarmupMs)m.flags.push('warmup below floor');
        if(m.samples.some(ms=>ms<CONFIG.minBatchMs))m.flags.push('batch below floor');
        m.statistics=describeSamples(m.samples,m.repeat); m.status='completed';
      }
    }
    for(const name of [...METHODS,'shared-forEach']) exact(f.functions[name](),f.expected,name+' after');
    result.after=descriptor(); assert.deepEqual(result.after,before,'Shared bytes or allocator changed');
    assert.deepEqual(physical(),result.physical,'Actual subject bundle changed'); result.actualDigest=result.expectedDigest;
    result.status='completed';
  } catch(error) { result.status='failed'; result.error=String(error.stack??error); }
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await subject(JSON.parse(process.argv[2])); console.log(JSON.stringify(result)); if(result.status!=='completed')process.exitCode=1;
}
