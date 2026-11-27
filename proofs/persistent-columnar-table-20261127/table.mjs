// Proof-only fixed-width column store. No public API or existing arena-format change.
// One allocating owner; descriptors go only to trusted same-application workers.
const PAGE = 65536;
const TYPES = Object.freeze({float64:Float64Array,float32:Float32Array,int32:Int32Array,uint32:Uint32Array,uint16:Uint16Array,uint8:Uint8Array,boolean:Uint8Array});
const RANGES = {int32:[-2147483648,2147483647],uint32:[0,4294967295],uint16:[0,65535],uint8:[0,255]};
const aligned = (n,a) => Math.ceil(n/a)*a;
function checkedSchema(schema) {
  const fields=Object.entries(schema);
  if(!fields.length || fields.length>64 || Object.getOwnPropertySymbols(schema).length) throw new TypeError('invalid schema');
  for(const [name,type] of fields) if(!name || !Object.hasOwn(TYPES,type)) throw new TypeError('invalid column '+name);
  return Object.freeze(fields.map(f=>Object.freeze(f)));
}
function value(type,v) {
  if(type==='boolean') {if(typeof v!=='boolean')throw new TypeError('expected boolean');return Number(v);}
  if(typeof v!=='number')throw new TypeError('expected number');
  if(Object.hasOwn(RANGES,type)){
    const [lo,hi]=RANGES[type];if(!Number.isInteger(v)||v<lo||v>hi)throw new RangeError('integer outside column range');
  }
  return type==='float32'?Math.fround(v):v;
}
class Slab {
  constructor(maximumBytes) {
    if(!Number.isSafeInteger(maximumBytes)||maximumBytes<PAGE||maximumBytes>0x7fff0000||maximumBytes%PAGE)throw new RangeError('invalid maximum');
    this.memory=new WebAssembly.Memory({initial:1,maximum:maximumBytes/PAGE,shared:true});
    this.maximum=maximumBytes;this.used=8;
  }
  alloc(bytes,alignment=8) {
    const p=aligned(this.used,alignment),end=p+bytes;
    if(!Number.isSafeInteger(end)||end>this.maximum)throw new RangeError('column arena exhausted');
    const capacity=this.memory.buffer.byteLength;
    if(end>capacity){
      const next=Math.min(this.maximum,Math.max(aligned(end,PAGE),capacity*2));
      this.memory.grow((next-capacity)/PAGE);
    }
    this.used=end;return p;
  }
}
const TOKEN=Symbol('internal');
export class ColumnTable {
  #memory;#owner;#fields;#names;#rows;#blockRows;#blocks;#root;#used;
  constructor(token,{memory,owner,fields,rows,blockRows,root,used}) {
    if(token!==TOKEN)throw new TypeError('use ColumnTable.fromRows or attach');
    this.#memory=memory;this.#owner=owner;this.#fields=fields;this.#names=new Map(fields.map(([k],i)=>[k,i]));
    this.#rows=rows;this.#blockRows=blockRows;this.#blocks=Math.ceil(rows/blockRows);this.#root=root;this.#used=used;
    Object.freeze(this);
  }
  static fromRows(schema,rows,{blockRows=256,maximumBytes=256*1024*1024}={}) {
    if(!Number.isSafeInteger(blockRows)||blockRows<32||blockRows>65536)throw new RangeError('invalid block size');
    const fields=checkedSchema(schema),n=rows.length;
    if(!Number.isSafeInteger(n)||n<0||n>0x3fffffff)throw new RangeError('invalid row count');
    const slab=new Slab(maximumBytes),blocks=Math.ceil(n/blockRows),addresses=new Uint32Array(fields.length*blocks);
    // Initial blocks for one column are adjacent (except natural alignment).
    for(let c=0;c<fields.length;c++){
      const [name,type]=fields[c],C=TYPES[type];
      for(let b=0;b<blocks;b++){
        const count=Math.min(blockRows,n-b*blockRows),p=slab.alloc(count*C.BYTES_PER_ELEMENT,C.BYTES_PER_ELEMENT);
        const out=new C(slab.memory.buffer,p,count);
        for(let i=0;i<count;i++)out[i]=value(type,rows[b*blockRows+i][name]);
        addresses[c*blocks+b]=p;
      }
    }
    const root=slab.alloc(addresses.byteLength,4);
    new Uint32Array(slab.memory.buffer,root,addresses.length).set(addresses);
    return new ColumnTable(TOKEN,{memory:slab.memory,owner:slab,fields,rows:n,blockRows,root,used:slab.used});
  }
  get size(){return this.#rows;}
  get usedBytes(){return this.#used;}
  get allocatedBytes(){return this.#owner?.used??this.#used;}
  get capacityBytes(){return this.#memory.buffer.byteLength;}
  #column(name){const c=this.#names.get(name);if(c===undefined)throw new TypeError('unknown column '+name);return c;}
  #valid(i){return Number.isInteger(i)&&i>=0&&i<this.#rows;}
  #directory(buffer){return new Uint32Array(buffer,this.#root,this.#blocks*this.#fields.length);}
  #count(b){return Math.min(this.#blockRows,this.#rows-b*this.#blockRows);}
  #block(buffer,dir,c,b){const C=TYPES[this.#fields[c][1]];return new C(buffer,dir[c*this.#blocks+b],this.#count(b));}
  get(i,name) {
    if(!this.#valid(i))return undefined;
    const c=this.#column(name),buffer=this.#memory.buffer,b=Math.floor(i/this.#blockRows);
    const raw=this.#block(buffer,this.#directory(buffer),c,b)[i%this.#blockRows];
    return this.#fields[c][1]==='boolean'?raw!==0:raw;
  }
  row(i){
    if(!this.#valid(i))return undefined;
    const buffer=this.#memory.buffer,dir=this.#directory(buffer),b=Math.floor(i/this.#blockRows),j=i%this.#blockRows;
    const entries=this.#fields.map(([name,type],c)=>{
      const raw=this.#block(buffer,dir,c,b)[j];return [name,type==='boolean'?raw!==0:raw];
    });
    return Object.freeze(Object.fromEntries(entries));
  }
  // Generic fixed-width range/equality filter with a numeric sum; no callbacks or row objects.
  // Each column is read directly from typed views; a matching row is never materialized.
  aggregate(filters,sumColumn){
    const sum=this.#column(sumColumn);
    const conditions=filters.map(f=>{
      const c=this.#column(f.column),type=this.#fields[c][1];
      if(Object.hasOwn(f,'eq'))return {c,eq:value(type,f.eq),equal:true};
      if(type==='boolean'||typeof f.min!=='number'||typeof f.max!=='number'||f.min>f.max)throw new TypeError('invalid range');
      return {c,min:f.min,max:f.max,equal:false};
    });
    const buffer=this.#memory.buffer,dir=this.#directory(buffer);
    let count=0,total=0;
    for(let b=0;b<this.#blocks;b++){
      const views=conditions.map(f=>this.#block(buffer,dir,f.c,b)),sums=this.#block(buffer,dir,sum,b),n=this.#count(b);
      rows:for(let i=0;i<n;i++){
        for(let k=0;k<conditions.length;k++){
          const f=conditions[k],v=views[k][i];
          if(f.equal?v!==f.eq:!(v>=f.min&&v<=f.max))continue rows;
        }
        count++;total+=sums[i];
      }
    }
    return {count,total};
  }
  editMany(edits){
    if(!this.#owner)throw new TypeError('read-only column table');
    const original=this.#memory.buffer,old=this.#directory(original),groups=new Map();
    // Validate all changes before allocating. Group by touched column block; last write wins.
    for(const [i,patch] of edits){
      if(!this.#valid(i))throw new RangeError('invalid row');
      const b=Math.floor(i/this.#blockRows),j=i%this.#blockRows;
      for(const [name,v] of Object.entries(patch)){
        const c=this.#column(name),slot=c*this.#blocks+b,type=this.#fields[c][1];
        let group=groups.get(slot);
        if(!group){group={c,b,values:new Map()};groups.set(slot,group);}
        group.values.set(j,value(type,v));
      }
    }
    for(const [slot,g] of groups){
      const block=this.#block(original,old,g.c,g.b);
      for(const [j,v] of g.values)if(Object.is(block[j],v))g.values.delete(j);
      if(!g.values.size)groups.delete(slot);
    }
    if(!groups.size)return this;
    const owner=this.#owner,next=new Uint32Array(old);
    for(const [slot,g] of groups){
      const source=this.#block(original,old,g.c,g.b),C=TYPES[this.#fields[g.c][1]],p=owner.alloc(source.byteLength,C.BYTES_PER_ELEMENT);
      const target=new C(owner.memory.buffer,p,source.length);target.set(source);
      for(const [j,v] of g.values)target[j]=v;
      next[slot]=p;
    }
    // V0 directory is a flat immutable u32 array: copied once per revision, not per field.
    // A persistent radix directory is a follow-up only if measured metadata costs warrant it.
    const root=owner.alloc(next.byteLength,4);new Uint32Array(owner.memory.buffer,root,next.length).set(next);
    return new ColumnTable(TOKEN,{memory:owner.memory,owner,fields:this.#fields,rows:this.#rows,blockRows:this.#blockRows,root,used:owner.used});
  }
  descriptor(){
    return {format:'column-proof-v0',memory:this.#memory,schema:Object.fromEntries(this.#fields),rows:this.#rows,blockRows:this.#blockRows,root:this.#root,used:this.#used};
  }
  static attach(d){
    if(d?.format!=='column-proof-v0'||!(d.memory instanceof WebAssembly.Memory)||!(d.memory.buffer instanceof SharedArrayBuffer))throw new TypeError('invalid shared descriptor');
    const fields=checkedSchema(d.schema),{memory,rows,blockRows,root,used}=d,buffer=memory.buffer;
    if(!Number.isSafeInteger(rows)||rows<0||rows>0x3fffffff||!Number.isSafeInteger(blockRows)||blockRows<32||blockRows>65536||
       !Number.isSafeInteger(used)||used<8||used>buffer.byteLength||!Number.isSafeInteger(root)||root<8||root%4)throw new RangeError('invalid descriptor bounds');
    const blocks=Math.ceil(rows/blockRows),slots=blocks*fields.length;
    if(root+slots*4>used)throw new RangeError('invalid directory');
    const dir=new Uint32Array(buffer,root,slots);
    for(let c=0;c<fields.length;c++){
      const width=TYPES[fields[c][1]].BYTES_PER_ELEMENT;
      for(let b=0;b<blocks;b++){
        const p=dir[c*blocks+b],bytes=Math.min(blockRows,rows-b*blockRows)*width;
        if(p<8||p%width||p+bytes>root)throw new RangeError('invalid column block');
      }
    }
    return new ColumnTable(TOKEN,{memory,fields,rows,blockRows,root,used});
  }
}
