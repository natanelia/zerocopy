import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,renameSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from './support.mjs';
import {indexSummary,rawReference,resolveRaw,validateIndex} from './evidence.mjs';

function fixture(fn) {
  const dir=mkdtempSync(join(tmpdir(),'callback-evidence-'));mkdirSync(join(dir,'logs'));
  const raw={phase:'measure',samples:[1,2,3],repeat:4,digest:'unchanged',calibration:[{repeat:2,ms:1}],warmup:{scans:50,elapsedMs:12,capped:false,batches:[{scans:25,ms:6},{scans:25,ms:6}]},runtime:{node:'22.23.3'},extra:{must:'survive'}};
  const bytes=JSON.stringify(raw),stdout=join(dir,'logs/0000.stdout.log');writeFileSync(stdout,bytes);
  const receipt={sequence:0,role:'main',caseId:'case',phase:'measure',complete:true,stdout,stdoutSha256:hash(bytes)};
  receipt.rawRef=rawReference(dir,receipt);
  const value={sequence:0,complete:true,...indexSummary(raw),role:'main'};
  const record={schema:2,status:'completed',subjects:[receipt],rows:[{workload:{id:'case'},pilots:[],blocks:[{subjects:[value]}]}]};
  try{return fn({dir,raw,bytes,receipt,record,value});}finally{rmSync(dir,{recursive:true,force:true});}
}
test('selector removes only the two duplicated trace fields and does not mutate raw',()=>fixture(({raw,bytes})=>{
  const summary=indexSummary(raw);assert.equal(JSON.stringify(raw),bytes);
  assert.deepEqual(Object.keys(summary),Object.keys(raw).filter(k=>k!=='calibration'));
  assert.deepEqual(Object.keys(summary.warmup),Object.keys(raw.warmup).filter(k=>k!=='batches'));
  for(const key of Object.keys(summary))if(key!=='warmup')assert.strictEqual(summary[key],raw[key]);
  assert.deepEqual(summary.extra,{must:'survive'});
}));
test('every original raw byte is hash-bound and archive relocation works',()=>fixture(({dir,raw,receipt,record})=>{
  receipt.stdout='/original/runner/latency/logs/0000.stdout.log';
  assert.deepEqual(resolveRaw(dir,receipt),raw);
  assert.deepEqual(validateIndex(record,dir),{schema:2,rawReferences:1,indexedSubjects:1});
}));
test('creation rejects a stdout path for a different sequence',()=>fixture(({dir,receipt})=>{
  assert.throws(()=>rawReference(dir,{...receipt,sequence:1}));
}));
test('resolver rejects missing, changed and mislinked raw evidence',()=>fixture(({dir,receipt,bytes})=>{
  const file=join(dir,receipt.rawRef.path);writeFileSync(file,bytes+' ');assert.throws(()=>resolveRaw(dir,receipt));
  writeFileSync(file,bytes);const original=receipt.rawRef;
  for(const path of ['../outside','logs/0001.stdout.log','/absolute']){receipt.rawRef={...original,path};assert.throws(()=>resolveRaw(dir,receipt));}
  receipt.rawRef=original;rmSync(file);assert.throws(()=>resolveRaw(dir,receipt));
}));
test('resolver rejects symlink files and log directories',()=>fixture(({dir,receipt,bytes})=>{
  const file=join(dir,receipt.rawRef.path),other=join(dir,'other');writeFileSync(other,bytes);rmSync(file);symlinkSync(other,file);assert.throws(()=>resolveRaw(dir,receipt));
  rmSync(file);writeFileSync(file,bytes);renameSync(join(dir,'logs'),join(dir,'real-logs'));symlinkSync(join(dir,'real-logs'),join(dir,'logs'));assert.throws(()=>resolveRaw(dir,receipt));
}));
test('index rejects changed summaries, identity links and absent completed subjects',()=>fixture(({dir,record,value,receipt})=>{
  value.samples=[7];assert.throws(()=>validateIndex(record,dir));value.samples=[1,2,3];
  receipt.caseId='wrong';assert.throws(()=>validateIndex(record,dir));receipt.caseId='case';
  receipt.role='candidate';assert.throws(()=>validateIndex(record,dir));receipt.role='main';
  record.rows[0].blocks[0].subjects.push(value);assert.throws(()=>validateIndex(record,dir));record.rows[0].blocks[0].subjects=[];
  assert.throws(()=>validateIndex(record,dir));
}));
test('incomplete receipts remain visible and cannot pass completed validation',()=>fixture(({dir,record,receipt})=>{
  delete receipt.rawRef;record.rows[0].blocks[0].subjects=[];
  assert.throws(()=>validateIndex(record,dir));record.status='failed';
  assert.deepEqual(validateIndex(record,dir),{schema:2,rawReferences:0,indexedSubjects:0});
}));
test('raw reference alone does not admit unsuccessful subjects',()=>fixture(({dir,receipt})=>{
  receipt.complete=false;assert.throws(()=>resolveRaw(dir,receipt));
}));
