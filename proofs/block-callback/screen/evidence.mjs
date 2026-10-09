import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {hash} from './support.mjs';

// Raw stdout remains immutable and complete. Only the repeatedly written index
// omits calibration and per-batch warmup traces, which inference never reads.
export function indexSummary(raw) {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw));
  assert(raw.warmup && typeof raw.warmup === 'object');
  const {calibration,...summary}=raw;
  const {batches,...warmup}=raw.warmup;
  return {...summary,warmup};
}
function expectedReference(receipt) {
  assert(Number.isSafeInteger(receipt.sequence) && receipt.sequence>=0);
  const path='logs/'+String(receipt.sequence).padStart(4,'0')+'.stdout.log';
  assert.match(receipt.stdoutSha256,/^[0-9a-f]{64}$/);
  return {schema:1,path,sha256:receipt.stdoutSha256};
}
export function rawReference(directory,receipt) {
  const reference=expectedReference(receipt);
  assert.equal(relative(directory,receipt.stdout).split(sep).join('/'),reference.path);
  return reference;
}
export function resolveRaw(directory,receipt) {
  assert.equal(receipt.complete,true,'Incomplete subject has no admitted raw evidence');
  const expected=expectedReference(receipt);
  assert.deepEqual(receipt.rawRef,expected,'Mislinked raw reference');
  const path=join(directory,expected.path);
  assert(lstatSync(join(directory,'logs')).isDirectory(),'Raw log directory is not a directory');
  assert(lstatSync(path).isFile(),'Raw stdout must be a regular file');
  const bytes=readFileSync(path);
  assert.equal(hash(bytes),expected.sha256,'Raw stdout changed');
  return JSON.parse(bytes.toString('utf8'));
}
export function validateIndex(record,directory) {
  assert.equal(record.schema,2);
  const summaries=new Map();
  for(const [sequence,receipt] of record.subjects.entries()) {
    assert.equal(receipt.sequence,sequence,'Noncontiguous subject sequence');
    if(!receipt.rawRef) {
      assert(!receipt.complete || record.status!=='completed','Completed record lacks raw evidence');
      continue;
    }
    const raw=resolveRaw(directory,receipt);
    assert.equal(raw.phase,receipt.phase);
    summaries.set(sequence,{sequence,complete:true,...indexSummary(raw)});
  }
  const seen=new Set();
  for(const row of record.rows) {
    for(const value of [...row.pilots,...row.blocks.flatMap(block=>block.subjects)]) {
      assert(!seen.has(value.sequence),'Repeated indexed subject');seen.add(value.sequence);
      const receipt=record.subjects[value.sequence];assert(receipt,'Missing subject receipt');
      assert.equal(receipt.caseId,row.workload.id);
      const expected=summaries.get(value.sequence);assert(expected,'Missing raw summary');
      assert.deepEqual(value,value.phase==='measure'?{...expected,role:receipt.role}:expected,'Index differs from raw evidence');
    }
  }
  if(record.status==='completed')assert.equal(seen.size,record.subjects.length,'Completed index omits a subject');
  return {schema:2,rawReferences:summaries.size,indexedSubjects:seen.size};
}
