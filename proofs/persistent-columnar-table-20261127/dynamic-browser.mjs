import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {cpus} from 'node:os';
import {chromium,firefox} from 'playwright';
const [output='dynamic-results.json',engine='chromium',size='4096',roundsArg='5',revisionsArg='96',retentionArg='2',pattern='spread']=process.argv.slice(2),n=Number(size),rounds=Number(roundsArg),revisions=Number(revisionsArg),retention=Number(retentionArg);
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
const url='http://127.0.0.1:'+server.address().port,report={engine,n,rounds,revisions,retention,pattern,cpu:cpus()[0]?.model,rows:[]};
const profile=process.argv[9]==='mixed-profile';
const scale=profile||process.argv[9]==='mixed-scale';
const modes=profile?['schema-mixed-packed-bulk','schema-mixed-packed-bulk-control','schema-mixed-packed-bulk-profile','schema-mixed-packed-bulk-profile-control']:scale?['json-mixed-direct','json-mixed-control','schema-mixed-packed-bulk','schema-mixed-packed-bulk-control']:process.argv[9]==='mixed'?['json-mixed-direct','json-mixed-control','schema-mixed-packed','schema-mixed-packed-control','schema-mixed-packed-bulk','schema-mixed-packed-bulk-control']:['json-direct','append','append-predicate','schema-append','schema-append-control','schema-packed'];
try{
  for(let round=-1;round<rounds;round++){
    const offset=(round+1)%modes.length;
    const order=scale?([-1,0,1,2,3].includes(round)?(round<0?[0,1,2,3]:[[0,1,2,3],[3,2,1,0],[2,3,0,1],[1,0,3,2]][round]).map(i=>modes[i]):null):[...modes.slice(offset),...modes.slice(0,offset)];
    if(!order)throw Error('scale proof requires exactly four measured rounds');
    if(!scale&&round%2===1)order.reverse();
    for(const mode of order){
      const browser=await launcher.launch({headless:true});
      try{
        report.version=browser.version();
        const page=await browser.newPage();await page.goto(url);
        const result=await page.evaluate(async({dir,mode,n,revisions,retention,pattern})=>(await import(dir+'/dynamic-page.mjs')).run(mode,n,revisions,retention,pattern),{dir,mode,n,revisions,retention,pattern});
        assert(result.verified);result.round=round;report.rows.push(result);writeFileSync(output,JSON.stringify(report));
        const {events,digests,attribution,...summary}=result;
        if(attribution){
          const stages=['validateLookupMs','sizePayloadMs','planMs','applyColumnsMs','indexMs'];
          const sum=(a,f)=>a.reduce((n,x)=>n+f(x),0);
          const aggregate=group=>({stages:Object.fromEntries(stages.map(k=>[k,sum(group,e=>e.edit[k])])),columns:Object.fromEntries(Object.keys(group[0].edit.columns).map(k=>[k,{ms:sum(group,e=>e.edit.columns[k].ms),patch:sum(group,e=>e.edit.columns[k].patch),append:sum(group,e=>e.edit.columns[k].append)}])),points:{lookupMs:sum(group,e=>sum(e.points,x=>x.lookupMs)),materializeMs:sum(group,e=>sum(e.points,x=>x.materializeMs)),count:sum(group,e=>sum(e.points,x=>x.count)),hits:sum(group,e=>sum(e.points,x=>x.hits))}});
          summary.attribution={bulk:aggregate(attribution.bulk),sparse:aggregate(attribution.sparse)};
        }
        console.log(JSON.stringify(summary));await page.close();
      }finally{await browser.close();}
    }
  }
}finally{server.close();}
