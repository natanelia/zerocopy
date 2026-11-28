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

test('packed bulk payload appends preserve exact rows, old roots and mixed length changes',async()=>{
  const old=schema.buildPacked([a,b,c]),reader=await schema.attach(structuredClone(schema.wire(old)));
  const d={...a,id:'new',xy:[-0,4,5]},a2={...a,xy:[8,7,6,5]},b2={...b,xy:[1,2]},c2={...c,xy:[]};
  const batches=[
    {remove:[],upsert:[[a.id,a2],['b',b2],['c',c2],['new',d]]},
    {remove:['b'],upsert:[[a.id,{...a2,xy:null}],['c',{...c2,xy:[9]}],['new',{...d,xy:[0,6]}]]},
    {remove:[],upsert:[[a.id,{...a2,xy:[]}],['c',{...c2,xy:[3]}]]}
  ];
  let x=old,y=old,previous=reader;
  for(const batch of batches){
    x=schema.edit(x,batch,true);y=schema.edit(y,batch);
    previous=await schema.attach(structuredClone(schema.wire(x)),previous);
    for(const id of [a.id,'b','c','new']){
      assert.deepEqual(schema.get(x,id),schema.get(y,id));
      assert.deepEqual(schema.get(previous,id),schema.get(y,id));
    }
  }
  assert.deepEqual(schema.get(reader,a.id),a);
  assert.deepEqual(schema.get(reader,'b'),b);
  assert.throws(()=>schema.edit(old,{remove:[],upsert:[[a.id,{...a,xy:[Infinity]}]]},true),TypeError);
  assert.throws(()=>schema.edit(old,{remove:[a.id],upsert:[[a.id,a]]},true),/duplicate/);
});

test('direct fresh-column append matches ordinary planner, offsets, fallback, errors and historical snapshots',async()=>{
  const old=schema.buildPacked([a,b,c]),reader=await schema.attach(structuredClone(schema.wire(old)));
  const d={...a,id:'d',xy:[-0,4]},e={...b,id:'e',xy:null},f={...c,id:'f',xy:[]};
  const batches=[
    {remove:['b'],upsert:[['d',d],['e',e],['f',f]]},
    {remove:[],upsert:[['g',{...d,id:'g',xy:[6,7,8]}]]},
    {remove:['c'],upsert:[['d',{...d,xy:[9]}],['h',{...a,id:'h'}]]},
    {remove:['e'],upsert:[]}
  ];
  let x=old,y=old,previous=reader;
  for(const batch of batches){
    x=schema.edit(x,batch,true,undefined,true);y=schema.edit(y,batch,true);
    previous=await schema.attach(structuredClone(schema.wire(x)),previous);
    assert.equal(schema.size(x),schema.size(y));
    assert.equal(schema.slotCount(x),schema.slotCount(y));
    for(const id of [a.id,'b','c','d','e','f','g','h']){
      assert.deepEqual(schema.get(x,id),schema.get(y,id));
      assert.deepEqual(schema.get(previous,id),schema.get(y,id));
    }
  }
  assert.deepEqual(schema.get(reader,a.id),a);
  assert.deepEqual(schema.get(reader,'b'),b);
  assert.throws(()=>schema.edit(old,{remove:[],upsert:[['d',{...d,xy:[Infinity]}]]},true,undefined,true),TypeError);
  assert.throws(()=>schema.edit(old,{remove:[],upsert:[['d',d],['d',d]]},true,undefined,true),/duplicate/);
  assert.throws(()=>schema.edit(old,{remove:['missing'],upsert:[['d',d]]},true,undefined,true),/deletion/);
  const collision=compileSchema({id:'string'},()=> 'same');
  const root=collision.buildPacked([{id:'a'}]);
  assert.throws(()=>collision.edit(root,{remove:[],upsert:[['b',{id:'b'}]]},true,undefined,true),/identity/);
  assert.deepEqual(collision.get(root,'a'),{id:'a'});
});
