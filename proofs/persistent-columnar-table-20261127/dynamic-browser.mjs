import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {cpus} from 'node:os';
import {chromium,firefox} from 'playwright';
const [output='dynamic-results.json',engine='chromium',size='4096',roundsArg='5']=process.argv.slice(2),n=Number(size),rounds=Number(roundsArg);
const launcher={chromium,firefox}[engine];assert(launcher);
const root=resolve('.'),dir='/proofs/persistent-columnar-table-20261127';
const server=createServer((req,res)=>{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cache-Control','no-store');
  try{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    if(path==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><title>Dynamic lane storage proof</title>');}
    if(!path.startsWith(dir+'/')&&!path.startsWith('/dist/'))return res.writeHead(404).end();
    const file=resolve(root,'.'+path);if(!file.startsWith(root+sep)||!/\.(?:mjs|js)$/.test(file))return res.writeHead(404).end();
    res.setHeader('Content-Type','text/javascript');res.end(readFileSync(file));
  }catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port,report={engine,n,rounds,cpu:cpus()[0]?.model,rows:[]};
const modes=['json-direct','append','reuse-slots','reuse-span','reuse-span-control','native'];
try{
  for(let round=-1;round<rounds;round++){
    const offset=(round+1)%modes.length,order=[...modes.slice(offset),...modes.slice(0,offset)];if(round%2===1)order.reverse();
    for(const mode of order){
      const browser=await launcher.launch({headless:true});
      try{
        report.version=browser.version();
        const page=await browser.newPage();await page.goto(url);
        const result=await page.evaluate(async({dir,mode,n})=>(await import(dir+'/dynamic-page.mjs')).run(mode,n),{dir,mode,n});
        assert(result.verified);result.round=round;report.rows.push(result);writeFileSync(output,JSON.stringify(report));
        const {events,digests,...summary}=result;console.log(JSON.stringify(summary));await page.close();
      }finally{await browser.close();}
    }
  }
}finally{server.close();}
