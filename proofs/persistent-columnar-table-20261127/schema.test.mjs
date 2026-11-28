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


test('direct full-row reads match original on retained, current and attached roots; return independent objects',async()=>{
  const old=schema.buildPacked([a,b,c]),reader=await schema.attach(structuredClone(schema.wire(old)));
  const d={...a,id:'d',xy:[-0,7]},next=schema.edit(old,{remove:['b'],upsert:[['d',d]]},true,undefined,true);
  const attached=await schema.attach(structuredClone(schema.wire(next)),reader);
  for(const root of [old,reader,next,attached])for(const id of [a.id,'b','c','d','missing']){
    const expected=schema.get(root,id),actual=schema.get(root,id,undefined,true);
    assert.deepEqual(actual,expected);
    if(actual){assert.deepEqual(Object.keys(actual),Object.keys(expected));assert.equal(Object.getPrototypeOf(actual),Object.prototype);}
  }
  const detached=schema.get(attached,'d',undefined,true);detached.xy[0]=99;detached.label='changed';
  assert.deepEqual(schema.get(attached,'d',undefined,true),{...d,xy:[0,7]});
  assert.deepEqual(schema.get(reader,a.id,undefined,true),a);
  const reordered=compileSchema({flag:'boolean',id:'string',xy:'number[]?'});
  const r={flag:false,id:'🛣️',xy:[]},s=reordered.buildPacked([r]);
  assert.deepEqual(Object.keys(reordered.get(s,r.id,undefined,true)),['flag','id','xy']);
  assert.deepEqual(reordered.get(s,r.id,undefined,true),r);
  const collision=compileSchema({id:'string'},()=> 'same');
  assert.throws(()=>collision.get(collision.buildPacked([{id:'a'}]),'b',undefined,true),/identity/);
});

for(const bulkRanges of [false,true])test(`live-column repack (${bulkRanges?'range':'scalar'}) resets slots and ranges, preserves old attachments and supports subsequent edits`,async()=>{
  const old=schema.buildPacked([a,b,c]),reader=await schema.attach(structuredClone(schema.wire(old)));
  const d={...a,id:'d',xy:[-0,7,8]},changed={...c,xy:[1,2],label:'道路'};
  const before=schema.edit(old,{remove:['b'],upsert:[['c',changed],['d',d]]},true,undefined,true);
  const beforeReader=await schema.attach(structuredClone(schema.wire(before)),reader);
  const packed=schema.repack(before,bulkRanges);
  assert.equal(schema.slotCount(packed),3);
  assert.equal(schema.size(packed),3);
  const afterReader=await schema.attach(structuredClone(schema.wire(packed)),beforeReader);
  for(const id of [a.id,'b','c','d','missing']){
    assert.deepEqual(schema.get(packed,id),schema.get(before,id));
    assert.deepEqual(schema.get(afterReader,id),schema.get(beforeReader,id));
  }
  const beforeIds=schema.arenaUsage(before).map(x=>x.id),afterIds=schema.arenaUsage(packed).map(x=>x.id);
  assert(afterIds.every(id=>!beforeIds.includes(id)));
  const later=schema.edit(packed,{remove:[a.id],upsert:[['d',{...d,xy:null}],['e',{...b,id:'e'}]]},true,undefined,true);
  const again=schema.repack(later,bulkRanges),last=await schema.attach(structuredClone(schema.wire(again)),afterReader);
  assert.equal(schema.slotCount(last),3);
  for(const id of [a.id,'b','c','d','e'])assert.deepEqual(schema.get(last,id),schema.get(later,id));
  assert.deepEqual(schema.get(reader,'b'),b);
  assert.deepEqual(schema.get(beforeReader,'d'),{...d,xy:[0,7,8]});
  assert.deepEqual(schema.get(afterReader,'c'),changed);
  const empty=schema.repack(schema.edit(again,{remove:['c','d','e'],upsert:[]}),bulkRanges);
  assert.equal(schema.size(empty),0);assert.equal(schema.slotCount(empty),0);
});


test('range gather preserves numeric identities, gaps, reordered payloads, nullable values and historical readers',async()=>{
  const t=compileSchema({id:'number',value:'number?',xy:'number[]?',links:'number[]'});
  const rows=Array.from({length:31},(_,id)=>({id,value:id%3===0?null:id,xy:id%4===0?null:id%5===0?[]:[id,id+1],links:[id]}));
  const old=t.buildPacked(rows),reader=await t.attach(structuredClone(t.wire(old)));
  const changed={...rows[2],xy:[9,8,7],links:[42,43]};
  const inserted={id:31,value:0,xy:[],links:[]};
  const before=t.edit(old,{remove:[1,4,7],upsert:[[2,changed],[31,inserted]]},true,undefined,true);
  const scalar=t.repack(before),range=t.repack(before,true),attached=await t.attach(structuredClone(t.wire(range)),reader);
  assert.equal(t.slotCount(range),29);
  for(let id=0;id<=31;id++){
    assert.deepEqual(t.get(range,id),t.get(scalar,id));
    assert.deepEqual(t.get(attached,id),t.get(before,id));
    assert.deepEqual(t.get(reader,id),rows[id]);
  }
  assert.deepEqual(t.get(range,2),changed);
  assert.deepEqual(t.get(range,31),inserted);
});


