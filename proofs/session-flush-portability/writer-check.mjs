// Proposed <=6-second synthetic gate. No runtime-arm or Playwright import.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { writeRow } from './writer.mjs';
const self=fileURLToPath(import.meta.url), padding='x'.repeat(8*1024*1024);
if(process.argv[2]==='child') {
  await writeRow({event:'batch-start',synthetic:true});
  let completed=false;
  process.on('message', message=>{
    if(message==='probe') process.send({event:'pending',pending:!completed});
  });
  process.send({event:'ready'});
  await writeRow({event:'backpressure',padding});
  completed=true;
  await writeRow({event:'batch',synthetic:true,checksum:7,ns:12345});
  throw new Error('synthetic-post-row-validation-failure');
} else {
  assert(process.argv[2], 'Specify a new output directory');
  const directory=resolve(process.argv[2]);mkdirSync(directory,{recursive:false});
  const stdout=[],stderr=[];let bytes=0,pendingObserved=false,failure=null,exitCode=null,draining=false;
  const child=spawn(process.execPath,[self,'child'],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
  const drain=()=>{
    if(!draining) {
      draining=true;
      child.stdout.on('data',data=>{stdout.push(data);bytes+=data.length;if(bytes>padding.length+2048){failure=new Error('Unexpected stdout overflow');child.kill('SIGKILL');}});
    }
    child.stdout.resume();
  };
  const timeout=setTimeout(()=>{failure=new Error('Synthetic writer gate deadline');child.kill('SIGKILL');drain();},5000);
  try {
    await new Promise((accept,reject)=>{
      child.on('error',reject);
      child.stderr.on('data',data=>{stderr.push(data);if(Buffer.concat(stderr).length>65536){failure=new Error('Unexpected stderr overflow');child.kill('SIGKILL');}});
      child.on('message',message=>{
        if(message.event==='ready')child.send('probe');
        if(message.event==='pending') {
          pendingObserved=message.pending===true;
          // The pipe was deliberately unread until this acknowledgment.
          drain();
        }
      });
      child.on('close',code=>{exitCode=code;accept();});
    });
    if(failure)throw failure;
    assert(pendingObserved,'Actual writer did not remain pending under pipe backpressure');
    assert.notEqual(exitCode,0);
    const expected=[{event:'batch-start',synthetic:true},{event:'backpressure',padding},{event:'batch',synthetic:true,checksum:7,ns:12345}].map(row=>JSON.stringify(row)+'\n').join('');
    assert.equal(Buffer.concat(stdout).toString(),expected,'Completed row lost or changed before subsequent failure');
    assert.match(Buffer.concat(stderr).toString(),/synthetic-post-row-validation-failure/);
    const broken=new Writable({write(_chunk,_encoding,callback){callback(new Error('synthetic-write-failure'));}});
    await assert.rejects(writeRow({event:'failure'},broken),/synthetic-write-failure/);
  } catch(error) {failure=error;child.kill('SIGKILL');drain();}
  finally {
    clearTimeout(timeout);
    writeFileSync(resolve(directory,'stdout.jsonl'),Buffer.concat(stdout),{flag:'wx'});
    writeFileSync(resolve(directory,'stderr.txt'),Buffer.concat(stderr),{flag:'wx'});
    writeFileSync(resolve(directory,'RESULT.json'),JSON.stringify({state:failure?'failed':'passed',exitCode,pendingObserved,retainedBytes:bytes,performanceSamples:0,error:failure?String(failure):null},null,2)+'\n',{flag:'wx'});
  }
  if(failure)throw failure;
}
