// Uses only the public portable shared entry point supplied by the controller.
import assert from 'node:assert/strict';
import { KEYS,NAMES,objectOracle,validateView,digest } from './oracle.mjs';
export function buildFixtures(api,cold) {
  function map(type,j=0,group=0,fresh=false) {
    api.resetMap();let value=new api.SharedMap(type);
    for(let i=0;i<128;i++) value=value.set(KEYS[i],type==='number'?i:objectOracle(j,i,group,fresh));
    return value;
  }
  const p10=map('number'),p11=p10.set('k0000',100000);
  const p80=Object.freeze(Object.fromEntries(NAMES.map((name,j)=>[name,map('object',j)])));
  const p81=Object.freeze({...p80,m0:p80.m0.set('k0000',objectOracle(0,0,1))});
  const fresh=[0,1].map(group=>Object.freeze(Object.fromEntries(NAMES.map((name,j)=>[name,map('object',j,group,true)]))));
  const variants={P1:[p10,p11],P8:[p80,p81],C8:[p80,p81],F8:fresh};
  const payload=api.getWorkerData(p80,{copy:false});
  const all=api.getWorkerData({cold,p1:p10,...Object.fromEntries(NAMES.map(name=>[`p8_${name}`,p80[name]])),
    ...Object.fromEntries(fresh.flatMap((record,g)=>NAMES.map(name=>[`f${g}_${name}`,record[name]])))},{copy:false});
  const committed=all.arenas.map(a=>a.memory.buffer.byteLength);
  assert.equal(all.arenas.length,26);assert.equal(new Set(all.arenas.map(a=>a.id)).size,26);
  assert.equal(new Set(all.arenas.map(a=>a.memory)).size,26);
  assert(all.arenas.length<=32);assert(committed.every(n=>n<=1048576));
  assert(committed.reduce((a,b)=>a+b,0)<=8388608);
  const familyIds={},descriptors={};
  for(const row of ['P1','P8','C8','F8']) {
    descriptors[row]=[];
    familyIds[row]=variants[row].map((value,v)=>{
      validateView(value,row,v);
      const data=api.getWorkerData(row==='P1'?{value}:value,{copy:false});
      assert.equal(data.arenas.length,row==='P1'?1:8);
      assert.equal(new Set(data.arenas.map(a=>a.memory)).size,data.arenas.length);
      descriptors[row].push(data.arenas.map(a=>({id:a.id,used:a.used,capacity:a.memory.buffer.byteLength})));
      return data.arenas.map(a=>a.id);
    });
  }
  assert.deepEqual(familyIds.P8[0],familyIds.P8[1]);assert.deepEqual(familyIds.P1[0],familyIds.P1[1]);
  assert.equal(new Set([...familyIds.F8[0],...familyIds.F8[1],...familyIds.P8[0]]).size,24);
  for(const name of NAMES.slice(1)) assert.equal(p80[name],p81[name]);
  assert.notEqual(p80.m0,p81.m0);
  const capture=()=>all.arenas.map((a,index)=>({index,used:a.used,capacity:a.memory.buffer.byteLength,
    sha256:digest(new Uint8Array(a.memory.buffer,0,a.used))}));
  const initialBytes=capture();
  function checkBytes() {
    const actual=api.getWorkerData({cold,p1:p10,...Object.fromEntries(NAMES.map(name=>[`p8_${name}`,p80[name]])),
      ...Object.fromEntries(fresh.flatMap((record,g)=>NAMES.map(name=>[`f${g}_${name}`,record[name]])))},{copy:false});
    assert.equal(actual.arenas.length,all.arenas.length);
    for(let i=0;i<all.arenas.length;i++) {
      assert.equal(actual.arenas[i].id,all.arenas[i].id);assert.equal(actual.arenas[i].memory,all.arenas[i].memory);
      assert.equal(actual.arenas[i].used,all.arenas[i].used);
    }
    assert.deepEqual(capture(),initialBytes);
    return {passed:true,arenas:initialBytes};
  }
  return {variants,payload,descriptors,checkBytes,manifest:{sourceArenaCount:all.arenas.length,
    totalCommittedBytes:committed.reduce((a,b)=>a+b,0),maxArenaCommittedBytes:Math.max(...committed),
    publicArenaCountsVerified:true,sourceBytesStable:true,sourceByteManifest:initialBytes,
    fixtureValueSHA256:digest(JSON.stringify({numeric:KEYS.map((_,i)=>i),objects:[0,1].map(v=>NAMES.map((_,j)=>KEYS.map((_,i)=>objectOracle(j,i,v)))),
      fresh:[0,1].map(g=>NAMES.map((_,j)=>KEYS.map((_,i)=>objectOracle(j,i,g,true))))})),
    capacityUse:'fixture-validation-only; no comparative memory claim'}};
}
