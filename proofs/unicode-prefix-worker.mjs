import assert from 'node:assert/strict';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {fixture,canonical} from './unicode-prefix-common.mjs';
const key='record/'+'a'.repeat(64)+'界',raw='alias/\ud800';
if(!isMainThread){
  const S=await import(pathToFileURL(workerData.reader).href);
  const old=await S.initWorker(workerData.data);
  function check(old){
    assert.equal(old.map.get(key),'before');assert.equal(old.map.get(raw),'alias');assert.equal(old.map.get(canonical(raw)),'alias');
    assert.equal(old.map.get(fixture.zero.key),'zero');
    assert.equal(old.map.get(fixture.collision[0].key),'left');assert.equal(old.map.get(fixture.collision[1].key),'right');
    assert.equal(old.ordered.get('ordered/界'),-0);assert.ok(Object.is(old.ordered.get('ordered/界'),-0));
    assert.throws(()=>old.map.set('x','forbidden'),/read-only/);
  }
  check(old);parentPort.postMessage({kind:'ready'});
  parentPort.once('message',async message=>{
    try{
      const next=await S.initWorker(message.data);check(old);
      assert.equal(next.map.get(key),'after');assert.equal(next.map.get('growth').length,262144);
      assert.equal(next.map.has('missing/界'),false);
      assert.equal(next.ordered.get('ordered/界'),-0);
      parentPort.postMessage({kind:'done',retained:true,growth:true});parentPort.close();
    }catch(error){throw error;}
  });
}else{
  const S=await import(pathToFileURL(process.argv[2]).href),readers=process.argv.slice(3),rows=[];
  const workerURL=new URL('./unicode-prefix-worker.mjs',import.meta.url);
  function message(worker,wanted){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('Worker phase exceeded original 5000ms test timeout')),5000);
      const fail=error=>finish(error),exit=code=>finish(new Error('Worker exited before '+wanted+': '+code));
      const receive=value=>{if(value.kind===wanted)finish(null,value);else finish(new Error('Unexpected worker reply'));};
      function finish(error,value){clearTimeout(timer);worker.off('message',receive);worker.off('error',fail);worker.off('exit',exit);error?reject(error):resolve(value);}
      worker.once('message',receive);worker.once('error',fail);worker.once('exit',exit);
    });
  }
  for(const reader of readers)for(const copy of [false,true]){
    S.resetMap();S.resetOrderedMap();
    let map=new S.SharedMap('string').setMany([[key,'before'],[raw,'alias'],[fixture.zero.key,'zero'],[fixture.collision[0].key,'left'],[fixture.collision[1].key,'right']]);
    const ordered=new S.SharedOrderedMap('number').set('ordered/界',-0);
    const old=map,shared=S.getWorkerData({map,ordered},{copy:false}),memory=shared.arenas.find(a=>a.id===shared.structures.map.arena).memory;
    const capacity=memory.buffer.byteLength;
    const worker=new Worker(workerURL,{workerData:{reader,data:S.getWorkerData({map,ordered},{copy})}});
    try{
      await message(worker,'ready');
      map=map.set('growth','x'.repeat(262144)).set(key,'after');
      assert.ok(memory.buffer.byteLength>capacity);
      const done=message(worker,'done');worker.postMessage({data:S.getWorkerData({map,ordered},{copy})});await done;
      assert.equal(old.get(key),'before');assert.equal(map.get(key),'after');
      rows.push({producer:process.argv[2],reader,copy,retained:true,grew:true});
    }finally{await worker.terminate();}
  }
  console.log(JSON.stringify({suite:'actual-workers',runtime:process.versions.bun?'bun':'node',rows}));
}

