import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,cpSync,realpathSync,lstatSync,readdirSync} from 'node:fs';
import {join,dirname,resolve,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCommand} from './reused/command.mjs';
import {ROLES,CONFIG} from './protocol.mjs';
import {HERE,REPO,pins,hash,readJson,writeJson,inventory,sourceCheck,buildCheck,executable,command,requireCI,currentMain,verifyHarness,archiveInputs} from './support.mjs';
export function preparePackages(destination){
  assert(!existsSync(destination),'Package staging must be fresh');mkdirSync(destination,{recursive:true});const p=pins();
  for(const role of ROLES){const root=join(destination,role);mkdirSync(root);
    const revision=role==='candidate'?p.publication.candidateCommit:p.roles.main.localCommit;
    const archive=spawnSync('git',['archive',revision],{cwd:REPO,maxBuffer:64*1024*1024});assert.equal(archive.status,0,String(archive.stderr));
    const unpack=spawnSync('tar',['-x','-C',root],{input:archive.stdout});assert.equal(unpack.status,0,String(unpack.stderr));
    if(role==='pr23'){const file=join(root,'arena.ts'),s=readFileSync(file,'utf8'),a=s.indexOf('  *blocks('),b=s.indexOf('  *vector(',a);assert(a>=0&&b>a);writeFileSync(file,s.slice(0,a)+readFileSync(join(HERE,'references/pr23-blocks.txt'),'utf8')+s.slice(b));}
    copyFileSync(join(HERE,'references/dependencies.lock'),join(root,'bun.lock'));sourceCheck(root,role);
  }return Object.fromEntries(ROLES.map(role=>[role,join(destination,role)]));
}
function dependencyManifests(root){
  const modules=join(root,'node_modules'),manifests={};
  function walk(dir,rel=''){for(const name of readdirSync(dir).sort()){
    if(['.bin','.vite','.cache'].includes(name))continue;const file=join(dir,name),path=rel?rel+'/'+name:name,st=lstatSync(file);
    if(st.isDirectory())walk(file,path);else if(name==='package.json'&&st.isFile())manifests[path]=hash(readFileSync(file));
  }}walk(modules);
  const compilers={};for(const [name,version]of Object.entries({typescript:'5.9.3',assemblyscript:'0.28.20',vitest:'4.1.11','bun-types':'1.4.2'})){
    const folder=join(modules,name);assert.equal(readJson(join(folder,'package.json')).version,version);compilers[name]=inventory(folder,path=>path.split('/').includes('node_modules'));
  }return {manifests,compilers};
}
export async function prerequisites(evidence,node=process.execPath,bun='bun'){
  const identity=requireCI(),harness=verifyHarness();currentMain();assert(!existsSync(join(evidence,'gate.json')),'No gate retry');mkdirSync(evidence,{recursive:true});
  const packageRoot=join(dirname(resolve(evidence)),'block-callback-packages'),roots=preparePackages(packageRoot);
  const bunPath=command(['which',bun]),nodeIdentity=executable(node),bunIdentity=executable(bunPath),deadline=Date.now()+CONFIG.prerequisitesTimeoutMs;
  const report={schema:1,status:'running',identity,harnessSha256:harness.harnessSha256,roots,commands:[],arms:{},started:new Date().toISOString(),deadlineMs:CONFIG.prerequisitesTimeoutMs};
  const save=()=>writeJson(join(evidence,'gate.json'),report);
  const env={...process.env,PATH:[dirname(node),dirname(bunPath),process.env.PATH??''].join(delimiter),NODE_OPTIONS:'',BUN_OPTIONS:'',NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:'',npm_config_cache:join(evidence,'npm-cache')};
  const run=async(role,name,exe,args,limit)=>{
    const source=sourceCheck(roots[role],role),tool=executable(exe);verifyHarness();const left=deadline-Date.now();assert(left>0,'40-minute prerequisite deadline reached');
    const prefix=join(evidence,'logs',String(report.commands.length).padStart(3,'0')+'-'+role+'-'+name);
    const receipt={role,name,source,tool,argv:[exe,...args],sourceRoot:roots[role],proofCommit:identity.commit,harnessSha256:harness.harnessSha256,status:'running'};report.commands.push(receipt);save();
    Object.assign(receipt,await runCommand({name,command:exe,args,cwd:roots[role],env,prefix,timeoutMs:Math.min(limit,left)}));
    receipt.stdoutSha256=hash(readFileSync(receipt.stdout));receipt.stderrSha256=hash(readFileSync(receipt.stderr));receipt.sourceAfter=sourceCheck(roots[role],role);assert.deepEqual(executable(exe),tool);save();assert(receipt.complete,`${role}:${name} failed; no retry`);return receipt;
  };
  try{
    assert.equal(command([node,'--version']),'v'+CONFIG.node);assert.equal(command([bunPath,'--version']),CONFIG.bun);
    report.runtimes={node:nodeIdentity,bun:bunIdentity};
    for(const role of ROLES){const root=roots[role],arm=report.arms[role]={source:sourceCheck(root,role),commands:[],cache:{}};save();
      archiveInputs(root,role,join(evidence,'sources',role));
      await run(role,'install',bunPath,['install','--frozen-lockfile'],180000);
      assert(!lstatSync(join(root,'node_modules')).isSymbolicLink(),'Each arm needs its own node_modules');
      arm.dependencies=dependencyManifests(root);
      for(const script of ['build:wasm','build:browser','build:types'])await run(role,script.replaceAll(':','-'),bunPath,['run',script],180000);
      arm.build=buildCheck(root,role);cpSync(join(root,'dist'),join(evidence,'builds',role,'dist'),{recursive:true});copyFileSync(join(root,'package.json'),join(evidence,'builds',role,'package.json'));save();
      const cache=join(root,'node_modules/.vite');assert(!existsSync(cache),'Standard Vitest cache must start absent');mkdirSync(cache);arm.cache={path:realpathSync(cache),initial:inventory(cache),initialState:'fresh-empty'};assert.deepEqual(arm.cache.initial,{});
      try { await run(role,'full-standard-test',bunPath,['run','test'],600000); }
      finally { arm.cache.after=inventory(cache);cpSync(cache,join(evidence,'caches',role),{recursive:true});save(); }
      for(const script of ['typecheck','typecheck:redux','typecheck:values','typecheck:geometry'])await run(role,script.replaceAll(':','-'),bunPath,['run',script],120000);
      await run(role,'typecheck-worker-consumer',node,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.worker.json'],120000);
      for(const proof of ['worker-tasks','list-query','list-query-regression','memory-startup'])await run(role,'node-proof-'+proof,node,['--test',`proofs/${proof}.mjs`],180000);
      await run(role,'check-package',node,['scripts/check-package.mjs'],180000);
      await run(role,'standard-node-worker',node,['proofs/node-worker.mjs'],180000);
      await run(role,'callback-node-workers',node,[join(REPO,'proofs/block-callback/workers.mjs'),join(root,'dist/shared.js')],180000);
      assert.deepEqual(buildCheck(root,role),arm.build);assert.deepEqual(dependencyManifests(root),arm.dependencies);arm.complete=true;save();
    }
    assert.equal(new Set(ROLES.map(r=>report.arms[r].cache.path)).size,3);assert.deepEqual(report.arms.main.dependencies,report.arms.candidate.dependencies);assert.deepEqual(report.arms.main.dependencies,report.arms.pr23.dependencies);
    await run('candidate','three-source-fixtures',node,[join(HERE,'semantic.mjs'),...ROLES.map(r=>join(roots[r],'dist/shared.js'))],180000);
    for(const role of ['candidate','pr23'])await run('candidate','review-probe-'+role,node,[join(HERE,'review-probe.mjs'),packageRoot,role,join(evidence,'review-'+role+'.json')],180000);
    for(const role of ROLES){sourceCheck(roots[role],role);assert.deepEqual(buildCheck(roots[role],role),report.arms[role].build);}
    report.status='passed';report.finished=new Date().toISOString();save();return report;
  }catch(error){report.status='failed';report.error=String(error.stack??error);report.finished=new Date().toISOString();save();throw error;}
}
export function expectedCommands(){
  const names=['install','build-wasm','build-browser','build-types','full-standard-test','typecheck','typecheck-redux','typecheck-values','typecheck-geometry','typecheck-worker-consumer','node-proof-worker-tasks','node-proof-list-query','node-proof-list-query-regression','node-proof-memory-startup','check-package','standard-node-worker','callback-node-workers'];
  return [...ROLES.flatMap(role=>names.map(name=>({role,name}))),...['three-source-fixtures','review-probe-candidate','review-probe-pr23'].map(name=>({role:'candidate',name}))];
}
export function validateGate(evidence){
  const report=readJson(join(evidence,'gate.json')),id=requireCI(),harness=verifyHarness();assert.equal(report.status,'passed');assert.deepEqual(report.identity,id);assert.equal(report.harnessSha256,harness.harnessSha256);
  assert.deepEqual(report.commands.map(({role,name})=>({role,name})),expectedCommands());assert(report.commands.every(c=>c.complete&&c.cleanup?.status==='verified-no-live-processes'));
  for(const receipt of report.commands){assert.equal(receipt.source.tree,pins().roles[receipt.role].tree);assert.equal(receipt.proofCommit,id.commit);assert.equal(receipt.harnessSha256,harness.harnessSha256);assert.equal(hash(readFileSync(receipt.stdout)),receipt.stdoutSha256);assert.equal(hash(readFileSync(receipt.stderr)),receipt.stderrSha256);assert.deepEqual(executable(receipt.argv[0]),receipt.tool);}
  for(const role of ROLES){sourceCheck(report.roots[role],role);assert.deepEqual(buildCheck(report.roots[role],role),report.arms[role].build);assert(report.arms[role].complete);}
  return {report,sha256:hash(readFileSync(join(evidence,'gate.json')))};
}
