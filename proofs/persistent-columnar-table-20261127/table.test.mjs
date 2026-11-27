import test from 'node:test';
import assert from 'node:assert/strict';
import {ColumnTable} from './table.mjs';
const schema={x:'float64',speed:'uint8',active:'boolean',height:'float32',signed:'int32',code:'uint16',flags:'uint32'};
const make=i=>({x:i, speed:i%100,active:i%2===0,height:Math.fround(i/7),signed:i===0?0:-i,code:i,flags:4294967295});
test('fixed-width values, retained forks, shared attachment and column-only copies',()=>{
  const rows=Array.from({length:513},(_,i)=>make(i)),a=ColumnTable.fromRows(schema,rows,{blockRows:256});
  const base=a.descriptor(),b=a.editMany([[0,{x:-0}],[255,{speed:99}],[256,{active:true}],[512,{height:1.1}],[0,{speed:1}],[0,{speed:2}]]);
  const c=a.editMany([[0,{x:-42}]]);
  assert.equal(a.size,513);assert(Object.is(b.get(0,'x'),-0));assert.equal(b.get(0,'speed'),2);
  assert.equal(b.get(255,'speed'),99);assert.equal(b.get(512,'height'),Math.fround(1.1));assert.equal(c.get(0,'x'),-42);
  for(let i=0;i<rows.length;i++){
    assert.deepEqual(a.row(i),rows[i]);
    assert.deepEqual(a.rowDirect(i),rows[i]);
    assert.deepEqual(b.rowDirect(i),b.row(i));
    assert.deepEqual(c.rowDirect(i),c.row(i));
  }
  assert.equal(a.row(-1),undefined);assert.throws(()=>b.editMany([[1,{speed:256}]]),RangeError);
  assert.throws(()=>b.editMany([[1,{active:1}]]),TypeError);
  assert.equal(b.editMany([[0,{speed:2}]]),b);
  const directory=d=>new Uint32Array(d.memory.buffer,d.root,Math.ceil(d.rows/d.blockRows)*Object.keys(d.schema).length);
  const before=directory(base),after=directory(b.descriptor());let changed=0;
  for(let i=0;i<before.length;i++)if(before[i]!==after[i])changed++;
  // x block0, speed block0, height block2; active on row256 was already true.
  assert.equal(changed,3);
  const old=ColumnTable.attach(structuredClone(base)),reader=ColumnTable.attach(structuredClone(b.descriptor()));
  assert.deepEqual(old.row(0),rows[0]);assert.deepEqual(reader.row(512),b.row(512));
  assert.deepEqual(old.rowDirect(0),rows[0]);assert.deepEqual(reader.rowDirect(512),b.row(512));
  assert.throws(()=>reader.editMany([[0,{x:0}]]),/read-only/);
  const f=[{column:'x',min:100,max:300},{column:'active',eq:true}];
  const expected=rows.filter(r=>r.x>=100&&r.x<=300&&r.active);
  assert.deepEqual(old.aggregate(f,'speed'),{count:expected.length,total:expected.reduce((s,r)=>s+r.speed,0)});
  assert.equal(Object.isFrozen(reader.row(0)),true);
});
test('old readers survive actual memory growth, invalid roots and exhausted allocation',()=>{
  const rows=Array.from({length:4096},(_,i)=>({x:i,y:i*2}));
  const root=ColumnTable.fromRows({x:'float64',y:'float64'},rows,{blockRows:256,maximumBytes:4*65536});
  const old=ColumnTable.attach(structuredClone(root.descriptor())),capacity=root.capacityBytes;
  assert.deepEqual(old.rowDirect(400),rows[400]); // retain the cached view before real growth
  let next=root;for(let i=0;i<40;i++)next=next.editMany([[i*100,{x:-i-1}]]);
  assert(next.capacityBytes>capacity);assert.equal(old.get(400,'x'),400);
  assert.equal(next.get(400,'x'),-5);
  assert.deepEqual(old.rowDirect(400),rows[400]);assert.deepEqual(next.rowDirect(400),next.row(400));
  assert.throws(()=>ColumnTable.attach({...root.descriptor(),root:root.descriptor().used}),RangeError);
  const tiny=ColumnTable.fromRows({x:'float64'},Array.from({length:4096},(_,i)=>({x:i})),{blockRows:256,maximumBytes:65536});
  assert.throws(()=>tiny.editMany(Array.from({length:4096},(_,i)=>[i,{x:-i-1}])),RangeError);
  assert.equal(tiny.get(4095,'x'),4095);
});
test('empty table, special floats and duplicate edits',()=>{
  const a=ColumnTable.fromRows({x:'float64'},[]);
  assert.deepEqual(ColumnTable.attach(a.descriptor()).aggregate([],'x'),{count:0,total:0});
  const b=ColumnTable.fromRows({x:'float64'},[{x:NaN},{x:-0},{x:Infinity}]);
  assert(Number.isNaN(b.get(0,'x')));assert(Object.is(b.get(1,'x'),-0));assert.equal(b.get(2,'x'),Infinity);
  assert.equal(b.editMany([[1,{x:1}],[1,{x:-0}]]),b);
});

test('integer zero is canonical, floating zero retains its sign',()=>{
  const a=ColumnTable.fromRows({i:'int32',f:'float64'},[{i:-0,f:-0}]);
  assert(Object.is(a.get(0,'i'),0));assert(Object.is(a.get(0,'f'),-0));
  assert.equal(a.editMany([[0,{i:-0}]]),a);
  assert(Object.is(a.editMany([[0,{f:0}]]).get(0,'f'),0));
});

test('direct row materialization preserves exact values, schema keys and ownership',()=>{
  const schema=Object.fromEntries([['__proto__','uint8'],['constructor','boolean'],['x','float64'],['f','float32'],['z','int32'],['𝄞','uint32']]);
  const rows=Array.from({length:1031},(_,i)=>Object.fromEntries([['__proto__',i%256],['constructor',i%2===0],['x',i%3===0?NaN:i%3===1?-0:Infinity],['f',Math.fround(-i/13)],['z',-i||0],['𝄞',4294967295-i]]));
  const a=ColumnTable.fromRows(schema,rows,{blockRows:257}),b=ColumnTable.attach(structuredClone(a.descriptor()));
  for(let i=0;i<rows.length;i++){
    assert.deepEqual(a.rowDirect(i),a.row(i));assert.deepEqual(b.rowDirect(i),rows[i]);
    assert(Object.isFrozen(b.rowDirect(i)));assert.equal(Object.getPrototypeOf(b.rowDirect(i)),Object.prototype);
  }
  assert.equal(a.rowDirect(-1),undefined);assert.equal(a.rowDirect(a.size),undefined);
  assert.equal(ColumnTable.fromRows({x:'float64'},[]).rowDirect(0),undefined);
});
