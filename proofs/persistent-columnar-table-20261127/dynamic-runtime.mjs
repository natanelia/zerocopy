// Proof-only schema integration using existing persistent vectors and key index.
// No format or production API change. Dense slot numbers are private, never row identities.
import {SharedMap,SharedList,getWorkerData,initWorker,resetMap,resetSharedList,compact} from '../../dist/shared.js';
import {key,schema,fields,matches,validate} from './lane-fixture.mjs';
const names=['id','occupied','capacity',...fields];
const isJSON=m=>m.startsWith('json'),isNative=m=>m==='native';
const slotReuse=m=>m.startsWith('reuse');
const spanReuse=m=>m.startsWith('reuse-span');
const meta=(r,start,capacity=r.xy.length)=>({id:r.id,occupied:true,capacity,left:r.left,bottom:r.bottom,right:r.right,top:r.top,start,count:r.xy.length,kind:r.kind,active:r.active});
const colType=f=>f==='occupied'||schema[f]==='boolean'?'boolean':'number';
function checkRow(id,r){
  if(!Number.isSafeInteger(id)||id<0||r.id!==id||!Array.isArray(r.xy)||r.xy.length<4||r.xy.length%2||r.xy.some(x=>!Number.isFinite(x)))throw new TypeError('invalid lane');
  if(typeof r.active!=='boolean'||!Number.isInteger(r.kind)||r.kind<0||r.kind>255||['left','right','top','bottom'].some(f=>!Number.isFinite(r[f])))throw new TypeError('invalid lane metadata');
}
export function build(mode,rows){
  const seen=new Set();for(const r of rows){checkRow(r.id,r);if(seen.has(r.id))throw Error('duplicate id');seen.add(r.id);}
  if(isNative(mode))return {map:new Map(rows.map(r=>[key(r.id),r]))};
  if(isJSON(mode))return {map:new SharedMap('object').setMany(rows.map(r=>[key(r.id),r]))};
  const index=new SharedMap('number').setMany(rows.map((r,i)=>[key(r.id),i]));
  const packed=new Float64Array(rows.reduce((s,r)=>s+r.xy.length,0)),metadata=[];let at=0;
  for(const r of rows){metadata.push(meta(r,at));packed.set(r.xy,at);at+=r.xy.length;}
  return {index,coords:new SharedList('number').pushMany(packed),columns:Object.fromEntries(names.map(f=>[f,new SharedList(colType(f)).pushMany(metadata.map(r=>r[f]))])),free:[]};
}
function slotMeta(s,i){return Object.fromEntries(names.map(f=>[f,s.columns[f].get(i)]));}
function findSlot(mode,s,id){
  const i=s.index.get(key(id));
  if(i===undefined)return undefined;
  if(s.columns.id.get(i)!==id||!s.columns.occupied.get(i))throw Error('slot identity mismatch');
  return i;
}
function materialize(s,m){
  const xy=new Float64Array(m.count);s.coords.copyToFloat64Array(xy,{start:m.start,end:m.start+m.count});
  return {id:m.id,kind:m.kind,active:m.active,left:m.left,bottom:m.bottom,right:m.right,top:m.top,xy:Array.from(xy)};
}
export function get(mode,s,id){
  if(isNative(mode)||isJSON(mode))return s.map.get(key(id));
  const i=findSlot(mode,s,id);return i===undefined?undefined:materialize(s,slotMeta(s,i));
}
export function size(mode,s){return isNative(mode)||isJSON(mode)?s.map.size:s.index.size;}
export function edit(mode,owner,{remove,upsert}){
  // Validate a whole batch before allocating. A delete and upsert of the same
  // external id is ambiguous in this small proof; reject it, as well as duplicates.
  const seen=new Set();
  for(const id of remove){
    if(seen.has(id)||!(isNative(mode)||isJSON(mode)?owner.map.has(key(id)):findSlot(mode,owner,id)!==undefined))throw Error('invalid delete');
    seen.add(id);
  }
  for(const [id,r] of upsert){checkRow(id,r);if(seen.has(id))throw Error('duplicate or overlapping operation');seen.add(id);}
  if(isNative(mode)){
    const map=new Map(owner.map);for(const id of remove)map.delete(key(id));for(const [id,r] of upsert)map.set(key(id),r);return {map};
  }
  if(isJSON(mode))return {map:owner.map.deleteMany(remove.map(key)).setMany(upsert.map(([id,r])=>[key(id),r]))};
  const old=owner.coords,patches=[],appends=[],indexAdds=[],free=owner.free.slice(),changes=new Map(),newRows=[];
  const startSlots=owner.columns.id.size;let next=old.size;
  for(const id of remove){
    const slot=findSlot(mode,owner,id);
    changes.set(slot,{occupied:false});
    if(slotReuse(mode))free.push(slot);
  }
  for(const [id,r] of upsert){
    let slot=findSlot(mode,owner,id),existing=slot!==undefined;
    if(!existing){
      slot=slotReuse(mode)&&free.length?free.pop():startSlots+newRows.length;
      indexAdds.push([key(id),slot]);
    }
    const prior=slot<startSlots?slotMeta(owner,slot):undefined;
    let start,capacity;
    // Same-length edits in all modes patch the vector. Reuse-span additionally
    // reuses the old capacity even across row replacement or a shorter line.
    if(prior&&(existing&&prior.count===r.xy.length||spanReuse(mode)&&prior.capacity>=r.xy.length)){
      start=prior.start;capacity=spanReuse(mode)?prior.capacity:r.xy.length;
      for(let j=0;j<r.xy.length;j++)if(!Object.is(old.get(start+j),r.xy[j]))patches.push([start+j,r.xy[j]]);
    }else{
      start=next;capacity=r.xy.length;next+=capacity;for(const v of r.xy)appends.push(v);
    }
    const target=meta(r,start,capacity);
    if(prior){
      const patch=Object.fromEntries(names.filter(f=>!Object.is(prior[f],target[f])).map(f=>[f,target[f]]));
      // Prior occupied=true for a slot deleted and immediately reused, so
      // replace its pending occupied=false change, even if true was unchanged.
      changes.set(slot,patch);
    }else newRows.push(target);
  }
  let coords=patches.length?old.setMany(patches):old;if(appends.length)coords=coords.pushMany(Float64Array.from(appends));
  const index=owner.index.deleteMany(remove.map(key)).setMany(indexAdds);
  const columns={...owner.columns};
  for(const f of names){
    const batch=[...changes].filter(([,p])=>Object.hasOwn(p,f)).map(([i,p])=>[i,p[f]]);
    let c=columns[f];if(batch.length)c=c.setMany(batch);if(newRows.length)c=c.pushMany(newRows.map(r=>r[f]));columns[f]=c;
  }
  return {index,coords,columns,free};
}
export function payload(mode,o){
  if(isNative(mode))return {wire:{map:o.map},memory:null};
  const structures=isJSON(mode)?{map:o.map}:{index:o.index,coords:o.coords,...o.columns};
  const data=getWorkerData(structures,{copy:false});
  return {wire:{data},memory:{used:data.arenas.reduce((s,a)=>s+a.used,0),capacity:data.arenas.reduce((s,a)=>s+a.memory.buffer.byteLength,0),
    slots:o.columns?.id.size??null,coordinateSlots:o.coords?.size??null,free:o.free?.length??null}};
}
export async function attach(mode,p,prev){
  if(isNative(mode))return p;
  const attached=await initWorker(p.data,{previous:prev?.attached});
  if(isJSON(mode))return {attached,map:attached.map};
  return {attached,index:attached.index,coords:attached.coords,columns:Object.fromEntries(names.map(f=>[f,attached[f]]))};
}
export function scan(mode,s,q){
  const out=[];
  if(mode==='json-direct'||mode==='json-compact'){
    for(const v of s.map.valuesView()){
      if(v.get('active')!==true||v.get('kind')!==q.kind)continue;
      const r={active:true,kind:q.kind,left:v.get('left'),right:v.get('right'),bottom:v.get('bottom'),top:v.get('top')};
      if(matches(r,q)){r.id=v.get('id');r.xy=v.get('xy').toObject();out.push(validate(r));}
    }
  }else if(isNative(mode)||isJSON(mode)){
    for(const r of s.map.values())if(matches(r,q))out.push(validate(r));
  }else{
    const c=s.columns;
    for(let i=0;i<c.id.size;i++){
      if(!c.occupied.get(i)||!c.active.get(i)||c.kind.get(i)!==q.kind)continue;
      const m=slotMeta(s,i);if(matches(m,q))out.push(validate(materialize(s,m)));
    }
  }
  out.sort((a,b)=>a[0]-b[0]);return out;
}

