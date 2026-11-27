// Proof only: independently owned spatial bands, stable external keys.
import * as base from './dynamic-runtime.mjs';
import {SharedMap,resetMap,resetSharedList,getWorkerData,initWorker} from '../../dist/shared.js';
import {key} from './lane-fixture.mjs';
const partitioned=m=>m.startsWith('partition');
const count=8, inner='append-repack-direct';
const band=(r,width)=>Math.max(0,Math.min(count-1,Math.floor(r.bottom/width)));
function envelope(old,rows){let lo=old.lo,hi=old.hi;for(const r of rows){lo=Math.min(lo,r.bottom);hi=Math.max(hi,r.top);}return {lo,hi};}
export function build(mode,rows){
  if(!partitioned(mode))return base.build(mode,rows);
  const width=Math.max(1,Math.ceil(rows.length/64/count)*12), groups=Array.from({length:count},()=>[]),entries=[];
  for(const r of rows){const b=band(r,width);groups[b].push(r);entries.push([key(r.id),b]);}
  resetMap();const routing=new SharedMap('number').setMany(entries);
  const shards=groups.map(g=>{resetMap();resetSharedList();return base.build(inner,g);});
  return {width,routing,shards,extents:groups.map(g=>envelope({lo:Infinity,hi:-Infinity},g))};
}
export function edit(mode,o,batch){
  if(!partitioned(mode))return base.edit(mode,o,batch);
  const ops=Array.from({length:count},()=>({remove:[],upsert:[]})),adds=[],deletes=[];
  for(const id of batch.remove){const old=o.routing.get(key(id));if(old===undefined)throw Error('missing routed deletion');ops[old].remove.push(id);deletes.push(key(id));}
  for(const [id,r] of batch.upsert){
    const old=o.routing.get(key(id)),next=band(r,o.width);
    if(old!==undefined&&old!==next)ops[old].remove.push(id);
    if(old!==next)adds.push([key(id),next]);
    ops[next].upsert.push([id,r]);
  }
  const routing=o.routing.deleteMany(deletes).setMany(adds);
  const shards=o.shards.map((s,i)=>ops[i].remove.length||ops[i].upsert.length?base.edit(inner,s,ops[i]):s);
  return {...o,routing,shards,extents:o.extents.map((e,i)=>envelope(e,ops[i].upsert.map(x=>x[1])))};
}
const needs=s=>s.columns.id.size>0&&base.shouldRepack(inner,0,s);
export function shouldRepack(mode,rev,o){return partitioned(mode)?mode.startsWith('partition-repack')&&o.shards.some(needs):base.shouldRepack(mode,rev,o);}
export function repack(mode,o){return partitioned(mode)?{...o,shards:o.shards.map(s=>needs(s)?base.repack(inner,s):s)}:base.repack(mode,o);}
export function arenaUsage(o,mode){
  if(!partitioned(mode))return base.arenaUsage(o,mode);
  const d=getWorkerData({routing:o.routing},{copy:false}),all=[...d.arenas.map(a=>({id:a.id,used:a.used,capacity:a.memory.buffer.byteLength})),...o.shards.flatMap(s=>base.arenaUsage(s,inner))];
  return [...new Map(all.map(a=>[a.id,a])).values()];
}
export function payload(mode,o){
  if(!partitioned(mode))return base.payload(mode,o);
  const routing=getWorkerData({routing:o.routing},{copy:false}),shards=o.shards.map(s=>base.payload(inner,s)),arenas=arenaUsage(o,mode);
  return {wire:{routing,shards:shards.map(s=>s.wire),extents:o.extents},memory:{used:arenas.reduce((s,a)=>s+a.used,0),capacity:arenas.reduce((s,a)=>s+a.capacity,0),slots:shards.reduce((s,a)=>s+a.memory.slots,0),coordinateSlots:shards.reduce((s,a)=>s+a.memory.coordinateSlots,0),free:0}};
}
export async function attach(mode,p,prev){
  if(!partitioned(mode))return base.attach(mode,p,prev);
  const routed=await initWorker(p.routing,{previous:prev?.routed}),shards=[];
  for(let i=0;i<p.shards.length;i++)shards.push(await base.attach(inner,p.shards[i],prev?.shards[i]));
  return {routed,routing:routed.routing,shards,extents:p.extents};
}
export function get(mode,s,id){if(!partitioned(mode))return base.get(mode,s,id);const b=s.routing.get(key(id));return b===undefined?undefined:base.get(inner,s.shards[b],id);}
export function size(mode,s){if(!partitioned(mode))return base.size(mode,s);const actual=s.shards.reduce((n,t)=>n+base.size(inner,t),0);if(actual!==s.routing.size)throw Error('routing size mismatch');return actual;}
export function scan(mode,s,q){if(!partitioned(mode))return base.scan(mode,s,q);return s.shards.flatMap((t,i)=>s.extents[i].lo<=q.top&&s.extents[i].hi>=q.bottom?base.scan(inner,t,q):[]).sort((a,b)=>a[0]-b[0]);}
