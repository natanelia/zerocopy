import assert from 'node:assert/strict';
import { parentPort,workerData,isMainThread,threadId } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { endpoint,isWire,protocolState,observedAck } from './endpoint.mjs';
import { SESSION,query,validateView,validateTransition,expectedBatch } from './oracle.mjs';

// The constructor counter is supplied only by the separate mechanism entry.
export async function runWorker(nativeCount=null) {
  const now=nativeCount?()=>0:()=>performance.now();
  assert(!isMainThread && parentPort && threadId>0);
  const {config}=workerData;
  assert.equal(config.mode==='mechanism',nativeCount!==null);
  const importStart=now();
  const shared=await import(pathToFileURL(config.sharedEntry).href);
  const worker=await import(pathToFileURL(config.workerEntry).href);
  const workerImportMs=now()-importStart;
  const states=new Map();let lastR8=null,commands=0;
  const post=message=>parentPort.postMessage({_nativeReaderScreen:1,...message});
  const onError=error=>{post({kind:'fatal',message:String(error?.message??error)});process.exitCode=1;};

  async function start(row,descriptors) {
    assert(!states.has(row));
    assert.equal(descriptors.length,2);
    const state={row,descriptors,wire:protocolState(row),reader:null,initial:null,previous:null,current:null,
      variant:0,previousVariant:null,version:0,initialVersion:0,publications:0,badSequence:0,
      nativeBefore:nativeCount?.()??0,dispatchNative:0,firstIncomingIds:null,lastIncomingIds:null,
      badTransport:0,accepted:0,responded:0};
    states.set(row,state);
    const adapted=endpoint(parentPort,{
      receive(data) {
        if(isWire(data)&&data.channel===row&&data.kind==='snapshot') {
          state.dispatchNative=nativeCount?.()??0;
          state.wire.snapshots++;
          state.wire.lastFrame=data;
          if(data.sequence!==state.wire.lastSnapshot+1) state.wire.badOrder++;
          state.wire.lastSnapshot=data.sequence;
          const ids=data.data.arenas.map(a=>a.id);
          if(row==='F8'&&state.lastIncomingIds?.some(id=>ids.includes(id))) state.badTransport++;
          if(!state.firstIncomingIds) state.firstIncomingIds=ids;
          state.lastIncomingIds=ids;
          // Last observation before the library gets the original event.
          state.wire.dispatchedAt=now();
        }
      },
      send(data) {observedAck(state.wire,data);},
    });
    state.reader=await worker.connectSharedSession({...SESSION,copy:row==='C8',channel:row,endpoint:adapted,onError});
    const connectResolved=now();
    state.initial=state.current=state.reader.current;
    state.initialMemory=row==='P1'||row==='P8'?new Map(state.wire.lastFrame.data.arenas.map(a=>[a.id,a.memory])):null;
    state.version=state.initialVersion=state.reader.version;
    const initialChecksum=query(state.current,row);
    state.reader.subscribe((snapshot,version)=>{
      const accepted=now();
      const acceptanceMs=accepted-state.wire.dispatchedAt;
      state.previous=state.current;state.previousVariant=state.variant;
      state.current=snapshot;state.variant=1-state.variant;
      if(version!==state.version+1) state.badSequence++;
      state.version=version;state.publications++;state.accepted++;
      const checksum=query(snapshot,row);
      const queryMs=now()-accepted;
      const response={kind:'publication',row,version,variant:state.variant,checksum,acceptanceMs,queryMs};
      if(nativeCount) response.nativeInstances=nativeCount()-state.dispatchNative;
      // receive() synchronously posts the library ACK after subscription returns.
      // Queueing the response makes that ACK precede it on the same real port.
      queueMicrotask(()=>{state.responded++;post(response);});
    });
    return {row,version:state.version,initialChecksum,
      receiverConnectMs:connectResolved-state.wire.dispatchedAt,
      nativeInstances:nativeCount?nativeCount()-state.nativeBefore:null};
  }
  function validate(row) {
    const state=states.get(row);assert(state?.reader);
    assert.equal(state.reader.version,state.version);assert.equal(state.initialVersion,0);
    assert.equal(state.badSequence,0);assert.equal(state.badTransport,0);
    assert.equal(state.wire.badOrder,0);assert.equal(state.wire.snapshots,state.wire.acks);
    assert.equal(state.accepted,state.responded);assert.equal(state.publications,state.version);
    validateView(state.initial,row,0);validateView(state.current,row,state.variant);
    if(state.previous) {
      validateView(state.previous,row,state.previousVariant);
      validateTransition(state.previous,state.current,row);
    }
    const frame=state.wire.lastFrame;
    assert.equal(frame.data.arenas.length,row==='P1'?1:8);
    assert.equal(new Set(frame.data.arenas.map(a=>a.id)).size,row==='P1'?1:8);
    const expected=state.descriptors[state.variant];
    assert.deepEqual(frame.data.arenas.map(a=>({id:a.id,used:a.used})),expected.map(({id,used})=>({id,used})));
    const attached=shared.getWorkerData(row==='P1'?{value:state.current}:state.current,{copy:false});
    assert.equal(attached.arenas.length,row==='P1'?1:8);
    const attachedById=new Map(attached.arenas.map(a=>[a.id,a]));
    for(const source of expected) {
      const arena=attachedById.get(source.id);assert(arena);assert.equal(arena.used,source.used);
      assert(arena.memory instanceof WebAssembly.Memory);assert(arena.memory.buffer instanceof SharedArrayBuffer);
      if(state.initialMemory) assert.equal(arena.memory,state.initialMemory.get(source.id));
      if(row==='F8') assert.equal(arena.memory,frame.data.arenas.find(a=>a.id===source.id).memory);
      if(row!=='C8') assert.equal(arena.memory.buffer.byteLength,source.capacity);
      else assert.equal(arena.memory.buffer.byteLength,Math.max(131072,Math.ceil(source.used/65536)*65536));
    }
    for(const arena of frame.data.arenas) {
      assert(Number.isSafeInteger(arena.used)&&arena.used>=65536);
      if(row==='C8') {assert(arena.copy instanceof Uint8Array);assert.equal(arena.memory,undefined);assert.equal(arena.copy.byteLength,arena.used);}
      else if(row==='F8'||state.version===0) {assert(arena.memory instanceof WebAssembly.Memory);assert.equal(arena.copy,undefined);assert(arena.memory.buffer instanceof SharedArrayBuffer);assert(arena.used<=arena.memory.buffer.byteLength);}
      else {assert.equal(arena.memory,undefined);assert.equal(arena.copy,undefined);}
    }
    return {passed:true,row,version:state.version,variant:state.variant,retainedSnapshots:state.previous?3:2,
      publications:state.publications,acks:state.wire.acks,initialRetained:true,fullValues:true,shape:true,identity:true};
  }
  async function command(message) {
    commands++;
    if(message.op==='start') return start(message.row,message.descriptors);
    if(message.op==='validate') return validate(message.row);
    if(message.op==='R8') {
      const {count,payload}=message;
      assert(payload && payload.arenas.length===8);
      const nativeBefore=nativeCount?.()??0;
      let checksum=0;
      const started=now();
      for(let i=0;i<count;i++) {lastR8=await shared.initWorker(payload);checksum+=query(lastR8,'R8');}
      const elapsedMs=now()-started;
      const nativeInstances=nativeCount?nativeCount()-nativeBefore:null;
      const validationStarted=now();
      const validation={passed:false,fullValues:true,shape:true,identity:true,retainedSnapshots:1};
      try {
        assert.equal(checksum,expectedBatch('R8',0,count,0));validateView(lastR8,'R8',0);
        const attached=shared.getWorkerData(lastR8,{copy:false});assert.equal(attached.arenas.length,8);
        const actual=new Map(attached.arenas.map(a=>[a.id,a]));
        for(const source of payload.arenas) {
          const arena=actual.get(source.id);assert(arena);assert.equal(arena.used,source.used);assert.equal(arena.memory,source.memory);
          assert.equal(arena.memory.buffer.byteLength,source.memory.buffer.byteLength);
        }
        validation.passed=true;
      }
      catch(error) {validation.error=String(error?.message??error);}
      validation.elapsedMs=now()-validationStarted;
      return {elapsedMs,checksum,nativeInstances,validation};
    }
    if(message.op==='W8') {
      const state=states.get('P8');assert(state?.reader);const {count}=message;let checksum=0;
      const started=now();
      for(let i=0;i<count;i++) checksum+=query(state.current,'W8');
      const elapsedMs=now()-started;
      return {elapsedMs,checksum,variant:state.variant};
    }
    if(message.op==='dropR8') {lastR8=null;return {passed:true};}
    if(message.op==='dispose') {
      const state=states.get(message.row);assert(state?.reader);state.reader.dispose();
      state.initial=state.previous=state.current=state.reader=state.initialMemory=null;state.wire.lastFrame=null;states.delete(message.row);
      return {passed:true,remainingSessions:states.size};
    }
    if(message.op==='finish') {
      assert.equal(states.size,0);assert.equal(lastR8,null);
      return {passed:true,commands,threadId,realWorker:true};
    }
    throw new Error('Unknown harness command');
  }
  let chain=Promise.resolve();
  parentPort.on('message',message=>{
    if(message?._nativeReaderScreen!==1||message.kind!=='request') return;
    chain=chain.then(()=>command(message)).then(result=>post({kind:'reply',id:message.id,result})).catch(error=>{
      post({kind:'reply',id:message.id,error:String(error?.message??error)});onError(error);
    });
  });
  post({kind:'boot',workerImportMs,threadId,realWorker:true,workerRoute:'node:worker_threads'});
}