/** Proof only: rebuild just live rows into fresh arenas. Resetting module defaults
 * is safe only in this dedicated single-owner proof, not a production API.
 * Published handles and attached workers keep the old arenas alive. */
export function repack(mode,owner){
  if(isNative(mode))throw Error('no native repack');
  if(isJSON(mode)){
    const map=compact(owner.map);resetMap();return {map};
  }
  if(mode.startsWith('append-repack-direct'))return repackDirect(owner);
  const rows=[],slots=Array.from(owner.index.values()).sort((a,b)=>a-b);
  for(const i of slots){
    const m=slotMeta(owner,i);
    if(!m.occupied||owner.index.get(key(m.id))!==i)throw Error('invalid live slot');
    rows.push(materialize(owner,m));
  }
  resetMap();resetSharedList();
  return build(mode,rows);
}
// Copy live ranges directly into one preallocated packed numeric array. Avoid
// materializing each geometry as a JS array and re-validating its coordinates.
// This still copies coordinates and rebuilds the key index; not zero-copy export.
function repackDirect(owner){
  const slots=Array.from(owner.index.values()).sort((a,b)=>a-b),n=slots.length,c=owner.columns;
  let length=0;
  for(const i of slots){
    const count=c.count.get(i),start=c.start.get(i);
    if(!c.occupied.get(i)||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(count)||count<4||count%2||start+count>owner.coords.size)throw Error('invalid live range');
    length+=count;
  }
  const packed=new Float64Array(length),metadata=Object.fromEntries(names.map(f=>[f,new Array(n)])),indexEntries=new Array(n);
  let at=0;
  for(let j=0;j<n;j++){
    const i=slots[j],id=c.id.get(i),count=c.count.get(i),start=c.start.get(i);
    if(owner.index.get(key(id))!==i)throw Error('invalid live slot');
    owner.coords.copyToFloat64Array(packed,{start,end:start+count,offset:at});
    for(const f of names)metadata[f][j]=f==='start'?at:f==='capacity'?count:c[f].get(i);
    indexEntries[j]=[key(id),j];at+=count;
  }
  resetMap();resetSharedList();
  return {index:new SharedMap('number').setMany(indexEntries),coords:new SharedList('number').pushMany(packed),
    columns:Object.fromEntries(names.map(f=>[f,new SharedList(colType(f)).pushMany(metadata[f])])),free:[]};
}
export function shouldRepack(mode,rev,owner){
  if(mode==='json-compact')return rev>0&&rev%24===0;
  return mode.startsWith('append-repack')&&owner.columns.id.size>=Math.ceil(owner.index.size*1.5);
}
export function arenaUsage(o,mode){
  if(isNative(mode))return [];
  const data=getWorkerData(isJSON(mode)?{map:o.map}:{index:o.index,coords:o.coords,...o.columns},{copy:false});
  return data.arenas.map(a=>({id:a.id,used:a.used,capacity:a.memory.buffer.byteLength}));
}
