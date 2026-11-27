// Proof-only fixed-width column store. No public API or existing arena-format change.
// One allocating owner; descriptors go only to trusted same-application workers.
const PAGE = 65536;
// Immutable two-level directory: 64 u32 block addresses per page. Only the
// small top index and touched pages are copied; fixed-width payload is unchanged.
export const DIRECTORY_PAGE_SLOTS=64;
const pageCount=slots=>Math.ceil(slots/DIRECTORY_PAGE_SLOTS);
const pageLength=(slots,page)=>Math.min(DIRECTORY_PAGE_SLOTS,slots-page*DIRECTORY_PAGE_SLOTS);
function writeDirectory(slab,addresses){
  const top=new Uint32Array(pageCount(addresses.length));
  for(let k=0;k<top.length;k++){
    const part=addresses.subarray(k*DIRECTORY_PAGE_SLOTS,(k+1)*DIRECTORY_PAGE_SLOTS);
    const p=slab.alloc(part.byteLength,4);
    new Uint32Array(slab.memory.buffer,p,part.length).set(part);top[k]=p;
  }
  const root=slab.alloc(top.byteLength,4);
  new Uint32Array(slab.memory.buffer,root,top.length).set(top);
  return root;
}
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
    // Integer typed arrays canonicalize signed zero; compare the stored value.
    return v===0?0:v;
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
// Native-width storage is host-endian in this proof. Match the typed-array layout.
const LITTLE_ENDIAN=new Uint8Array(new Uint16Array([1]).buffer)[0]===1;
const READERS=Object.freeze({
  float64:(v,p)=>v.getFloat64(p,LITTLE_ENDIAN),
  float32:(v,p)=>v.getFloat32(p,LITTLE_ENDIAN),
  int32:(v,p)=>v.getInt32(p,LITTLE_ENDIAN),
  uint32:(v,p)=>v.getUint32(p,LITTLE_ENDIAN),
  uint16:(v,p)=>v.getUint16(p,LITTLE_ENDIAN),
  uint8:(v,p)=>v.getUint8(p),
  boolean:(v,p)=>v.getUint8(p)!==0,
});
const TOKEN=Symbol('internal');
export class ColumnTable {
  #memory;#owner;#fields;#names;#rows;#blockRows;#blocks;#root;#used;#point;#meta;#top;
  constructor(token,{memory,owner,fields,rows,blockRows,root,used}) {
    if(token!==TOKEN)throw new TypeError('use ColumnTable.fromRows or attach');
    this.#memory=memory;this.#owner=owner;this.#fields=fields;this.#names=new Map(fields.map(([k],i)=>[k,i]));
    this.#rows=rows;this.#blockRows=blockRows;this.#blocks=Math.ceil(rows/blockRows);this.#root=root;this.#used=used;
    const buffer=memory.buffer;
    this.#meta=new DataView(buffer,0,used);
    this.#top=new Uint32Array(buffer,root,pageCount(this.#blocks*fields.length));
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
    const root=writeDirectory(slab,addresses);
    return new ColumnTable(TOKEN,{memory:slab.memory,owner:slab,fields,rows:n,blockRows,root,used:slab.used});
  }
  get size(){return this.#rows;}
  get usedBytes(){return this.#used;}
  get allocatedBytes(){return this.#owner?.used??this.#used;}
  get capacityBytes(){return this.#memory.buffer.byteLength;}
  #column(name){const c=this.#names.get(name);if(c===undefined)throw new TypeError('unknown column '+name);return c;}
  #valid(i){return Number.isInteger(i)&&i>=0&&i<this.#rows;}
  #directory(){return this.#top;}
  #address(dir,slot){return this.#meta.getUint32(dir[slot>>>6]+(slot&63)*4,LITTLE_ENDIAN);}
  #count(b){return Math.min(this.#blockRows,this.#rows-b*this.#blockRows);}
  #block(buffer,dir,c,b){const C=TYPES[this.#fields[c][1]];return new C(buffer,this.#address(dir,c*this.#blocks+b),this.#count(b));}
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
  /** Proof variant: keep one immutable byte view and directory per snapshot,
   * instead of creating a typed-array object for each field of every row.
   * All reachable bytes already exist; old SAB views survive memory.grow().
   * Keep exactly the same materialization and freezing semantics as row().
   */
  rowDirect(i){
    if(!this.#valid(i))return undefined;
    if(!this.#point){
      const buffer=this.#memory.buffer;
      this.#point={view:new DataView(buffer,0,this.#used),directory:this.#directory(buffer),
        fields:this.#fields.map(([name,type])=>({name,width:TYPES[type].BYTES_PER_ELEMENT,read:READERS[type]}))};
    }
    const {view,directory,fields}=this.#point,b=Math.floor(i/this.#blockRows),j=i%this.#blockRows;
    const entries=fields.map(({name,width,read},c)=>[name,read(view,this.#address(directory,c*this.#blocks+b)+j*width)]);
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
    const owner=this.#owner,next=new Uint32Array(old),pages=new Map(),slots=this.#blocks*this.#fields.length;
    for(const [slot,g] of groups){
      const source=this.#block(original,old,g.c,g.b),C=TYPES[this.#fields[g.c][1]],p=owner.alloc(source.byteLength,C.BYTES_PER_ELEMENT);
      const target=new C(owner.memory.buffer,p,source.length);target.set(source);
      for(const [j,v] of g.values)target[j]=v;
      const page=slot>>>6;
      let copy=pages.get(page);
      if(!copy){
        copy=new Uint32Array(new Uint32Array(original,old[page],pageLength(slots,page)));
        pages.set(page,copy);
      }
      copy[slot&63]=p;
    }
    for(const [page,copy] of pages){
      const address=owner.alloc(copy.byteLength,4);
      new Uint32Array(owner.memory.buffer,address,copy.length).set(copy);
      next[page]=address;
    }
    const root=owner.alloc(next.byteLength,4);new Uint32Array(owner.memory.buffer,root,next.length).set(next);
    return new ColumnTable(TOKEN,{memory:owner.memory,owner,fields:this.#fields,rows:this.#rows,blockRows:this.#blockRows,root,used:owner.used});
  }
  descriptor(){
    return {format:'column-proof-paged-v0',memory:this.#memory,schema:Object.fromEntries(this.#fields),rows:this.#rows,blockRows:this.#blockRows,root:this.#root,used:this.#used};
  }
  static attach(d){
    if(d?.format!=='column-proof-paged-v0'||!(d.memory instanceof WebAssembly.Memory)||!(d.memory.buffer instanceof SharedArrayBuffer))throw new TypeError('invalid shared descriptor');
    const fields=checkedSchema(d.schema),{memory,rows,blockRows,root,used}=d,buffer=memory.buffer;
    if(!Number.isSafeInteger(rows)||rows<0||rows>0x3fffffff||!Number.isSafeInteger(blockRows)||blockRows<32||blockRows>65536||
       !Number.isSafeInteger(used)||used<8||used>buffer.byteLength||!Number.isSafeInteger(root)||root<8||root%4)throw new RangeError('invalid descriptor bounds');
    const blocks=Math.ceil(rows/blockRows),slots=blocks*fields.length;
    if(root+pageCount(slots)*4>used)throw new RangeError('invalid directory');
    const top=new Uint32Array(buffer,root,pageCount(slots));
    // Validate all pages/blocks, as in the flat control. Do not relax validation
    // to improve performance. Every page is published before its top index.
    for(let k=0;k<top.length;k++){
      const page=top[k],length=pageLength(slots,k);
      if(page<8||page%4||page+length*4>root)throw new RangeError('invalid directory page');
      const addresses=new Uint32Array(buffer,page,length);
      for(let j=0;j<length;j++){
        const slot=k*DIRECTORY_PAGE_SLOTS+j,c=Math.floor(slot/blocks),b=slot%blocks;
        const width=TYPES[fields[c][1]].BYTES_PER_ELEMENT,p=addresses[j],bytes=Math.min(blockRows,rows-b*blockRows)*width;
        if(p<8||p%width||p+bytes>page)throw new RangeError('invalid column block');
      }
    }
    return new ColumnTable(TOKEN,{memory,fields,rows,blockRows,root,used});
  }
}
