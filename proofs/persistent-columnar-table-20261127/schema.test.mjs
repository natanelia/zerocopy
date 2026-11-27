import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSchema} from './schema-runtime.mjs';
const schema=compileSchema({id:'string',label:'string?',value:'number?',flag:'boolean',xy:'number[]?'});
const a={id:'道路/🛣️',label:'道路\0é',value:null,flag:false,xy:[1,2,3,4]};
const b={id:'b',label:null,value:0,flag:true,xy:[]};
const c={id:'c',label:'',value:2,flag:true,xy:null};
test('typed schema nulls, UTF8, empty arrays, retained roots, forks and worker attachment',async()=>{
  const old=schema.build([a,b,c]),reader=await schema.attach(structuredClone(schema.wire(old)));
  const a2={...a,label:null,value:3,xy:[4,3,2,1]},b2={...b,xy:[5,6]},d={...c,id:'d',label:'新'};
  const next=schema.edit(old,{remove:['c'],upsert:[[a.id,a2],['b',b2],['d',d]]});
  const attached=await schema.attach(structuredClone(schema.wire(next)),reader);
  for(const row of [a,b,c])assert.deepEqual(schema.get(reader,row.id),row);
  for(const row of [a2,b2,d])assert.deepEqual(schema.get(attached,row.id),row);
  assert.equal(schema.get(attached,'c'),undefined);
  assert.equal(schema.size(attached),3);
  assert.equal(schema.slotCount(attached),4);
  const fork=schema.edit(old,{remove:['b'],upsert:[[a.id,{...a,xy:null}]]});
  assert.equal(schema.get(fork,a.id).xy,null);
  assert.deepEqual(schema.get(old,a.id),a);
  const empty=schema.edit(next,{remove:[a.id,'b','d'],upsert:[]});
  assert.equal(schema.size(empty),0);
  assert.deepEqual(schema.get(next,a.id),a2);
  await assert.rejects(compileSchema({id:'string',label:'string'}).attach(schema.wire(old)),/schema mismatch/);
});
test('invalid rows and duplicate operations fail without changing existing snapshots',()=>{
  const old=schema.build([a,b,c]);
  for(const invalid of [{...a,value:NaN},{...a,xy:[Infinity]},{...a,flag:1},{...a,label:undefined},{...a,extra:1}]){
    assert.throws(()=>schema.edit(old,{remove:[],upsert:[[a.id,invalid]]}),TypeError);
  }
  assert.throws(()=>schema.edit(old,{remove:[a.id],upsert:[[a.id,a]]}),/duplicate/);
  assert.throws(()=>schema.build([a,a]),/duplicate/);
  assert.throws(()=>schema.edit(old,{remove:['missing'],upsert:[]}),/deletion/);
  assert.deepEqual(schema.get(old,a.id),a);
});

test('packed ingestion is equivalent to original build across types, nulls, empty rows, subsequent edits and retained roots',async()=>{
  const rows=[a,b,c],old=schema.buildPacked(rows),original=schema.build(rows);
  const reader=await schema.attach(structuredClone(schema.wire(old)));
  for(const row of rows){assert.deepEqual(schema.get(old,row.id),schema.get(original,row.id));assert.deepEqual(schema.get(reader,row.id),row);}
  const change={remove:['b'],upsert:[[a.id,{...a,value:4,xy:[-0,8]}],['d',{...c,id:'d',xy:[]}]]};
  const next=schema.edit(old,change),expected=schema.edit(original,change);
  for(const id of [a.id,'b','c','d'])assert.deepEqual(schema.get(next,id),schema.get(expected,id));
  assert.deepEqual(schema.get(reader,a.id),a);
  assert.equal(schema.size(schema.buildPacked([])),0);
  assert.throws(()=>schema.buildPacked([a,a]),/duplicate/);
  assert.throws(()=>schema.buildPacked([a,{...b,xy:[NaN]}]),TypeError);
  const collision=compileSchema({id:'string'},()=> 'same');
  assert.throws(()=>collision.buildPacked([{id:'a'},{id:'b'}]),/duplicate/);
});
