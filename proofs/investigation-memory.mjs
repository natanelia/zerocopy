/** Reproducible whole-worker retained-memory comparison. No performance gate. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MEMORY_SCHEMA, METHOD, KINDS, FIXTURES, STAGES, decorateColumns, median } from './investigation-memory-model.mjs';
import { generateColumns } from '../website/assets/explorer-core.mjs';
import { reference } from '../website/assets/explorer-reference.mjs';
import { stageRuntime } from './investigation-memory-runtime.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)), runtime=mkdtempSync(join(tmpdir(),'zerocopy-worker-memory-'));
const output=resolve(process.env.MEMORY_OUT || join(root,'proofs/results/investigation-memory'));
const entries=Number(process.env.MEMORY_ENTRIES || 100000), trials=Number(process.env.MEMORY_TRIALS || 3);
assert.ok(Number.isSafeInteger(trials)&&trials>=1&&trials<=10);
const readerCounts=(process.env.MEMORY_READERS || '0,2,4').split(',').map(Number);
const fixtures=process.env.MEMORY_FIXTURES ? process.env.MEMORY_FIXTURES.split(',') : FIXTURES;
const kinds=process.env.MEMORY_KINDS ? process.env.MEMORY_KINDS.split(',') : KINDS;
assert.ok(fixtures.length && kinds.length && readerCounts.length);
assert.ok(fixtures.every(f=>FIXTURES.includes(f)) && kinds.every(k=>KINDS.includes(k)));
for (const values of [fixtures,kinds,readerCounts]) assert.equal(new Set(values).size,values.length,'Duplicate case selection');
assert.ok(readerCounts.every(value=>[0,1,2,4].includes(value)));
assert.ok(Number.isSafeInteger(entries) && entries >= 1000 && entries <= 100000);
mkdirSync(output,{recursive:true});
const samples=[], expected=new Map();
function verifyAnswer(answer, config, frozen) {
  const count=frozen ? config.entries : answer.count ?? config.currentCount;
  const key=`${config.fixture}:${count}`;
  if(!expected.has(key)) expected.set(key,reference(decorateColumns(generateColumns(0,count),0,config.fixture),{term:'request'}));
  const want=expected.get(key), values=answer.readers || [answer];
  assert.equal(values.length,Math.max(1,config.readers));
  for(const value of values) {
    assert.ok(value.search || value.summary);
    if(value.search) {assert.deepEqual(value.search,want.search); assert.deepEqual(value.rows,want.rows);}
    if(value.summary) assert.deepEqual(value.summary,want.summary);
  }
}
try {
  const modules=stageRuntime(root,runtime);
  // Validate the accounting assumption for this Node build in a separate process.
  const calibration=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',`
    const before=process.memoryUsage();
    globalThis.ab=new ArrayBuffer(8*1024*1024); global.gc();const ordinary=process.memoryUsage();
    globalThis.wasm=new WebAssembly.Memory({initial:128,maximum:256,shared:true});global.gc();const wasm=process.memoryUsage();
    console.log(JSON.stringify({before,ordinary,wasm,wasmCapacity:globalThis.wasm.buffer.byteLength}));
  `],{encoding:'utf8',timeout:30000});
  assert.equal(calibration.status,0,calibration.stderr);
  const calibrationData=JSON.parse(calibration.stdout);
  assert.ok(calibrationData.ordinary.arrayBuffers-calibrationData.before.arrayBuffers>=8*1024*1024-65536,'Ordinary buffers must be included');
  assert.ok(Math.abs(calibrationData.wasm.arrayBuffers-calibrationData.ordinary.arrayBuffers)<65536,'WASM is now counted by Node; revise accounting before using this report');
  for(let trial=0;trial<trials;trial++) for(const fixture of fixtures) {
    const order=kinds.map((_,i)=>kinds[(i+trial)%kinds.length]);
    for(const kind of order) for(const readers of kind==='centralized'?[0]:readerCounts) {
      const config={kind,fixture,readers,entries,runtime};
      const run=spawnSync(process.execPath,['--expose-gc',join(root,'proofs/investigation-memory-case.mjs'),JSON.stringify(config)],{encoding:'utf8',timeout:180000,maxBuffer:12*1024*1024});
      const filename=`${fixture}-${kind}-${readers}-trial-${trial+1}.json`;
      if(run.status!==0) {writeFileSync(join(output,filename+'.failed.log'),run.stdout+'\n'+run.stderr);throw new Error(`${filename}: ${run.stderr}`);}
      const records=run.stdout.trim().split('\n').map(line=>JSON.parse(line));
      assert.deepEqual(records.filter(r=>r.type==='stage').map(r=>r.name),STAGES);
      let currentCount=entries;
      for(const record of records) {
        if(record.type==='stage') {
          assert.equal(record.threads.length,readers+2);
          assert.equal(record.memory.arenaCount,kind==='shared'?1:0);
          if(record.name==='queried') currentCount=entries+2000;
          if(record.name==='released') currentCount=entries+42000;
        }
        if(record.type==='answer') verifyAnswer(record.value,{...config,currentCount},record.frozen);
      }
      const sample={trial:trial+1,kind,fixture,readers,entries,records};samples.push(sample);
      writeFileSync(join(output,filename),JSON.stringify(sample,null,2)+'\n');
      const queried=records.find(r=>r.name==='queried');
      console.log(`${trial+1}/${trials} ${fixture} ${kind} readers=${readers}: ${(queried.memory.retainedBytes/1048576).toFixed(3)} MiB`);
    }
  }
  const groups=new Map();
  for(const sample of samples) for(const record of sample.records.filter(r=>r.type==='stage')) {
    const identity={kind:sample.kind,fixture:sample.fixture,readers:sample.readers,entries:sample.entries,stage:record.name},key=JSON.stringify(identity);
    if(!groups.has(key))groups.set(key,{...identity,samples:[]});
    groups.get(key).samples.push({trial:sample.trial,...record.memory,rssBytes:record.rssBytes,processHighWaterRSSBytes:record.processHighWaterRSSBytes});
  }
  const summary=[...groups.values()].map(group=>({...group,medians:Object.fromEntries(['retainedBytes','heapDelta','arrayBufferDelta','wasmCapacityBytes','arenaUsedBytes','rssBytes','processHighWaterRSSBytes'].map(field=>[field,median(group.samples.map(sample=>sample[field]))]))}));
  const proofHashes=Object.fromEntries(readdirSync(join(root,'proofs')).filter(name=>/^investigation-memory.*\.mjs$/.test(name)).sort().map(name=>[name,createHash('sha256').update(readFileSync(join(root,'proofs',name))).digest('hex')]));
  const result={schema:MEMORY_SCHEMA,method:METHOD,measuredAt:new Date().toISOString(),runtime:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,trials,entries,readerCounts,fixtures,runCount:samples.length,runtimeSourceCommit:process.env.MEMORY_SOURCE || process.env.GITHUB_SHA || null,...modules,proofHashes,calibration:calibrationData,summary};
  writeFileSync(join(output,'summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(`Verified ${samples.length} fresh-process runs; all worker query results match the independent reference.`);
} finally {rmSync(runtime,{recursive:true,force:true});}
