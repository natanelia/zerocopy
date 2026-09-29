import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { totals, compareMemory, median, decorateColumns, validateCase, STAGES } from './investigation-memory-model.mjs';
import { generateColumns } from '../website/assets/explorer-core.mjs';
const arena = {id:'one',capacityBytes:131072,usedBytes:66000,readOnly:false};
const thread = (role,heapUsed=100,arrayBuffers=20,arenas=[]) => ({role,usage:{heapUsed,arrayBuffers,external:1e9,rss:5e9},arenas});

test('one shared arena is counted once across all workers and retained versions',()=>{
  const result=totals([thread('owner',100,20,[arena,arena]),thread('reader-0',110,30,[{...arena,readOnly:true}]),thread('controller')]);
  assert.equal(result.arenaCount,1);assert.equal(result.wasmCapacityBytes,131072);assert.equal(result.heapUsed,310);
});
test('different arenas are added and spare capacity is retained',()=>{
  const result=totals([thread('owner',100,20,[arena,{...arena,id:'two',capacityBytes:262144}])]);
  assert.equal(result.wasmCapacityBytes,393216);assert.equal(result.arenaUsedBytes,132000);
});
test('signed heap changes remain visible; neither external nor RSS is added twice',()=>{
  const result=compareMemory([thread('owner',200,100)],[thread('owner',100,80,[arena])]);
  assert.equal(result.heapDelta,-100);assert.equal(result.arrayBufferDelta,-20);assert.equal(result.retainedBytes,131072-120);
});
test('a result below measurement resolution is marked rather than clamped',()=>{
  const result=compareMemory([thread('owner',200)],[thread('owner',100)]);
  assert.equal(result.resolved,false);assert.equal(result.retainedBytes,-100);
});
test('duplicate threads and conflicting current arena sizes fail',()=>{
  assert.throws(()=>totals([thread('owner'),thread('owner')]));
  assert.throws(()=>totals([thread('owner',100,20,[arena]),thread('reader',100,20,[{...arena,capacityBytes:262144}])]));
});
test('invalid sizes and absent measurements fail',()=>{
  assert.throws(()=>totals([thread('owner',NaN)]));
  assert.throws(()=>totals([thread('owner',100,20,[{...arena,usedBytes:999999}])]));
  assert.throws(()=>validateCase({kind:'shared',fixture:'unique',readers:3,entries:1000}));
  assert.throws(()=>validateCase({kind:'centralized',fixture:'unique',readers:2,entries:1000}));
  assert.throws(()=>validateCase({kind:'native',fixture:'other',readers:0,entries:1000}));
});
test('fixture changes preserve numeric columns and match text-search diagnostics',()=>{
  const original=generateColumns(10,8), unique=decorateColumns(generateColumns(10,8),10,'unique'), unicode=decorateColumns(generateColumns(10,8),10,'unicode');
  for(const field of ['time','level','service','latency'])assert.deepEqual(original[field],unique[field]);
  for(let i=0;i<8;i++) {assert.equal(unique.message[i],original.message[i]+` [event ${10+i}]`);assert.equal(unicode.message[i],((10+i)%5===0?'追跡 ':'')+unique.message[i]);}
});
test('median keeps all samples and handles even counts without mutating data',()=>{
  const samples=[5,1,9,3];assert.equal(median(samples),4);assert.deepEqual(samples,[5,1,9,3]);assert.equal(median([9,1,3]),3);assert.throws(()=>median([]));
});
test('all four real-worker paths, old snapshots, publication and lifecycle checks pass',{timeout:60000},()=>{
  const out=mkdtempSync(join(tmpdir(),'zerocopy-memory-smoke-'));
  try {
    const run=spawnSync(process.execPath,[fileURLToPath(new URL('./investigation-memory.mjs',import.meta.url))],{encoding:'utf8',timeout:55000,maxBuffer:1024*1024,env:{...process.env,MEMORY_ENTRIES:'1000',MEMORY_TRIALS:'1',MEMORY_READERS:'2',MEMORY_FIXTURES:'unicode',MEMORY_OUT:out}});
    assert.equal(run.status,0,run.stderr+'\n'+run.stdout);
    const result=JSON.parse(readFileSync(join(out,'summary.json'),'utf8'));
    assert.equal(result.runCount,4);assert.equal(result.summary.length,4*STAGES.length);
    for(const group of result.summary) {
      assert.equal(group.samples.length,1);
      assert.ok(group.samples[0].resolved);
      if(group.kind==='shared')assert.equal(group.samples[0].arenaCount,1);
    }
    for(const kind of ['shared','immutable','native','centralized']) {
      const file=join(out,`unicode-${kind}-${kind==='centralized'?0:2}-trial-1.json`), sample=JSON.parse(readFileSync(file,'utf8'));
      assert.equal(sample.records.at(-1).type,'stopped');assert.equal(sample.records.at(-1).threads.length,1);
      if(kind==='shared') {
        const loaded=sample.records.find(r=>r.name==='loaded'), queried=sample.records.find(r=>r.name==='queried');
        assert.equal(loaded.memory.wasmCapacityBytes,queried.memory.wasmCapacityBytes);
        assert.equal(loaded.memory.arenaUsedBytes,queried.memory.arenaUsedBytes);
        const retained=sample.records.find(r=>r.name==='append-retained'), released=sample.records.find(r=>r.name==='released');
        assert.equal(retained.memory.wasmCapacityBytes,released.memory.wasmCapacityBytes);
      }
    }
  } finally {rmSync(out,{recursive:true,force:true});}
});
