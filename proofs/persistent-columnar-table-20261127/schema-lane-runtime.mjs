// Compare a reusable schema with the prior hand-written lane implementation.
import * as base from './dynamic-runtime.mjs';
import {compileSchema} from './schema-runtime.mjs';
import {key,matches,validate} from './lane-fixture.mjs';
const table=compileSchema({id:'number',kind:'number',active:'boolean',left:'number',bottom:'number',right:'number',top:'number',xy:'number[]'},key);
const typed=m=>m.startsWith('schema-');
export const build=(m,rows)=>typed(m)?table.build(rows):base.build(m,rows);
export const edit=(m,o,b)=>typed(m)?table.edit(o,b):base.edit(m,o,b);
export const get=(m,s,id)=>typed(m)?table.get(s,id):base.get(m,s,id);
export const size=(m,s)=>typed(m)?table.size(s):base.size(m,s);
export const shouldRepack=(m,rev,o)=>typed(m)?false:base.shouldRepack(m,rev,o);
export const repack=(m,o)=>typed(m)?o:base.repack(m,o);
export const arenaUsage=(o,m)=>typed(m)?table.arenaUsage(o):base.arenaUsage(o,m);
export function payload(m,o){
  if(!typed(m))return base.payload(m,o);
  const wire=table.wire(o),a=wire.data.arenas;
  return {wire,memory:{used:a.reduce((s,x)=>s+x.used,0),capacity:a.reduce((s,x)=>s+x.memory.buffer.byteLength,0),slots:table.slotCount(o),coordinateSlots:null,free:0}};
}
export const attach=(m,p,prev)=>typed(m)?table.attach(p,prev):base.attach(m,p,prev);
export function scan(m,s,q){
  if(!typed(m))return base.scan(m,s,q);
  const out=[];
  for(let i=0;i<table.slotCount(s);i++){
    if(!table.isLive(s,i)||!table.readAt(s,i,'active')||table.readAt(s,i,'kind')!==q.kind)continue;
    if(table.readAt(s,i,'left')>q.right||table.readAt(s,i,'right')<q.left||table.readAt(s,i,'bottom')>q.top||table.readAt(s,i,'top')<q.bottom)continue;
    const r=table.rowAt(s,i);if(matches(r,q))out.push(validate(r));
  }
  return out.sort((a,b)=>a[0]-b[0]);
}
