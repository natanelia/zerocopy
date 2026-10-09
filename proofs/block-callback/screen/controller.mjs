import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,cpSync,rmSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import os from 'node:os';
import {runCommand} from './reused/command.mjs';
import {CASES,CONFIG,ROLES,schedule,freezeWork,decision,validateMeasured} from './protocol.mjs';
import {HERE,REPO,pins,hash,readJson,writeJson,inventory,verifyHarness,prospective,requireCI,currentMain,executable} from './support.mjs';
import {preparePackages,prerequisites,validateGate} from './gate.mjs';
export async function executePlan(plan,subject,persist){
  const rows=plan.rows.map(row=>({...row,blocks:[],pilots:[]}));
  for(const row of rows){for(const role of row.pilotOrder){row.pilots.push(await subject(role,{workload:row.workload,phase:'pilot'}));persist(rows);}row.work=freezeWork(row.workload,row.pilots);persist(rows);}
  for(const planned of plan.measuredOrder){const row=rows.find(r=>r.workload.id===planned.caseId),block={block:planned.block,roles:planned.roles,subjects:[]};row.blocks.push(block);persist(rows);
    for(const role of planned.roles){const value=await subject(role,{workload:row.workload,phase:'measure',repeat:row.work.repeat,warmupScans:row.work.warmupScans});assert.equal(value.digest,row.work.expectedDigest);block.subjects.push({...value,role});persist(rows);}
  }return rows;
}
export async function campaign(evidence){
  const intent=readJson(join(HERE,'intent.json')),harness=verifyHarness();assert.equal(intent.measure,true,'Timing is disabled');assert.equal(intent.reviewedHarnessSha256,harness.harnessSha256,'Exact harness review is required');
  const identity=requireCI();currentMain();const gate=validateGate(evidence),directory=join(evidence,'latency');assert(!existsSync(directory),'No timing retry/overwrite');mkdirSync(directory);
  const started=Date.now(),deadline=started+CONFIG.campaignTimeoutMs,plan=schedule(),neutral=join(directory,'subject'),input=join(directory,'request.json');
  const record={schema:1,status:'running',identity,harnessSha256:harness.harnessSha256,gateSha256:gate.sha256,plan,config:CONFIG,subjects:[],rows:[],started:new Date().toISOString(),hardware:{platform:process.platform,arch:process.arch,cpus:os.cpus(),totalmem:os.totalmem()},cleanup:{}};
  const save=()=>writeJson(join(directory,'results.json'),record);save();
  writeJson(join(directory,'frozen-plan.json'),{plan,config:CONFIG,pins:pins(),harnessSha256:harness.harnessSha256,gateSha256:gate.sha256});
  const subject=async(role,request)=>{
    const left=deadline-Date.now();assert(left>0,'30-minute campaign deadline reached');verifyHarness();
    const expected=gate.report.arms[role].build,source=join(evidence,'builds',role);
    assert.deepEqual(inventory(join(source,'dist')),expected.dist);assert.equal(hash(readFileSync(join(source,'package.json'))),expected.packageSha256);
    rmSync(neutral,{recursive:true,force:true});cpSync(join(source,'dist'),join(neutral,'dist'),{recursive:true});copyFileSync(join(source,'package.json'),join(neutral,'package.json'));
    assert.deepEqual(inventory(join(neutral,'dist')),expected.dist);
    writeJson(input,{...request,entryUrl:pathToFileURL(join(neutral,'dist/shared.js')).href,harnessUrl:pathToFileURL(join(HERE,'fixtures.mjs')).href});
    const sequence=record.subjects.length;copyFileSync(input,join(directory,String(sequence).padStart(4,'0')+'.request.json'));const receipt={sequence,role,caseId:request.workload.id,phase:request.phase,requestSha256:hash(readFileSync(input)),sourceTree:pins().roles[role].tree,packageSha256:expected.packageSha256,distSha256:hash(JSON.stringify(expected.dist)),tool:executable(process.execPath),complete:false};
    record.subjects.push(receipt);save();
    Object.assign(receipt,await runCommand({name:'subject-'+sequence,command:process.execPath,args:[join(HERE,'subject.mjs'),input],cwd:directory,
      env:{...process.env,NODE_OPTIONS:'',BUN_OPTIONS:'',NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:'',BLOCK_CALLBACK_MEASURE:'reviewed-ci-campaign'},
      prefix:join(directory,'logs',String(sequence).padStart(4,'0')),timeoutMs:Math.min(CONFIG.subjectTimeoutMs,deadline-Date.now())}));
    receipt.stdoutSha256=hash(readFileSync(receipt.stdout));receipt.stderrSha256=hash(readFileSync(receipt.stderr));save();
    assert(receipt.complete,'Subject failed; no retry');assert.equal(readFileSync(receipt.stderr,'utf8'),'','Measured/pilot subject stderr is not allowed');
    const raw=JSON.parse(readFileSync(receipt.stdout,'utf8'));assert.equal(raw.runtime.node,CONFIG.node);assert.equal(raw.arch,'x64');assert.deepEqual(raw.execArgv,[]);if(request.phase==='measure')validateMeasured(raw,{repeat:request.repeat,warmupScans:request.warmupScans,expectedDigest:record.rows.find(r=>r.workload.id===request.workload.id).work.expectedDigest});
    assert.deepEqual(inventory(join(neutral,'dist')),expected.dist);assert.deepEqual(executable(process.execPath),receipt.tool);assert.equal(hash(readFileSync(join(neutral,'package.json'))),expected.packageSha256);
    Object.assign(receipt,{raw});save();return{sequence,complete:true,...raw};
  };
  try{
    record.rows=await executePlan(plan,subject,rows=>{record.rows=rows;save();});
    assert.equal(record.subjects.length,510);assert.equal(record.subjects.filter(s=>s.phase==='measure').length,480);
    validateGate(evidence);verifyHarness();record.status='completed';record.decision=decision(record.rows);
  }catch(error){record.status='failed';record.error=String(error.stack??error);record.decision=decision(record.rows);throw error;}
  finally{rmSync(neutral,{recursive:true,force:true});record.cleanup.neutralRemoved=!existsSync(neutral);record.finished=new Date().toISOString();save();}
  return record;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,arg]=process.argv.slice(2);
  if(mode==='freeze'){writeJson(join(HERE,'plan.json'),{config:CONFIG,...schedule()});writeJson(join(HERE,'manifest.json'),prospective());console.log(JSON.stringify(verifyHarness()));}
  else if(mode==='check'){verifyHarness();assert.deepEqual(readJson(join(HERE,'plan.json')),{config:CONFIG,...schedule()});console.log(JSON.stringify({stage:'prospective-only',counts:schedule().counts,timingEnabled:readJson(join(HERE,'intent.json')).measure}));}
  else if(mode==='prepare'){verifyHarness();console.log(JSON.stringify(preparePackages(resolve(arg))));}
  else if(mode==='gate'){assert(arg);await prerequisites(resolve(arg));}
  else if(mode==='run'){assert(arg);await campaign(resolve(arg));}
  else throw new Error('Use freeze, check, prepare, gate, or run');
}
