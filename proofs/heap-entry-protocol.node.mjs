import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG, MODES, interval, controlDrift, makeSchedule, randomSource, summarize, gate } from './heap-entry-protocol.mjs';
import { CASES, consume, expectedBatch, scan } from './heap-entry-workloads.mjs';
import { COMMAND_LIMITS } from './heap-entry-command.mjs';
import { freezePlan, prepareSubject, inventory, assertPilotBarrier } from './heap-entry-performance.mjs';

test('predeclared sixteen public workloads cover sizes, types and controls', () => {
  assert.equal(COMMAND_LIMITS.subjectMs, CONFIG.subjectTimeoutMs);
  assert.equal(CASES.length, 16); assert.equal(new Set(CASES.map(c => c.name)).size, 16);
  assert.deepEqual([...new Set(CASES.map(c => c.size))].sort((a,b) => a-b), [0,1,31,32,33,65,1057,4097]);
  for (const type of ['number','boolean','string','object','nested']) assert(CASES.some(c => c.type === type));
  assert(CASES.some(c => c.operation === 'first-close')); assert(CASES.some(c => c.operation === 'next'));
  assert(CASES.some(c => c.size === 4097 && c.type === 'object' && c.cache.includes('naturally saturated')));
});
test('every comparison has exactly two quartets of each balanced orientation', () => {
  for (let seed = 1; seed < 50; seed++) {
    const schedule = makeSchedule(randomSource(seed)); assert.equal(schedule.length, 8);
    for (const mode of MODES) {
      const group = schedule.filter(s => s.mode === mode);
      assert.equal(group.filter(s => s.roles.join() === 'left,right,right,left').length, 2);
      assert.equal(group.filter(s => s.roles.join() === 'right,left,left,right').length, 2);
      assert.deepEqual(group.map(s => s.block).sort(), [0,1,2,3]);
    }
  }
});
test('df3 interval rejects partial replication and preserves log-ratio scale', () => {
  assert.equal(interval([0,0,0]).lower, null);
  const values = [-0.03,-0.01,0.01,0.03], ci = interval(values);
  const variance = 0.002 / 3, half = CONFIG.tCritical * Math.sqrt(variance / 4);
  assert(Math.abs(ci.lower - Math.exp(-half)) < 1e-12); assert(Math.abs(ci.upper - Math.exp(half)) < 1e-12); assert.equal(ci.df,3);
  assert.equal(interval(Array(4).fill(Math.log(0.97))).classification,'material-gain');
  assert.equal(interval(Array(4).fill(Math.log(1.03))).classification,'material-loss');
});
test('AA drift requires both magnitude and exclusion criteria', () => {
  assert(controlDrift({geometricMean:1.03,lower:1.01,upper:1.05}));
  assert(controlDrift({geometricMean:0.97,lower:0.95,upper:0.99}));
  assert(!controlDrift({geometricMean:1.01,lower:1.005,upper:1.015}));
  assert(!controlDrift({geometricMean:1.03,lower:0.99,upper:1.08}));
});
test('full and early-close paths observe values, priorities and closure', () => {
  const workload = {type:'number',operation:'full'};
  const item = { *entries() { yield [3,7]; yield [-2,11]; } };
  assert.deepEqual(consume(item,workload),{count:2,value:1,priority:18,paired:100,completed:1});
  assert.deepEqual(scan(item,workload,3),expectedBatch(consume(item,workload),3));
  let closed = false;
  const early = { *entries() { try { yield [5,2]; yield [6,3]; } finally {closed = true;} } };
  assert.deepEqual(consume(early,{type:'number',operation:'first-close'}),{count:1,value:5,priority:2,paired:515,completed:1}); assert(closed);
  assert.deepEqual(consume({*entries(){}},{type:'number',operation:'next'}),{count:0,value:0,priority:0,paired:0,completed:1});
});
function row(runtime='node', ratio=0.97, aaRatio=1, orientation=['left','right','right','left']) {
  const r = {runtime,workload:{name:'synthetic',target:true},plan:{},invalid:[],blocks:[]}; let sequence=0;
  for (const mode of MODES) for (let block=0;block<4;block++) {
    const subjects = orientation.map(role => {
      const scale = role === 'right' ? mode === 'ab' ? ratio : aaRatio : 1;
      return {status:'passed',role,sequence:sequence++,repeat:100,prescribedWarmupScans:1000,samples:Array(21).fill(40*scale),invalid:[]};
    }); r.blocks.push({mode,block,subjects});
  } r.summary=summarize(r); return r;
}
test('quartets are independent replicates; reversed pairs keep R/L direction', () => {
  for (const order of [['left','right','right','left'],['right','left','left','right']]) {
    const r=row('node',0.97,1,order); assert(r.summary.usable);
    assert.equal(r.summary.modes.ab.pairs.length,8); assert.equal(r.summary.modes.ab.interval.quartets,4);
    assert(Math.abs(r.summary.modes.ab.interval.geometricMean-0.97)<1e-12);
    r.blocks[0].subjects[0].invalid.push('sample-below-floor'); assert(!summarize(r).usable);
  }
});
function screen(nodeRatio=0.97,bunRatio=0.97,nodeAA=1) {
  return ['node','bun'].flatMap(runtime=>CASES.map(workload=>{
    const r=row(runtime,runtime==='node'?nodeRatio:bunRatio,runtime==='node'?nodeAA:1); r.workload=workload; return r;
  }));
}
test('screen requires all32 cells; scoped uncertainty remains explicit', () => {
  assert.equal(gate(screen(),true),'strong-clear-requires-human-review');
  assert.equal(gate(screen(0.97,1),true),'hold-no-established-gain-in-each-runtime');
  assert.equal(gate(screen(0.97,1.03),true),'hold-material-loss');
  assert.equal(gate(screen(0.97,0.97,1.03),true),'hold-invalid-cells');
  assert.equal(gate(screen(),false),'incomplete'); assert.equal(gate(screen().slice(1),true),'incomplete');
  const partial=screen(); partial[0].summary.modes.ab.interval.upper=1.04;
  assert.equal(gate(partial,true),'scoped-review-required-inconclusive-cells');
});
test('common work uses faster pilot and rejects mismatched fixture bytes', () => {
  const pilot = (repeat, ms) => ({status:'passed',invalid:[],repeat,minMsPerIteration:ms,expected:{count:31},identity:{bytes:'same'}});
  const plan=freezePlan([pilot(20,3),pilot(50,1)]);
  assert.equal(plan.repeat,50); assert.equal(plan.warmupScans,650);
  const bad=pilot(50,1);bad.identity.bytes='different';assert.throws(()=>freezePlan([pilot(20,3),bad]),/fixture bytes/);
  const rows=Array.from({length:32},()=>({plan,invalid:[],pilots:{baseline:{},candidate:{}}}));assertPilotBarrier(rows);
  rows[3].plan=null;assert.throws(()=>assertPilotBarrier(rows),/pilot barrier/);
});
test('neutral path replaces whole dist tree and preserves exact package context', () => {
  const dir=mkdtempSync(join(tmpdir(),'heap-neutral-test-'));
  try {
    const root=join(dir,'source'),neutral=join(dir,'package'); mkdirSync(join(root,'dist'),{recursive:true});
    const packageBytes=Buffer.from('{"type":"module","name":"fixture"}\n');writeFileSync(join(root,'package.json'),packageBytes);
    writeFileSync(join(root,'dist/shared.js'),'export const n=1;');writeFileSync(join(root,'dist/chunk.js'),'export const k=2;');
    mkdirSync(join(neutral,'dist'),{recursive:true});writeFileSync(join(neutral,'dist/stale.js'),'stale');
    const source={root,packageBytes,packageSha256:createHash('sha256').update(packageBytes).digest('hex'),dist:inventory(join(root,'dist'))};
    const entry=prepareSubject(source,neutral);assert(entry.endsWith('/package/dist/shared.js'));assert(!existsSync(join(neutral,'dist/stale.js')));
    assert.deepEqual(readFileSync(join(neutral,'package.json')),packageBytes);assert.deepEqual(inventory(join(neutral,'dist')),source.dist);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('command failures retain raw output, exit status, immediate metadata and environment', async () => {
  const { runCommand } = await import('./heap-entry-command.mjs');
  const dir=mkdtempSync(join(tmpdir(),'heap-command-failure-'));
  try {
    const prefix=join(dir,'failed');
    const result=await runCommand({name:'synthetic-failure',command:process.execPath,
      args:['-e',"process.stdout.write(process.env.HEAP_TEST_MARKER);process.stderr.write('diagnostic');process.exit(3)"],
      cwd:dir,env:{...process.env,HEAP_TEST_MARKER:'partial-output'},prefix,timeoutMs:5000});
    assert.equal(result.status,3);assert.equal(result.complete,false);assert.equal(result.timedOut,false);
    assert.equal(result.cleanup.status,'verified-no-live-processes');
    assert.equal(readFileSync(result.stdout,'utf8'),'partial-output');assert.equal(readFileSync(result.stderr,'utf8'),'diagnostic');
    const receipt=JSON.parse(readFileSync(result.metadata,'utf8'));assert.equal(receipt.status,3);assert(receipt.started&&receipt.finished);
    await assert.rejects(runCommand({name:'duplicate',command:process.execPath,args:[],cwd:dir,prefix,timeoutMs:5000}),/EEXIST/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('command deadline kills TERM-resistant descendants and verifies stable evidence', async () => {
  const { runCommand, processGroupMembers } = await import('./heap-entry-command.mjs');
  const dir=mkdtempSync(join(tmpdir(),'heap-command-timeout-'));
  try {
    const script="trap '' TERM; (trap '' TERM; printf 'descendant-started\\n'; while :; do printf 'still-running\\n'; sleep 0.02; done) & wait";
    const result=await runCommand({name:'synthetic-timeout',command:'/bin/sh',args:['-c',script],cwd:dir,prefix:join(dir,'timeout'),timeoutMs:300});
    assert.equal(result.timedOut,true);assert.equal(result.complete,false);assert.equal(result.signal,'SIGKILL');
    assert.equal(result.cleanup.status,'verified-no-live-processes');
    assert(processGroupMembers(result.cleanup.group).every(({state})=>['Z','X'].includes(state)));
    const bytes=readFileSync(result.stdout);assert.match(bytes.toString(),/descendant-started/);
    await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(readFileSync(result.stdout),bytes);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('a successful wrapper cannot leave live descendants behind', async () => {
  const { runCommand } = await import('./heap-entry-command.mjs');
  const dir=mkdtempSync(join(tmpdir(),'heap-command-orphan-'));
  try {
    const script="(trap '' TERM; while :; do printf 'background\\n'; sleep 0.02; done) & printf 'wrapper-finished\\n'; exit 0";
    const result=await runCommand({name:'synthetic-orphan',command:'/bin/sh',args:['-c',script],cwd:dir,prefix:join(dir,'orphan'),timeoutMs:5000});
    assert.equal(result.status,0);assert.equal(result.complete,true);assert.equal(result.cleanup.status,'verified-no-live-processes');
    const bytes=readFileSync(result.stdout);assert.match(bytes.toString(),/wrapper-finished/);
    await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(readFileSync(result.stdout),bytes);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('parent interruption finalizes failed receipts after owned-group cleanup', async () => {
  const { spawn } = await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'heap-command-interrupt-'));
  let runner;
  try {
    const module=new URL('./heap-entry-command.mjs',import.meta.url).href,prefix=join(dir,'interrupt');
    const code=`import { runCommand } from ${JSON.stringify(module)};const result=await runCommand({name:'interrupt-fixture',command:process.execPath,args:['-e',"console.log('child-started');setInterval(()=>{},1000)"],cwd:${JSON.stringify(dir)},prefix:${JSON.stringify(prefix)},timeoutMs:5000});process.exitCode=result.complete?0:1;`;
    const file=join(dir,'runner.mjs');writeFileSync(file,code);
    runner=spawn(process.execPath,[file],{stdio:['ignore','pipe','pipe']});let starts='';runner.stdout.on('data',bytes=>{starts+=bytes;});runner.stderr.resume();
    const exited=new Promise(resolve=>runner.once('close',(code,signal)=>resolve({code,signal})));
    const deadline=Date.now()+5000;
    while(!starts.includes('[start]')||!existsSync(prefix+'.stdout.log')||!readFileSync(prefix+'.stdout.log','utf8').includes('child-started')){
      assert(Date.now()<deadline,'Synthetic runner did not start');await new Promise(resolve=>setTimeout(resolve,10));
    }
    const before=JSON.parse(readFileSync(prefix+'.command.json','utf8'));assert.equal(before.complete,false);assert.equal(before.finished,undefined);
    runner.kill('SIGTERM');assert.deepEqual(await exited,{code:1,signal:null});
    const receipt=JSON.parse(readFileSync(prefix+'.command.json','utf8'));
    assert.equal(receipt.interruptedSignal,'SIGTERM');assert.equal(receipt.complete,false);assert.equal(receipt.timedOut,false);
    assert.equal(receipt.cleanup.status,'verified-no-live-processes');assert(receipt.finished);
  } finally {if(runner?.exitCode===null)runner.kill('SIGTERM');rmSync(dir,{recursive:true,force:true});}
});
