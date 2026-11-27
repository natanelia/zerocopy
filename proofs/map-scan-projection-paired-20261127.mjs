import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [count,shape,build,candidate,output]=process.argv.slice(2);
assert(['1000','10000','100000'].includes(count)&&['flat','nested'].includes(shape));
mkdirSync(output,{recursive:true});
const modes=['view','direct','aa','full'];
const orders=modes.map((_,i)=>[...modes.slice(i),...modes.slice(0,i)]);
orders.push(...orders.map(order=>[...order].reverse()));
const report={count:Number(count),shape,build,candidate,orders,rounds:8,samples:[]};
const trial=fileURLToPath(new URL('./map-scan-projection-trial-20261127.mjs',import.meta.url));
let oracle,sharedOrder;
for(let round=-1;round<8;round++)for(const mode of orders[(round+8)%8]){
  const path=resolve(output,round+'-'+mode+'.json');
  const api=mode==='direct'?'shared-direct':mode==='full'?'shared-forEach':'shared-view';
  const run=spawnSync(process.execPath,[trial,count,'1',path],{env:{...process.env,ZEROCOPY_SCAN_MODE:api,ZEROCOPY_SCAN_SHAPE:shape,ZEROCOPY_SCAN_BUILD:resolve(mode==='direct'?candidate:build),ZEROCOPY_SCAN_PROFILE:'0',ZEROCOPY_SCAN_PREVIOUS:'1'},encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
  if(run.status!==0)throw Error(JSON.stringify({mode,round,status:run.status,error:String(run.error),stderr:run.stderr,stdout:run.stdout}));
  const raw=JSON.parse(readFileSync(path,'utf8')),s=raw.samples[0];
  assert.equal(raw.shape,shape);assert.equal(s.id,api);assert(s.verified);assert(s.points.readers.every(x=>x.verified));
  const phases=['first','repeat','updated','retained'];
  const digests=phases.map(p=>s[p].readers.map(r=>r.scans.map(x=>[x.start,x.count,x.digest])));
  const ordered=phases.map(p=>s[p].readers.map(r=>r.scans.map(x=>x.ordered)));
  if(oracle)assert.deepEqual(digests,oracle);else oracle=digests;
  if(sharedOrder)assert.deepEqual(ordered,sharedOrder);else sharedOrder=ordered;
  const metrics={first:s.first.roundTripMs,repeat:s.repeat.roundTripMs,updated:s.updated.roundTripMs,retained:s.retained.roundTripMs,pointMs:Math.max(...s.points.readers.map(r=>r.ms)),mutation:s.mutationMs,prepareInitial:s.prepareInitialMs,prepareUpdate:s.prepareUpdateMs,peakProcessRssKiB:s.measuredPeakRssKiB};
  report.samples.push({mode,round,cpu:raw.cpu,node:raw.node,source:raw.source,...metrics});
  writeFileSync(resolve(output,'summary.json'),JSON.stringify(report,null,2));
  console.log('PROJECTION_TRIAL '+JSON.stringify({mode,round,...metrics}));
}
const median=xs=>{const a=[...xs].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
for(const mode of ['direct','aa','full']){
  const pairs=Array.from({length:8},(_,round)=>[report.samples.find(x=>x.round===round&&x.mode==='view'),report.samples.find(x=>x.round===round&&x.mode===mode)]);
  const summary=Object.fromEntries(['first','repeat','updated','retained','pointMs','mutation','prepareInitial','prepareUpdate','peakProcessRssKiB'].map(k=>[k,{baseline:median(pairs.map(([a])=>a[k])),other:median(pairs.map(([,b])=>b[k])),pairedRatio:median(pairs.map(([a,b])=>b[k]/a[k])),wins:pairs.filter(([a,b])=>b[k]<a[k]).length}]));
  console.log('PROJECTION_SUMMARY '+JSON.stringify({count,shape,mode,summary}));
}
