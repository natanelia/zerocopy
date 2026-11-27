import test from 'node:test';
import assert from 'node:assert/strict';
import {ColumnTable,openPublisher,openReader} from './table-paged-runs.mjs';
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

import {ColumnTable as ReferenceTable} from './table-paged-session.mjs';
test('coalesced scan is identical to block scan for arbitrary predicates and fragmented retained roots',()=>{
  const schema={x:'float64',y:'float32',flag:'boolean',code:'uint16',weight:'float64'};
  const rows=Array.from({length:2067},(_,i)=>({x:i%23===0?NaN:(i%103)-51,y:Math.fround(i/17),flag:i%3===0,code:i%19,weight:i%83===0?-0:((i%7)-3)*0.1}));
  const queries=[[],[{column:'flag',eq:true}],[{column:'x',min:-50,max:20},{column:'code',eq:3}],[{column:'y',min:0,max:1},{column:'x',eq:NaN}],[{column:'code',eq:5},{column:'code',min:3,max:8}],[{column:'weight',min:-1,max:1}]];
  for(const blockRows of [32,64,127,256,1024]){
    let a=ColumnTable.fromRows(schema,rows,{blockRows}),b=ReferenceTable.fromRows(schema,rows,{blockRows});
    const oldA=ColumnTable.attach(structuredClone(a.descriptor())),oldB=ReferenceTable.attach(structuredClone(b.descriptor()));
    const pubA=openPublisher(a),readerA=openReader(structuredClone(pubA.initial()));
    for(let rev=0;rev<11;rev++){
      const edits=Array.from({length:rev===7?2067:25},(_,j)=>[(j*71+rev*37)%rows.length,{x:j-rev,flag:j%2===0,weight:j/19}]);
      a=a.editMany(edits);b=b.editMany(edits);
      const current=readerA.accept(pubA.publish(a)),expected=ReferenceTable.attach(structuredClone(b.descriptor()));
      for(const q of queries)for(const sum of ['x','y','weight','code','flag']){
        assert.deepEqual(current.aggregate(q,sum),expected.aggregate(q,sum));
        assert.deepEqual(oldA.aggregate(q,sum),oldB.aggregate(q,sum));
      }
    }
  }
});
