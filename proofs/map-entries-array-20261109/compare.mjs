import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const baseline=resolve(process.argv[2]||'');
const candidate=resolve(process.argv[3]||'');
if(!baseline||!candidate||baseline===candidate)throw new Error('Pass different build paths');
const file=resolve(dirname(fileURLToPath(import.meta.url)),'case.mjs');
const cases=['number-64','number-1024','number-8192','number-16384','string-4096'];
const PAIRS=6,criticalT=2.571;
const data={baselineCommit:'1f6d5bdd114217e8405f0518abfa7612d7db0cd9',
  baseline,candidate,runner:process.platform+'-'+process.arch,pairs:PAIRS,results:[],controls:[]};
function run(mode,runtime,workload){
  const cwd=mode==='before'?baseline:candidate;
  const p=spawnSync(runtime,[file,mode,workload],
    {cwd,encoding:'utf8',timeout:90000,maxBuffer:1048576,env:{...process.env,NODE_ENV:'production'}});
  if(p.error||p.status!==0)throw new Error(JSON.stringify({mode,runtime,workload,
    status:p.status,error:String(p.error||''),stderr:p.stderr?.slice(-2000),stdout:p.stdout?.slice(-2000)}));
  const x=JSON.parse(p.stdout.trim().split('\n').at(-1));
  if(x.mode!==mode||x.runtime!==runtime||x.workload!==workload||x.samplesUs.length!==9
   ||x.samplesUs.some(v=>!Number.isFinite(v)||v<=0))throw new Error('Invalid child record');
  return x;
}
function stats(pairs){
  const logs=pairs.map(x=>Math.log(x.after.estimateUs/x.before.estimateUs));
  const mean=logs.reduce((a,b)=>a+b)/logs.length;
  const sd=Math.sqrt(logs.reduce((a,b)=>a+(b-mean)**2,0)/(logs.length-1));
  const half=criticalT*sd/Math.sqrt(logs.length);
  const med=arr=>[...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)];
  return {beforeMedianUs:med(pairs.map(x=>x.before.estimateUs)),
    afterMedianUs:med(pairs.map(x=>x.after.estimateUs)),ratio:Math.exp(mean),
    ci95:[Math.exp(mean-half),Math.exp(mean+half)],fasterPairs:logs.filter(x=>x<0).length};
}
for(const runtime of ['node','bun'])for(const workload of cases){
  const pairs=[];
  for(let n=0;n<PAIRS;n++){
    const order=n%2?['after','before']:['before','after'];
    const pair={};
    for(const m of order)pair[m]=run(m,runtime,workload);
    if(pair.before.checksum!==pair.after.checksum||pair.before.size!==pair.after.size||
       pair.before.sourceSha256===pair.after.sourceSha256)throw new Error('Non-identical fixtures or builds');
    pairs.push(pair);
  }
  const row={runtime,workload,stats:stats(pairs),pairs};
  data.results.push(row);
  console.log([runtime,workload,row.stats.beforeMedianUs.toFixed(2)+'us',
    row.stats.afterMedianUs.toFixed(2)+'us',(100*(1-row.stats.ratio)).toFixed(1)+'% faster',
    '95% ratio CI '+row.stats.ci95.map(x=>x.toFixed(3)).join('..'),
    row.stats.fasterPairs+'/'+PAIRS].join(' | '));
}
for(const runtime of ['node','bun'])for(const workload of ['number-8192','string-4096']){
  const pairs=[];
  for(let n=0;n<PAIRS;n++){
    const x=run('after',runtime,workload),y=run('after',runtime,workload);
    if(x.sourceSha256!==y.sourceSha256||x.checksum!==y.checksum)throw new Error('Invalid A/A record');
    pairs.push({before:x,after:y});
  }
  const row={runtime,workload,stats:stats(pairs),pairs};
  data.controls.push(row);
  console.log(['A/A',runtime,workload,'ratio='+row.stats.ratio.toFixed(3),
    '95% CI '+row.stats.ci95.map(x=>x.toFixed(3)).join('..')].join(' | '));
}
writeFileSync('proofs/map-entries-array-20261109/results.json',JSON.stringify(data,null,2)+'\n');
console.log('Saved '+data.results.length+' workloads and '+data.controls.length+' controls');
