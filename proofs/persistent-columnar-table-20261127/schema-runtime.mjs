// Proof only. Schema-defined persistent columns on the existing SharedList/Map.
// Explicit null, finite number (JSON-compatible signed zero), boolean, string,
// and variable-length numeric arrays. No JSON row encoding or new arena format.
import {SharedMap,SharedList,getWorkerData,initWorker,resetMap,resetSharedList} from '../../dist/shared.js';

export function compileSchema(definition, keyOf = id => String(id)) {
  const fields=Object.entries(definition).map(([name,type],i)=>{
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||['__proto__','constructor','prototype'].includes(name))throw TypeError('invalid field');
    const nullable=type.endsWith('?'),kind=nullable?type.slice(0,-1):type;
    if(!['number','boolean','string','number[]'].includes(kind))throw TypeError('invalid type');
    return {name,kind,nullable,root:'f'+i};
  });
  const idField=fields.find(f=>f.name==='id');
  if(!idField||idField.nullable||!['number','string'].includes(idField.kind))throw TypeError('id required');
  const signature=JSON.stringify(fields.map(f=>[f.name,f.kind,f.nullable]));
  const byName=new Map(fields.map(f=>[f.name,f]));
  const kinds={occupied:'boolean'};
  for(const f of fields){
    if(f.nullable)kinds[f.root+'p']='boolean';
    if(f.kind==='number[]'){kinds[f.root]='number';kinds[f.root+'n']='number';kinds[f.root+'a']='number';}
    else kinds[f.root]=f.kind;
  }
  const roots=Object.keys(kinds);
  const number=v=>{if(typeof v!=='number'||!Number.isFinite(v))throw TypeError('finite number required');return v===0?0:v;};
  function checkRow(id,row){
    if(!row||typeof row!=='object'||row.id!==id||Object.keys(row).length!==fields.length)throw TypeError('row shape or identity');
    for(const f of fields){
      if(!Object.hasOwn(row,f.name))throw TypeError('missing field');
      const v=row[f.name];
      if(v===null&&f.nullable)continue;
      if(f.kind==='number')number(v);
      else if(f.kind==='number[]'){if(!Array.isArray(v))throw TypeError('numeric array required');for(const x of v)number(x);}
      else if(typeof v!==f.kind)throw TypeError('invalid field type');
    }
    if(typeof id==='number'&&!Number.isSafeInteger(id))throw TypeError('invalid numeric identity');
    const key=keyOf(id);if(typeof key!=='string')throw TypeError('invalid key');return key;
  }
  const empty=()=>({index:new SharedMap('number'),columns:Object.fromEntries(roots.map(r=>[r,new SharedList(kinds[r])]))});
  const slotCount=s=>s.columns.occupied.size;
  const isLive=(s,i)=>s.columns.occupied.get(i)===true;
  function lookup(s,id){
    const i=s.index.get(keyOf(id));if(i===undefined)return undefined;
    if(!isLive(s,i)||s.columns[idField.root].get(i)!==id)throw Error('slot identity mismatch');return i;
  }
  function readAt(s,i,name){
    const f=byName.get(name);if(!f)throw TypeError('unknown field');
    return readField(s.columns,i,f);
  }
  function readField(c,i,f){
    const r=f.root;
    if(f.nullable&&!c[r+'p'].get(i))return null;
    if(f.kind!=='number[]')return c[r].get(i);
    const start=c[r].get(i),count=c[r+'n'].get(i);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||start<0||count<0||start+count>c[r+'a'].size)throw Error('invalid array range');
    const out=new Float64Array(count);
    if(count)c[r+'a'].copyToFloat64Array(out,{start,end:start+count});
    return Array.from(out);
  }
  const rowAt=(s,i)=>Object.fromEntries(fields.map(f=>[f.name,readAt(s,i,f.name)]));
  // Proof-only direct row materialization: descriptors are already resolved by
  // the schema. Avoid per-row entry arrays and repeated name lookups; retain
  // the identical field decoder, including array bounds and fresh arrays.
  function directRowAt(s,i){
    const row={},c=s.columns;
    for(const f of fields)row[f.name]=readField(c,i,f);
    return row;
  }
  const get=(s,id,profile,directRow=false)=>{
    const materialize=directRow?directRowAt:rowAt;
    if(!profile){const i=lookup(s,id);return i===undefined?undefined:materialize(s,i);}
    const start=performance.now(),i=lookup(s,id),found=performance.now();
    const value=i===undefined?undefined:materialize(s,i),end=performance.now();
    profile.lookupMs+=found-start;profile.materializeMs+=end-found;profile.count++;if(i!==undefined)profile.hits++;
    return value;
  };
  function edit(s,{remove,upsert},packedPayloads=false,profile,columnBulk=false){
    let tick=profile?performance.now():0;
    const mark=name=>{if(profile){const now=performance.now();profile[name]=now-tick;tick=now;}};
    // Validate all user inputs and key collisions before allocating.
    const seen=new Set(),deletions=[],updates=[];
    for(const id of remove){const k=keyOf(id),i=lookup(s,id);if(i===undefined||seen.has(k))throw Error('invalid deletion');seen.add(k);deletions.push([k,i]);}
    for(const [id,row] of upsert){const k=checkRow(id,row);if(seen.has(k))throw Error('duplicate operation');seen.add(k);updates.push([k,lookup(s,id),row]);}
    mark('validateLookupMs');
    // A batch containing only new rows can append whole columns directly.
    // Validation, identity lookup and duplicate detection above remain identical.
    // Existing-row edits still use the ordinary sparse/mixed planner.
    if(columnBulk&&packedPayloads&&!profile&&updates.length&&updates.every(([,old])=>old===undefined)){
      const rows=updates.map(x=>x[2]),lengths={};
      for(const f of fields)if(f.kind==='number[]'){
        let length=0;
        for(const row of rows){
          length+=row[f.name]?.length??0;
          if(!Number.isSafeInteger(length))throw RangeError('array capacity');
        }
        lengths[f.root]=length;
      }
      const c=s.columns,values=packFreshRows(rows,lengths,c),columns={...c};
      if(deletions.length)columns.occupied=columns.occupied.setMany(deletions.map(([,i])=>[i,false]));
      for(const r of roots)if(values[r].length)columns[r]=columns[r].pushMany(values[r]);
      const next=slotCount(s),additions=updates.map(([k],i)=>[k,next+i]);
      let index=s.index;
      if(deletions.length)index=index.deleteMany(deletions.map(x=>x[0]));
      index=index.setMany(additions);
      return {index,columns};
    }
    const c=s.columns,plans=Object.fromEntries(roots.map(r=>[r,{append:[],patch:[]}]));
    // Proof-only bulk append variant: count variable payloads once, allocate
    // exact typed storage and avoid growing a JS number array plus converting it.
    const payloads=new Map();
    if(packedPayloads)for(const f of fields)if(f.kind==='number[]'){
      const r=f.root;let count=0;
      for(const [,old,row] of updates){
        const length=row[f.name]?.length??0;
        if(old===undefined||c[r+'n'].get(old)!==length){
          count+=length;if(!Number.isSafeInteger(count))throw RangeError('array capacity');
        }
      }
      payloads.set(r+'a',{values:new Float64Array(count),at:0});
    }
    mark('sizePayloadMs');
    let next=slotCount(s);const additions=[];
    const write=(r,i,v,fresh)=>{
      if(fresh)plans[r].append.push(v);
      else if(!Object.is(c[r].get(i),v))plans[r].patch.push([i,v]);
    };
    for(const [,i] of deletions)write('occupied',i,false,false);
    for(const [k,old,row] of updates){
      const fresh=old===undefined,i=fresh?next++:old;
      if(fresh){additions.push([k,i]);write('occupied',i,true,true);}
      for(const f of fields){
        const r=f.root,v=row[f.name],present=v!==null;
        if(f.nullable)write(r+'p',i,present,fresh);
        if(f.kind==='number[]'){
          const a=present?v:[],prevCount=fresh?-1:c[r+'n'].get(i),prevStart=fresh?0:c[r].get(i);
          if(!fresh&&prevCount===a.length){
            for(let j=0;j<a.length;j++)write(r+'a',prevStart+j,number(a[j]),false);
          }else{
            const packed=payloads.get(r+'a');
            const start=c[r+'a'].size+(packed?packed.at:plans[r+'a'].append.length);
            write(r,i,start,fresh);write(r+'n',i,a.length,fresh);
            if(packed){
              // Values were checked before allocation; assigning into typed
              // storage still canonicalizes signed zero as the original path.
              for(const x of a)packed.values[packed.at++]=number(x);
            }else for(const x of a)plans[r+'a'].append.push(number(x));
          }
        }else{
          const value=present?(f.kind==='number'?number(v):v):f.kind==='number'?0:f.kind==='boolean'?false:'';
          write(r,i,value,fresh);
        }
      }
    }
    mark('planMs');
    const columns={...c};
    if(profile)profile.columns={};
    for(const r of roots){
      const start=profile?performance.now():0;
      const p=plans[r],packed=payloads.get(r);let col=c[r];
      if(p.patch.length)col=col.setMany(p.patch);
      if(packed){
        if(packed.at!==packed.values.length)throw Error('packed append length mismatch');
        if(packed.at)col=col.pushMany(packed.values);
      }else if(p.append.length)col=col.pushMany(r.endsWith('a')&&kinds[r]==='number'?Float64Array.from(p.append):p.append);
      columns[r]=col;
      if(profile)profile.columns[r]={ms:performance.now()-start,patch:p.patch.length,append:packed?packed.at:p.append.length};
    }
    mark('applyColumnsMs');
    let index=s.index;if(deletions.length)index=index.deleteMany(deletions.map(x=>x[0]));if(additions.length)index=index.setMany(additions);
    mark('indexMs');
    return {index,columns};
  }
  const build=rows=>edit(empty(),{remove:[],upsert:rows.map(r=>[r.id,r])});
  // Cold ingestion: validate before persistent allocation, pre-size numeric
  // payloads, then construct columns directly rather than through edit plans.
  // Keep the old build as an exact same-layout control.
  function buildPacked(rows){
    const n=rows.length,seen=new Set(),entries=new Array(n),lengths={};
    for(const f of fields)if(f.kind==='number[]')lengths[f.root]=0;
    for(let i=0;i<n;i++){
      const row=rows[i],k=checkRow(row.id,row);
      if(seen.has(k))throw Error('duplicate operation');seen.add(k);entries[i]=[k,i];
      for(const f of fields)if(f.kind==='number[]'&&row[f.name]!==null){
        const length=lengths[f.root]+row[f.name].length;
        if(!Number.isSafeInteger(length))throw RangeError('array capacity');
        lengths[f.root]=length;
      }
    }
    const values=packFreshRows(rows,lengths);
    const columns=Object.fromEntries(roots.map(r=>[r,new SharedList(kinds[r]).pushMany(values[r])]));
    return {index:new SharedMap('number').setMany(entries),columns};
  }
  function packFreshRows(rows,lengths,existing){
    const n=rows.length;
    const values=Object.fromEntries(roots.map(r=>[r,kinds[r]==='number'?new Float64Array(r.endsWith('a')?lengths[r.slice(0,-1)]:n):new Array(n)]));
    values.occupied.fill(true);
    for(const f of fields){
      const r=f.root;let at=0;
      const base=f.kind==='number[]'?(existing?.[r+'a'].size??0):0;
      for(let i=0;i<n;i++){
        const v=rows[i][f.name],present=v!==null;
        if(f.nullable)values[r+'p'][i]=present;
        if(f.kind==='number[]'){
          const a=present?v:[];values[r][i]=base+at;values[r+'n'][i]=a.length;
          for(let j=0;j<a.length;j++)values[r+'a'][at++]=number(a[j]);
        }else values[r][i]=present?(f.kind==='number'?number(v):v):f.kind==='number'?0:f.kind==='boolean'?false:'';
      }
    }
    return values;
  }
  // Dedicated single-writer proof only. Gather live slots into fresh columns
  // without materializing row objects or per-row numeric payload arrays.
  // Module defaults are reset only after gathering; old handles remain valid.
  function repack(s){
    const c=s.columns,slots=Array.from(s.index.values()).sort((a,b)=>a-b),n=slots.length;
    const arrays=fields.filter(f=>f.kind==='number[]'),lengths={};
    for(const f of arrays)lengths[f.root]=0;
    const entries=new Array(n);
    for(let j=0;j<n;j++){
      const i=slots[j];
      if(!Number.isSafeInteger(i)||i<0||i>=slotCount(s)||!isLive(s,i))throw Error('invalid live slot');
      const id=c[idField.root].get(i),key=keyOf(id);
      if(s.index.get(key)!==i)throw Error('invalid live identity');
      entries[j]=[key,j];
      for(const f of arrays){
        const r=f.root,start=c[r].get(i),count=c[r+'n'].get(i);
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||start<0||count<0||start+count>c[r+'a'].size)throw Error('invalid array range');
        if(f.nullable&&!c[r+'p'].get(i)&&count!==0)throw Error('invalid null array range');
        lengths[r]+=count;
        if(!Number.isSafeInteger(lengths[r]))throw RangeError('array capacity');
      }
    }
    const values=Object.fromEntries(roots.map(r=>[r,kinds[r]==='number'?new Float64Array(r.endsWith('a')?lengths[r.slice(0,-1)]:n):new Array(n)]));
    values.occupied.fill(true);
    for(const f of fields){
      const r=f.root;let at=0;
      for(let j=0;j<n;j++){
        const i=slots[j];
        if(f.nullable)values[r+'p'][j]=c[r+'p'].get(i);
        if(f.kind==='number[]'){
          const start=c[r].get(i),count=c[r+'n'].get(i);
          values[r][j]=at;values[r+'n'][j]=count;
          if(count)c[r+'a'].copyToFloat64Array(values[r+'a'],{start,end:start+count,offset:at});
          at+=count;
        }else values[r][j]=c[r].get(i);
      }
    }
    resetMap();resetSharedList();
    const columns=Object.fromEntries(roots.map(r=>[r,new SharedList(kinds[r]).pushMany(values[r])]));
    return {index:new SharedMap('number').setMany(entries),columns};
  }
  function wire(s){return {signature,data:getWorkerData({index:s.index,...s.columns},{copy:false})};}
  async function attach(p,previous){
    if(p.signature!==signature)throw TypeError('schema mismatch');
    const attached=await initWorker(p.data,{previous:previous?.attached});
    const columns=Object.fromEntries(roots.map(r=>[r,attached[r]])),n=columns.occupied.size;
    for(const r of roots){if(!columns[r]||columns[r].type!==kinds[r]||(!r.endsWith('a')&&columns[r].size!==n))throw Error('column shape mismatch');}
    return {attached,index:attached.index,columns};
  }
  return {build,buildPacked,repack,edit,get,rowAt,readAt,slotCount,isLive,wire,attach,size:s=>s.index.size,
    arenaUsage:s=>wire(s).data.arenas.map(a=>({id:a.id,used:a.used,capacity:a.memory.buffer.byteLength}))};
}
