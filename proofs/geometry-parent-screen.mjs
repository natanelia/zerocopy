import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, cpSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { CASES, CONFIG, METHODS, studyFor, commonPlan, validatePilot, validateMeasured, summarizeMethods, screenStatus, describeSamples } from './geometry-parent-screen-protocol.mjs';
import { BASELINE, CANDIDATE, BRANCH, TOOLCHAIN, PROOF_FILES, SUBJECT_FILES, sha256, files, compare, git } from './geometry-parent-screen-source.mjs';
import { validatePrerequisites } from './geometry-parent-screen-prerequisites.mjs';
const repository=dirname(dirname(fileURLToPath(import.meta.url)));
export const save=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(value,null,2)+'\n');renameSync(path+'.tmp',path);};
const read=path=>JSON.parse(readFileSync(path,'utf8'));
function copy(from,to){mkdirSync(dirname(to),{recursive:true});cpSync(from,to,{recursive:true});}
export function assertEvent(env=process.env, event) {
  assert.equal(env.GITHUB_ACTIONS,'true','No local latency measurements');
  assert.equal(env.GITHUB_EVENT_NAME,'push');assert.equal(env.GITHUB_REF,BRANCH);assert.equal(env.GITHUB_RUN_ATTEMPT,'1');
  event ??= read(env.GITHUB_EVENT_PATH);
  assert.equal(event.before,CANDIDATE,'Only the first scoped push from the reviewed runtime may run');assert.equal(event.after,env.GITHUB_SHA);
  assert.notEqual(event.after,CANDIDATE);assert.equal(event.ref,BRANCH);assert.equal(event.deleted,false);assert.equal(event.forced,false);
}
export function prepare(baseRoot,candidateRoot,directory) {
  directory=resolve(directory);assert(!existsSync(directory),'Never overwrite a frozen study');
  const prerequisites=validatePrerequisites(dirname(directory)),comparison=compare(baseRoot,candidateRoot);
  assert.deepEqual(comparison,prerequisites.comparison,'Build changed after prerequisites');
  const bundleFiles={};
  for(const build of ['baseline','candidate']) {
    const source=comparison.roots[build],target=join(directory,'bundles',build);
    for(const file of ['dist','package.json','geometry-kernels.wasm'])copy(join(source,file),join(target,file));
    bundleFiles[build]=files(target);
  }
  for(const file of [...PROOF_FILES,'proofs/geometry-bbox.mjs','proofs/geometry-fixtures.mjs','proofs/geometry-parent-cache.mjs'])copy(join(candidateRoot,file),join(directory,'proof-source',file));
  copy(join(candidateRoot,'.github/workflows/geometry-parent-cache-screen.yml'),join(directory,'workflow.yml'));
  const frozen={schema:1,study:studyFor(CASES),comparison,prerequisites,bundleFiles,proofFiles:files(join(directory,'proof-source')),
    workflowSha256:sha256(readFileSync(join(directory,'workflow.yml'))),proofHead:comparison.proofHead,
    runtime:process.env.PROOF_RUNTIME,arch:process.arch,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT};
  save(join(directory,'frozen.json'),frozen);writeFileSync(join(directory,'frozen.sha256'),sha256(readFileSync(join(directory,'frozen.json')))+'\n');
  checkFrozen(directory);return frozen;
}
export function checkFrozen(directory) {
  const bytes=readFileSync(join(directory,'frozen.json'));
  assert.equal(sha256(bytes),readFileSync(join(directory,'frozen.sha256'),'utf8').trim());const f=JSON.parse(bytes);
  assert.deepEqual(f.study,studyFor(CASES));assert.deepEqual(validatePrerequisites(dirname(directory)),f.prerequisites);
  assert.deepEqual(files(join(directory,'proof-source')),f.proofFiles);
  for(const file of Object.keys(f.proofFiles)) assert.equal(sha256(readFileSync(join(repository,file))),f.proofFiles[file],`Executing proof changed: ${file}`);
  for(const build of ['baseline','candidate'])assert.deepEqual(files(join(directory,'bundles',build)),f.bundleFiles[build]);
  assert.equal(sha256(readFileSync(join(directory,'workflow.yml'))),f.workflowSha256);return f;
}
export function stageSubject(directory,build,neutral,frozen) {
  assert(['baseline','candidate'].includes(build));rmSync(neutral,{recursive:true,force:true});copy(join(directory,'bundles',build),neutral);
  for(const file of SUBJECT_FILES)copy(join(directory,'proof-source','proofs',file),join(neutral,'proofs',file));
  const expected={...frozen.bundleFiles[build]};for(const file of SUBJECT_FILES)expected['proofs/'+file]=frozen.proofFiles['proofs/'+file];
  assert.deepEqual(files(neutral),Object.fromEntries(Object.entries(expected).sort(([a],[b])=>a.localeCompare(b))));
  assert.equal(realpathSync(neutral),neutral);return files(neutral);
}
function sameNumbers(actual,expected) {
  if(typeof expected==='number'){assert(Number.isFinite(actual));assert(Math.abs(actual-expected)<=32*Number.EPSILON*Math.max(1,Math.abs(expected)));}
  else if(expected&&typeof expected==='object'){assert.deepEqual(Object.keys(actual),Object.keys(expected));for(const k of Object.keys(expected))sameNumbers(actual[k],expected[k]);}
  else assert.equal(actual,expected);
}
export function validateRecord(record,frozen,directory) {
  assert.equal(record.status,'completed');assert.equal(record.plansFrozenBeforeMeasurements,true);
  assert.equal(record.baseline,BASELINE);assert.equal(record.candidate,CANDIDATE);assert.equal(record.proofHead,frozen.proofHead);
  assert.equal(record.runtime,frozen.runtime);assert.equal(record.arch,frozen.arch);assert(['x64','arm64'].includes(record.arch));
  assert.equal(record.runId,frozen.runId);assert.equal(record.runAttempt,1);assert.deepEqual(record.config,CONFIG);
  assert.equal(record.rows.length,CASES.length);assert.equal(record.verifications.length,CASES.length*2);
  assert.equal(record.attempts.length,CASES.length*36);assert.equal(record.frozenSha256,sha256(readFileSync(join(directory,'frozen.json'))));
  assert.equal(record.plansSha256,sha256(readFileSync(join(directory,'plans.json'))));
  assert.deepEqual(read(join(directory,'plans.json')),record.rows.map(row=>({workload:row.workload,plans:row.plans})));
  const used=new Set();let sequence=0;
  function bind(s,expected) {
    assert.equal(s.sequence,sequence++,'Process reordered');assert(!used.has(s.sequence));used.add(s.sequence);
    const a=record.attempts[s.sequence];assert.equal(a.status,0);assert.equal(a.signal,null);assert.equal(a.error,null);
    for(const [key,value]of Object.entries(expected)){assert.equal(s[key],value,key);assert.equal(a[key],value,key);}
    assert.deepEqual(a.after,a.before);assert.equal(a.root,record.neutral);
    const expectedFiles={...frozen.bundleFiles[s.build]};for(const file of SUBJECT_FILES)expectedFiles['proofs/'+file]=frozen.proofFiles['proofs/'+file];
    assert.deepEqual(a.before,Object.fromEntries(Object.entries(expectedFiles).sort(([a],[b])=>a.localeCompare(b))));
    assert.equal(s.physical.root,record.neutral);assert.deepEqual(s.physical.files,a.before);
    assert.equal(s.runtime.name,record.runtime);assert.equal(s.runtime.version,TOOLCHAIN[record.runtime]);assert.equal(s.runtime.arch,record.arch);assert.equal(s.runtime.platform,'linux');assert.deepEqual(s.runtime.execArgv,[]);
    assert.equal(s.status,'completed');assert.deepEqual(s.after,s.before);assert.equal(s.actualDigest,s.expectedDigest);
    assert.equal(s.rawWasmSha256,frozen.comparison.builds[s.build].wasm['geometry-kernels.wasm']);
    for(const stream of ['stdout','stderr'])assert.equal(sha256(readFileSync(join(directory,a[stream].path))),a[stream].sha256);
    const {sequence:ignored,build,role,orderOffset,...raw}=s;assert.deepEqual(read(join(directory,a.stdout.path)),raw);
  }
  for(let i=0;i<frozen.study.rows.length;i++)for(const build of ['baseline','candidate'])bind(record.verifications[i*2+(build==='candidate'?1:0)],{build,phase:'verify',workload:frozen.study.rows[i].workload.name});
  for(let i=0;i<frozen.study.rows.length;i++) {
    const row=record.rows[i],planned=frozen.study.rows[i];assert.deepEqual(row.workload,planned.workload);assert.deepEqual(row.schedule,planned.schedule);
    for(const build of planned.pilotOrder) {
      bind(row.pilots[build],{build,phase:'pilot',workload:row.workload.name});
      for(const method of METHODS)validatePilot(row.pilots[build].methods[method]);
    }
    for(const method of METHODS)assert.deepEqual(row.plans[method],commonPlan(Object.fromEntries(['baseline','candidate'].map(b=>[b,row.pilots[b].methods[method]]))));
  }
  for(const row of record.rows) {
    assert.equal(row.blocks.length,row.schedule.length);
    for(let i=0;i<row.schedule.length;i++) {
      const planned=row.schedule[i],block=row.blocks[i];const {subjects,...shape}=block;assert.deepEqual(shape,planned);assert.equal(subjects.length,4);
      for(let slot=0;slot<4;slot++) {
        const role=planned.roles[slot],s=subjects[slot];bind(s,{build:planned[role],role,phase:'measure',workload:row.workload.name});assert.equal(s.orderOffset,slot%2);
        for(let sample=0;sample<CONFIG.samples;sample++)assert.deepEqual(s.batchOrder[sample],(sample+s.orderOffset)&1?[...METHODS].reverse():METHODS);
        for(const method of METHODS) {
          const m=s.methods[method];validateMeasured(m,row.plans[method]);sameNumbers(m.statistics,describeSamples(m.samples,m.repeat));
          assert.deepEqual(m.batches.map(b=>b.ms),[...m.warmup.batches.map(b=>b.ms),...m.samples]);
          assert(m.batches.every(b=>b.iterations===m.repeat&&Number.isFinite(b.sink)));
          assert.equal(m.consumedOperations,m.repeat*m.batches.length);
        }
      }
    }
    sameNumbers(row.summaries,summarizeMethods(row));
  }
  assert.equal(sequence,record.attempts.length);assert.equal(record.screen,screenStatus(record.rows));
}
export function run(directory) {
  directory=resolve(directory);assertEvent();assert.deepEqual(process.execArgv,[]);assert.equal(process.env.NODE_OPTIONS??'','');assert.equal(process.env.BUN_OPTIONS??'','');
  const runtime=process.versions.bun?'bun':'node';assert.equal(process.versions.bun??process.versions.node,TOOLCHAIN[runtime]);assert.equal(process.platform,'linux');assert(['x64','arm64'].includes(process.arch));
  const frozen=checkFrozen(directory);assert.equal(frozen.proofHead,process.env.GITHUB_SHA);assert.equal(frozen.runtime,runtime);assert.equal(frozen.arch,process.arch);assert.equal(frozen.runId,process.env.GITHUB_RUN_ID);assert.equal(frozen.runAttempt,'1');
  const resultPath=join(directory,'result.json');assert(!existsSync(resultPath),'No overwrite, retry or cherry-picked rerun');
  const neutral=join(realpathSync(mkdtempSync(join(os.tmpdir(),'geometry-screen-'))),'subject');
  const record={schema:1,status:'running',runtime,arch:process.arch,baseline:BASELINE,candidate:CANDIDATE,proofHead:frozen.proofHead,runId:frozen.runId,runAttempt:1,config:CONFIG,
    frozenSha256:sha256(readFileSync(join(directory,'frozen.json'))),neutral,controller:{executable:realpathSync(process.execPath),versions:process.versions,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,platform:process.platform},
    verifications:[],attempts:[],rows:frozen.study.rows.map(r=>({...r,pilots:{},plans:{},blocks:[]})),plansFrozenBeforeMeasurements:false};
  const checkpoint=()=>{for(const row of record.rows)row.summaries=summarizeMethods(row);record.screen=screenStatus(record.rows);save(resultPath,record);};
  function child(build,name,phase,plans,role,orderOffset=0) {
    const a={sequence:record.attempts.length,build,workload:name,phase,...(role?{role}:{}),orderOffset,root:neutral,startedAt:new Date().toISOString()};record.attempts.push(a);checkpoint();
    a.before=stageSubject(directory,build,neutral,frozen);checkpoint();
    const args=[join(neutral,'proofs/geometry-parent-screen-subject.mjs'),JSON.stringify({name,phase,orderOffset,...(plans?{plans}:{})})];
    a.command={executable:realpathSync(process.execPath),args,cwd:neutral,flags:[],compileCacheDisabled:true};checkpoint();
    const output=spawnSync(process.execPath,args,{cwd:neutral,encoding:'utf8',timeout:CONFIG.subjectTimeoutMs,maxBuffer:64*1024*1024,
      env:{...process.env,NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:'',GEOMETRY_PARENT_SCREEN_TIMING:'1'}});
    Object.assign(a,{status:output.status,signal:output.signal??null,error:output.error?String(output.error):null,finishedAt:new Date().toISOString()});
    for(const stream of ['stdout','stderr']){const path='children/'+String(a.sequence).padStart(4,'0')+'.'+stream;mkdirSync(join(directory,'children'),{recursive:true});writeFileSync(join(directory,path),output[stream]??'');a[stream]={path,sha256:sha256(readFileSync(join(directory,path)))};}
    try{a.after=files(neutral);}catch(error){a.after=null;a.receiptError=String(error);}checkpoint();
    assert.equal(output.status,0,`Subject ${a.sequence} failed; partial evidence retained`);assert.deepEqual(a.after,a.before);
    const s=JSON.parse(output.stdout);assert.equal(s.phase,phase);assert.equal(s.workload,name);assert.equal(s.status,'completed');assert.deepEqual(s.before,s.after);
    assert.equal(s.physical.root,neutral);assert.deepEqual(s.physical.files,a.before);
    return {...s,sequence:a.sequence,build,...(role?{role}:{}),orderOffset};
  }
  try {
    checkpoint();
    for(const row of record.rows)for(const build of ['baseline','candidate']){record.verifications.push(child(build,row.workload.name,'verify'));checkpoint();}
    for(const row of record.rows) {
      for(const build of row.pilotOrder){row.pilots[build]=child(build,row.workload.name,'pilot');checkpoint();}
      for(const method of METHODS)row.plans[method]=commonPlan(Object.fromEntries(['baseline','candidate'].map(build=>[build,row.pilots[build].methods[method]])));
      checkpoint();
    }
    save(join(directory,'plans.json'),record.rows.map(row=>({workload:row.workload,plans:row.plans})));
    record.plansSha256=sha256(readFileSync(join(directory,'plans.json')));record.plansFrozenBeforeMeasurements=true;checkpoint();
    assert(record.rows.every(row=>METHODS.every(method=>row.plans[method].valid)),'Invalid pilot; no measured processes permitted');
    for(const row of record.rows)for(const planned of row.schedule) {
      const block={...planned,subjects:[]};row.blocks.push(block);checkpoint();
      for(let slot=0;slot<4;slot++){const role=planned.roles[slot];block.subjects.push(child(planned[role],row.workload.name,'measure',row.plans,role,slot%2));checkpoint();}
    }
    record.status='completed';record.finishedAt=new Date().toISOString();checkpoint();validateRecord(record,frozen,directory);checkFrozen(directory);
  } catch(error){record.status='failed';record.error=String(error.stack??error);record.finishedAt=new Date().toISOString();checkpoint();throw error;}
  return record;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,...args]=process.argv.slice(2);
  if(mode==='prepare')console.log(JSON.stringify(prepare(...args),null,2));
  else if(mode==='run'){const r=run(args[0]);console.log(JSON.stringify({status:r.status,screen:r.screen,runtime:r.runtime,arch:r.arch,rows:r.rows.map(row=>({workload:row.workload,summaries:row.summaries}))},null,2));}
  else if(mode==='verify-record'){const f=checkFrozen(args[0]);validateRecord(read(join(args[0],'result.json')),f,args[0]);console.log('Frozen screen receipt validated');}
  else throw new Error('Usage: geometry-parent-screen.mjs prepare BASE CAND OUTPUT | run OUTPUT | verify-record OUTPUT');
}
