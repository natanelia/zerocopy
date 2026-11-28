// Compare a reusable schema with the prior hand-written lane implementation.
import * as base from './dynamic-runtime.mjs';
import {resetMap,resetSharedList} from '../../dist/shared.js';
import {compileSchema} from './schema-runtime.mjs';
import {key,matches,validate,mixedMode,mixedMatches,validateMixed} from './lane-fixture.mjs';
const table=compileSchema({id:'number',kind:'number',active:'boolean',left:'number',bottom:'number',right:'number',top:'number',xy:'number[]'},key);
const mixedTable=compileSchema({id:'number',kind:'number',active:'boolean',left:'number',bottom:'number',right:'number',top:'number',xy:'number[]',roadName:'string?',speedLimit:'number?',reviewed:'boolean',connections:'number[]?'},key);
const typed=m=>m.startsWith('schema-');
const tableFor=m=>mixedMode(m)?mixedTable:table;
// Four independent map/list arena pairs. Numeric fixture ids choose a stable
// shard, never a physical slot. Global reset is only for this isolated writer
// when allocating a fresh shard; existing roots retain their own arena.
const shardCount=4,sharded=m=>m.includes('-shard-'),stagger=m=>m.includes('-shard-stagger-');
const shardOf=id=>{if(!Number.isSafeInteger(id)||id<0)throw TypeError('invalid shard identity');return id%shardCount;};
const shardMode='schema-mixed-packed-column-bulk-range-repack48';
export function build(m,rows){
  if(!sharded(m))return typed(m)?(m.includes('packed')?tableFor(m).buildPacked(rows):tableFor(m).build(rows)):base.build(m,rows);
  const groups=Array.from({length:shardCount},()=>[]);
  for(const row of rows)groups[shardOf(row.id)].push(row);
  return {shards:groups.map(group=>{resetMap();resetSharedList();return build(shardMode,group);})};
}
export function edit(m,o,b,profile){
  if(!sharded(m))return typed(m)?tableFor(m).edit(o,b,m.includes('-bulk'),profile,m.includes('-column-bulk')):base.edit(m,o,b);
  const groups=Array.from({length:shardCount},()=>({remove:[],upsert:[]}));
  for(const id of b.remove)groups[shardOf(id)].remove.push(id);
  for(const entry of b.upsert)groups[shardOf(entry[0])].upsert.push(entry);
  return {shards:o.shards.map((s,i)=>groups[i].remove.length||groups[i].upsert.length?edit(shardMode,s,groups[i]):s)};
}
export const get=(m,s,id,profile)=>sharded(m)?get(shardMode,s.shards[shardOf(id)],id,profile):typed(m)?tableFor(m).get(s,id,profile,m.includes('-direct-row')):base.get(m,s,id);
export const size=(m,s)=>sharded(m)?s.shards.reduce((n,x)=>n+size(shardMode,x),0):typed(m)?tableFor(m).size(s):base.size(m,s);
// Matched fixed cadence is an experimental control, not a production policy.
export const shouldRepack=(m,rev,o)=>stagger(m)?rev>0&&rev%12===0:m.endsWith('-repack48')?rev>0&&rev%48===0:typed(m)?false:base.shouldRepack(m,rev,o);
export function repack(m,o,rev){
  if(!sharded(m))return typed(m)?tableFor(m).repack(o,m.includes('-range-')):base.repack(m,o);
  if(!shouldRepack(m,rev,o))throw Error('unexpected shard repack');
  const selected=(rev/12-1)%shardCount;
  return {shards:o.shards.map((s,i)=>!stagger(m)||selected===i?repack(shardMode,s):s)};
}
export const arenaUsage=(o,m)=>sharded(m)?o.shards.flatMap(s=>arenaUsage(s,shardMode)):typed(m)?tableFor(m).arenaUsage(o):base.arenaUsage(o,m);
export function payload(m,o){
  if(sharded(m)){
    const parts=o.shards.map(s=>payload(shardMode,s));
    const sum=key=>parts.reduce((n,x)=>n+x.memory[key],0);
    return {wire:{shards:parts.map(p=>p.wire)},memory:{used:sum('used'),capacity:sum('capacity'),slots:sum('slots'),coordinateSlots:null,free:0}};
  }
  if(!typed(m))return base.payload(m,o);
  const table=tableFor(m),wire=table.wire(o),a=wire.data.arenas;
  return {wire,memory:{used:a.reduce((s,x)=>s+x.used,0),capacity:a.reduce((s,x)=>s+x.memory.buffer.byteLength,0),slots:table.slotCount(o),coordinateSlots:null,free:0}};
}
export async function attach(m,p,prev){
  if(!sharded(m))return typed(m)?tableFor(m).attach(p,prev):base.attach(m,p,prev);
  if(!Array.isArray(p.shards)||p.shards.length!==shardCount)throw Error('invalid shard wire');
  const shards=[];
  for(let i=0;i<shardCount;i++)shards.push(await attach(shardMode,p.shards[i],prev?.shards[i]));
  return {shards};
}
export function scan(m,s,q){
  if(sharded(m))return s.shards.flatMap(x=>scan(shardMode,x,q)).sort((a,b)=>a[0]-b[0]);
  const mixed=mixedMode(m);
  if(!typed(m)){
    if(!mixed)return base.scan(m,s,q);
    const out=[];
    if(m==='json-mixed-full'){
      for(const r of s.map.values())if(mixedMatches(r,q))out.push(validateMixed(r));
    }else{
      for(const v of s.map.valuesView()){
        if(v.get('active')!==true||v.get('kind')!==q.kind)continue;
        if(v.get('left')>q.right||v.get('right')<q.left||v.get('bottom')>q.top||v.get('top')<q.bottom)continue;
        if(q.reviewedOnly&&v.get('reviewed')!==true)continue;
        if(q.minimumSpeed){const speed=v.get('speedLimit');if(speed===null||speed<q.minimumSpeed)continue;}
        const r=v.toObject();if(mixedMatches(r,q))out.push(validateMixed(r));
      }
    }
    return out.sort((a,b)=>a[0]-b[0]);
  }
  const table=tableFor(m),out=[];
  for(let i=0;i<table.slotCount(s);i++){
    if(!table.isLive(s,i)||!table.readAt(s,i,'active')||table.readAt(s,i,'kind')!==q.kind)continue;
    if(table.readAt(s,i,'left')>q.right||table.readAt(s,i,'right')<q.left||table.readAt(s,i,'bottom')>q.top||table.readAt(s,i,'top')<q.bottom)continue;
    if(mixed){
      if(q.reviewedOnly&&table.readAt(s,i,'reviewed')!==true)continue;
      if(q.minimumSpeed){const speed=table.readAt(s,i,'speedLimit');if(speed===null||speed<q.minimumSpeed)continue;}
    }
    const r=table.rowAt(s,i);if((mixed?mixedMatches:matches)(r,q))out.push((mixed?validateMixed:validate)(r));
  }
  return out.sort((a,b)=>a[0]-b[0]);
}
