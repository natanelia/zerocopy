// Pure standard-library tests. No target import, Worker, build, or timing.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { endpoint,protocolState,sentSnapshot,observedAck,verifyProtocol } from './endpoint.mjs';
import { oracleTotal,expectedBatch,validateView,validateTransition,KEYS,NAMES,objectOracle } from './oracle.mjs';

class Emitter extends EventEmitter {postMessage(...args){this.sent=args;}}
const real=new Emitter(),received=[],observed=[];
const wrapped=endpoint(real,{receive:value=>observed.push(value),send:value=>observed.push(value)});
const payload={value:42};
function listener(value,extra){assert.equal(this,real);received.push([value,extra]);}
wrapped.on('message',listener);real.emit('message',payload,'extra');
assert.equal(received[0][0],payload);assert.equal(received[0][1],'extra');assert.equal(observed[0],payload);
wrapped.off('message',listener);real.emit('message',payload);assert.equal(received.length,1);
wrapped.postMessage(payload,[]);assert.equal(real.sent[0],payload);
let exited=0;const exit=()=>exited++;wrapped.on('exit',exit);real.emit('exit');wrapped.off('exit',exit);real.emit('exit');assert.equal(exited,1);

class Target extends EventTarget {postMessage(...args){this.sent=args;}start(){this.started=true;}}
const eventReal=new Target(),eventWrapped=endpoint(eventReal),events=[];
function eventListener(event){assert.equal(this,eventReal);events.push(event);}
eventWrapped.addEventListener('message',eventListener);eventWrapped.addEventListener('message',eventListener);
const message=new MessageEvent('message',{data:payload});eventReal.dispatchEvent(message);
assert.equal(events.length,1);assert.equal(events[0],message);assert.equal(events[0].data,payload);
eventWrapped.removeEventListener('message',eventListener);eventReal.dispatchEvent(message);assert.equal(events.length,1);
const objectListener={handleEvent(event){assert.equal(this,objectListener);assert.equal(event,message);}};
eventWrapped.addEventListener('message',objectListener,{once:true});eventReal.dispatchEvent(message);eventReal.dispatchEvent(message);
eventWrapped.start();assert.equal(eventReal.started,true);

const state=protocolState('P8');
const frame=sequence=>({protocol:'zerocopy/session',channel:'P8',kind:'snapshot',sequence,data:{
  structures:Object.fromEntries(NAMES.map(name=>[name,{}])),
  arenas:NAMES.map((_,i)=>({id:`arena-${i}`,used:65536,...(sequence===0?{memory:{}}:{})}))}});
for(let sequence=0;sequence<3;sequence++) {
  sentSnapshot(state,frame(sequence));observedAck(state,{protocol:'zerocopy/session',channel:'P8',kind:'ack',sequence});
}
assert.equal(verifyProtocol(state,'P8').passed,true);
state.lastAck=1;assert.throws(()=>verifyProtocol(state,'P8'));state.lastAck=2;
observedAck(state,{protocol:'zerocopy/session',channel:'P8',kind:'ack',sequence:2});assert.throws(()=>verifyProtocol(state,'P8'));

assert.equal(oracleTotal('P1',0),1016);assert.equal(oracleTotal('P1',1),101016);
assert.equal(oracleTotal('P8',0),19312);assert.equal(oracleTotal('P8',1),19313);
assert.equal(oracleTotal('F8',0),19312);assert.equal(oracleTotal('F8',1),147312);
for(const row of ['P1','P8','C8','F8']) for(const before of [0,1]) for(const count of [1,2,3,31,32,8192]) {
  let reference=0;for(let i=0;i<count;i++) reference+=oracleTotal(row,(before+i+1)%2);
  assert.equal(expectedBatch(row,before,count,17),reference);
}
assert.equal(expectedBatch('N8',1,256,17),4352);assert.equal(expectedBatch('W8',1,128,17),2472064);

function syntheticMap(j,variant) {
  const data=new Map(KEYS.map((key,i)=>[key,Object.freeze(objectOracle(j,i,variant))]));
  return Object.freeze({size:128,keys:()=>data.keys(),get:key=>data.get(key)});
}
const initial=Object.freeze(Object.fromEntries(NAMES.map((name,j)=>[name,syntheticMap(j,0)])));
const current=Object.freeze({...initial,m0:syntheticMap(0,1)});
validateView(initial,'P8',0);validateView(current,'P8',1);validateTransition(initial,current,'P8');
assert.throws(()=>validateTransition(initial,initial,'P8'));
const changedUnchanged=Object.freeze({...current,m1:syntheticMap(1,0)});
assert.throws(()=>validateTransition(initial,changedUnchanged,'P8'));
assert.throws(()=>validateView(Object.freeze({...current,extra:true}),'P8',1));
console.log(JSON.stringify({passed:true,scope:'synthetic endpoint semantics, sequence checks, independent oracle, negative shape/identity checks',targetImports:false,workersCreated:0}));
