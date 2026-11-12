// node reader-run.mjs node|chromium OUTPUT.json [pairs=7]
// Uses the unchanged PR #75 website workload and original worker proof.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [engine='node',output,pairArg='7']=process.argv.slice(2),pairs=Number(pairArg),runFile=promisify(execFile);
if(!output||!['node','chromium'].includes(engine)||!Number.isSafeInteger(pairs)||pairs<1||existsSync(output)) throw Error('Expected node|chromium NEW_OUTPUT.json [pairs]');
const root=fileURLToPath(new URL('../../',import.meta.url)), runtime=fileURLToPath(new URL('.runtime/',import.meta.url));
const data={schema:'zerocopy-direct-json-reader/v1',engine,pairs,startedAt:new Date().toISOString(),manifest:JSON.parse(readFileSync(join(runtime,'build-manifest.json'),'utf8')),rows:[],
  method:'Fresh owner and two fresh readers per sample, unchanged catalog workload at 10k; 1000 requested IDs, 910 hits, full field fingerprints timed. No reader warmup; module/worker startup excluded. Alternating before/after pairs. Existing baseline and candidate differ only in object decoding, with identical cache limits and query/output checks. All samples retained.'};
const save=()=>{writeFileSync(output+'.partial',JSON.stringify(data,null,2)+'\n');renameSync(output+'.partial',output);};save();
let browser,page,server;
try {
  if(engine==='chromium') {
    const {chromium}=await import('playwright');
    server=createServer((request,response)=>{
      response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp');
      response.setHeader('Cache-Control','no-store');
      const path=new URL(request.url,'http://localhost').pathname;
      if(path==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Actual reader comparison</title>');return;}
      const [,arm,area,...parts]=path.split('/');if(!['before','after'].includes(arm)||parts.includes('..')){response.writeHead(404).end();return;}
      const file=area==='assets'?join(root,'website/assets',...parts):area==='library'?join(runtime,arm,'dist',...parts):null;
      try{if(!file)throw Error();response.setHeader('Content-Type','text/javascript');response.end(readFileSync(file));}catch{response.writeHead(404).end();}
    });server.listen(0,'127.0.0.1');await once(server,'listening');
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);data.browser=browser.version();
  }
  for(let pair=0;pair<pairs;pair++)for(const arm of pair%2?['after','before']:['before','after']) {
    let result;
    if(engine==='node') {
      const child=await runFile(process.execPath,[join(root,'proofs/reader-startup-20261112/worker.mjs'),join(runtime,arm),'catalog-map','10000'],{timeout:120000,maxBuffer:1024*1024});
      result=JSON.parse(child.stdout);
    } else {
      result=await page.evaluate(async arm=>{
        const {Peer}=await import(`/${arm}/assets/catalog-peer.mjs`),owner=new Peer(new URL(`/${arm}/assets/feature-owner.mjs`,location.href));
        try {
          await owner.request('prepare',{kind:'shared',readers:2,updateMode:'incremental'});
          const setup=await owner.request('load',{count:10000});
          const first=await owner.request('query'),repeat=await owner.request('query');
          const edit=await owner.request('edit'),updated=await owner.request('query');
          const retained=await owner.request('query',{frozen:true});
          await owner.request('stop');
          return {verified:true,times:{constructionMs:setup.constructionMs,publicationMs:setup.publicationMs,firstQueryMs:first.ms,repeatQueryMs:repeat.ms,updateMs:edit.updateMs,editPublicationMs:edit.publicationMs,updatedQueryMs:updated.ms,retainedQueryMs:retained.ms},
            verification:[first,repeat,updated,retained].map(x=>({lookup:x.answer.lookup.fingerprint,validation:x.answer.validation.fingerprint,found:x.answer.lookup.found,missing:x.answer.lookup.missing,verifiedReplies:x.verifiedReplies}))};
        } finally{owner.close();}
      },arm);
    }
    data.rows.push({pair,arm,...result});save();
    console.log(`${engine} pair ${pair} ${arm}: first=${result.times.firstQueryMs.toFixed(3)} ms`);
  }
  data.completedAt=new Date().toISOString();save();
}catch(error){data.error=error.stack;save();throw error;}
finally{await browser?.close();if(server){server.closeAllConnections();server.close();}}
