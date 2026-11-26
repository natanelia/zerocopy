import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium,firefox} from 'playwright';
const [browserName,out]=process.argv.slice(2);assert(out&&['chromium','firefox'].includes(browserName));
const root=resolve('.');
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cache-Control','no-store');
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Copied publication proof</title>');return;}
  const path=resolve(root,'.'+pathname);assert(path.startsWith(root+sep));
  res.setHeader('Content-Type',extname(path)==='.wasm'?'application/wasm':'text/javascript');res.end(await readFile(path));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await ({chromium,firefox}[browserName]).launch();
const report={browser:browserName,version:browser.version(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),base:'d57fc413ee5f67d0839f5a3a8ff36f4a51fb0341',candidateSource:'8a442515a358500c30d25c2f4f63fc3b703f4323',hashes:{},samples:[]};
for(const p of ['worker.ts','worker-protocol.ts','shared.ts','arena.ts','persistent-core.wasm','baseline-dist/shared.js','baseline-dist/worker.js','control-dist/shared.js','control-dist/worker.js','dist/shared.js','dist/worker.js'])report.hashes[p]=createHash('sha256').update(await readFile(p)).digest('hex');
assert.equal(report.hashes['baseline-dist/shared.js'],report.hashes['control-dist/shared.js']);assert.equal(report.hashes['baseline-dist/worker.js'],report.hashes['control-dist/worker.js']);
try{
 for(const n of [1000,10000,100000])for(let pair=-1;pair<5;pair++){
  const cohorts=['AB','AA','default','shared'];
  for(const cohort of (pair%2===0?cohorts:cohorts.slice().reverse())){
   const arms=cohort==='AB'?[['base-copy','baseline-dist'],['candidate-transfer','dist']]:cohort==='AA'?[['base-copy','baseline-dist'],['control-copy','control-dist']]:cohort==='default'?[['base-copy','baseline-dist'],['candidate-copy','dist']]:[['base-shared','baseline-dist'],['candidate-shared','dist']];
   for(const [arm,bundle] of (pair%2===0?arms:arms.slice().reverse())){
    const page=await browser.newPage();
    try{
     await page.goto('http://127.0.0.1:'+server.address().port);
     const row=await page.evaluate(async args=>(await import('/proofs/copied-session-browser-case-20261126.mjs')).sample(...args),[n,cohort,pair,arm,bundle]);
     report.samples.push(row);console.log(JSON.stringify(row));await writeFile(out,JSON.stringify(report));
    }finally{await page.close();}
   }
  }
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
