import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium,firefox} from 'playwright';
const [browserName,output]=process.argv.slice(2);assert(output&&['chromium','firefox'].includes(browserName));
const root=resolve('.');
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cache-Control','no-store');
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Retained compaction proof</title>');return;}
  const path=resolve(root,'.'+pathname);assert(path.startsWith(root+sep));
  res.setHeader('Content-Type','text/javascript');res.end(await readFile(path));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await ({chromium,firefox}[browserName]).launch();
const sha=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const report={browser:browserName,version:browser.version(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),base:'76ab6b53aa0d3b40202720ca12d9fcc904716cf2',candidateSource:'3f8f0d89fb4fa95fec87bcce52ff21c44652fd3d',hashes:{},samples:[]};
for(const p of ['compaction.ts','persistent-core.wasm','baseline-dist/shared.js','control-dist/shared.js','dist/shared.js'])report.hashes[p]=await sha(p);
assert.equal(report.hashes['baseline-dist/shared.js'],report.hashes['control-dist/shared.js']);
try{
 for(const [n,mode] of [[100000,'eight'],[100000,'shuffled'],[100000,'churn'],[100000,'dense-four'],[10000,'eight']]){
  for(const cohort of ['AB','AA']){
   const arms=cohort==='AB'?['base','candidate']:['base','control'];
   for(let pair=-1;pair<(cohort==='AB'?5:3);pair++){
    const rows=[];
    for(const arm of (pair%2===0?arms:arms.slice().reverse())){
     const page=await browser.newPage();
     try{
      await page.goto('http://127.0.0.1:'+server.address().port);
      const row=await page.evaluate(async ({arm,n,mode,fullWorker})=>(await import('/proofs/retained-map-compaction-browser-case.mjs')).run(arm,n,mode,fullWorker),{arm,n,mode,fullWorker:pair===0});
      rows.push({...row,cohort,pair});report.samples.push(rows.at(-1));console.log(JSON.stringify(rows.at(-1)));
      await writeFile(output,JSON.stringify(report));
     }finally{await page.close();}
    }
    assert.deepEqual(rows[0].original,rows[1].original,'source iteration differs');
    assert.deepEqual(rows[0].packed,rows[1].packed,'packed iteration differs');
    assert.equal(rows[0].sourceUsedBytes,rows[1].sourceUsedBytes);
   }
  }
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
