// Pure fixtures, model calls, alias/clock/admission guards. No arm or subject execution.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,symlinkSync,linkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,expectedChecksum,rangeAutoBody,rangeScalarBody,spatialBody,selectionGuard,
  SIMD_PROBE,SCALAR_CONTROL_FILE,verifyScalarFixture,clockFor,workCounts,requireTimedAdmission} from './subject.mjs';
import {investigationDecision} from './decision.mjs';
const protocol=JSON.parse(readFileSync(new URL('./protocol.json',import.meta.url)));
let checks=0;
const check=fn=>{fn();checks++;};
check(()=>{let calls=0;const read=clockFor('untimed',{now(){calls++;return 1;}});assert.throws(read,/forbids/);assert.equal(calls,0);});
check(()=>{const sequence=[7,9];const read=clockFor('measure',{now:()=>sequence.shift()});assert.equal(read(),7);assert.equal(read(),9);});
check(()=>assert.throws(()=>clockFor('unknown')));
for(const spec of protocol.cases) {
  const f=fixture(spec);
  check(()=>{assert.deepEqual(workCounts(spec,'untimed'),[spec.ladder[0],spec.ladder.at(-1)]);assert(spec.ladder[0]>1);assert.throws(()=>workCounts(spec,'measure',{operations:1}));});
  check(()=>{assert.equal(f.entries.length,spec.size);assert(Object.isFrozen(f.entries));assert(Object.isFrozen(f.queries));assert.equal(f.expected[1],0);assert.equal(f.expected[2],spec.points??spec.size);assert(Number.isSafeInteger(expectedChecksum(f,spec.ladder.at(-1))));});
  check(()=>{
    const calls=[],root=Object.freeze({marker:true});
    const api={countInRange(list,lo,hi){assert.equal(list,root);const q=f.queries.findIndex(q=>q[0]===lo&&q[1]===hi);calls.push(q);return f.expected[q];},
      countPointsInBox(list,box){assert.equal(list,root);const q=f.queries.indexOf(box);calls.push(q);return f.expected[q];}};
    const body=spec.operation==='countPointsInBox'?spatialBody:spec.mode==='scalar'?rangeScalarBody:rangeAutoBody;
    const got=body(api,root,f.queries,9);assert.deepEqual(calls,[0,1,2,3,0,1,2,3,0]);
    assert.equal(got.checksum,f.expected.reduce((a,b)=>a+b,0)*2+f.expected[0]);assert.equal(got.last,f.expected[0]);
    assert.equal(got.checksum,expectedChecksum(f,9));
  });
}
for(const [size,expected] of [[1,[1,0,1,1]],[3,[2,0,3,1]],[4,[2,0,4,1]]]) check(()=>assert.deepEqual(fixture({size,operation:'countInRange'}).expected,expected));
function model({automaticResult=true,sharedCache=false,badProbe=false,throwScalar=false}={}) {
  const original=()=>automaticResult,wasm={validate:original},choices=[];let shared;
  function realm(role) {let selected;return {countInRange(){
    if(role==='scalar'&&throwScalar) throw Error('synthetic scalar failure');
    if(sharedCache && shared!==undefined) selected=shared;
    if(selected===undefined) {selected=wasm.validate(Uint8Array.from(badProbe?[1,2,3]:SIMD_PROBE));choices.push([role,selected]);shared=selected;}
    return 1;
  },countPointsInBox(){return 0;}};}
  return {wasm,original,choices,automatic:realm('automatic'),scalar:realm('scalar')};
}
check(()=>{const m=model();const record=selectionGuard(m.automatic,m.scalar,{},m.wasm);assert.deepEqual(m.choices,[['automatic',true],['scalar',false]]);assert.equal(m.wasm.validate,m.original);assert.equal(record.scalarControlFile,SCALAR_CONTROL_FILE);assert.equal(record.firstUseMeasured,false);});
check(()=>{const m=model();assert.throws(()=>selectionGuard(m.automatic,m.automatic,{},m.wasm),/independent/);});
for(const options of [{automaticResult:false},{sharedCache:true},{badProbe:true},{throwScalar:true}]) check(()=>{const m=model(options);assert.throws(()=>selectionGuard(m.automatic,m.scalar,{},m.wasm));assert.equal(m.wasm.validate,m.original);});
const fixtureDirectory=mkdtempSync(path.join(tmpdir(),'numeric-sibling-file-test-'));
try {
  const official=path.join(fixtureDirectory,'numeric.js'),copy=path.join(fixtureDirectory,SCALAR_CONTROL_FILE);
  writeFileSync(official,'export const value=1;\n');writeFileSync(copy,readFileSync(official));
  check(()=>{const f=verifyScalarFixture(pathToFileURL(official));assert.equal(f.generatedTestFixture,true);assert.equal(f.officialOutput,false);});
  check(()=>{writeFileSync(copy,'changed');assert.throws(()=>verifyScalarFixture(pathToFileURL(official)),/match official/);});
  check(()=>{unlinkSync(copy);symlinkSync(official,copy);assert.throws(()=>verifyScalarFixture(pathToFileURL(official)),/regular files/);});
  check(()=>{unlinkSync(copy);linkSync(official,copy);assert.throws(()=>verifyScalarFixture(pathToFileURL(official)),/separate physical/);});
} finally {rmSync(fixtureDirectory,{recursive:true,force:true});}
const temporary=mkdtempSync(path.join(tmpdir(),'numeric-unroll-admission-test-'));
try {
  check(()=>requireTimedAdmission({mode:'untimed'},temporary));
  check(()=>assert.throws(()=>requireTimedAdmission({mode:'calibrate'},temporary)));
  const admission={mode:'ci-screen',promotionAllowed:false,fullStandardGateStatus:{baseline:'passed-fresh-exact-source',candidate:'passed-fresh-exact-source'},standardCommandsPerArm:23,numericCommandsPerArm:9,firstUseStatus:'unresolved'};
  writeFileSync(path.join(temporary,'admission.json'),JSON.stringify(admission));
  writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify({sources:{baseline:{path:'/exact/baseline'}}}));
  check(()=>requireTimedAdmission({mode:'measure',arm:'baseline',entrypoint:'/exact/baseline/dist/shared.js'},temporary));
  check(()=>assert.throws(()=>requireTimedAdmission({mode:'measure',arm:'baseline',entrypoint:'/other/dist/shared.js'},temporary)));
  for(const key of ['standardCommandsPerArm','numericCommandsPerArm','firstUseStatus']) check(()=>{writeFileSync(path.join(temporary,'admission.json'),JSON.stringify({...admission,[key]:'wrong'}));assert.throws(()=>requireTimedAdmission({mode:'measure',arm:'baseline',entrypoint:'/exact/baseline/dist/shared.js'},temporary));});
} finally {rmSync(temporary,{recursive:true,force:true});}
const primary=protocol.cases.find(c=>c.primary).id;
const gain={runtime:'node',case:primary,decision:'worthwhile gain supported in this cell',flags:[]};
const unknown={runtime:'bun',case:'range-auto-1',decision:'inconclusive',flags:['A/A']};
const loss={runtime:'bun',case:'range-auto-3',decision:'material loss supported in this cell',flags:[]};
check(()=>{const d=investigationDecision([gain,unknown],protocol.cases,true);assert.match(d.disposition,/further investigation/);assert.deepEqual(d.inconclusiveControlsAndCells,[unknown]);assert.equal(d.promotionAllowed,false);assert.equal(d.firstUseStatus,'unresolved');});
check(()=>assert.match(investigationDecision([gain,loss],protocol.cases,true).disposition,/do not advance/));
check(()=>assert.match(investigationDecision([unknown],protocol.cases,true).disposition,/no supported worthwhile/));
check(()=>assert.match(investigationDecision([gain],protocol.cases,false).disposition,/incomplete/));
console.log(JSON.stringify({deterministicSubjectChecks:checks,passed:true,armImports:false,subjectsRun:false,operationClocks:false}));
