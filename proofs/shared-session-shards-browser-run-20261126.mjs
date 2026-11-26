import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium,firefox} from 'playwright';
const [name,out]=process.argv.slice(2);assert(out&&['chromium','firefox'].includes(name));
const root=resolve('.');
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cache-Control','no-store');
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Shared shard proof</title>');return;}
  const path=resolve(root,'.'+pathname);assert(path.startsWith(root+sep));
  res.setHeader('Content-Type',extname(path)==='.wasm'?'application/wasm':'text/javascript');res.end(await readFile(path));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
 browser=await ({chromium,firefox}[name]).launch();
 const cases=[[1000,1,'one'],[10000,8,'distinct'],[100000,64,'one'],[100000,64,'distinct'],[100000,64,'dense'],[100000,64,'sparse-all']];
 const report={browser:name,version:browser.version(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),base:'84ad23a76ee197f45cbc7316017f28b5bbe93d6c',candidateSource:'26e39645f69904ab7976758b7370334a8ead3e99',hashes:{},cases,measuredPairs:8,samples:[],complete:false};
 for(const p of ['arena.ts','shared.ts','worker.ts','worker-protocol.ts','persistent-core.wasm','website/assets/catalog-core.mjs','proofs/shared-session-shards-browser-case-20261126.mjs','baseline-dist/shared.js','baseline-dist/worker.js','control-dist/shared.js','control-dist/worker.js','dist/shared.js','dist/worker.js'])report.hashes[p]=createHash('sha256').update(await readFile(p)).digest('hex');
 for(const p of ['shared.js','worker.js'])assert.equal(report.hashes['baseline-dist/'+p],report.hashes['control-dist/'+p]);
 async function sample(n,count,layout,pair,arm,bundle){
  const page=await browser.newPage();
  try{
   await page.goto('http://127.0.0.1:'+server.address().port);
   const row=await page.evaluate(async args=>(await import('/proofs/shared-session-shards-browser-case-20261126.mjs')).sample(...args),[n,count,layout,pair,arm,bundle]);
   assert(row.verified&&row.rows.length===8&&row.arm===arm&&row.pair===pair);
   for(const group of [row.initialReaders,...row.rows.map(x=>x.readers)])assert.equal(group.length,2);
   report.samples.push(row);console.log(JSON.stringify(row));await writeFile(out,JSON.stringify(report));
  }finally{await page.close();}
 }
 for(let pair=-1;pair<report.measuredPairs;pair++)for(const [n,count,layout] of (pair%2===0?cases:cases.slice().reverse())){
  const arms=[['base','baseline-dist'],['candidate','dist'],['aa-base','baseline-dist'],['aa-control','control-dist']];
  for(const [arm,bundle] of (pair%2===0?arms:arms.slice().reverse()))await sample(n,count,layout,pair,arm,bundle);
 }
 for(const [n,count,layout] of cases.filter(([n,count,layout])=>n===100000&&count===64&&layout!=='one')){
  await sample(n,count,layout,-2,'profile-base','baseline-dist');await sample(n,count,layout,-2,'profile-candidate','dist');
 }
 report.complete=true;await writeFile(out,JSON.stringify(report));
}finally{try{await browser?.close();}finally{await new Promise(r=>server.close(r));}}
