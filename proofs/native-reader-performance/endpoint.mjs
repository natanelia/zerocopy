// One-for-one listener wrappers over a real Worker/MessagePort. Events, arguments,
// this binding, ordering, error/exit listeners, and listener removals are preserved.
import assert from 'node:assert/strict';
export function endpoint(real, observe={}) {
  const wrappers=new Map();
  const wrapped=(api,type,listener,options) => {
    const capture=typeof options==='boolean'?options:!!options?.capture;
    const key=`${api}:${type}:${capture}`;
    let byListener=wrappers.get(key);
    if(!byListener) wrappers.set(key,byListener=new Map());
    if(!byListener.has(listener)) byListener.set(listener,function(...args) {
      const data=api==='event'?args[0]?.data:args[0];
      if(type==='message') observe.receive?.(data);
      if(typeof listener==='function') return listener.apply(this,args);
      return listener.handleEvent.apply(listener,args);
    });
    return byListener.get(listener);
  };
  const find=(api,type,listener,options) => wrappers.get(`${api}:${type}:${typeof options==='boolean'?options:!!options?.capture}`)?.get(listener) ?? listener;
  const out={postMessage(...args) { observe.send?.(args[0]); return real.postMessage(...args); }};
  if(typeof real.addEventListener==='function' && typeof real.removeEventListener==='function') {
    out.addEventListener=(type,listener,options)=>real.addEventListener(type,wrapped('event',type,listener,options),options);
    out.removeEventListener=(type,listener,options)=>real.removeEventListener(type,find('event',type,listener,options),options);
  }
  if(typeof real.on==='function' && typeof real.off==='function') {
    out.on=(type,listener)=>{real.on(type,wrapped('emitter',type,listener));return out;};
    out.off=(type,listener)=>{real.off(type,find('emitter',type,listener));return out;};
  }
  if(typeof real.start==='function') out.start=()=>real.start();
  return out;
}
export const isWire=data=>data?.protocol==='zerocopy/session';
export function protocolState(channel) {
  return {channel,snapshots:0,acks:0,lastSnapshot:-1,lastAck:-1,badOrder:0,
    dispatchedAt:0,lastFrame:null,firstFrame:null,copyFrames:0,sharedFrames:0,
    missingMemoryFrames:0,fullMemoryFrames:0};
}
export function sentSnapshot(state,data) {
  if(!isWire(data)||data.channel!==state.channel||data.kind!=='snapshot') return;
  state.snapshots++;
  if(data.sequence!==state.lastSnapshot+1) state.badOrder++;
  state.lastSnapshot=data.sequence;
  state.lastFrame=data;
  // Keep only scalar descriptor summaries; no earlier frame or Memory history.
  const summary=frameSummary(data);
  if(!state.firstFrame) state.firstFrame=summary;
  if(summary.copies===summary.arenas) state.copyFrames++;
  else if(summary.memories===summary.arenas) state.fullMemoryFrames++;
  else if(summary.memories===0 && summary.copies===0) state.missingMemoryFrames++;
  else state.badOrder++;
  if(summary.copies===0) state.sharedFrames++;
}
export function observedAck(state,data) {
  if(!isWire(data)||data.channel!==state.channel||data.kind!=='ack') return;
  state.acks++;
  if(data.sequence!==state.lastAck+1) state.badOrder++;
  state.lastAck=data.sequence;
}
export function frameSummary(data) {
  const arenas=data.data.arenas;
  return {sequence:data.sequence,arenas:arenas.length,structures:Object.keys(data.data.structures),
    memories:arenas.filter(a=>a.memory!==undefined).length,copies:arenas.filter(a=>a.copy!==undefined).length,
    ids:arenas.map(a=>a.id),used:arenas.map(a=>a.used)};
}
export function verifyProtocol(state,row) {
  const count=row==='P1'?1:8;
  assert.equal(state.badOrder,0);assert.equal(state.acks,state.snapshots);
  assert.equal(state.lastSnapshot,state.lastAck);
  assert.equal(state.firstFrame.arenas,count);
  const last=frameSummary(state.lastFrame);
  assert.equal(last.arenas,count);assert.equal(new Set(last.ids).size,count);
  assert.deepEqual(last.structures,row==='P1'?['value']:Array.from({length:8},(_,j)=>`m${j}`));
  if(row==='C8') {assert.equal(state.copyFrames,state.snapshots);assert.equal(last.copies,8);}
  else if(row==='F8') {assert.equal(state.fullMemoryFrames,state.snapshots);assert.equal(last.memories,8);}
  else {assert.equal(state.fullMemoryFrames,1);assert.equal(state.missingMemoryFrames,state.snapshots-1);}
  return {passed:true,snapshots:state.snapshots,acks:state.acks,lastSequence:state.lastAck,
    copyFrames:state.copyFrames,fullMemoryFrames:state.fullMemoryFrames,omittedKnownMemoryFrames:state.missingMemoryFrames};
}
