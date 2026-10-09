import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import os from 'node:os';
import {runCommand} from './reused/command.mjs';
for(const mode of ['success','failure','timeout','descendant'])test(`bounded command retains ${mode} outcome and clears its process group`,async()=>{
 const root=mkdtempSync(join(os.tmpdir(),'block-callback-command-'));
 const code=mode==='success'?"process.stdout.write('ok');":mode==='failure'?"process.stderr.write('expected failure');process.exit(7);":mode==='timeout'?"setInterval(()=>{},1000);":"require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.exit(0);";
 try{const r=await runCommand({name:mode,command:process.execPath,args:['-e',code],cwd:root,prefix:join(root,'command'),timeoutMs:mode==='timeout'?100:2000});
 assert.equal(r.cleanup.status,'verified-no-live-processes');assert.equal(r.cleanup.survivors.length,0);assert.equal(r.complete,['success','descendant'].includes(mode));
 if(mode==='timeout')assert.equal(r.timedOut,true);if(mode==='failure'){assert.equal(r.status,7);assert(readFileSync(r.stderr,'utf8').includes('expected failure'));}
 assert.equal(JSON.parse(readFileSync(r.metadata,'utf8')).complete,r.complete);
 }finally{rmSync(root,{recursive:true,force:true});}
});
