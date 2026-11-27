import test from 'node:test';
import assert from 'node:assert/strict';
import {build,edit,get,size,payload,attach,scan,repack,arenaUsage} from './dynamic-runtime.mjs';
import {lane,bounds} from './lane-fixture.mjs';
const modes=['append','reuse-slots','reuse-span','reuse-span-control','json-direct','native'];
function shorten(r){const xy=r.xy.slice(0,4);return {...r,xy,...bounds(xy)};}
function longer(r){const xy=[...r.xy,...r.xy];return {...r,xy,...bounds(xy)};}
test('dynamic identities, exact historical roots, forks, free slots, and reused variable geometry',async()=>{
  const initial=Array.from({length:65},(_,i)=>lane(i));
  const a0=initial[0],a31=initial[31],a64=initial[64],b100=shorten(lane(100)),b101=longer(lane(101)),b102=lane(102);
  for(const mode of modes){
    const a=build(mode,initial),old=await attach(mode,structuredClone(payload(mode,a).wire));
    const b=edit(mode,a,{remove:[0,31],upsert:[[100,b100],[101,b101],[64,shorten(a64)]]});
    const c=edit(mode,b,{remove:[100],upsert:[]});
    const d=edit(mode,c,{remove:[],upsert:[[102,b102],[101,shorten(b101)]]});
    const fork=edit(mode,b,{remove:[101],upsert:[[102,b102]]});
    const reader=await attach(mode,structuredClone(payload(mode,d).wire),old);
    assert.deepEqual(get(mode,old,0),a0);assert.deepEqual(get(mode,old,31),a31);assert.deepEqual(get(mode,old,64),a64);
    assert.deepEqual(get(mode,b,100),b100);assert.deepEqual(get(mode,b,101),b101);assert.equal(get(mode,c,100),undefined);
    assert.deepEqual(get(mode,d,102),b102);assert.deepEqual(get(mode,reader,101),shorten(b101));assert.equal(get(mode,reader,0),undefined);
    assert.equal(get(mode,fork,101),undefined);assert.deepEqual(get(mode,b,101),b101);assert.equal(size(mode,d),65);
    if(mode.startsWith('reuse'))assert.equal(payload(mode,d).memory.slots,65);
    if(mode==='append')assert.equal(payload(mode,d).memory.slots,68);
    assert.throws(()=>edit(mode,d,{remove:[0],upsert:[]}),/delete/);
    assert.throws(()=>edit(mode,d,{remove:[102],upsert:[[102,b102]]}),/overlapping/);
    const q={left:-Infinity,right:Infinity,bottom:-Infinity,top:Infinity,kind:2};
    const native=build('native',initial),expected=edit('native',edit('native',edit('native',native,{remove:[0,31],upsert:[[100,b100],[101,b101],[64,shorten(a64)]]}),{remove:[100],upsert:[]}),{remove:[],upsert:[[102,b102],[101,shorten(b101)]]});
    assert.deepEqual(scan(mode,reader,q),scan('native',expected,q));
  }
});
test('reused capacity and old geometry independent',()=>{
  const r=lane(0),small=shorten({...lane(500),id:500});
  const a=build('reuse-span',[r]),b=edit('reuse-span',a,{remove:[0],upsert:[[500,small]]});
  assert.equal(payload('reuse-span',a).memory.coordinateSlots,payload('reuse-span',b).memory.coordinateSlots);
  assert.deepEqual(get('reuse-span',a,0),r);assert.deepEqual(get('reuse-span',b,500),small);
  assert.equal(get('reuse-span',b,0),undefined);
});

test('repacking live identities into fresh arenas retains old worker views and forks',async()=>{
  for(const mode of ['append-repack','json-compact']){
    const rows=Array.from({length:65},(_,i)=>lane(i)),a=build(mode,rows),old=await attach(mode,structuredClone(payload(mode,a).wire));
    const b=edit(mode,a,{remove:[0,31],upsert:[[100,lane(100)],[101,lane(101)]]});
    const before=arenaUsage(b,mode),held=await attach(mode,structuredClone(payload(mode,b).wire),old);
    const c=repack(mode,b),after=arenaUsage(c,mode);
    assert(after.every(x=>!before.some(y=>y.id===x.id)));
    const current=await attach(mode,structuredClone(payload(mode,c).wire),held);
    assert.equal(size(mode,current),65);assert.equal(get(mode,current,0),undefined);assert.deepEqual(get(mode,old,0),rows[0]);
    assert.deepEqual(get(mode,current,100),lane(100));assert.deepEqual(get(mode,held,101),lane(101));
    if(mode.startsWith('append'))assert.equal(payload(mode,c).memory.slots,65);
    const fork=edit(mode,b,{remove:[100],upsert:[[102,lane(102)]]});
    assert.equal(get(mode,fork,100),undefined);assert.deepEqual(get(mode,c,100),lane(100));
    const d=edit(mode,c,{remove:[101],upsert:[[103,lane(103)]]});
    assert.deepEqual(get(mode,d,103),lane(103));assert.deepEqual(get(mode,held,101),lane(101));
    const q={left:-Infinity,right:Infinity,bottom:-Infinity,top:Infinity,kind:2};
    assert.deepEqual(scan(mode,current,q),scan(mode,held,q));
  }
});
