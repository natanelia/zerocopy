import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const mode=process.argv[2],workload=process.argv[3];
const configs={
  'number-64':['number',64], 'number-1024':['number',1024],
  'number-8192':['number',8192], 'number-16384':['number',16384],
  'string-4096':['string',4096],
};
if(!['before','after'].includes(mode)||!(workload in configs))throw new Error('Unknown workload');
const [type,size]=configs[workload];
const entry=resolve(process.cwd(),'dist/shared.js');
const {SharedMap}=await import(pathToFileURL(entry).href);
const values=Array.from({length:size},(_,i)=>['feature-'+i,type==='number'?(i*37)%1129:'value-'+i]);
const map=new SharedMap(type).setMany(values);
if(map.size!==size)throw new Error('Incorrect Map cardinality');
const make=mode==='before'?()=>Array.from(map.entries()):()=>map.toEntriesArray();
const initial=make();
const expected=[...map.entries()];
if(initial.length!==expected.length)throw new Error('Incomplete Map output');
for(let i=0;i<initial.length;i++){
  if(initial[i][0]!==expected[i][0] || !Object.is(initial[i][1],expected[i][1]))
    throw new Error('Unexpected traversal order or value at '+i);
}
let sink=0;
function run(repeats){
  let last, checksum=0;
  for(let i=0;i<repeats;i++){
    last=make();
    for(let j=0;j<last.length;j++)checksum+=last[j][0].length
      +(type==='number'?last[j][1]:last[j][1].length);
  }
  sink=checksum;
  return last;
}
const expectedChecksum=expected.reduce((sum,[key,value])=>sum+key.length+(type==='number'?value:value.length),0);
function timed(repeats){
  const start=performance.now(),out=run(repeats);
  const duration=performance.now()-start;
  if(sink!==expectedChecksum*repeats)throw new Error('Invalid checksum');
  if(out.length!==expected.length)throw new Error('Wrong output length');
  return duration;
}
const end=performance.now()+250;
while(performance.now()<end)timed(2);
let repeats=1;
while(repeats<8192&&timed(repeats)<20)repeats*=2;
const samplesUs=[];
for(let i=0;i<9;i++)samplesUs.push(timed(repeats)*1000/repeats);
const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
console.log(JSON.stringify({mode,workload,type,size,
 runtime:process.versions.bun?'bun':'node',runtimeVersion:process.versions.bun||process.version,
 sourceSha256:createHash('sha256').update(readFileSync(entry)).digest('hex'),
 checksum:expectedChecksum,repeats,estimateUs:median(samplesUs),samplesUs}));
