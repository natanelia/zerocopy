import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
export const fixture=JSON.parse(readFileSync(new URL('./unicode-prefix-fixtures.json',import.meta.url)));
export const encoder=new TextEncoder(), decoder=new TextDecoder('utf-8',{ignoreBOM:true});
export const canonical=s=>decoder.decode(encoder.encode(s));
export function referenceHash(key){
  let h=2166136261n;
  for(const b of encoder.encode(key)) h=((h^BigInt(b))*16777619n)&0xffffffffn;
  return Number(h);
}
export const offsets=[0,1,2,7,8,15,16,31,32,63,64,255,256,4096];
export const suffixes=['é','界','🙂','\ufeff','e\u0301','\ud800','\udc00','\ud800x','\udc00\ud800','🙂\ud800','\ufffd'];
export function keys(){
  const out=['','ascii','\0','\x7f'];
  for(const [i,p] of offsets.entries()){
    const prefix=i%2?'a'.repeat(p):Array.from({length:p},(_,j)=>String.fromCharCode(j%128)).join('');
    for(const s of suffixes) out.push(prefix+s+'z\0');
    out.push(prefix);
  }
  return [...new Set([...out,fixture.zero.key,...fixture.collision.map(x=>x.key),'costarring界','liquid界'])];
}
export function verifyFixtures(){
  for(const f of [fixture.zero,...fixture.collision]){
    assert.deepEqual([...encoder.encode(f.key)],f.utf8);
    assert.equal(referenceHash(f.key),f.hash);
  }
  assert.equal(fixture.zero.hash,0);
  assert.equal(fixture.collision[0].hash,fixture.collision[1].hash);
  assert.notEqual(fixture.collision[0].key,fixture.collision[1].key);
  assert.equal(fixture.collision[0].utf8.length,fixture.collision[1].utf8.length);
  assert.equal(referenceHash('costarring界'),referenceHash('liquid界'));
}
export function valuesEqual(actual,expected){assert.deepEqual(actual,expected);}

