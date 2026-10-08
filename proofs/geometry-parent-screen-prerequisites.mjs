// Standard full Bun suite plus built Node/package/worker consumers. No latency work.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE, CANDIDATE, TOOLCHAIN, sha256, sourceComparison, compare } from './geometry-parent-screen-source.mjs';
export const CHECKS = Object.freeze({
  'build-wasm':['bun','run','build:wasm'],
  'build-browser':['bun','run','build:browser'],
  'build-types':['bun','run','build:types'],
  'worker-types':['node','node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.worker.json'],
  'typecheck':['bun','run','typecheck'],
  'type-geometry':['bun','run','typecheck:geometry'],
  'type-redux':['bun','run','typecheck:redux'],
  'type-values':['bun','run','typecheck:values'],
  'unit':['bun','run','test'],
  'package':['bun','run','check:package'],
  'node-worker':['node','proofs/node-worker.mjs'],
  'worker-tasks':['node','--test','proofs/worker-tasks.mjs'],
  'worker-docs':['node','scripts/check-worker-docs.mjs','--node-only'],
  'redux-node':['node','proofs/redux-node.mjs'],
  'typed-json-worker':['node','proofs/typed-json-worker.mjs'],
});
export const REQUIRED = Object.freeze([...['baseline','candidate'].flatMap(build=>Object.keys(CHECKS).map(name=>build+'/'+name)),
  'candidate/geometry-node','candidate/geometry-bun','candidate/protocol-tests']);
export const save = (path,data)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(data,null,2)+'\n');};
const read = path=>JSON.parse(readFileSync(path,'utf8'));
export function validatePrerequisites(evidence) {
  const path=join(evidence,'prerequisites.json'),r=read(path); assert.equal(r.status,'completed');
  assert.equal(r.baseline,BASELINE);assert.equal(r.candidate,CANDIDATE);
  assert.deepEqual(r.checks.map(c=>c.key),REQUIRED);
  for(const c of r.checks) {
    assert.equal(c.status,0,c.key);assert.equal(c.signal,null);assert.equal(c.error,null);
    assert.equal(sha256(readFileSync(join(evidence,c.log))),c.logSha256);
    const [build,name]=c.key.split('/');
    const expected=CHECKS[name]??(name==='geometry-node'?['node','proofs/geometry-parent-cache.mjs']:name==='geometry-bun'?['bun','proofs/geometry-parent-cache.mjs']:['node','--test','proofs/geometry-parent-screen.node.mjs']);
    assert.deepEqual(c.command,expected);assert.equal(c.cwd,r.roots[build]);
  }
  for(const runtime of ['node','bun']) {
    const p=join(evidence,`geometry-${runtime}`,`report-${runtime}-${r.arch}.json`),report=read(p);
    assert.equal(report.timed,false);assert.equal(report.readOnlyCases,4309);assert.equal(report.randomSeeds,4096);
    assert.equal(report.tracedCases,123);assert.equal(report.workers.length,8);assert.equal(report.midScanGrowth.length,2);
    assert.equal(report.baseline,BASELINE); assert.equal(sha256(readFileSync(p)),r.geometryReports[runtime]);
  }
  return {...r,sha256:sha256(readFileSync(path))};
}
export function runPrerequisites(baseRoot,candidateRoot,evidence) {
  evidence=resolve(evidence);assert(!existsSync(join(evidence,'prerequisites.json')),'Never overwrite/retry prerequisites');
  const source=sourceComparison(baseRoot,candidateRoot);
  const r={schema:1,status:'partial',baseline:BASELINE,candidate:CANDIDATE,roots:source.roots,arch:process.arch,checks:[],geometryReports:{}};
  const path=join(evidence,'prerequisites.json');save(path,r);
  function check(build,name,command,env={}) {
    const key=build+'/'+name,log='logs/'+build+'-'+name+'.log';
    const c={key,command,cwd:source.roots[build],log,startedAt:new Date().toISOString(),status:null,signal:null,error:null};r.checks.push(c);save(path,r);
    mkdirSync(join(evidence,'logs'),{recursive:true});const fd=openSync(join(evidence,log),'wx');
    let child;
    try { child=spawnSync(command[0],command.slice(1),{cwd:c.cwd,stdio:['ignore',fd,fd],env:{...process.env,...env},timeout:600000}); }
    finally {closeSync(fd);}
    Object.assign(c,{status:child.status,signal:child.signal??null,error:child.error?String(child.error):null,finishedAt:new Date().toISOString(),logSha256:sha256(readFileSync(join(evidence,log)))});save(path,r);
    process.stdout.write(readFileSync(join(evidence,log)));assert.equal(child.status,0,`Prerequisite ${key} failed; partial evidence retained`);
  }
  try {
    for(const build of ['baseline','candidate']) for(const [name,command] of Object.entries(CHECKS)) check(build,name,command);
    for(const runtime of ['node','bun']) {
      const output=join(evidence,`geometry-${runtime}`);
      check('candidate','geometry-'+runtime,[runtime,'proofs/geometry-parent-cache.mjs'],{GEOMETRY_PROOF_OUTPUT:output});
      r.geometryReports[runtime]=sha256(readFileSync(join(output,`report-${runtime}-${process.arch}.json`)));save(path,r);
    }
    check('candidate','protocol-tests',['node','--test','proofs/geometry-parent-screen.node.mjs']);
    r.comparison=compare(baseRoot,candidateRoot);r.status='completed';r.finishedAt=new Date().toISOString();save(path,r);validatePrerequisites(evidence);
  } catch(error) {r.status='failed';r.error=String(error.stack??error);save(path,r);throw error;}
  return r;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,baseline,candidate,evidence]=process.argv.slice(2);assert.equal(mode,'run');
  assert.equal(process.versions.node,TOOLCHAIN.node);assert.equal(spawnSync('bun',['--version'],{encoding:'utf8'}).stdout.trim(),TOOLCHAIN.bun);
  console.log(JSON.stringify(runPrerequisites(baseline,candidate,evidence),null,2));
}
