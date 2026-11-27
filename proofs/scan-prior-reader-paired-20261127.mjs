import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [count, buildRoot, output] = process.argv.slice(2);
assert(['10000','100000'].includes(count));
mkdirSync(output,{recursive:true});
const modes=['base','prior','large','largePrior','aa'];
const rotations=modes.map((_,i)=>[...modes.slice(i),...modes.slice(0,i)]);
const orders=[...rotations,...rotations.map(x=>[...x].reverse())];
const largeBuild=count==='10000'?'mid':'high';
const report={count:Number(count),orders,warmupRounds:1,measuredRounds:10,largeBuild,samples:[]};
const driver=fileURLToPath(new URL('./scan-prior-reader-trial-20261127.mjs',import.meta.url));
for(let round=-1;round<10;round++){
  for(const mode of orders[(round+10)%10]){
    const build=resolve(buildRoot,mode.startsWith('large')?largeBuild:'base','shared.js');
    const reusePrevious=['prior','largePrior','aa'].includes(mode);
    const file=resolve(output,round+'-'+mode+'.json');
    const run=spawnSync(process.execPath,[driver,count,'1',file],{env:{...process.env,ZEROCOPY_SCAN_PROFILE:'0',ZEROCOPY_SCAN_PREVIOUS:reusePrevious?'1':'0',ZEROCOPY_SCAN_BUILD:build},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
    if(run.status!==0) throw Error(JSON.stringify({mode,round,status:run.status,error:String(run.error),stderr:run.stderr,stdout:run.stdout}));
    const raw=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(raw.runtimeBuild,build);assert.equal(raw.reusePrevious,reusePrevious);assert.equal(raw.samples.length,1);
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
for(const [control,mode] of [['prior','aa'],['base','prior'],['large','largePrior'],['prior','largePrior']]){
  const pairs=Array.from({length:10},(_,round)=>[report.samples.find(x=>x.round===round&&x.mode===control),report.samples.find(x=>x.round===round&&x.mode===mode)]);
  const summary=Object.fromEntries(['first','repeat','updated','retained','pointMs','peakProcessRssKiB'].map(k=>[k,{base:median(pairs.map(([a])=>a[k])),candidate:median(pairs.map(([,b])=>b[k])),pairedRatio:median(pairs.map(([a,b])=>b[k]/a[k]))}]));
  console.log('CACHE_SUMMARY '+JSON.stringify({control,mode,summary}));
}
