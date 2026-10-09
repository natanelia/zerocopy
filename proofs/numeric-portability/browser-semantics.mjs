import {check,equal,selectionGuard} from './core.mjs';
export async function semantics(io){
  const api=await io.importModule('shared.js'),automatic=await io.importModule('numeric.js'),scalar=await io.importModule('numeric-scalar-control.mjs');
  api.configureMemory({maximumBytes:67108864});let seed=new api.SharedList('number').pushMany([0]);
  const selection=selectionGuard(automatic,scalar,seed);seed=null;api.resetSharedList();let checks=0;
  const snap=async list=>({root:list.root,depth:list.depth,tail:list.tail,size:list.size,used:list.arena.used,capacity:list.arena.memory.buffer.byteLength,digest:await io.sha256(new Uint8Array(list.arena.memory.buffer))});
  for(const [mode,numeric] of [['auto',automatic],['scalar',scalar]])for(const size of [...Array.from({length:33},(_,i)=>i),33,63,64,65,1023,1024,1025,32769]){
    const values=Array.from({length:size},(_,i)=>i%13-6),special=[NaN,Infinity,-Infinity,-0,0,Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,-Number.MAX_VALUE];
    for(let i=0;i<Math.min(size,special.length);i++)values[i]=special[i];
    let list=new api.SharedList('number').pushMany(values),before=await snap(list),actualCounts=[];
    for(const lo of [-Infinity,-0,2,Infinity,NaN])for(const hi of [-Infinity,0,4,Infinity,NaN]){const n=values.reduce((sum,v)=>sum+Number(v>=lo&&v<=hi),0);const actual=numeric.countInRange(list,lo,hi);actualCounts.push(actual);check(actual===n,`Range semantics ${size}`);checks++;}
    const after=await snap(list);equal(after,before);await io.emit({kind:'kernel-semantic',mode,operation:'countInRange',size,actualCounts,before,after});list=null;api.resetSharedList();
  }
  for(const [mode,numeric] of [['auto',automatic],['scalar',scalar]])for(const size of [0,1,2,3,4,5,15,16,17,31,32,33,513,16385]){
    const values=Array.from({length:size*2},(_,i)=>i%31-15);if(size)values[0]=NaN;if(size>1)values[2]=Infinity;if(size>2)values[5]=-Infinity;
    let list=new api.SharedList('number').pushMany(values),before=await snap(list),actualCounts=[];
    for(const minX of [-Infinity,-0,2,Infinity,NaN])for(const maxY of [-Infinity,0,12,Infinity,NaN]){const q={minX,minY:-10,maxX:10,maxY};let n=0;for(let i=0;i<values.length;i+=2)n+=Number(values[i]>=q.minX&&values[i]<=q.maxX&&values[i+1]>=q.minY&&values[i+1]<=q.maxY);const actual=numeric.countPointsInBox(list,q);actualCounts.push(actual);check(actual===n);checks++;}
    const after=await snap(list);equal(after,before);await io.emit({kind:'kernel-semantic',mode,operation:'countPointsInBox',size,actualCounts,before,after});list=null;api.resetSharedList();
  }
  for(const copy of [false,true])for(const mode of ['auto','scalar']){
    let list=new api.SharedList('number').pushMany(Array(33).fill(1)),points=new api.SharedList('number').pushMany(Array(34).fill(1));
    const old=list,oldPoints=points,capacity=list.arena.memory.buffer.byteLength;
    const worker=new Worker('/semantic-worker.mjs?mode='+mode,{type:'module'});
    let sequence=0;const ask=data=>new Promise((resolve,reject)=>{const id=sequence++;const timer=setTimeout(()=>finish(new Error('Worker semantic timeout')),15000);const message=event=>{if(event.data.id===id)finish(event.data.error?new Error(event.data.error):null,event.data.result);};const error=event=>finish(new Error(event.message));function finish(reason,result){clearTimeout(timer);worker.removeEventListener('message',message);worker.removeEventListener('error',error);reason?reject(reason):resolve(result);}worker.addEventListener('message',message);worker.addEventListener('error',error);worker.postMessage({id,...data});});
    try{
      const ready=await ask({kind:'attach',copy,data:api.getWorkerData({list,points},{copy})});check(ready.ready&&ready.selection===mode);
      const first=await ask({kind:'read'});equal(first.counts,[33,17]);
      const overlap=ask({kind:'read',concurrentOwnerMayWrite:true});list=list.pushMany(Array(32768).fill(1)).set(0,99);points=points.pushMany(Array(32768).fill(1)).set(0,99).set(1,99);
      const capacityAfter=list.arena.memory.buffer.byteLength;check(capacityAfter>capacity,'Owner growth must actually occur');const during=await overlap;equal(during.counts,[33,17]);const final=await ask({kind:'read'});equal(final.counts,[33,17]);
      const oldCount=automatic.countInRange(old,0,2);check(oldCount===33);const changedCount=automatic.countInRange(list,99,99);check(changedCount===1);const spatialCount=automatic.countPointsInBox(oldPoints,{minX:0,minY:0,maxX:2,maxY:2});check(spatialCount===17);const ownerCounts=[oldCount,changedCount,spatialCount];
      await io.emit({kind:'worker-semantic',copy,mode,countChecks:6,actualGrowth:true,capacityBefore:capacity,capacityAfter,ready,first,during,final,ownerCounts,overlap:'scheduled tasks; not individual load overlap',passed:true});checks+=8;
    }finally{worker.terminate();}
    list=null;points=null;api.resetSharedList();
  }
  await io.emit({kind:'semantics-complete',checks,selection,exceptionTransfer:false,sharedAndCopiedActualWorkers:true});
}
