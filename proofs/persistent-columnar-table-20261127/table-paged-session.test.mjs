import test from 'node:test';
import assert from 'node:assert/strict';
import {ColumnTable,openPublisher,openReader} from './table-paged-session.mjs';
const schema={x:'float64',speed:'uint8',active:'boolean'},rows=Array.from({length:4097},(_,i)=>({x:i,speed:i%255,active:i%2===0}));
test('same-memory stream, skip, fork, historical root, growth and independent attachment',()=>{
  const a=ColumnTable.fromRows(schema,rows,{blockRows:32,maximumBytes:8*65536});
  const p=openPublisher(a),initial=structuredClone(p.initial()),reader=openReader(initial),full=openReader(initial,{reuse:false});
  const held=reader.snapshot,cap=a.capacityBytes;
  let b=a;for(let i=0;i<100;i++)b=b.editMany([[i*39,{x:-i-1,speed:255}]]);
  assert(b.capacityBytes>cap);
  const msg=structuredClone(p.publish(b)),latest=reader.accept(msg),control=full.accept(msg);
  for(let i=0;i<rows.length;i++){assert.deepEqual(latest.rowDirect(i),b.rowDirect(i));assert.deepEqual(control.rowDirect(i),latest.rowDirect(i));assert.deepEqual(held.rowDirect(i),rows[i]);}
  const fork=a.editMany([[4096,{x:-42}],[0,{active:false}]]);
  assert.deepEqual(reader.accept(structuredClone(p.publish(fork))).rowDirect(4096),fork.rowDirect(4096));
  assert.deepEqual(reader.accept(structuredClone(p.publish(a))).rowDirect(0),rows[0]);
  assert.deepEqual(latest.rowDirect(0),b.rowDirect(0));
  assert.throws(()=>held.editMany([[0,{x:1}]]),/read-only/);
  const independent=ColumnTable.fromRows(schema,rows,{blockRows:32});
  assert.throws(()=>p.publish(independent),/handshake/);
  const other=openPublisher(independent),otherReader=openReader(structuredClone(other.initial()));
  assert.throws(()=>reader.accept(other.publish(independent)),/session/);
  assert.deepEqual(otherReader.snapshot.rowDirect(4096),rows[4096]);
  assert.throws(()=>reader.accept({...p.publish(b),memory:independent.descriptor().memory}),/session/);
  assert.throws(()=>reader.accept({...p.publish(b),root:b.usedBytes}),/directory/);
  assert.deepEqual(reader.snapshot.rowDirect(0),rows[0]); // failure did not advance
});
test('reused page bounds are checked; changed page contents are independently checked',()=>{
  const a=ColumnTable.fromRows(schema,rows,{blockRows:32}),p=openPublisher(a),reader=openReader(p.initial());
  const b=a.editMany([[0,{x:123456}]]),d=b.descriptor(),slots=Math.ceil(d.rows/d.blockRows)*3;
  const top=new Uint32Array(d.memory.buffer,d.root,Math.ceil(slots/64));
  const address=top[0],page=new Uint32Array(d.memory.buffer,address,64);
  page[0]=address;
  assert.throws(()=>reader.accept(p.publish(b)),/invalid column block/);
  assert.deepEqual(reader.snapshot.rowDirect(0),rows[0]);
  top[0]=d.root;
  assert.throws(()=>reader.accept(p.publish(b)),/invalid directory page/);
});
test('zero-row stream and fixed schema guard',()=>{
  const a=ColumnTable.fromRows({x:'float64'},[]),p=openPublisher(a),r=openReader(p.initial());
  assert.equal(r.accept(p.publish(a)).size,0);
  assert.throws(()=>p.publish(ColumnTable.fromRows({x:'uint8'},[])),/handshake/);
});
