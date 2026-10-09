// Untimed mechanism probes only. Transparent intrinsic wrappers are restored after each call.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {encoder,canonical,fixture,verifyFixtures} from './unicode-prefix-common.mjs';
const S=await import(pathToFileURL(process.argv[2]).href),arm=process.argv[3];
assert.ok(['baseline','candidate'].includes(arm));verifyFixtures();
const {Arena,arenaOf}=S, rows=[];
const expected=key=>{
  const p=[...Array(key.length).keys()].find(i=>key.charCodeAt(i)>127);
  return p===undefined?key.length:encoder.encode(key).length+(arm==='baseline'?p:0);
};
function probe(label,key,run,want,encodes){
  const imul=Math.imul,encode=TextEncoder.prototype.encode,desc=Object.getOwnPropertyDescriptor(Arena.prototype,'dv');
  let steps=0,calls=0,encodedBytes=0,views=0,result;
  Math.imul=(x,y)=>{steps++;return imul(x,y);};
  TextEncoder.prototype.encode=function(text){calls++;const bytes=encode.call(this,text);encodedBytes+=bytes.length;return bytes;};
  Object.defineProperty(Arena.prototype,'dv',{...desc,get(){views++;return desc.get.call(this);}});
  try{result=run();}finally{Math.imul=imul;TextEncoder.prototype.encode=encode;Object.defineProperty(Arena.prototype,'dv',desc);}
  assert.equal(steps,want,label+' FNV steps');assert.equal(calls,encodes,label+' encoder calls');
  rows.push({label,keyCodeUnits:key.length,keyBytes:encoder.encode(key).length,steps,encodes:calls,encodedBytes,views});
  return result;
}
const direct=['','abc','é','s:é','a'.repeat(8)+'界','a'.repeat(64)+'🙂','a'.repeat(256)+'界','a'.repeat(4096)+'é',fixture.zero.key,...fixture.collision.map(x=>x.key),'prefix/\ud800'];
for(const key of direct){
  const a=new Arena(),leaf=a.leaf('number',key,7);
  assert.equal(probe('direct-'+direct.indexOf(key),key,()=>a.findUncached(leaf,key),expected(key),/[^\x00-\x7f]/.test(key)?1:0),leaf);
  assert.equal(rows.at(-1).views,1);
}
const fresh=key=>new S.SharedMap('number',0,0,new Arena()).set(key,7);
for(const key of ['ascii','é','a'.repeat(64)+'界']){
  const m=fresh(key);
  assert.equal(probe('public-cold-get',key,()=>m.get(key),expected(key),/[^\x00-\x7f]/.test(key)?1:0),7);
  assert.equal(probe('public-warm-get',key,()=>m.get(key),0,0),7);
  assert.equal(probe('public-warm-has',key,()=>m.has(key),0,0),true);
  const miss=key+'missing';
  assert.equal(probe('public-repeat-miss',miss,()=>m.get(miss),expected(miss),/[^\x00-\x7f]/.test(miss)?1:0),undefined);
  assert.equal(probe('public-repeat-miss-again',miss,()=>m.get(miss),expected(miss),/[^\x00-\x7f]/.test(miss)?1:0),undefined);
}
const raw='prefix/\ud800',normal=canonical(raw),m=fresh(raw);
for(let i=0;i<2;i++)assert.equal(probe('raw-alias-repeat-'+i,raw,()=>m.get(raw),expected(raw),2),7);
assert.equal(probe('canonical-warm-alias',normal,()=>m.get(normal),0,0),7);
const presentKey='present/界',present=fresh(presentKey);
assert.equal(probe('PRESENT-has',presentKey,()=>present.has(presentKey),expected(presentKey),1),true);
assert.equal(probe('PRESENT-get',presentKey,()=>present.get(presentKey),expected(presentKey),1),7);
const short='short/界',sm=fresh(short);
assert.equal(probe('short-delete-control',short,()=>sm.delete(short),0,1).size,0);
const long='a'.repeat(49150)+'界',lm=fresh(long);
assert.equal(probe('long-delete-cold',long,()=>lm.delete(long),expected(long),2).size,0);
const cached=fresh(long);arenaOf(cached).find(cached.root,long);
assert.equal(probe('long-delete-ReadCache-hit',long,()=>cached.delete(long),0,1).size,0);
const sorted=new S.SharedSortedMap('number').set('sorted/界',3);sorted.get('sorted/界');
assert.equal(probe('sorted-warm-control','sorted/界',()=>sorted.get('sorted/界'),0,0),3);
console.log(JSON.stringify({suite:'mechanism',arm,rows}));

