import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {CASES} from './protocol.mjs';
import {fixture,materialize,equal} from './fixtures.mjs';
const entries=process.argv.slice(2);assert.equal(entries.length,3);
const summaries=[];
for(const entry of entries){
  const S=await import(pathToFileURL(resolve(entry)).href);S.configureMemory({maximumBytes:16*1024*1024});const rows=[];
  for(const workload of CASES){const {item,expected}=fixture(S,workload),reverse=workload.operation.endsWith('Reverse');equal(materialize(item,workload.operation),reverse?[...expected].reverse():expected);rows.push({caseId:workload.id,values:expected.length});}
  const C=S.SharedLinkedList,Arena=C.owner(new C('number')).constructor,a=new Arena({memory:new WebAssembly.Memory({initial:2,maximum:256,shared:true})});
  let item=new C('object',0,0,0,a);for(let i=0;i<65;i++)item=item.append({i});
  const decode=a.decode,seen=[];a.decode=function(type,raw){const v=decode.call(this,type,raw);seen.push(v.i);return v;};
  const stop=new Error('stop');assert.throws(()=>item.forEach((v,i)=>{if(i===3)throw stop;}),e=>e===stop);assert.deepEqual(seen,[0,1,2,3]);
  const child=new S.SharedList('number').pushMany([3,5]);let outer=new C('SharedList<number>');for(let i=0;i<65;i++)outer=outer.append(child);
  const old=outer.toArray();for(const copy of [false,true]){const reader=(await S.initWorker(S.getWorkerData({outer},{copy}))).outer;assert.deepEqual(reader.toArray().map(x=>x.toArray()),old.map(x=>x.toArray()));}
  summaries.push(rows);
}
assert.deepEqual(summaries[0],summaries[1]);assert.deepEqual(summaries[0],summaries[2]);console.log(JSON.stringify({subjects:3,casesPerSubject:10,lazyFailure:true,nestedAttachments:true}));
