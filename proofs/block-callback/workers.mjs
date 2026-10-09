import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const subject = isMainThread ? resolve(process.argv[2]) : workerData.subject;
const S = await import(pathToFileURL(subject).href);
S.configureMemory({ maximumBytes: 16 * 1024 * 1024 });
const lengths = [0, 1, 32, 33, 65, 4097];
function check(items, phase = 'old') {
  let callbacks = 0;
  for (const [name, list] of Object.entries(items)) {
    const [kind, type, nText] = name.split('_'), n = Number(nText);
    const expected = Array.from({length:n}, (_, i) => type === 'number' ? i : type === 'string' ? `value${i}🙂` : type === 'object' ? {i, nested:[i]} : [i, i+1]);
    const got = []; list.forEach(function (value, index) { assert.equal(this, undefined); assert.equal(arguments.length, 2); assert.equal(index, got.length); got.push(type === 'nested' ? value.toArray() : value); callbacks++; });
    assert.deepEqual(got, expected);
    if (kind === 'doubly') {
      const reversed = []; list.forEachReverse((value, index) => { assert.equal(index,n-1-reversed.length); reversed.push(type === 'nested' ? value.toArray() : value); callbacks++; });
      assert.deepEqual(reversed,[...expected].reverse());
    }
    assert.throws(() => list.append(type === 'number' ? 4 : type === 'string' ? 'x' : type === 'object' ? {} : new S.SharedList('number')), /read-only/);
  }
  return callbacks;
}
if (!isMainThread) {
  let old;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'initial') { old = await S.initWorker(message.data); parentPort.postMessage({type:'ready',callbacks:check(old)}); }
      if (message.type === 'paused-scan') {
        let count=0; old.linked_number_65.forEach((v,i)=> {
          if (!count) { parentPort.postMessage({type:'paused'}); assert.notEqual(Atomics.wait(new Int32Array(workerData.control),0,0,10000),'timed-out'); }
          assert.equal(v,i); count++;
        });
        parentPort.postMessage({type:'resumed',count,callbacks:check(old)});
      }
      if (message.type === 'new') {
        const newer = await S.initWorker(message.data); assert.deepEqual(newer.newer.toArray(),[999]);
        parentPort.postMessage({type:'retained',callbacks:check(old)});
      }
    } catch (error) { parentPort.postMessage({error:error.stack}); }
  });
} else {
  const receipts=[];
  for (const copy of [false,true]) {
    S.resetLinkedList(); S.resetDoublyLinkedList(); S.resetSharedList();
    const items={};
    for (const [kind,C] of [['linked',S.SharedLinkedList],['doubly',S.SharedDoublyLinkedList]]) {
      for (const n of lengths) { let list=new C('number'); for(let i=0;i<n;i++) list=list.append(i); items[`${kind}_number_${n}`]=list; }
      for(const type of ['string','object','nested']) {
        let list=new C(type==='nested'?'SharedList<number>':type);
        for(let i=0;i<65;i++) list=list.append(type==='string'?`value${i}🙂`:type==='object'?{i,nested:[i]}:new S.SharedList('number').pushMany([i,i+1]));
        items[`${kind}_${type}_65`]=list;
      }
    }
    const data=S.getWorkerData(items,{copy}), control=new SharedArrayBuffer(4), worker=new Worker(new URL(import.meta.url),{workerData:{subject,control}});
    const timer=setTimeout(()=>{console.error('Block callback worker deadline');process.exit(1);},30000);
    const receive=async()=>{const [message]=await once(worker,'message');if(message.error)throw new Error(message.error);return message;};
    try {
      let pending=receive();worker.postMessage({type:'initial',data});const ready=await pending;assert.equal(ready.type,'ready');
      pending=receive();worker.postMessage({type:'paused-scan'});assert.equal((await pending).type,'paused');
      const source=S.getWorkerData({list:items.linked_number_65},{copy:false}).arenas[0], before=source.memory.buffer.byteLength;
      source.memory.grow(2);assert.equal(source.memory.buffer.byteLength,before+131072);
      const changed=items.linked_number_65.append(65);assert.equal(changed.size,66);assert.equal(items.linked_number_65.size,65);
      pending=receive();Atomics.store(new Int32Array(control),0,1);Atomics.notify(new Int32Array(control),0);const resumed=await pending;assert.equal(resumed.type,'resumed');assert.equal(resumed.count,65);
      S.resetLinkedList();S.resetDoublyLinkedList();S.resetSharedList();
      pending=receive();worker.postMessage({type:'new',data:S.getWorkerData({newer:new S.SharedLinkedList('number').append(999)},{copy})});const retained=await pending;assert.equal(retained.type,'retained');
      receipts.push({copy,structures:Object.keys(items).length,callbacksPerCompleteCheck:ready.callbacks,checks:3,pausedCallbackGrowth:true,repeatedAttachment:true,oldSnapshotsAfterReset:true});
    } finally {clearTimeout(timer);await worker.terminate();}
  }
  console.log(JSON.stringify({runtime:process.version,bun:globalThis.Bun?.version??null,subject,receipts},null,2));
}
