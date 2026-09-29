import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? 'proofs/results/map-set.json');
const baseline = process.argv[3] ? resolve(process.argv[3]) : undefined;
const bun = process.env.BUN_BIN ?? 'bun';
const cases = ['build.string', 'build.number', 'build.unicode', 'build.long-prefix', 'overwrite.string', 'overwrite.number', 'overwrite.after-read', 'forks.set', 'mixed.set-get-has', 'build.first-use'];
const hash = b => createHash('sha256').update(b).digest('hex');
function source(dir) {
 const files = readdirSync(dir).filter(f=>f.endsWith('.ts')&&!f.endsWith('.test.ts')).sort();
 const h=createHash('sha256');for(const f of files)h.update(f+'\0').update(readFileSync(join(dir,f))).update('\0');
 return {sha256:h.digest('hex'),wasmSHA256:hash(readFileSync(join(dir,'persistent-core.wasm'))),files};
}
const sources={shared:source(root), ...(baseline?{baseline:source(baseline)}:{})};
mkdirSync(dirname(output),{recursive:true});
const records=[];
if(process.env.RESUME === '1' && existsSync(output+'.partial')) {
 const saved=JSON.parse(readFileSync(output+'.partial','utf8'));
 assert.deepEqual(saved.sources,sources,'Source changed since checkpoint');records.push(...saved.records);
}
for(let round=0;round<3;round++){
 const variants=baseline?['shared','immutable','baseline','native']:['shared','immutable','native'];
 for(const scenario of cases) for(let index=0;index<variants.length;index++){
  const variant=variants[(index+round)%variants.length],cwd=variant==='baseline'?baseline:root;
  if(records.some(r=>r.round===round+1&&r.variant===variant&&r.scenario===scenario))continue;
  const env={...process.env,MAP_CASE:scenario,MAP_KIND:variant==='baseline'?'shared':variant,SAMPLES:'15'};
  const p=spawnSync(bun,['proofs/map-set.ts'],{cwd,env,encoding:'utf8',maxBuffer:32*1024*1024});
  if(p.status!==0)throw Error(`${scenario}/${variant}: ${p.stderr}\n${p.stdout}`);
  records.push({round:round+1,variant,...JSON.parse(p.stdout)});
  console.error(`${round+1}: ${scenario} ${variant} checked`);
  writeFileSync(output+'.partial',JSON.stringify({sources,records}));
 }
 writeFileSync(output+'.partial',JSON.stringify({sources,records}));
}
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const summary=cases.map(scenario=>{
 const get=(variant,field)=>records.filter(r=>r.scenario===scenario&&r.variant===variant).flatMap(r=>r[field]);
 const sharedMs=median(get('shared','samplesMs')),immutableMs=median(get('immutable','samplesMs')),nativeMs=median(get('native','samplesMs'));
 const result={scenario,sharedMs,immutableMs,nativeMs,versusImmutable:immutableMs/sharedMs,allocatedBytes:median(get('shared','allocatedBytes'))};
 if(baseline){
  const baselineMs=median(get('baseline','samplesMs'));Object.assign(result,{baselineMs,versusBaseline:baselineMs/sharedMs});
  for(let round=1;round<=3;round++){
   const old=records.find(r=>r.round===round&&r.scenario===scenario&&r.variant==='baseline'),now=records.find(r=>r.round===round&&r.scenario===scenario&&r.variant==='shared');
   assert.deepEqual(now.allocatedBytes,old.allocatedBytes,`${scenario}: allocation changed`);
   assert.equal(now.payloadSHA256,old.payloadSHA256,`${scenario}: published bytes changed`);
  }
  result.identicalPublishedBytes=true;
 }
 return result;
});
assert.equal(source(root).sha256,sources.shared.sha256,'Source changed during measurements');
writeFileSync(output,JSON.stringify({measuredAt:new Date().toISOString(),sources,benchmarkSHA256:hash(readFileSync(join(root,'proofs/map-set.ts'))),samplesPerCell:45,summary,records})+'\n');
rmSync(output+'.partial',{force:true});
console.log(JSON.stringify(summary,null,2));
