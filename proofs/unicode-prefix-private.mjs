import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {keys,canonical,referenceHash,verifyFixtures,fixture,encoder} from './unicode-prefix-common.mjs';
const S=await import(pathToFileURL(process.argv[2]).href);
const {Arena,arenaOf}=S;
verifyFixtures();let checks=0;
const fresh=(type='number',a=new Arena())=>new S.SharedMap(type,0,0,a);
const copy=m=>new S.SharedMap(m.valueType,m.root,m.size,new Arena({copy:arenaOf(m).copy(),used:arenaOf(m).used,readOnly:true}));
const published=a=>a.buf.slice(65536,a.used);
const corpus=keys();
let base=fresh();const model=new Map();
for(const [i,k] of corpus.entries()){base=base.set(k,i);model.set(canonical(k),i);}
const reader=copy(base),a=arenaOf(reader),before=published(a);
for(const key of corpus){
  const leaf=a.findUncached(base.root,key);
  assert.notEqual(leaf,0);assert.equal(a.dv.getUint32(leaf+4,true),referenceHash(key));
  assert.equal(a.lastReadAscii,[...key].every(c=>c.charCodeAt(0)<128));assert.equal(a.leafValue('number',leaf),model.get(canonical(key)));
  checks+=4;
}
assert.deepEqual(published(a),before);assert.equal(a.findUncached(0,'abc界'),0);assert.equal(a.lastReadAscii,false);
assert.equal(a.findUncached(0,''),0);assert.equal(a.lastReadAscii,true);
// Natural ReadCache entry saturation and prefix 8/12-bit boundary.
let many=fresh('object');const entries=Array.from({length:16385},(_,i)=>['p'+i.toString(36).padStart(4,'0')+'é',{i}]);
many=many.setMany(entries);const ar=arenaOf(many);
for(let i=0;i<16384;i++) assert.deepEqual(many.get(entries[i][0]),{i});
assert.equal(ar.reads.slots.size,16384);
assert.deepEqual(many.get(entries[16384][0]),{i:16384});assert.equal(ar.reads.slot(entries[16384][0]),undefined);assert.equal(ar.prefixBits,12);
const smaller=many.delete(entries[16384][0]);assert.equal(ar.findUncached(smaller.root,'absent/界'),0);assert.equal(ar.prefixBits,8);
assert.equal(ar.findUncached(many.root,entries[16384][0])!==0,true);assert.equal(ar.prefixBits,12);
const original=entries[1][0],oldLeaf=ar.find(many.root,original),fork=many.set('fork/界',{i:-1});
assert.equal(ar.find(fork.root,original),oldLeaf);
const overwrite=fork.set(original,{i:-2});assert.deepEqual(overwrite.get(original),{i:-2});assert.deepEqual(many.get(original),{i:1});
assert.equal(overwrite.delete(original).has(original),false);assert.deepEqual(many.get(original),{i:1});checks+=15;
// Character budget exactly reached, followed by a nonadmitted key.
let chars=fresh('object').setMany([['a'.repeat(65535),{i:1}],['b'.repeat(65536),{i:2}],['x',{i:3}],['é',{i:4}]]);
for(const k of ['a'.repeat(65535),'b'.repeat(65536),'x']) chars.get(k);
const ca=arenaOf(chars);assert.equal(ca.reads.chars,131072);chars.get('é');assert.equal(ca.reads.slot('é'),undefined);checks+=2;
// Primitive value-cache entry saturation, then raw-surrogate vs canonical spelling.
let primitive=fresh().setMany(entries.map(([k],i)=>[k,i]));
for(let i=0;i<16384;i++)primitive.get(entries[i][0]);
const pa=arenaOf(primitive);assert.equal(pa.valueMap.size,16384);primitive.get(entries[16384][0]);assert.equal(pa.valueMap.has(entries[16384][0]),false);
const alias='prefix/\ud800',normal=canonical(alias),aliases=fresh().set(alias,7),aa=arenaOf(aliases);
assert.equal(aliases.get(alias),7);assert.equal(aa.valueMap.has(alias),false);assert.equal(aa.valueMap.has(normal),true);
assert.equal(aliases.has(alias),true);assert.equal(aliases.get(normal),7);checks+=7;
// Value bytes saturate at 1 MiB; the uncached present value remains readable.
let strings=fresh('string').setMany([['p/界','x'.repeat(524288)],['q/界','tail']]);strings.get('p/界');
const sa=arenaOf(strings);assert.equal(sa.valueMapBytes,1048576);assert.equal(strings.get('q/界'),'tail');assert.equal(sa.valueMap.has('q/界'),false);checks+=3;
// Manual low-level valid journals: pending override/base hit/miss/zero base.
const ja=new Arena();let jm=fresh('number',ja).set('base/界',1).set('same/界',2);
const old=ja.leaf('number','same/界',9),z=ja.leaf('number',fixture.zero.key,0);
function journal(base,leaves,size){const p=ja.alloc(16+4*leaves.length),dv=ja.dv;dv.setUint32(p,0xffffffff,true);dv.setUint32(p+4,base,true);dv.setUint32(p+8,size,true);dv.setUint32(p+12,leaves.length,true);leaves.forEach((q,i)=>dv.setUint32(p+16+4*i,q,true));return p;}
const jr=journal(jm.root,[old,z],3),emptyBase=journal(0,[z],1);
assert.equal(ja.findUncached(jr,'same/界'),old);assert.equal(ja.leafValue('number',ja.findUncached(jr,'base/界')),1);
assert.equal(ja.findUncached(jr,'missing/界'),0);assert.equal(ja.findUncached(jr,fixture.zero.key),z);assert.equal(ja.findUncached(emptyBase,fixture.zero.key),z);checks+=5;
// Bounded malformed copies preserve raw-byte mismatch rather than decoded alias equality.
const good=fresh().set('p/�',1),ga=arenaOf(good),leaf=ga.find(good.root,'p/�');
function malformed(change){const bytes=ga.copy(),v=new DataView(bytes.buffer);change(bytes,v,leaf);return new Arena({copy:bytes,used:ga.used,readOnly:true});}
const badUtf=malformed((b,v,p)=>{b[p+18]=0xff;});
assert.equal(badUtf.findUncached(good.root,'p/�'),0);
const badHash=malformed((b,v,p)=>v.setUint32(p+4,(referenceHash('p/�')+1)>>>0,true));assert.equal(badHash.findUncached(good.root,'p/�'),0);
const badLength=malformed((b,v,p)=>v.setUint32(p+8,999,true));assert.equal(badLength.findUncached(good.root,'p/�'),0);
assert.throws(()=>badLength.findUncached(badLength.memory.buffer.byteLength-2,'p/�'),RangeError);checks+=4;
// Shared reader refresh after writer growth; copied readers keep their own immutable extent.
const writer=fresh().set('retained/界',5),wa=arenaOf(writer),sharedArena=new Arena({memory:wa.memory,used:wa.used,readOnly:true});
const shared=new S.SharedMap('number',writer.root,writer.size,sharedArena),copied=copy(writer);
assert.equal(shared.get('retained/界'),5);const publishedBefore=published(wa),capacity=wa.memory.buffer.byteLength;
wa.alloc(capacity+65536);assert.ok(wa.memory.buffer.byteLength>capacity);
const changed=writer.set('new/界',6),newReader=new S.SharedMap('number',changed.root,changed.size,sharedArena);
assert.equal(newReader.get('new/界'),6);assert.equal(shared.get('retained/界'),5);assert.equal(copied.get('retained/界'),5);
assert.deepEqual(wa.buf.slice(65536,65536+publishedBefore.length),publishedBefore);assert.throws(()=>shared.set('x',1),/read-only/);checks+=7;
console.log(JSON.stringify({suite:'private',checks,keys:corpus.length,entry:process.argv[2]}));

