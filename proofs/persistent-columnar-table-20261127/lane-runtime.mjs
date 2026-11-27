import {SharedMap,SharedList,getWorkerData,initWorker} from '../../dist/shared.js';
import {ColumnTable,openPublisher,openReader} from './table-paged-session.mjs';
import {key,schema,fields,matches,validate} from './lane-fixture.mjs';
const tableMode=m=>m.startsWith('table-'),jsonMode=m=>m.startsWith('json'),shared=m=>m!=='native';
const meta=(r,start)=>({left:r.left,bottom:r.bottom,right:r.right,top:r.top,start,count:r.xy.length,kind:r.kind,active:r.active});
export function build(mode,rows){
  if(mode==='native')return {map:new Map(rows.map(r=>[key(r.id),r]))};
  if(jsonMode(mode))return {map:new SharedMap('object').setMany(rows.map(r=>[key(r.id),r]))};
  const index=new SharedMap('number').setMany(rows.map(r=>[key(r.id),r.id]));
  const total=rows.reduce((s,r)=>s+r.xy.length,0),packed=new Float64Array(total),metadata=[];let at=0;
  for(const r of rows){metadata.push(meta(r,at));packed.set(r.xy,at);at+=r.xy.length;}
  const coords=new SharedList('number').pushMany(packed);
  if(tableMode(mode)){
    const table=ColumnTable.fromRows(schema,metadata,{blockRows:Number(mode.split('-')[1])});
    return {index,coords,table,publisher:openPublisher(table)};
  }
  const columns=Object.fromEntries(fields.map(f=>[f,new SharedList(schema[f]==='boolean'?'boolean':'number').pushMany(metadata.map(r=>r[f]))]));
  return {index,coords,columns};
}
function getMeta(mode,s,i){
  if(tableMode(mode))return s.table.rowDirect(i);
  return Object.fromEntries(fields.map(f=>[f,s.columns[f].get(i)]));
}
function materialize(s,i,m){
  const xy=new Float64Array(m.count);
  s.coords.copyToFloat64Array(xy,{start:m.start,end:m.start+m.count});
  return {id:i,kind:m.kind,active:m.active,left:m.left,bottom:m.bottom,right:m.right,top:m.top,xy:Array.from(xy)};
}
export function edit(mode,owner,edits){
  if(mode==='native'){const map=new Map(owner.map);for(const [i,r] of edits)map.set(key(i),r);return {map};}
  if(jsonMode(mode))return {map:owner.map.setMany(edits.map(([i,r])=>[key(i),r]))};
  const old=owner.coords,patches=[],appends=[],changes=[];let next=old.size;
  for(const [i,r] of edits){
    const m=getMeta(mode,owner,i);let start=m.start;
    if(m.count===r.xy.length){
      for(let j=0;j<m.count;j++)if(old.get(start+j)!==r.xy[j])patches.push([start+j,r.xy[j]]);
    }else{start=next;next+=r.xy.length;for(const v of r.xy)appends.push(v);}
    const target=meta(r,start),patch=Object.fromEntries(fields.filter(f=>!Object.is(m[f],target[f])).map(f=>[f,target[f]]));
    if(Object.keys(patch).length)changes.push([i,patch]);
  }
  let coords=patches.length?old.setMany(patches):old;if(appends.length)coords=coords.pushMany(Float64Array.from(appends));
  if(tableMode(mode))return {...owner,coords,table:owner.table.editMany(changes)};
  const columns={...owner.columns};
  for(const f of fields){const batch=changes.filter(([,p])=>Object.hasOwn(p,f)).map(([i,p])=>[i,p[f]]);if(batch.length)columns[f]=columns[f].setMany(batch);}
  return {...owner,coords,columns};
}
export function payload(mode,o,first){
  if(mode==='native')return {wire:{map:o.map},memory:null};
  const structures=jsonMode(mode)?{map:o.map}:tableMode(mode)?{index:o.index,coords:o.coords}:{index:o.index,coords:o.coords,...o.columns};
  const data=getWorkerData(structures,{copy:false}),d=tableMode(mode)?o.table.descriptor():null;
  return {wire:{data,table:d?(first?o.publisher.initial():o.publisher.publish(o.table)):undefined},
    memory:{used:data.arenas.reduce((s,a)=>s+a.used,0)+(d?.used??0),capacity:data.arenas.reduce((s,a)=>s+a.memory.buffer.byteLength,0)+(d?.memory.buffer.byteLength??0),columnUsed:d?.used??null}};
}
export async function attach(mode,p,prev){
  if(mode==='native')return p;
  const attached=await initWorker(p.data,{previous:prev?.attached});
  if(jsonMode(mode))return {attached,map:attached.map};
  const {index,coords}=attached;
  if(tableMode(mode)){
    const reader=prev?.reader??openReader(p.table);
    const table=prev?reader.accept(p.table):reader.snapshot;
    return {attached,index,coords,reader,table};
  }
  return {attached,index,coords,columns:Object.fromEntries(fields.map(f=>[f,attached[f]]))};
}
export function get(mode,s,i){
  if(mode==='native'||jsonMode(mode))return s.map.get(key(i));
  const id=s.index.get(key(i));if(id!==i)throw Error('index mismatch');
  return materialize(s,id,getMeta(mode,s,id));
}
export function scan(mode,s,n,q){
  const out=[];
  if(mode==='json-direct'||mode==='json-direct-control'){
    for(const v of s.map.valuesView()){
      if(v.get('active')!==true||v.get('kind')!==q.kind)continue;
      const r={active:true,kind:q.kind,left:v.get('left'),right:v.get('right'),bottom:v.get('bottom'),top:v.get('top')};
      if(matches(r,q)){r.id=v.get('id');r.xy=v.get('xy').toObject();out.push(validate(r));}
    }
  }else if(mode==='native'||jsonMode(mode)){
    for(const r of s.map.values())if(matches(r,q))out.push(validate(r));
  }else{
    // Identical packed geometry and range-copy paths for both binary metadata arms.
    for(let i=0;i<n;i++){
      if(tableMode(mode)){
        if(s.table.get(i,'active')!==true||s.table.get(i,'kind')!==q.kind)continue;
      }else if(!s.columns.active.get(i)||s.columns.kind.get(i)!==q.kind)continue;
      const m=getMeta(mode,s,i);if(matches(m,q))out.push(validate(materialize(s,i,m)));
    }
  }
  out.sort((a,b)=>a[0]-b[0]);return out;
}