test('four isolated shard arenas and staggered repacks preserve previous roots, routing and scan results',async()=>{
  const api=await import('./schema-lane-runtime.mjs');
  const {mixedLane,mixedQuery}=await import('./lane-fixture.mjs');
  const baseline='schema-mixed-packed-column-bulk-range-repack48',stagger='schema-mixed-packed-column-bulk-range-shard-stagger-repack48',sync='schema-mixed-packed-column-bulk-range-shard-sync-repack48';
  const rows=Array.from({length:32},(_,i)=>mixedLane(i));
  const ids=Array.from({length:40},(_,i)=>i);
  const old=api.build(stagger,rows),reader=await api.attach(stagger,structuredClone(api.payload(stagger,old).wire));
  const originalArenas=api.arenaUsage(old,stagger).map(a=>a.id);
  assert.equal(new Set(originalArenas).size,8);
  let x=old,y=api.build(baseline,rows),z=api.build(sync,rows);
  const fresh=mixedLane(32),changed={...rows[1],roadName:'道路🌏',connections:[]};
  const batch={remove:[0,4],upsert:[[32,fresh],[1,changed],[33,mixedLane(33)]]};
  x=api.edit(stagger,x,batch);y=api.edit(baseline,y,batch);z=api.edit(sync,z,batch);
  assert.equal(api.size(stagger,x),32);
  let attached=reader;
  for(let rev=12;rev<=96;rev+=12){
    assert(api.shouldRepack(stagger,rev,x));
    const before=api.arenaUsage(x,stagger).map(a=>a.id);
    x=api.repack(stagger,x,rev);
    const after=api.arenaUsage(x,stagger).map(a=>a.id);
    assert.equal(after.filter(id=>!before.includes(id)).length,2);
    if(rev%48===0){
      const oldSync=api.arenaUsage(z,sync).map(a=>a.id);
      z=api.repack(sync,z,rev);y=api.repack(baseline,y,rev);
      assert.equal(api.arenaUsage(z,sync).filter(a=>!oldSync.includes(a.id)).length,8);
    }
    attached=await api.attach(stagger,structuredClone(api.payload(stagger,x).wire),attached);
    for(const id of ids){
      assert.deepEqual(api.get(stagger,x,id),api.get(baseline,y,id));
      assert.deepEqual(api.get(stagger,attached,id),api.get(baseline,y,id));
      assert.deepEqual(api.get(sync,z,id),api.get(baseline,y,id));
      assert.deepEqual(api.get(stagger,reader,id),rows[id]);
    }
    const q=mixedQuery(32,rev,0);
    assert.deepEqual(api.scan(stagger,attached,q),api.scan(baseline,y,q));
  }
  assert(!api.shouldRepack(stagger,13,x));
  assert.equal(api.payload(stagger,x).memory.slots,32);
  assert.throws(()=>api.edit(stagger,x,{remove:[0],upsert:[]}),/deletion/);
});

test('quiet shard compaction respects deadlines and old roots for 4/8 shards',async()=>{
  const api=await import('./schema-lane-runtime.mjs');
  const {mixedLane,mixedQuery}=await import('./lane-fixture.mjs');
  const base='schema-mixed-packed-column-bulk-range-shard-stagger-';
  for(const count of [4,8]){
    const mode=base+'quiet-'+(count===8?'eight-':'')+'repack48';
    const rows=Array.from({length:32},(_,i)=>mixedLane(i));
    let owner=api.build(mode,rows),previous=await api.attach(mode,structuredClone(api.payload(mode,owner).wire));
    const old=previous,original=api.arenaUsage(owner,mode).map(a=>a.id),interval=48/count;
    assert.equal(new Set(original).size,2*count);
    const expected=new Map(rows.map(r=>[r.id,r])),events=[];
    for(let rev=1;rev<=96;rev++){
      const id=rev%32,row={...expected.get(id),reviewed:rev%2===0};
      expected.set(id,row);owner=api.edit(mode,owner,{remove:[],upsert:[[id,row]]});
      const work=rev<=48?{removed:rev%4===0?1:0,changed:1,scan:rev%3===0}:{removed:1,changed:10000,scan:true};
      if(api.shouldRepack(mode,rev,owner,work)){
        const before=api.arenaUsage(owner,mode).map(a=>a.id);
        owner=api.repack(mode,owner,rev,work);
        const after=api.arenaUsage(owner,mode).map(a=>a.id);
        assert.equal(after.filter(id=>!before.includes(id)).length,2);
        const due=(events.length+1)*interval;
        assert(rev>=due-2&&rev<=due);
        if(rev>48)assert.equal(rev,due);
        events.push(rev);
        previous=await api.attach(mode,structuredClone(api.payload(mode,owner).wire),previous);
        for(const [id,r] of expected)assert.deepEqual(api.get(mode,previous,id),r);
      }
      assert.equal(api.size(mode,owner),32);
    }
    assert.equal(events.length,count*2);
    assert(events.some((rev,i)=>rev<(i+1)*interval));
    assert(api.arenaUsage(owner,mode).every(a=>!original.includes(a.id)));
    const last=await api.attach(mode,structuredClone(api.payload(mode,owner).wire),previous);
    for(const [id,r] of expected)assert.deepEqual(api.get(mode,last,id),r);
    for(const r of rows)assert.deepEqual(api.get(mode,old,r.id),r);
    assert.deepEqual(api.scan(mode,last,mixedQuery(32,96,0)),api.scan(mode,owner,mixedQuery(32,96,0)));
  }
});
