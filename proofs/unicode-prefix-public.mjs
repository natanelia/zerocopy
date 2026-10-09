import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {keys,canonical,verifyFixtures,fixture} from './unicode-prefix-common.mjs';
const S=await import(pathToFileURL(process.argv[2]).href);
verifyFixtures();
const corpus=keys();
let checks=0;
for(const C of [S.SharedMap,S.SharedOrderedMap]){
  let map=new C('number'); const model=new Map();
  for(const [i,key] of corpus.entries()){map=map.set(key,i);model.set(canonical(key),i);}
  assert.equal(map.size,model.size);
  for(const key of corpus){assert.equal(map.has(key),true);assert.equal(map.get(key),model.get(canonical(key)));checks+=2;}
  const old=map, oldExpected=[...old.entries()], fork=old.set('retained/界',-17);
  for(const [i,key] of corpus.entries()) if(i%7===0) map=map.delete(key);
  assert.deepEqual([...old.entries()],oldExpected);
  assert.equal(old.has('retained/界'),false);assert.equal(fork.get('retained/界'),-17);
  assert.equal(old.delete('absent/é'),old);
  for(const key of [fixture.zero.key,...fixture.collision.map(x=>x.key)]){
    const withKeys=old.set(key,999);assert.equal(withKeys.get(key),999);assert.equal(old.get(key),model.get(key));
    assert.equal(withKeys.delete(key).has(key),false);checks+=3;
  }
  for(const key of ['a'.repeat(32)+'界','\ud800','\ufffd','']){
    for(const [type,values] of [['number',[NaN,-0,0,Infinity,-Infinity]],['boolean',[false,true]],['string',['','a\0\ufeff界']],['object',[{a:[1,'界'],b:{x:true}}]]]){
      for(const v of values){
        const m=new C(type).set(key,v);assert.equal(m.has(key),true);assert.deepEqual(m.get(key),v);assert.deepEqual(m.get(canonical(key)),v);
        if(type==='object'){assert.equal(Object.isFrozen(m.get(key)),true);assert.equal(Object.isFrozen(m.get(key).b),true);}
        const changed=m.set('new/é',v);assert.deepEqual(m.get(key),v);assert.equal(changed.has(key),true);checks+=5;
      }
    }
    const inner=new S.SharedList('string').pushMany(['nested','界']);
    const m=new C('SharedList<string>').set(key,inner);assert.deepEqual(m.get(key).toArray(),['nested','界']);checks++;
  }
  for(const B of [49151,49152,49153]){
    const key='a'.repeat(B-3)+'界',m=new C('string').set(key,'boundary');
    const d=m.delete(key);assert.equal(d.has(key),false);assert.equal(m.get(key),'boundary');assert.equal(m.delete(key+'missing').size,m.size);
    m.get(key);assert.equal(m.delete(key).size,0);checks+=4;
  }
  for(const bad of [42,new String('a'),{toString(){throw Error('coercion');}}]){
    const empty=new C('number');
    for(const method of ['get','has','delete']) assert.throws(()=>empty[method](bad),TypeError);
    checks+=3;
  }
}
for(const C of [S.SharedSet,S.SharedOrderedSet]){
  let set=new C().add('a'.repeat(16)+'界').add('\ud800').add(1).add('1').add(NaN).add(-0);
  assert.equal(set.has('a'.repeat(16)+'界'),true);assert.equal(set.has('\ufffd'),true);assert.equal(set.has('\ud800'),true);
  assert.equal(set.has(1),true);assert.equal(set.has('1'),true);assert.equal(set.has(0),true);assert.equal(set.has(NaN),true);
  const old=set;set=set.delete('a'.repeat(16)+'界');assert.equal(old.has('a'.repeat(16)+'界'),true);assert.equal(set.has('a'.repeat(16)+'界'),false);checks+=9;
}
const sorted=new S.SharedSortedMap('number').set('a'.repeat(64)+'界',3);
assert.equal(sorted.get('a'.repeat(64)+'界'),3);assert.equal(sorted.delete('a'.repeat(64)+'界').size,0);
assert.equal(new S.SharedSortedSet().add('界').has('界'),true);
console.log(JSON.stringify({suite:'public',checks:checks+3,keys:corpus.length,fixtures:'verified',entry:process.argv[2]}));

