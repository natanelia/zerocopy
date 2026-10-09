import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {CASES,CONFIG,ROLES,STEP_BUDGETS,schedule,freezeWork,interval,summarizeRow,decision} from './protocol.mjs';
import {executePlan} from './controller.mjs';
import {preparePackages,expectedCommands} from './gate.mjs';
import {HERE,REPO,pins,sourceCheck,verifyHarness,requireCI,readJson,hash} from './support.mjs';
function synthetic(factors={main:1,candidate:.9,pr23:1}){
  let sequence=0;return schedule().rows.map(row=>({...row,work:{repeat:1,warmupScans:500,expectedDigest:'same'},blocks:row.blocks.map(block=>({...block,subjects:block.roles.map(role=>({role,sequence:sequence++,phase:'measure',complete:true,samples:Array(21).fill(40*factors[role]),repeat:1,prescribedWarmupScans:500,digest:'same',belowTargetBatches:0,warmup:{capped:false,elapsedMs:500,scans:500},warmupTimeShort:false,warmupWorkShort:false}))}))}));
}
test('exact prospective count, palindromes, and cases',()=>{
 const p=schedule();assert.deepEqual(p,schedule());assert.deepEqual(p.counts,{cases:10,pilots:30,blocks:80,subjects:480,batches:10080});
 assert.equal(p.measuredOrder.length,80);assert.equal(CASES.filter(c=>c.target).length,5);assert.equal(new Set(CASES.map(c=>c.id)).size,10);
 for(const block of p.measuredOrder){assert.deepEqual(block.roles.slice(0,3),block.roles.slice(3).reverse());for(const role of ROLES)assert.equal(block.roles.filter(r=>r===role).length,2);}
 for(const row of p.rows)assert.deepEqual(row.blocks.map(b=>b.block),[0,1,2,3,4,5,6,7]);
});
test('every sequential workflow step and reserve fit the 95-minute job cap',()=>{const workflow=readFileSync(join(REPO,'.github/workflows/block-callback-screen.yml'),'utf8');const timeouts=[...workflow.matchAll(/timeout-minutes: (\d+)/g)].map(m=>Number(m[1]));assert.deepEqual(timeouts,[95,2,2,2,1,42,32,4,5]);assert.equal(Object.values(STEP_BUDGETS).reduce((s,x)=>s+x,0),CONFIG.totalJobTimeoutMinutes);assert.equal(timeouts.slice(1).reduce((s,x)=>s+x,0)+STEP_BUDGETS.reserve,95);assert.equal(CONFIG.prerequisitesTimeoutMs/60000,40);assert.equal(CONFIG.campaignTimeoutMs/60000,30);assert(STEP_BUDGETS.correctness>40&&STEP_BUDGETS.campaign>30);assert.equal(CONFIG.subjectTimeoutMs,60000);assert.equal(CONFIG.retryCount,0);});
test('common work uses all three pilots and rejects capped calibration',()=>{
 const pilots=[2,3,4].map((repeat,i)=>({phase:'pilot',repeat,minMsPerScan:[2,1,.5][i],digest:'same',warmup:{capped:false},repeatCapped:false}));
 const p=freezeWork(CASES[0],pilots);assert.equal(p.repeat,4);assert.equal(p.warmupScans,1252);assert.equal(p.expectedDigest,'same');
 assert.throws(()=>freezeWork(CASES[0],[...pilots.slice(0,2),{...pilots[2],digest:'different'}]));assert.throws(()=>freezeWork(CASES[0],pilots.map(p=>({...p,repeatCapped:true}))));
});
test('all thirty pilots finish before any of 480 measured processes',async()=>{
 const calls=[];const rows=await executePlan(schedule(),async(role,request)=>{calls.push({role,request});assert(!('role'in request));return request.phase==='pilot'?{phase:'pilot',repeat:4,minMsPerScan:1,digest:'same',warmup:{capped:false},repeatCapped:false}:{complete:true,digest:'same'};},()=>{});
 assert.equal(calls.length,510);assert(calls.slice(0,30).every(c=>c.request.phase==='pilot'));assert(calls.slice(30).every(c=>c.request.phase==='measure'));assert(rows.every(r=>r.blocks.length===8));
});
test('process-level interval rejects incomplete blocks',()=>{assert.equal(interval([0,0]).complete,false);assert.deepEqual(interval(Array(8).fill(0)),{complete:true,n:8,point:1,lower:1,upper:1,confidenceLevel:.95,df:7});});
test('incremental target gain admits only broader validation',()=>{const d=decision(synthetic());assert.equal(d.status,'admit-broader-validation');assert.equal(d.worthwhile.length,5);assert.equal(d.summaries.length,10);});
test('main-only gain is insufficient',()=>{const d=decision(synthetic({main:1,candidate:.9,pr23:.895}));assert.equal(d.status,'no-worthwhile-incremental-evidence');assert(d.summaries.every(s=>s.comparisons.main.upper<1));});
test('the worthwhile threshold is stronger than any positive improvement',()=>{assert.equal(decision(synthetic({main:1,candidate:.99,pr23:1})).status,'no-worthwhile-incremental-evidence');});
test('an adverse unchanged control stops admission',()=>{const rows=synthetic();for(const b of rows[9].blocks)for(const s of b.subjects)if(s.role==='candidate')s.samples=Array(21).fill(44);const d=decision(rows);assert.equal(d.status,'detected-material-loss');assert(d.losses.includes('vector-number-4097:candidate/pr23'));});
test('inconclusive controls remain visible without automatic rejection',()=>{const rows=synthetic();for(const [i,b]of rows[9].blocks.entries())for(const s of b.subjects)if(s.role==='candidate')s.samples=Array(21).fill(40*Math.exp(i%2?.15:-.15));const d=decision(rows);assert.equal(d.summaries[9].comparisons.pr23.classification,'inconclusive');assert.equal(d.status,'admit-broader-validation');});
test('matched AA drift invalidates the row and campaign',()=>{const rows=synthetic();for(const b of rows[0].blocks){const same=b.subjects.filter(s=>s.role==='pr23');same[1].samples=Array(21).fill(50);}const d=decision(rows);assert.equal(d.summaries[0].aaDrift,true);assert.equal(d.status,'incomplete-or-invalid');});
test('measurement floors and missing subjects cannot be dropped',()=>{const rows=synthetic();rows[0].blocks[0].subjects[0].belowTargetBatches=1;rows[0].blocks[0].subjects[0].samples[0]=9;assert.equal(decision(rows).status,'incomplete-or-invalid');rows[0].blocks[0].subjects.pop();assert.equal(summarizeRow(rows[0]).completeBlocks,7);assert.equal(decision(rows).status,'incomplete-or-invalid');});
test('every measured subject is bound to common work and digest',()=>{for(const key of ['repeat','prescribedWarmupScans','digest']){const rows=synthetic();rows[0].blocks[0].subjects[0][key]=key==='digest'?'bad':999;assert.throws(()=>decision(rows));}});
test('prerequisites preserve standard test command and all three source barriers',()=>{const p=expectedCommands();assert.equal(p.length,54);for(const r of ROLES){assert.equal(p.filter(c=>c.role===r&&c.name==='full-standard-test').length,1);assert(p.some(c=>c.role===r&&c.name==='check-package'));assert(p.some(c=>c.role===r&&c.name==='callback-node-workers'));}const s=readFileSync(join(HERE,'gate.mjs'),'utf8');assert(s.includes("['run','test'],600000"));assert(!s.includes('--testTimeout'));assert(s.includes("assert(!existsSync(cache)"));});
test('worker consumer types and four existing Node proofs gate every pinned source',()=>{
 const plan=expectedCommands(),sources=pins(),inputs=['tsconfig.worker.json','type-tests/worker.consumer.ts','type-tests/worker-tasks.consumer.ts','proofs/worker-tasks.mjs','proofs/list-query.mjs','proofs/list-query-regression.mjs','proofs/memory-startup.mjs'];
 const additions=['typecheck-worker-consumer','node-proof-worker-tasks','node-proof-list-query','node-proof-list-query-regression','node-proof-memory-startup'];
 for(const role of ROLES){const names=plan.filter(c=>c.role===role).map(c=>c.name),start=names.indexOf('typecheck-worker-consumer');assert.deepEqual(names.slice(start,start+5),additions);assert(start>names.indexOf('typecheck-geometry')&&start+5===names.indexOf('check-package'));for(const path of inputs){assert(sources.roles[role].files[path],`${role}:${path}`);assert.equal(sources.roles[role].files[path].sha256,sources.roles.main.files[path].sha256);}}
 const gate=readFileSync(join(HERE,'gate.mjs'),'utf8');assert(gate.includes("['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.worker.json'],120000"));assert(gate.includes("node,['--test',`proofs/${proof}.mjs`],180000"));assert.equal(CONFIG.prerequisitesTimeoutMs,40*60000);
});
test('publication identity preserves the reviewed runtime tree and file modes',()=>{const p=pins();assert.equal(p.publication.candidateCommit,'2fbd8b27599ad9575038a2a9c4f9fc68e25aa391');assert.equal(p.roles.candidate.tree,'4f557a7e447e44bf3a3dfc744da7f115b72c5894');for(const [path,v]of Object.entries(p.roles.candidate.files))if(path.startsWith('proofs/block-callback/')||path==='block-callback.test.ts')assert.equal(v.mode,'100644');});
test('timing cannot run locally, including after prospective activation',()=>{assert.equal(typeof readJson(join(HERE,'intent.json')).measure,'boolean');const previous=process.env.GITHUB_ACTIONS;try{process.env.GITHUB_ACTIONS='false';assert.throws(()=>requireCI());}finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}const p=spawnSync(process.execPath,[join(HERE,'controller.mjs'),'run','/tmp/not-a-campaign'],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'false'}});assert.notEqual(p.status,0);assert(/Timing is disabled|Execution is CI only|Exact harness review is required/.test(p.stderr));});
test('frozen fixture and subject reuse can be reversed to original source',()=>{
 const reuse=readJson(join(HERE,'reuse.json'));assert.equal(hash(readFileSync(join(HERE,'reused/fixtures.mjs'))),reuse.fixtures.extractedSha256);assert.equal(hash(readFileSync(join(HERE,'reused/command.mjs'))),reuse.command.sha256);
 let s=readFileSync(join(HERE,'reused/subject.mjs'),'utf8').split('\n').slice(2).join('\n').trimEnd();for(const [a,b]of [...reuse.subject.replacements].reverse())s=s.replace(b,a);assert.equal(hash(s),reuse.subject.originalFunctionSha256);
 let probe=readFileSync(join(HERE,'review-probe.mjs'),'utf8');for(const [a,b]of [...reuse.reviewProbe.adapterReplacements].reverse())probe=probe.replace(b,a);assert.equal(hash(probe),reuse.reviewProbe.sha256);
});
test('frozen harness and source staging reject changed source, modes, and extra inputs',()=>{
 verifyHarness();const dir=mkdtempSync(join(os.tmpdir(),'block-callback-stage-'));rmSync(dir,{recursive:true});
 try {const roots=preparePackages(dir);for(const r of ROLES)sourceCheck(roots[r],r);const f=join(roots.main,'arena.ts'),original=readFileSync(f);writeFileSync(f,Buffer.concat([original,Buffer.from('\n')]));assert.throws(()=>sourceCheck(roots.main,'main'));writeFileSync(f,original);chmodSync(f,0o755);assert.throws(()=>sourceCheck(roots.main,'main'));chmodSync(f,0o644);writeFileSync(join(roots.main,'extra.ts'),'export const x=1;');assert.throws(()=>sourceCheck(roots.main,'main'));}
 finally {rmSync(dir,{recursive:true,force:true});}
});
