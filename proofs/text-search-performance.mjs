/** End-to-end text-search proof against PR13 before compiled byte matching.
 * All four architectures keep identical data, predicates, task yields, workers,
 * output verification and sample counts. Fixture variants are diagnostic only.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'proofs/results/text-search'); mkdirSync(out, { recursive: true });
const median = values => { const a = [...values].sort((a,b)=>a-b), i=a.length>>1; return a.length%2?a[i]:(a[i-1]+a[i])/2; };
const repetitions = Number(process.env.TEXT_PERF_REPEATS ?? 3);
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const types = { '.mjs':'text/javascript', '.js':'text/javascript', '.html':'text/html', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
function server(folder) {
  return createServer((req,res)=>{
    try {
      let p=resolve(folder,'.'+new URL(req.url,'http://localhost').pathname);
      if(p!==folder&&!p.startsWith(folder+sep)) {res.writeHead(403).end();return;}
      if(statSync(p).isDirectory())p=resolve(p,'index.html');
      res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
      res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',types[extname(p)]??'application/octet-stream');res.end(readFileSync(p));
    }catch{res.writeHead(404).end();}
  });
}
function fixture(folder,kind,variant) {
  const destination=resolve(root,'.text-search-baseline',`${variant}-${kind}`);
  cpSync(folder,destination,{recursive:true});
  const visit=dir=>{
    for(const item of readdirSync(dir,{withFileTypes:true})) {
      const p=resolve(dir,item.name);
      if(item.isDirectory())visit(p);
      else if(item.name==='explorer-core.mjs'&&kind!=='repeated') {
        const text=readFileSync(p,'utf8'),token='n % 240, message };';
        assert.ok(text.includes(token),'Revisit fixture adaptation if generation changes');
        const suffix=kind==='unicode' ? "message: (index % 5 === 0 ? '追跡 ' : '') + message + ' [event ' + index + ']' };" : "message: message + ' [event ' + index + ']' };";
        writeFileSync(p,text.replace(token,'n % 240, '+suffix));
      } else if(item.name==='explorer-bench-runner.mjs'&&kind==='unique-miss') {
        const text=readFileSync(p,'utf8');assert.ok(text.includes("{ term: 'request' }"));
        writeFileSync(p,text.replace("{ term: 'request' }","{ term: 'not-present' }"));
      }
    }
  };visit(destination);return destination;
}
const variants=[];
for(const kind of ['repeated','unique','unique-miss','unicode'])for(const [variant,folder]of Object.entries({before:resolve(root,'.text-search-baseline/website/_site'),after:resolve(root,'website/_site')})) {
  const dir=fixture(folder,kind,variant),s=server(dir);s.listen(0,'127.0.0.1');await once(s,'listening');
  variants.push({kind,variant,dir,server:s,origin:`http://127.0.0.1:${s.address().port}`});
}
const runs=[];
try {
  for(const [engine,browserType]of Object.entries({chromium,webkit})) {
    const browser=await browserType.launch({headless:true});
    try {
      for(let repeat=0;repeat<repetitions;repeat++)for(const kind of ['repeated','unique','unique-miss','unicode']) {
        const order=variants.filter(x=>x.kind===kind);if(repeat%2)order.reverse();
        for(const v of order) {
          const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
          try {
            await page.goto(v.origin+'/investigation-benchmark/');
            const result=await page.evaluate(async()=>{
              if(!crossOriginIsolated)throw Error('Not isolated');
              const {Peer}=await import('./assets/explorer-peer.mjs');
              const peer=new Peer(new URL('./assets/explorer-bench-runner.mjs',location.href));
              try{return await peer.request('run',{entries:100000},180000);}finally{peer.close();}
            });
            assert.equal(result.raw.length,28);assert.deepEqual(Object.keys(result.samples).sort(),['centralized','immutable','replicated','shared']);
            for(const phases of Object.values(result.samples))for(const values of Object.values(phases))assert.ok(values.length===7&&values.every(x=>Number.isFinite(x)&&x>=0));
            assert.deepEqual(errors,[]);
            const source=JSON.parse(readFileSync(resolve(v.dir,'build.json'),'utf8')).sourceCommit;
            const record={engine,browserVersion:browser.version(),variant:v.variant,fixture:kind,repeat,source,...result};
            runs.push(record);writeFileSync(resolve(out,`${engine}-${kind}-${v.variant}-${repeat}.json`),JSON.stringify(record,null,2));
            console.log(engine,kind,v.variant,repeat,JSON.stringify(Object.fromEntries(Object.entries(result.samples).map(([p,phases])=>[p,Object.fromEntries(Object.entries(phases).map(([k,a])=>[k,median(a)]))]))));
          } finally {await context.close();}
        }
      }
    }finally{await browser.close();}
  }
  const groups=new Map();
  for(const run of runs)for(const sample of run.raw) {
    const identity={engine:run.engine,fixture:run.fixture,variant:run.variant,path:sample.path,query:sample.query};const key=JSON.stringify(identity);
    if(!groups.has(key))groups.set(key,{...identity,samples:[]});
    groups.get(key).samples.push({repeat:run.repeat,queryMs:sample.queryMs,updateMs:sample.updateMs,initialMs:sample.initialMs});
  }
  for(const group of groups.values())group.medians=Object.fromEntries(['initialMs','queryMs','updateMs'].map(k=>[k,median(group.samples.map(s=>s[k]))]));
  writeFileSync(resolve(out,'by-query.json'),JSON.stringify([...groups.values()],null,2));
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify({schema:'zerocopy-text-search-proof/v1',repetitions,runCount:runs.length,records:runs.reduce((n,r)=>n+r.raw.length,0),note:'Baseline is PR13 before compiled text search. Both use the same 4096-index task yields, bulk appends, field/row layout and unchanged Immutable.js. Query preparation is timed. Actual four-architecture worker benchmark; full independent reference checks. Original, unique IDs, absent ASCII text and 20% Unicode-prefix diagnostics run for every architecture. No precomputed index, decoded dataset cache or artificial delay. No universal performance threshold; retain losing cases.'},null,2));
}finally{for(const v of variants){v.server.closeAllConnections();await new Promise(r=>v.server.close(r));}}
