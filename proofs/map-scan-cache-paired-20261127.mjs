import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [count, buildRoot, output] = process.argv.slice(2);
assert(['1000','10000','100000'].includes(count));
mkdirSync(output,{recursive:true});
const orders=[['base','mid','aa','high'],['mid','high','base','aa'],['aa','base','high','mid'],['high','aa','mid','base']];
const report={count:Number(count),orders,warmupRounds:1,measuredRounds:8,samples:[]};
const driver=fileURLToPath(new URL('./map-scan-cache-trial-20261127.mjs',import.meta.url));
for(let round=-1;round<8;round++){
  for(const mode of orders[(round+4)%4]){
    const build=resolve(buildRoot,mode==='aa'?'base':mode,'shared.js');
    const file=resolve(output,round+'-'+mode+'.json');
    const run=spawnSync(process.execPath,[driver,count,'1',file],{env:{...process.env,ZEROCOPY_SCAN_PROFILE:'0',ZEROCOPY_SCAN_BUILD:build},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
    if(run.status!==0) throw Error(JSON.stringify({mode,round,status:run.status,error:String(run.error),stderr:run.stderr,stdout:run.stdout}));
    const raw=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(raw.runtimeBuild,build);assert.equal(raw.samples.length,1);
    const s=raw.samples[0];assert(s.verified);assert(s.points.readers.every(x=>x.verified));
    const fingerprints=Object.fromEntries(['first','repeat','updated','retained'].map(p=>[p,s[p].readers.map(r=>r.scans.map(x=>[x.start,x.count,x.digest,x.ordered]))]));
    if(report.samples.length)assert.deepEqual(fingerprints,report.samples[0].fingerprints);
    const result={mode,round,warmup:round<0,source:raw.source,node:raw.node,cpu:raw.cpu,fingerprints,first:s.first.roundTripMs,repeat:s.repeat.roundTripMs,updated:s.updated.roundTripMs,retained:s.retained.roundTripMs,pointMs:Math.max(...s.points.readers.map(r=>r.ms)),heaps:Object.fromEntries(['first','repeat','updated','retained','points'].map(p=>[p,s[p].readers.map(r=>r.heapUsed)])),rss:Object.fromEntries(['first','repeat','updated','retained','points'].map(p=>[p,s[p].rss])),peakProcessRssKiB:s.peakProcessRssKiB};
    report.samples.push(result);
    writeFileSync(resolve(output,'summary.json'),JSON.stringify(report,null,2));
    console.log('CACHE_TRIAL '+JSON.stringify({...result,fingerprints:undefined}));
  }
}
const median=xs=>{const s=[...xs].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
for(const mode of ['aa','mid','high']){
  const pairs=Array.from({length:8},(_,round)=>[report.samples.find(x=>x.round===round&&x.mode==='base'),report.samples.find(x=>x.round===round&&x.mode===mode)]);
  const summary=Object.fromEntries(['first','repeat','updated','retained','pointMs','peakProcessRssKiB'].map(k=>[k,{base:median(pairs.map(([a])=>a[k])),candidate:median(pairs.map(([,b])=>b[k])),pairedRatio:median(pairs.map(([a,b])=>b[k]/a[k]))}]));
  console.log('CACHE_SUMMARY '+JSON.stringify({mode,summary}));
}
