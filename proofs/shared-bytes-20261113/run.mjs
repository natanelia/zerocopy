// node run.mjs node|chromium OUTPUT.json [pairs=7]
import { Worker } from 'node:worker_threads';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cpus } from 'node:os';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './fixtures.mjs';

const [engine='node',output,pairArg='7'] = process.argv.slice(2), pairs=Number(pairArg);
if(!['node','chromium'].includes(engine)||!output||!Number.isSafeInteger(pairs)||pairs<1) throw Error('Expected node|chromium OUTPUT.json [pairs]');
if(existsSync(output)) throw Error(`Refusing to overwrite ${output}`);
const root=resolve(fileURLToPath(new URL('../../',import.meta.url))), rows=[];
const sha256=x=>createHash('sha256').update(x).digest('hex');
const sources=Object.fromEntries(['fixtures.mjs','bench-worker.mjs','direct-json.mjs','byte-query.mjs','.runtime/utf8.mjs','.runtime/freeze-json.mjs'].map(name=>[name,sha256(readFileSync(new URL(name,import.meta.url)))]));
const result={schema:'zerocopy-shared-bytes-exploration/v1',startedAt:new Date().toISOString(),baseline:'b4c08def84b905026632bfd27612da4efef0a3f0',engine,pairs,sources,cpu:cpus()[0]?.model,node:process.version,rows,
  method:'Fresh worker per method/sample, no parser warmup; immutable shared input prepared by owner before timing. Codec retains all outputs; query methods return count, query compilation timed. Full decoded-object cache control materializes entire dataset before its separate scan timer. These isolated codec/predicate experiments do not include map traversal, transport, construction or website fingerprints in timed regions. All samples retained; order rotates.'};
const save=()=>{writeFileSync(output+'.partial',JSON.stringify(result,null,2)+'\n');renameSync(output+'.partial',output);};
save();
let server,browser,page;
if(engine==='chromium') {
  const {chromium}=await import('playwright');
  server=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    response.setHeader('Cache-Control','no-store');
    const pathname=new URL(request.url,'http://localhost').pathname;
    if(pathname==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Shared byte experiments</title>');return;}
    const path=resolve(root,'.'+pathname);
    if(!path.startsWith(root+sep)){response.writeHead(403).end();return;}
    try {response.setHeader('Content-Type',extname(path)==='.mjs'||extname(path)==='.js'?'text/javascript':'application/octet-stream');response.end(readFileSync(path));}
    catch{response.writeHead(404).end();}
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  result.browser=browser.version();result.sharedDecode=await page.evaluate(()=>{try{new TextDecoder().decode(new Uint8Array(new SharedArrayBuffer(1)));return true;}catch{return false;}});
}
function nodeSample(fixture,method,field) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./bench-worker.mjs',import.meta.url));
    const timer=setTimeout(()=>{worker.terminate();reject(Error('worker timeout'));},60000);
    worker.on('error',error=>{clearTimeout(timer);reject(error);});
    worker.on('message',async message=>{
      if(message.ready){worker.postMessage({fixture,method,field});return;}
      clearTimeout(timer);await worker.terminate();message.error?reject(Error(message.error)):resolve(message.result);
    });
  });
}
async function browserSample(method,field) {
  return page.evaluate(({method,field})=>new Promise((resolve,reject)=>{
    const worker=new Worker('/proofs/shared-bytes-20261113/bench-worker.mjs',{type:'module'});
    const timer=setTimeout(()=>{worker.terminate();reject(Error('worker timeout'));},60000);
    worker.onerror=e=>{clearTimeout(timer);worker.terminate();reject(Error(e.message));};
    worker.onmessage=e=>{const message=e.data;if(message.ready){worker.postMessage({fixture:globalThis.fixture,method,field});return;}clearTimeout(timer);worker.terminate();message.error?reject(Error(message.error)):resolve(message.result);};
  }),{method,field});
}
try {
  for(const kind of ['catalog','unicode','numeric','large-early','large-late']) {
    const count=kind==='numeric'?2000:10000;
    const fixture=engine==='node'?makeFixture(kind,count):undefined;
    if(engine==='chromium') await page.evaluate(async({kind,count})=>{const {makeFixture}=await import('/proofs/shared-bytes-20261113/fixtures.mjs');globalThis.fixture=makeFixture(kind,count);},{kind,count});
    const methods=['codec-native','codec-direct','query-native','query-bytes','query-cached'];
    if(kind==='catalog') methods.push('codec-native-plain','codec-direct-plain','decode-only');
    for(let pair=0;pair<pairs;pair++) for(let j=0;j<methods.length;j++) {
      const method=methods[(j+pair)%methods.length];
      const timing=engine==='node'?await nodeSample(fixture,method,'category'):await browserSample(method,'category');
      rows.push({kind,count,pair,method,field:'category',...timing});save();
    }
    // A missing field must scan the complete record; retain this adverse control.
    if(kind==='large-late') for(let pair=0;pair<pairs;pair++) for(const method of pair%2?['query-bytes','query-native']:['query-native','query-bytes']) {
      const timing=engine==='node'?await nodeSample(fixture,method,'absent'):await browserSample(method,'absent');
      rows.push({kind,count,pair,method,field:'absent',...timing});save();
    }
    console.log(`${engine}: completed ${kind}; ${rows.length} samples`);
  }
  result.completedAt=new Date().toISOString();save();
} catch(error){result.error=error.stack;save();throw error;}
finally{await browser?.close();if(server){server.closeAllConnections();server.close();}}
