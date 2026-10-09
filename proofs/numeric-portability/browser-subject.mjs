import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import childProcess from 'node:child_process';
import {guardEngineSpawn} from './launch-guard.mjs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const manifest=JSON.parse(readFileSync(config.manifestPath,'utf8'));
assert.equal(createHash('sha256').update(readFileSync(config.manifestPath)).digest('hex'),config.manifestSha256);assert.equal(config.admitted,true);assert.equal(process.arch,config.lane);
const require=createRequire(path.join(manifest.sources[config.arm].path,'package.json')),playwright=require('playwright');
assert.equal(require('playwright/package.json').version,config.protocol.browserVersion);
assert(['chromium','firefox','webkit'].includes(config.runtime));
const emit=row=>writeSync(1,JSON.stringify(row)+'\n');let requests=0;
const server=createServer((request,response)=>{
  response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp');response.setHeader('Cross-Origin-Resource-Policy','same-origin');response.setHeader('Cache-Control','no-store');
  try{const url=new URL(request.url,'http://127.0.0.1'),name=url.pathname;let bytes,type;
    if(name==='/favicon.ico'){response.statusCode=204;response.end();return;}
    if(name==='/'){bytes=Buffer.from('<!doctype html><title>Numeric portability proof</title>');type='text/html';}
    else if(['/core.mjs','/browser-semantics.mjs','/semantic-worker.mjs'].includes(name)){bytes=readFileSync(path.join(here,name.slice(1)));type='text/javascript';}
    else if(/^\/dist\/[\w.-]+\.(js|mjs)$/.test(name)){const relative=name.slice(1),entry=[...manifest.sources[config.arm].builds,...manifest.sources[config.arm].generatedFixtures].find(x=>x.path===relative);assert(entry,'Only frozen official outputs and scalar fixture can be served');bytes=readFileSync(path.join(manifest.sources[config.arm].path,relative));assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);type='text/javascript';}
    else{response.statusCode=404;response.end();throw Error('Unexpected local request '+name);}
    response.setHeader('Content-Type',type);response.end(bytes);emit({kind:'http-response',request:requests++,path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),cacheControl:'no-store',originIsolation:true});
  }catch(error){response.statusCode=500;response.end();emit({kind:'server-error',error:String(error)});}
});
let context,browser;
const executable=playwright[config.runtime].executablePath(),profile=mkdtempSync(path.join(os.tmpdir(),'numeric-proof-profile-'));
assert.deepEqual(readdirSync(profile),[]);
const launchGuard=guardEngineSpawn(childProcess,{executable,profile,onSpawn:(child,args,attempt)=>emit({kind:'browser-process',pid:child.pid,spawnargs:child.spawnargs,executable,profile,profileInitiallyEmpty:true,profileMechanism:config.runtime==='firefox'?'explicit -profile argument':'explicit --user-data-dir argument',spawnAttempt:attempt})});
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  // Explicit fresh persistent profile also covers WebKit; one-spawn guard rejects Playwright's internal retry.
  context=await playwright[config.runtime].launchPersistentContext(profile,{executablePath:executable,headless:true,handleSIGINT:true,handleSIGTERM:true,handleSIGHUP:true});
  assert.equal(launchGuard.state.attempts,1);assert(launchGuard.state.child?.pid);browser=context.browser();assert(browser);
  const page=context.pages()[0]??await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));await page.exposeBinding('__proofEmit',(_source,row)=>emit(row));
  await page.goto(origin);await page.evaluate(async config=>{
    if(!crossOriginIsolated)throw Error('Cross-origin isolation required');
    const io={importModule:name=>import('/dist/'+name),sha256:async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))).map(x=>x.toString(16).padStart(2,'0')).join(''),emit:row=>globalThis.__proofEmit(row),now:performance.now.bind(performance),gcKind:'natural browser GC; no portable forced-GC API',collect:()=>{},memory:()=>({rss:'externally sampled browser process tree',jsHeapBytes:performance.memory?.usedJSHeapSize??null})};
    if(config.mode==='untimed'||config.mode==='semantics')Object.defineProperty(performance,'now',{configurable:true,value:()=>{throw Error('Untimed operation clocks forbidden');}});
    if(config.mode==='semantics'){const {semantics}=await import('/browser-semantics.mjs');await semantics(io);}else{const {runCore}=await import('/core.mjs');await runCore(config,io);}
  },config);
  assert.deepEqual(errors,[]);emit({kind:'browser-complete',version:browser.version(),origin,requests,resourceTimings:config.mode==='measure'?await page.evaluate(()=>performance.getEntriesByType('resource').map(x=>({name:x.name,startTime:x.startTime,duration:x.duration,transferSize:x.transferSize,encodedBodySize:x.encodedBodySize}))):null,localHttpOnly:true,globallyColdCompilerOrOsCache:false});
  await context.close();context=null;
}finally{
  try{if(context)await context.close();}finally{launchGuard.restore();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(!launchGuard.state.child||launchGuard.state.child.exitCode!==null||launchGuard.state.child.signalCode!==null)rmSync(profile,{recursive:true,force:true});}
}
