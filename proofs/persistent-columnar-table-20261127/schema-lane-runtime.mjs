// Compare a reusable schema with the prior hand-written lane implementation.
import * as base from './dynamic-runtime.mjs';
import {compileSchema} from './schema-runtime.mjs';
import {key,matches,validate,mixedMode,mixedMatches,validateMixed} from './lane-fixture.mjs';
const table=compileSchema({id:'number',kind:'number',active:'boolean',left:'number',bottom:'number',right:'number',top:'number',xy:'number[]'},key);
const mixedTable=compileSchema({id:'number',kind:'number',active:'boolean',left:'number',bottom:'number',right:'number',top:'number',xy:'number[]',roadName:'string?',speedLimit:'number?',reviewed:'boolean',connections:'number[]?'},key);
const typed=m=>m.startsWith('schema-');
const tableFor=m=>mixedMode(m)?mixedTable:table;
export const build=(m,rows)=>typed(m)?(m.includes('packed')?tableFor(m).buildPacked(rows):tableFor(m).build(rows)):base.build(m,rows);
export const edit=(m,o,b,profile)=>typed(m)?tableFor(m).edit(o,b,m.includes('-bulk'),profile,m.includes('-column-bulk')):base.edit(m,o,b);
export const get=(m,s,id,profile)=>typed(m)?tableFor(m).get(s,id,profile,m.includes('-direct-row')):base.get(m,s,id);
export const size=(m,s)=>typed(m)?tableFor(m).size(s):base.size(m,s);
export const shouldRepack=(m,rev,o)=>typed(m)?false:base.shouldRepack(m,rev,o);
export const repack=(m,o)=>typed(m)?o:base.repack(m,o);
export const arenaUsage=(o,m)=>typed(m)?tableFor(m).arenaUsage(o):base.arenaUsage(o,m);
export function payload(m,o){
  if(!typed(m))return base.payload(m,o);
  const table=tableFor(m),wire=table.wire(o),a=wire.data.arenas;
  return {wire,memory:{used:a.reduce((s,x)=>s+x.used,0),capacity:a.reduce((s,x)=>s+x.memory.buffer.byteLength,0),slots:table.slotCount(o),coordinateSlots:null,free:0}};
}
export const attach=(m,p,prev)=>typed(m)?tableFor(m).attach(p,prev):base.attach(m,p,prev);
export function scan(m,s,q){
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
