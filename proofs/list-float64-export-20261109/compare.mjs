import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = resolve(process.argv[2] || '');
const candidate = resolve(process.argv[3] || '');
if (!baseline || !candidate || baseline === candidate) throw new Error('Pass distinct baseline and candidate directories');
const script = resolve(dirname(fileURLToPath(import.meta.url)), 'case.mjs');
const sizes = [32, 1024, 65536, 262144], runtimes = ['node', 'bun'], PAIRS = 6;
const criticalT = 2.571; // Student's t, five degrees of freedom, 95% two-sided
const results = {baseCommit:'a4265a0608ec25eec5719496225212db6b251989', baseline,candidate,
  runner:process.platform+'-'+process.arch, pairs:PAIRS, cases:[], identicalControls:[]};
function run(which, runtime, size) {
  const cwd = which === 'baseline' ? baseline : candidate;
  const mode = which === 'baseline' ? 'before' : 'after';
  const p = spawnSync(runtime, [script, mode, String(size)], {cwd,encoding:'utf8',timeout:90000,
    maxBuffer:1048576,env:{...process.env,NODE_ENV:'production'}});
  if (p.error || p.status!==0) throw new Error(JSON.stringify({which,runtime,size,status:p.status,
    error:String(p.error??''),out:p.stdout?.slice(-1400),err:p.stderr?.slice(-1600)}));
  const x=JSON.parse(p.stdout.trim().split('\n').at(-1));
  if (x.mode!==mode || x.size!==size || x.runtime!==runtime ||
      x.samplesUs.length!==9 || x.samplesUs.some(v=>!Number.isFinite(v)||v<=0))
    throw new Error('Invalid measurement');
  return x;
}
function stats(pairs) {
  const logs = pairs.map(p=>Math.log(p.after.estimateUs/p.before.estimateUs));
  const mean=logs.reduce((a,b)=>a+b,0)/logs.length;
  const sd=Math.sqrt(logs.reduce((a,b)=>a+(b-mean)**2,0)/(logs.length-1));
  const half=criticalT*sd/Math.sqrt(logs.length);
  const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
  return {beforeMedianUs:median(pairs.map(p=>p.before.estimateUs)),
    afterMedianUs:median(pairs.map(p=>p.after.estimateUs)),
    geometricRatio:Math.exp(mean), confidence95:[Math.exp(mean-half),Math.exp(mean+half)],
    fasterPairs:logs.filter(x=>x<0).length};
}
for (const runtime of runtimes) for (const size of sizes) {
  const pairs=[];
  for(let i=0;i<PAIRS;i++){
    const order=i%2?['candidate','baseline']:['baseline','candidate'];
    const record={};
    for(const which of order)record[which]=run(which,runtime,size);
    if(record.baseline.checksum!==record.candidate.checksum ||
       record.baseline.sourceSha256===record.candidate.sourceSha256)
      throw new Error('Not comparing distinct builds with identical outputs');
    pairs.push({before:record.baseline,after:record.candidate});
  }
  const row={runtime,size,stats:stats(pairs),pairs};results.cases.push(row);
  console.log([runtime,size+' numbers',row.stats.beforeMedianUs.toFixed(2)+'us',
    row.stats.afterMedianUs.toFixed(2)+'us',(100*(1-row.stats.geometricRatio)).toFixed(1)+'% faster',
    'ratio CI '+row.stats.confidence95.map(x=>x.toFixed(3)).join('..'),
    row.stats.fasterPairs+'/'+PAIRS+' pairs faster'].join(' | '));
}
for(const runtime of runtimes)for(const size of [1024,65536]){
  const pairs=[];
  for(let i=0;i<PAIRS;i++){
    // Identical candidate code, measured twice. No A/A correction applied.
    const before=run('candidate',runtime,size),after=run('candidate',runtime,size);
    if(before.sourceSha256!==after.sourceSha256 || before.checksum!==after.checksum)
      throw new Error('Invalid identical-build control');
    pairs.push({before,after});
  }
  const row={runtime,size,stats:stats(pairs),pairs};results.identicalControls.push(row);
  console.log(['A/A',runtime,size,row.stats.geometricRatio.toFixed(3),
    'CI '+row.stats.confidence95.map(x=>x.toFixed(3)).join('..')].join(' | '));
}
writeFileSync('proofs/list-float64-export-20261109/results.json',JSON.stringify(results,null,2)+'\n');
console.log('Saved '+results.cases.length+' A/B workloads and '+results.identicalControls.length+' A/A controls.');
